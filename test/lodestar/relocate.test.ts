import { describe, it, expect } from "vitest";
import { resolveLine, linePattern, reanchorTag } from "../../src/lodestar/relocate";
import { LineEdit } from "../../src/lodestar/tree";

const text = ["void a(){", "  doThing();", "}", "", "case SU_RepeatMode:"].join("\n");

describe("resolveLine", () => {
  it("keeps the stored line when it still matches", () => {
    expect(resolveLine(text, 5, "case SU_RepeatMode:")).toBe(5);
  });
  it("relocates when the line drifted but pattern still matches", () => {
    expect(resolveLine(text, 2, "case SU_RepeatMode:")).toBe(5);
  });
  it("falls back to stored line when no pattern", () => {
    expect(resolveLine(text, 2)).toBe(2);
  });
  it("falls back to stored line when pattern is absent from file", () => {
    expect(resolveLine(text, 3, "no_such_token")).toBe(3);
  });
});

describe("linePattern", () => {
  it("anchors at leading whitespace and escapes regex specials", () => {
    expect(linePattern("    if (a) { b(); }")).toBe(
      "^[^\\S\\n]*if \\(a\\) \\{ b\\(\\); \\}"
    );
  });
  it("returns undefined for a blank or whitespace-only line", () => {
    expect(linePattern("")).toBeUndefined();
    expect(linePattern("   \t ")).toBeUndefined();
  });
  it("round-trips: a pattern it builds recovers that line via resolveLine", () => {
    const src = ["int x;", "    unsigned char OverFlowEnable;", "int y;"].join(
      "\n"
    );
    const pat = linePattern("    unsigned char OverFlowEnable;")!;
    // stored line is wrong (1); the built pattern recovers the real line (2)
    expect(resolveLine(src, 1, pat)).toBe(2);
  });
});

describe("reanchorTag (persisted live re-anchoring)", () => {
  // insert n blank lines at the START of 0-based `line`
  const ins = (line: number, n: number): LineEdit => ({
    start: line,
    end: line,
    endChar: 0,
    delta: n
  });

  it("shifts the line down when lines are inserted above, keeping the anchor", () => {
    const text = ["a", "b", "c", "d", "  doThing();", "f"].join("\n");
    const pat = linePattern("  doThing();");
    const after = reanchorTag(text, { line: 2, pattern: pat }, [ins(0, 3)]);
    expect(after.line).toBe(5);
    expect(after.pattern).toBe(pat);
  });

  it("recovers the true line by content when the incremental shift is wrong (file overwrite)", () => {
    const lines = Array.from({ length: 36 }, (_, i) => `line${i + 1}`);
    lines[34] = "  OverFlowEnable;"; // 1-based line 35
    const text = lines.join("\n");
    const pat = linePattern("  OverFlowEnable;");
    // stored line is stale (29); a whole-document replace doesn't shift it,
    // so only content recovery can find the real line.
    const after = reanchorTag(text, { line: 29, pattern: pat }, [
      { start: 0, end: 33, endChar: 0, delta: 6 }
    ]);
    expect(after.line).toBe(35);
  });

  it("refreshes the anchor to the line's new text so the next recovery stays accurate", () => {
    const text = ["x", "  newName();", "y"].join("\n");
    const stale = linePattern("  oldName();");
    const after = reanchorTag(text, { line: 2, pattern: stale }, []);
    expect(after.line).toBe(2);
    expect(after.pattern).toBe(linePattern("  newName();"));
  });

  it("tracks by line number alone when the tag has no pattern", () => {
    const text = ["a", "b", "  x();", "d"].join("\n");
    const after = reanchorTag(text, { line: 1, pattern: undefined }, [ins(0, 2)]);
    expect(after.line).toBe(3);
  });
});
