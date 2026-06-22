import { describe, it, expect } from "vitest";
import { createEmptyStore, addTag, createFolder } from "../../src/lodestar/tree";
import { pruneCovered, collectTagsUnder } from "../../src/lodestar/selection";
import { TagNode } from "../../src/lodestar/types";

function tag(id: string): TagNode {
  return { type: "tag", id, note: "n" + id, file: "a.c", line: 1, createdAt: "t" };
}

describe("pruneCovered", () => {
  it("drops a child whose ancestor folder is also selected", () => {
    const s = createEmptyStore();
    createFolder(s, "F", () => "f1");
    addTag(s, tag("t1"), "f1");
    expect(pruneCovered(s, ["f1", "t1"])).toEqual(["f1"]);
  });

  it("keeps unrelated nodes", () => {
    const s = createEmptyStore();
    addTag(s, tag("t1"));
    addTag(s, tag("t2"));
    expect(pruneCovered(s, ["t1", "t2"]).sort()).toEqual(["t1", "t2"]);
  });
});

describe("collectTagsUnder", () => {
  it("expands folders to their nested tags in tree order", () => {
    const s = createEmptyStore();
    createFolder(s, "F", () => "f1");
    addTag(s, tag("a"), "f1");
    addTag(s, tag("b"), "f1");
    addTag(s, tag("c")); // root-level
    const tags = collectTagsUnder(s, ["f1", "c"]);
    expect(tags.map(t => t.id)).toEqual(["a", "b", "c"]);
  });

  it("dedups a tag selected both directly and via its folder", () => {
    const s = createEmptyStore();
    createFolder(s, "F", () => "f1");
    addTag(s, tag("a"), "f1");
    const tags = collectTagsUnder(s, ["f1", "a"]);
    expect(tags.map(t => t.id)).toEqual(["a"]);
  });
});
