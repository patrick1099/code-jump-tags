import { LineEdit, shiftedLine } from "./tree";

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
