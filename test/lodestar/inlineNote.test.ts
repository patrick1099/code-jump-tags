import { describe, it, expect } from "vitest";
import {
  fullMarkers,
  findMarker,
  parseInlineNote,
  stripInlineNote,
  stripInlineNotesFromText,
  toInlineText
} from "../../src/lodestar/inlineNote";
import { matchAnchor } from "../../src/lodestar/relocate";

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

describe("stripInlineNotesFromText（锚匹配前的归一化）", () => {
  it("逐行剥，行数与换行风格不变", () => {
    const raw = "a();\r\n  b();  //me: 私记\r\nc();";
    expect(stripInlineNotesFromText(raw, M)).toBe("a();\r\n  b();\r\nc();");
    expect(stripInlineNotesFromText(raw, M).split(/\r?\n/).length).toBe(3);
  });
  it("空行/纯空白行原样保留（不塌行）", () => {
    expect(stripInlineNotesFromText("a();\n\n   \nb();", M)).toBe("a();\n\n   \nb();");
  });
  it("无 markers 时原样返回", () => {
    expect(stripInlineNotesFromText("x //me: y", [])).toBe("x //me: y");
  });
});

// ③ 的回归闸：展开态的行必须不再把该行上的标签判成失配。
describe("展开态 + 失配（回归）", () => {
  const clean = "int x = f();";
  const expanded = `${clean}  //me: 这里会溢出`;
  const file = (line2: string) => `void g() {\n  ${line2}\n}\n`;

  it("原文喂给 matchAnchor：正式标签被误判失配（记录病灶）", () => {
    const m = matchAnchor(file(expanded), 2, clean, clean);
    expect(m.status).not.toBe("original");
  });

  it("归一化后喂给 matchAnchor：判定健康", () => {
    const canonical = stripInlineNotesFromText(file(expanded), M);
    const m = matchAnchor(canonical, 2, clean, clean);
    expect(m.status).toBe("original");
  });

  it("同一行并存的随手私记本身也判定健康", () => {
    const canonical = stripInlineNotesFromText(file(expanded), M);
    // 随手标签的 original 同样是剥净的代码（collapseLine 的约定）
    const m = matchAnchor(canonical, 2, clean, undefined);
    expect(m.status).toBe("original");
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
