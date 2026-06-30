import { describe, it, expect } from "vitest";
import {
  resolveLine,
  linePattern,
  reanchorTag,
  normalizeWs,
  similarity,
  resolveLineFuzzy,
  findAnchorLine,
  lineAnchorText,
  patternToText,
  backfillAnchorText,
  backfillOriginal,
  resolveAnchoredLine,
  matchAnchor,
  resolveTagLine,
  type AnchorMatch
} from "../../src/lodestar/relocate";
import { LineEdit } from "../../src/lodestar/tree";
import type { LodestarStore } from "../../src/lodestar/types";

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
  const ins = (line: number, n: number): LineEdit => ({
    start: line,
    end: line,
    endChar: 0,
    delta: n
  });

  it("shifts the line down when lines are inserted above, refreshing both anchors", () => {
    const text = ["a", "b", "c", "d", "  doThing();", "f"].join("\n");
    const after = reanchorTag(text, { line: 2, text: "doThing();" }, [ins(0, 3)]);
    expect(after.line).toBe(5);
    expect(after.text).toBe("doThing();");
    expect(after.pattern).toBe(linePattern("  doThing();"));
  });

  it("recovers the true line by FUZZY content when the incremental shift is wrong", () => {
    const lines = Array.from({ length: 36 }, (_, i) => `line${i + 1}`);
    lines[34] = "  OverFlowEnable;"; // 1-based line 35
    const text = lines.join("\n");
    const after = reanchorTag(text, { line: 29, text: "OverFlowEnable;" }, [
      { start: 0, end: 33, endChar: 0, delta: 6 }
    ]);
    expect(after.line).toBe(35);
  });

  it("refreshes the text anchor to the line's new content", () => {
    const text = ["x", "  newName();", "y"].join("\n");
    const after = reanchorTag(text, { line: 2, text: "newName();" }, []);
    expect(after.line).toBe(2);
    expect(after.text).toBe("newName();");
  });

  it("falls back to legacy regex pattern when the tag has no text", () => {
    const lines = Array.from({ length: 36 }, (_, i) => `line${i + 1}`);
    lines[34] = "  OverFlowEnable;";
    const text = lines.join("\n");
    const pat = linePattern("  OverFlowEnable;");
    const after = reanchorTag(text, { line: 29, pattern: pat }, [
      { start: 0, end: 33, endChar: 0, delta: 6 }
    ]);
    expect(after.line).toBe(35);
    expect(after.text).toBe("OverFlowEnable;"); // refreshed from the resolved line
  });

  it("tracks by line number alone when the tag has neither text nor pattern", () => {
    const text = ["a", "b", "  x();", "d"].join("\n");
    const after = reanchorTag(text, { line: 1 }, [ins(0, 2)]);
    expect(after.line).toBe(3);
  });

  it("a mid-line split keeps the tag on the upper half and re-anchors to it", () => {
    // line 2 "if (a > b) { foo(); }" split after "{" -> upper "if (a > b) {"
    const text = ["void a(){", "if (a > b) {", "foo(); }", "}"].join("\n");
    // emulate the split edit: a newline inserted mid-line on line index 1
    const after = reanchorTag(
      text,
      { line: 2, text: "if (a > b) { foo(); }" },
      [{ start: 1, end: 1, endChar: 12, delta: 1 }]
    );
    expect(after.line).toBe(2);            // stays on the upper half
    expect(after.text).toBe("if (a > b) {"); // re-anchored to the upper half
  });

  // Cutting the tagged line whole (Ctrl+X / delete-line) makes its anchor text
  // momentarily vanish. Resolution then FALLS BACK to the stored line — which
  // now holds an UNRELATED neighbour's text. The old code overwrote the anchor
  // with that neighbour ("poisoning"), so a later undo could never recover.
  it("does NOT poison the anchor when the tagged line is cut (unconfident fallback keeps the old anchor)", () => {
    // line 5 "  foo();" is cut; "  bar();" slides up into its slot.
    const afterCut = ["L1", "L2", "L3", "L4", "  bar();", "L7"].join("\n");
    const after = reanchorTag(
      afterCut,
      { line: 5, text: "foo();", pattern: linePattern("  foo();") },
      [{ start: 4, end: 5, endChar: 0, delta: -1 }]
    );
    // The resolved line never matched "foo();", so the anchor must be preserved
    // verbatim — not rewritten to "bar();".
    expect(after.text).toBe("foo();");
    expect(after.pattern).toBe(linePattern("  foo();"));
  });

  it("recovers to the original line after a cut + undo (no poisoning)", () => {
    // 1) cut line 5 ("  foo();")
    const afterCut = ["L1", "L2", "L3", "L4", "  bar();", "L7"].join("\n");
    const cut = reanchorTag(
      afterCut,
      { line: 5, text: "foo();", pattern: linePattern("  foo();") },
      [{ start: 4, end: 5, endChar: 0, delta: -1 }]
    );
    // 2) undo: line 5 is re-inserted
    const restored = ["L1", "L2", "L3", "L4", "  foo();", "  bar();", "L7"].join("\n");
    const undone = reanchorTag(restored, cut, [
      { start: 4, end: 4, endChar: 0, delta: 1 }
    ]);
    expect(undone.line).toBe(5);     // back home, not stuck on the "bar();" line
    expect(undone.text).toBe("foo();");
  });
});

describe("normalizeWs", () => {
  it("trims ends and collapses internal whitespace runs", () => {
    expect(normalizeWs("  if  (a >  b) {\t}  ")).toBe("if (a > b) { }");
  });
  it("maps blank/whitespace-only to empty string", () => {
    expect(normalizeWs("   \t ")).toBe("");
    expect(normalizeWs("")).toBe("");
  });
});

describe("similarity", () => {
  it("is 1 for identical strings and for two empties", () => {
    expect(similarity("foo()", "foo()")).toBe(1);
    expect(similarity("", "")).toBe(1);
  });
  it("tolerates a one-char insertion on a ~10-char line (>=0.9)", () => {
    // "if (a > b)" -> "if (a > b);" : 1 edit over length 11
    expect(similarity("if (a > b)", "if (a > b);")).toBeGreaterThanOrEqual(0.9);
  });
  it("is low for unrelated strings", () => {
    expect(similarity("alpha();", "return 0;")).toBeLessThan(0.5);
  });
});

describe("resolveLineFuzzy", () => {
  it("returns center when anchorText is empty", () => {
    const text = ["a", "b", "c"].join("\n");
    expect(resolveLineFuzzy(text, 2)).toBe(2);
  });

  it("keeps center when the center line still matches (exact)", () => {
    const text = ["void a(){", "  doThing();", "}"].join("\n");
    expect(resolveLineFuzzy(text, 2, "doThing();")).toBe(2);
  });

  it("keeps center when the center line drifted only a little (fuzzy >=0.9)", () => {
    const text = ["void a(){", "  doThing(x);", "}"].join("\n");
    // anchor is the old text "doThing();" — center now "doThing(x);"
    expect(resolveLineFuzzy(text, 2, "doThing();")).toBe(2);
  });

  it("prefers the NEAR fuzzy line over a FAR exact duplicate (macro twin)", () => {
    // line 2 (near, edited -> fuzzy ~0.9) vs line 40 (exact old text).
    const lines = Array.from({ length: 45 }, (_, i) => `pad${i}`);
    lines[1] = "  if (a > b) {;"; // 1-based line 2, near center, fuzzy
    lines[39] = "if (a > b) {";   // 1-based line 40, far, EXACT old text
    const text = lines.join("\n");
    expect(resolveLineFuzzy(text, 2, "if (a > b) {")).toBe(2);
  });

  it("relocates to the nearest matching line when center drifted out", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `x${i}`);
    lines[6] = "  uniqueAnchorToken();"; // 1-based line 7
    const text = lines.join("\n");
    // stored center stale at 4; nearest (only) match is line 7
    expect(resolveLineFuzzy(text, 4, "uniqueAnchorToken();")).toBe(7);
  });

  it("stays put when nothing in the whole file clears the threshold", () => {
    const text = ["aaa", "bbb", "ccc"].join("\n");
    expect(resolveLineFuzzy(text, 2, "zzzzzzzzzz")).toBe(2);
  });

  it("ring search picks the NEAR fuzzy line over a FAR exact duplicate (RC2, center stale)", () => {
    // Center is STALE so the fast path does NOT fire and the ring search runs.
    // The near edited line (ring 8, fuzzy ~0.92) must beat the far EXACT
    // duplicate (distance > 40), even though exact (1.0) > fuzzy — distance wins.
    const lines = Array.from({ length: 80 }, (_, i) => `pad_line_number_${i}`);
    lines[9] = "stale center line zzz"; // 1-based line 10 = center, NOT a match
    lines[12] = "  if (a > b) {;";       // 1-based line 13, near (dist 3), fuzzy ~0.92
    lines[60] = "if (a > b) {";          // 1-based line 61, far (dist 51), EXACT
    const text = lines.join("\n");
    expect(resolveLineFuzzy(text, 10, "if (a > b) {")).toBe(13);
  });

  it("returns center for a whitespace-only anchor", () => {
    const text = ["a", "b", "c"].join("\n");
    expect(resolveLineFuzzy(text, 2, "   ")).toBe(2);
  });
});

describe("lineAnchorText", () => {
  it("returns the trimmed text, undefined for blank", () => {
    expect(lineAnchorText("   foo(a, b);  ")).toBe("foo(a, b);");
    expect(lineAnchorText("   \t")).toBeUndefined();
  });
});

describe("patternToText", () => {
  it("reverses linePattern: strips the prefix and unescapes specials", () => {
    const original = "if (a[0] > b) { c(); }";
    const pat = linePattern("    " + original)!;
    expect(patternToText(pat)).toBe(original);
  });
  it("returns undefined for a pattern without the known prefix", () => {
    expect(patternToText("something_else")).toBeUndefined();
  });
});

describe("backfillAnchorText", () => {
  it("derives text from pattern for tags missing text, keeps pattern", () => {
    const pat = linePattern("  unsigned char OverFlowEnable;")!;
    const store: LodestarStore = {
      version: 1,
      tree: [
        {
          type: "folder",
          id: "f1",
          title: "F",
          children: [
            { type: "tag", id: "t1", note: "n", file: "a.c", line: 3, pattern: pat, createdAt: "x" }
          ]
        }
      ]
    };
    backfillAnchorText(store);
    const tag = (store.tree[0] as any).children[0];
    expect(tag.text).toBe("unsigned char OverFlowEnable;");
    expect(tag.pattern).toBe(pat); // unchanged
  });
  it("leaves a tag that already has text untouched", () => {
    const store: LodestarStore = {
      version: 1,
      tree: [{ type: "tag", id: "t1", note: "n", file: "a.c", line: 1, text: "keep", pattern: "p", createdAt: "x" } as any]
    };
    backfillAnchorText(store);
    expect((store.tree[0] as any).text).toBe("keep");
  });
});

describe("resolveAnchoredLine", () => {
  const text = ["void a(){", "  doThing();", "}", "", "uniqueXYZ();"].join("\n");
  it("uses fuzzy text anchor when present", () => {
    expect(resolveAnchoredLine(text, 2, "uniqueXYZ();")).toBe(5);
  });
  it("falls back to regex pattern when no text", () => {
    expect(resolveAnchoredLine(text, 2, undefined, "uniqueXYZ\\(\\);")).toBe(5);
  });
  it("returns the line when neither anchor is given", () => {
    expect(resolveAnchoredLine(text, 3)).toBe(3);
  });
});

describe("findAnchorLine", () => {
  const text = ["alpha", "beta", "gamma", "delta"].join("\n");

  it("returns the center line when it matches", () => {
    expect(findAnchorLine(text, 2, "beta")).toBe(2);
  });

  it("finds a moved line by distance-first ring search", () => {
    expect(findAnchorLine(text, 1, "delta")).toBe(4);
  });

  it("returns 0 when nothing clears the bar (no blind fallback)", () => {
    expect(findAnchorLine(text, 2, "nonexistent-zzz")).toBe(0);
  });

  it("returns 0 for empty/blank anchor", () => {
    expect(findAnchorLine(text, 2, "")).toBe(0);
    expect(findAnchorLine(text, 2, undefined)).toBe(0);
  });
});

describe("matchAnchor (二重匹配)", () => {
  it("matches original first and reports original", () => {
    const text = ["int foo(a)", "int bar(b)"].join("\n");
    expect(matchAnchor(text, 1, "int foo(a)", "int foo(a)")).toEqual({
      status: "original",
      line: 1
    });
  });

  it("falls to current when original is gone (renamed line)", () => {
    // original 描述老名字(已不在), current 描述改名后的行(在第2行)
    const text = ["x", "int computeCrc16(buf)"].join("\n");
    const m = matchAnchor(text, 1, "void oldCompute()", "int computeCrc16(buf)");
    expect(m).toEqual({ status: "current", line: 2 });
  });

  it("reports lost when neither matches, line = center fallback", () => {
    const text = ["totally", "different"].join("\n");
    expect(matchAnchor(text, 2, "old-aaa", "new-bbb")).toEqual({
      status: "lost",
      line: 2
    });
  });

  it("stays on the in-place-edited line, never hops to an identical twin", () => {
    // 行内编辑:本行(第1行)被改得偏离 original,但仍等于刚刷新的 current;
    // 文件第4行有一条与 original 一模一样的孪生行。标签必须钉在本行,
    // 不能因为 original 在别处有同款就跳过去。(RC: decorator 实时重绘的 hop)
    const text = [
      "* @param usart_num :串口号 111111111", // 第1行:本标签行,行内编辑后的 current
      "void a()",
      "  body",
      "* @param usart_num :串口号"             // 第4行:与 original 完全相同的孪生行
    ].join("\n");
    const original = "* @param usart_num :串口号";
    const current = "* @param usart_num :串口号 111111111";
    expect(matchAnchor(text, 1, original, current)).toEqual({
      status: "current",
      line: 1
    });
  });

  it("still ring-searches when the center matches neither (genuine move)", () => {
    // 中心行被整体覆盖成无关内容、original 真的搬到了别处时,仍按内容环搜恢复。
    const text = ["unrelated overwrite", "x", "int computeCrc16(buf)"].join("\n");
    expect(matchAnchor(text, 1, "int computeCrc16(buf)", "int computeCrc16(buf)")).toEqual({
      status: "original",
      line: 3
    });
  });
});

describe("resolveTagLine", () => {
  it("prefers original-matched line", () => {
    const text = ["a", "needle()", "b"].join("\n");
    expect(resolveTagLine(text, 1, "needle()", "needle()")).toBe(2);
  });

  it("uses current when original fails", () => {
    const text = ["a", "renamed()", "b"].join("\n");
    expect(resolveTagLine(text, 1, "oldname()", "renamed()")).toBe(2);
  });

  it("falls back to pattern when both anchors miss", () => {
    const text = ["a", "  target;", "b"].join("\n");
    // 故意 original/current 都对不上, 只有 pattern 命中
    const pattern = "^[^\\S\\n]*target;";
    expect(resolveTagLine(text, 1, "zzz", "yyy", pattern)).toBe(2);
  });

  it("returns stored line when everything misses", () => {
    const text = ["a", "b", "c"].join("\n");
    expect(resolveTagLine(text, 2, "zzz", "yyy")).toBe(2);
  });

  it("keeps the marker on the in-place-edited line, not on an identical twin", () => {
    const text = [
      "* @param usart_num :串口号 111111111",
      "void a()",
      "  body",
      "* @param usart_num :串口号"
    ].join("\n");
    const original = "* @param usart_num :串口号";
    const current = "* @param usart_num :串口号 111111111";
    expect(resolveTagLine(text, 1, original, current)).toBe(1);
  });
});

describe("backfillOriginal", () => {
  function store(tag: any): LodestarStore {
    return { version: 1, tree: [{ type: "folder", id: "f", title: "x", children: [tag] }] } as any;
  }

  it("fills original from text when missing", () => {
    const s = store({ type: "tag", id: "t", note: "", file: "a", line: 1, text: "foo()" });
    backfillOriginal(s);
    expect((s.tree[0] as any).children[0].original).toBe("foo()");
  });

  it("fills original from pattern when no text", () => {
    const s = store({ type: "tag", id: "t", note: "", file: "a", line: 1, pattern: "^[^\\S\\n]*bar;" });
    backfillOriginal(s);
    expect((s.tree[0] as any).children[0].original).toBe("bar;");
  });

  it("leaves an existing original untouched (idempotent)", () => {
    const s = store({ type: "tag", id: "t", note: "", file: "a", line: 1, text: "new", original: "frozen" });
    backfillOriginal(s);
    backfillOriginal(s);
    expect((s.tree[0] as any).children[0].original).toBe("frozen");
  });
});
