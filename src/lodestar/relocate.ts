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
