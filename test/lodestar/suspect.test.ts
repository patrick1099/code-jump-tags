import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyFileTags,
  setFileSuspects,
  getSuspect,
  allSuspects,
  clearSuspects,
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
