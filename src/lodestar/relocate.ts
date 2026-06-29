import { LineEdit, shiftedLine } from "./tree";
import { LodestarStore, TreeNode } from "./types";

export const SIMILARITY_THRESHOLD = 0.9;
export const SEARCH_RADII = [8, 40, Infinity];
export const MAX_CMP_LEN = 200;

// Collapse a line to its comparison form: trim ends, squeeze internal
// whitespace runs to a single space. Blank/whitespace-only -> "".
export function normalizeWs(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

// Normalized Levenshtein similarity in [0,1]. Inputs are compared as-is
// (callers pass normalizeWs'd strings). Each side is capped at MAX_CMP_LEN
// chars to bound the DP cost. Two empty strings count as identical (1).
export function similarity(a: string, b: string): number {
  const s = a.length > MAX_CMP_LEN ? a.slice(0, MAX_CMP_LEN) : a;
  const t = b.length > MAX_CMP_LEN ? b.slice(0, MAX_CMP_LEN) : b;
  const n = s.length;
  const m = t.length;
  if (n === 0 && m === 0) return 1;
  if (n === 0 || m === 0) return 0;
  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  const dist = prev[m];
  return 1 - dist / Math.max(n, m);
}

// A tag's position anchor: 1-based line plus optional recovery anchors.
// `text` (raw line text) drives fuzzy recovery; `pattern` (regex) is kept for
// the URL deep-link / legacy step layer and as a fallback for un-migrated tags.
export interface TagAnchor {
  line: number;
  text?: string;
  pattern?: string;
}

// Re-anchor a tag after a document change. (1) shift the stored line by the
// incremental edits, then (2) let content recovery override that guess: fuzzy
// on `text` when present, else the legacy regex on `pattern`. Finally refresh
// BOTH anchors from the resolved line's current text so neither goes stale.
export function reanchorTag(
  text: string,
  anchor: TagAnchor,
  edits: LineEdit[]
): TagAnchor {
  const shifted1 = shiftedLine(anchor.line - 1, edits) + 1;
  const resolved1 = anchor.text
    ? resolveLineFuzzy(text, shifted1, anchor.text)
    : resolveLine(text, shifted1, anchor.pattern);
  const line = Math.max(1, resolved1);

  const lines = text.split(/\r?\n/);
  const current = lines[line - 1];

  // Decide whether to ADOPT the resolved line's text as the tag's new anchor.
  // resolve*() returns the stored line BOTH when it genuinely matched and when
  // nothing matched (a blind fallback). Adopting on a blind fallback overwrites
  // a good anchor with an unrelated line's text ("poisoning") — and that poison
  // survives an undo, dragging the tag to the wrong line (e.g. cut a tagged line
  // whole, then undo: the neighbour that slid up would be adopted, so undo lands
  // the tag on the neighbour). We adopt only when we can trust the resolved line
  // really is this tag's line:
  //   - the tag's own line was NOT structurally deleted by this change (it was
  //     merely shifted, or edited in place — e.g. a mid-line split), so whatever
  //     it now reads IS the tag's line; or
  //   - the line WAS deleted, but content recovery found a confident match
  //     elsewhere (the line genuinely moved). Otherwise keep the old anchor so a
  //     later edit / undo can still recover the original line by content.
  const line0 = anchor.line - 1;
  const tagLineDeleted = edits.some(e => e.start <= line0 && e.end > line0);
  if (current === undefined || (tagLineDeleted && !lineMatchesAnchor(current, anchor))) {
    return { line, text: anchor.text, pattern: anchor.pattern };
  }

  const newText = lineAnchorText(current) ?? anchor.text;
  const newPattern = linePattern(current) ?? anchor.pattern;
  return { line, text: newText, pattern: newPattern };
}

// Does `lineText` confidently correspond to this anchor — by fuzzy text
// similarity (preferred), else by the legacy regex pattern? Used to decide
// whether a line reached after a structural deletion is really the tag's line.
function lineMatchesAnchor(lineText: string, anchor: TagAnchor): boolean {
  if (anchor.text) {
    return (
      similarity(normalizeWs(lineText), normalizeWs(anchor.text)) >=
      SIMILARITY_THRESHOLD
    );
  }
  if (anchor.pattern) {
    try {
      return new RegExp(anchor.pattern).test(lineText);
    } catch {
      return false;
    }
  }
  return false;
}

// Build the drift-recovery pattern for a line from its raw text. Anchors at the
// line's leading whitespace, then matches the trimmed text literally (regex
// specials escaped). Returns undefined for a blank/whitespace-only line, which
// has no usable anchor. Single source of truth for how tags capture their
// anchor (used at tag creation and whenever a tag's line text changes).
export function linePattern(lineText: string): string | undefined {
  const trimmed = lineText.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return "^[^\\S\\n]*" + trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Resolve a tag's display line in possibly-changed file text.
// Pure: takes full text + stored 1-based line + optional pattern.
export function resolveLine(text: string, line: number, pattern?: string): number {
  if (!pattern) return line;

  const lines = text.split(/\r?\n/);
  const stored = lines[line - 1];

  let re: RegExp;
  try {
    re = new RegExp(pattern, "m");
  } catch {
    return line;
  }

  // If the stored line still satisfies the pattern, trust the stored line.
  if (stored !== undefined && new RegExp(pattern).test(stored)) {
    return line;
  }

  const match = text.match(re);
  if (match && match.index !== undefined) {
    const before = text.slice(0, match.index);
    return before.split(/\r?\n/).length; // 1-based line of match
  }

  return line;
}

// Distance-first fuzzy line resolver (the recovery layer for changes we did
// NOT witness live — reopen after external/git edits). 1-based in/out.
// Trusts the center (incrementally-tracked) line whenever it still clears the
// similarity bar; otherwise searches outward in concentric rings, so a NEAR
// fuzzy match wins over a FAR exact duplicate (e.g. a #if-0 macro twin).
export function resolveLineFuzzy(
  text: string,
  centerLine: number,
  anchorText?: string
): number {
  if (!anchorText) return centerLine;
  const target = normalizeWs(anchorText);
  if (target.length === 0) return centerLine;

  const lines = text.split(/\r?\n/);
  const center0 = centerLine - 1;
  const simAt = (i: number): number => {
    const l = lines[i];
    return l === undefined ? -1 : similarity(normalizeWs(l), target);
  };

  // Fast path: incremental tracking already put us on a good line.
  if (center0 >= 0 && center0 < lines.length && simAt(center0) >= SIMILARITY_THRESHOLD) {
    return centerLine;
  }

  for (const R of SEARCH_RADII) {
    const lo = Math.max(0, center0 - R);
    const hi = Math.min(lines.length - 1, center0 + R);
    let best = -1;
    let bestSim = -1;
    let bestDist = Infinity;
    for (let i = lo; i <= hi; i++) {
      const s = simAt(i);
      if (s < SIMILARITY_THRESHOLD) continue;
      const d = Math.abs(i - center0);
      if (s > bestSim || (s === bestSim && d < bestDist)) {
        best = i;
        bestSim = s;
        bestDist = d;
      }
    }
    if (best >= 0) return best + 1;
    if (!isFinite(R)) break; // whole-file ring already scanned
  }
  return centerLine;
}

// Strict distance-first resolver: like resolveLineFuzzy but returns 0 (not the
// center line) when NO line clears the similarity bar, so callers can tell a
// real match from a miss. 1-based; 0 = miss.
export function findAnchorLine(
  text: string,
  centerLine: number,
  anchorText?: string
): number {
  if (!anchorText) return 0;
  const target = normalizeWs(anchorText);
  if (target.length === 0) return 0;

  const lines = text.split(/\r?\n/);
  const center0 = centerLine - 1;
  const simAt = (i: number): number => {
    const l = lines[i];
    return l === undefined ? -1 : similarity(normalizeWs(l), target);
  };

  if (center0 >= 0 && center0 < lines.length && simAt(center0) >= SIMILARITY_THRESHOLD) {
    return centerLine;
  }

  for (const R of SEARCH_RADII) {
    const lo = Math.max(0, center0 - R);
    const hi = Math.min(lines.length - 1, center0 + R);
    let best = -1;
    let bestSim = -1;
    let bestDist = Infinity;
    for (let i = lo; i <= hi; i++) {
      const s = simAt(i);
      if (s < SIMILARITY_THRESHOLD) continue;
      const d = Math.abs(i - center0);
      if (s > bestSim || (s === bestSim && d < bestDist)) {
        best = i;
        bestSim = s;
        bestDist = d;
      }
    }
    if (best >= 0) return best + 1;
    if (!isFinite(R)) break;
  }
  return 0;
}

// Cold-recovery double match: try the immutable judge `original` first, then the
// live cache `current`. Both via findAnchorLine (distance-first ring around
// centerLine). 1-based. status tells the caller whether to heal silently
// (original), offer a soft-suspect candidate (current), or give up (lost).
export type AnchorMatch =
  | { status: "original"; line: number }
  | { status: "current"; line: number }
  | { status: "lost"; line: number };

export function matchAnchor(
  text: string,
  centerLine: number,
  original?: string,
  current?: string
): AnchorMatch {
  const o = findAnchorLine(text, centerLine, original);
  if (o > 0) return { status: "original", line: o };
  const c = findAnchorLine(text, centerLine, current);
  if (c > 0) return { status: "current", line: c };
  return { status: "lost", line: centerLine };
}

// The single choke point that turns a stored tag line into a display/jump line.
// Original-first double match, then the legacy regex pattern, else the stored
// line. Marker and jump MUST both call this so they always agree.
export function resolveTagLine(
  text: string,
  line: number,
  original?: string,
  current?: string,
  pattern?: string
): number {
  const m = matchAnchor(text, line, original, current);
  if (m.status !== "lost") return m.line;
  if (pattern) return resolveLine(text, line, pattern);
  return line;
}

// The raw comparison anchor for a line: its trimmed text. undefined for a
// blank/whitespace-only line (no usable anchor). Counterpart of linePattern,
// but un-escaped — fed to the fuzzy resolver.
export function lineAnchorText(lineText: string): string | undefined {
  const t = lineText.trim();
  return t.length === 0 ? undefined : t;
}

// Unified resolve for a tag/step: prefer the fuzzy text anchor, fall back to
// the legacy regex pattern, else trust the stored line. One choke point for
// every place that turns a stored line into a display line.
export function resolveAnchoredLine(
  text: string,
  line: number,
  anchorText?: string,
  pattern?: string
): number {
  if (anchorText) return resolveLineFuzzy(text, line, anchorText);
  if (pattern) return resolveLine(text, line, pattern);
  return line;
}

const PATTERN_PREFIX = "^[^\\S\\n]*";

// Recover the raw line text from a linePattern() regex (strip the leading-
// whitespace prefix, then unescape the regex specials it escaped). Returns
// undefined if the string isn't one of our patterns.
export function patternToText(pattern: string): string | undefined {
  if (!pattern.startsWith(PATTERN_PREFIX)) return undefined;
  const body = pattern.slice(PATTERN_PREFIX.length);
  return body.replace(/\\([.*+?^${}()|[\]\\])/g, "$1");
}

// One-time, idempotent: give every tag a `text` anchor. Tags that predate the
// fuzzy model have only `pattern`; derive `text` from it so they get fuzzy
// recovery immediately. `pattern` is left untouched (URL/legacy still use it).
export function backfillAnchorText(store: LodestarStore): void {
  const walk = (nodes: TreeNode[]): void => {
    for (const node of nodes) {
      if (node.type === "folder") {
        walk(node.children);
      } else if (node.text === undefined && node.pattern) {
        const t = patternToText(node.pattern);
        if (t !== undefined) node.text = t;
      }
    }
  };
  walk(store.tree);
}
