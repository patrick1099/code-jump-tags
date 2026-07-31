import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyFileTags,
  setFileSuspects,
  getSuspect,
  allSuspects,
  clearSuspects,
  removeSuspects,
  FileTag
} from "../../src/lodestar/suspect";

describe("classifyFileTags", () => {
  const text = ["int foo(a)", "int renamed(b)", "third"].join("\n");

  it("skips tags whose original still matches (not suspect)", () => {
    const tags: FileTag[] = [
      { id: "t1", file: "a.ts", line: 1, original: "int foo(a)", current: "int foo(a)" }
    ];
    expect(classifyFileTags(tags, text)).toEqual([]);
  });

  it("reports a soft suspect (current matches, original gone)", () => {
    const tags: FileTag[] = [
      { id: "t2", file: "a.ts", line: 1, original: "int original(b)", current: "int renamed(b)" }
    ];
    expect(classifyFileTags(tags, text)).toEqual([
      { id: "t2", file: "a.ts", status: "current", line: 2, original: "int original(b)", current: "int renamed(b)" }
    ]);
  });

  // 失配只该出现在「没看见的改动」上：文件被别的编辑器改、git 拉取、VS Code 没开着
  // 时被动过。用户在编辑器里自己改的行，扩展是亲眼看着它变的，不算失配。
  it("亲眼看见的改动不算失配（witnessed 的软可疑直接放行）", () => {
    const tags: FileTag[] = [
      {
        id: "t2",
        file: "a.ts",
        line: 1,
        original: "int original(b)",
        current: "int renamed(b)",
        witnessed: true
      }
    ];
    expect(classifyFileTags(tags, text)).toEqual([]);
  });

  it("witnessed 不豁免硬可疑：连现内容都对不上说明确实在看不见处变了", () => {
    const tags: FileTag[] = [
      {
        id: "t3",
        file: "a.ts",
        line: 3,
        original: "gone-aaa",
        current: "gone-bbb",
        witnessed: true
      }
    ];
    expect(classifyFileTags(tags, text).map(i => i.status)).toEqual(["lost"]);
  });

  it("reports a hard suspect (neither matches) at the fallback line", () => {
    const tags: FileTag[] = [
      { id: "t3", file: "a.ts", line: 3, original: "gone-aaa", current: "gone-bbb" }
    ];
    expect(classifyFileTags(tags, text)).toEqual([
      { id: "t3", file: "a.ts", status: "lost", line: 3, original: "gone-aaa", current: "gone-bbb" }
    ]);
  });
});

describe("suspect registry", () => {
  beforeEach(() => clearSuspects());

  it("stores and reads by id", () => {
    setFileSuspects("a.ts", [{ id: "t1", file: "a.ts", status: "lost", line: 5 }]);
    expect(getSuspect("t1")?.status).toBe("lost");
    expect(allSuspects()).toHaveLength(1);
  });

  it("clears stale entries for a file on re-set", () => {
    setFileSuspects("a.ts", [{ id: "t1", file: "a.ts", status: "lost", line: 5 }]);
    setFileSuspects("a.ts", []); // t1 healed
    expect(getSuspect("t1")).toBeUndefined();
    expect(allSuspects()).toHaveLength(0);
  });

  it("re-set of one file does not touch other files' entries", () => {
    setFileSuspects("a.ts", [{ id: "ta", file: "a.ts", status: "lost", line: 1 }]);
    setFileSuspects("b.ts", [{ id: "tb", file: "b.ts", status: "current", line: 2 }]);
    setFileSuspects("a.ts", []);
    expect(getSuspect("tb")?.status).toBe("current");
  });

  it("returns changed=false when nothing changed", () => {
    const info = { id: "t1", file: "a.ts", status: "lost" as const, line: 5 };
    setFileSuspects("a.ts", [info]);
    expect(setFileSuspects("a.ts", [{ ...info }])).toBe(false);
  });
});

describe("removeSuspects", () => {
  beforeEach(() => clearSuspects());

  it("removes the given ids and reports changed", () => {
    setFileSuspects("a.ts", [
      { id: "t1", file: "a.ts", status: "current", line: 2 },
      { id: "t2", file: "a.ts", status: "lost", line: 5 }
    ]);
    expect(removeSuspects(["t1"])).toBe(true);
    expect(getSuspect("t1")).toBeUndefined();
    expect(getSuspect("t2")).toBeDefined();
  });

  it("returns false when none of the ids were present", () => {
    setFileSuspects("a.ts", [{ id: "t1", file: "a.ts", status: "current", line: 2 }]);
    expect(removeSuspects(["nope"])).toBe(false);
    expect(getSuspect("t1")).toBeDefined();
  });

  it("removing the last suspect empties the registry", () => {
    setFileSuspects("a.ts", [{ id: "t1", file: "a.ts", status: "current", line: 2 }]);
    expect(removeSuspects(["t1"])).toBe(true);
    expect(allSuspects()).toEqual([]);
  });
});
