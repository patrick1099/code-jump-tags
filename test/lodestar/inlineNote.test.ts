import { describe, it, expect } from "vitest";
import {
  fullMarkers,
  findMarker,
  parseInlineNote,
  stripInlineNote,
  toInlineText
} from "../../src/lodestar/inlineNote";

const M = ["//me:", "//?"]; // 完整 markers（已拼好行注释符）

describe("fullMarkers", () => {
  it("拼行注释符，跳过空 token，去重", () => {
    expect(fullMarkers("//", ["me:", "?"])).toEqual(["//me:", "//?"]);
    expect(fullMarkers("#", ["me:", "", "me:"])).toEqual(["#me:"]);
  });
});

describe("findMarker", () => {
  it("取最靠右的一处", () => {
    const hit = findMarker("a(); // real //me: 私记", M);
    expect(hit).toEqual({ start: "a(); // real ".length, marker: "//me:" });
  });
  it("无 marker 返回 null", () => {
    expect(findMarker("int x = 1;", M)).toBeNull();
  });
  it("并列同起点取更长 marker", () => {
    // 人为构造：两个 marker 同一起点
    const hit = findMarker("x //ab", ["//a", "//ab"]);
    expect(hit).toEqual({ start: 2, marker: "//ab" });
  });
});

describe("parseInlineNote", () => {
  it("行尾 marker：拆出保留缩进的 code 与 trim 的 note", () => {
    expect(parseInlineNote("    int x = f();  //me: 会溢出", M)).toEqual({
      code: "    int x = f();",
      note: "会溢出",
      marker: "//me:"
    });
  });
  it("行内已有真注释：只认最后一段 marker，真注释留在 code 里", () => {
    expect(parseInlineNote("a(); // real //? 私记", M)).toEqual({
      code: "a(); // real",
      note: "私记",
      marker: "//?"
    });
  });
  it("空 note", () => {
    expect(parseInlineNote("x = 1; //me:", M)).toEqual({
      code: "x = 1;",
      note: "",
      marker: "//me:"
    });
  });
  it("无 marker 返回 null", () => {
    expect(parseInlineNote("plain code", M)).toBeNull();
  });
});

describe("stripInlineNote", () => {
  it("剥掉 marker 段，保留缩进；无 marker 原样", () => {
    expect(stripInlineNote("    int x = f();  //me: 会溢出", M)).toBe("    int x = f();");
    expect(stripInlineNote("    int x = f();", M)).toBe("    int x = f();");
  });
});

describe("toInlineText + 往返幂等", () => {
  it("展开格式", () => {
    expect(toInlineText("int x = f();", "会溢出", "//me:")).toBe("int x = f();  //me: 会溢出");
  });
  it("parse(toInlineText(...)) 还原 code/note/marker（对每个 m）", () => {
    for (const m of M) {
      const code = "  foo(bar);";
      const note = "私记内容";
      const round = parseInlineNote(toInlineText(code, note, m), M);
      expect(round).toEqual({ code, note, marker: m });
      expect(stripInlineNote(toInlineText(code, note, m), M)).toBe(code);
    }
  });
});
