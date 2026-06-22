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

// A tag's position anchor: 1-based line plus its optional content pattern.
export interface TagAnchor {
  line: number;
  pattern?: string;
}

// Re-anchor a tag after a document change. Combines both tracking strategies:
//  1. shift the stored line by the incremental edits (exact, and correct even
//     for duplicate lines), then
//  2. if the tag has a content pattern, let resolveLine override that guess —
//     it trusts the shifted line when the pattern still matches there, but
//     searches the whole file otherwise. This is what recovers a tag after a
//     wholesale overwrite, where the incremental shift can't know where the
//     line went.
// Finally the anchor pattern is refreshed from the resolved line's current text
// so future content recovery stays accurate (a blank line keeps the old anchor).
export function reanchorTag(
  text: string,
  anchor: TagAnchor,
  edits: LineEdit[]
): TagAnchor {
  const shifted0 = shiftedLine(anchor.line - 1, edits);
  const resolved1 = anchor.pattern
    ? resolveLine(text, shifted0 + 1, anchor.pattern)
    : shifted0 + 1;
  const line = Math.max(1, resolved1);

  const lines = text.split(/\r?\n/);
  const current = lines[line - 1];
  const pattern =
    current !== undefined ? linePattern(current) ?? anchor.pattern : anchor.pattern;

  return { line, pattern };
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

// The raw comparison anchor for a line: its trimmed text. undefined for a
// blank/whitespace-only line (no usable anchor). Counterpart of linePattern,
// but un-escaped — fed to the fuzzy resolver.
export function lineAnchorText(lineText: string): string | undefined {
  const t = lineText.trim();
  return t.length === 0 ? undefined : t;
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
