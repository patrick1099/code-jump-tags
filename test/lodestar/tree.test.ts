import { describe, it, expect } from "vitest";
import { createEmptyStore, serialize, parse } from "../../src/lodestar/tree";

describe("serialize/parse", () => {
  it("round-trips an empty store", () => {
    const store = createEmptyStore();
    expect(parse(serialize(store))).toEqual(store);
  });

  it("createEmptyStore has version 1 and empty tree", () => {
    expect(createEmptyStore()).toEqual({ version: 1, tree: [] });
  });
});

import {
  addTag, createFolder, removeNode, findNode
} from "../../src/lodestar/tree";
import { TagNode } from "../../src/lodestar/types";

function tag(id: string): TagNode {
  return { type: "tag", id, note: "n" + id, file: "a.c", line: 1, createdAt: "t" };
}

describe("mutations", () => {
  it("addTag at root", () => {
    const s = createEmptyStore();
    addTag(s, tag("1"));
    expect(s.tree).toHaveLength(1);
    expect(s.tree[0].id).toBe("1");
  });

  it("createFolder then addTag into it", () => {
    const s = createEmptyStore();
    const f = createFolder(s, "通信", () => "f1");
    addTag(s, tag("1"), f.id);
    expect((findNode(s, "f1")!.node as any).children).toHaveLength(1);
    expect(findNode(s, "1")!.parent!.id).toBe("f1");
  });

  it("createFolder nests a sub-folder under a parent folder", () => {
    const s = createEmptyStore();
    createFolder(s, "外层", () => "f1");
    const sub = createFolder(s, "内层", () => "f2", "f1");
    // sub-folder lives inside f1, not at the root
    expect(s.tree).toHaveLength(1);
    expect((findNode(s, "f1")!.node as any).children).toHaveLength(1);
    expect(findNode(s, "f2")!.parent!.id).toBe("f1");
    addTag(s, tag("1"), sub.id);
    expect(findNode(s, "1")!.parent!.id).toBe("f2");
  });

  it("createFolder with an unknown parentId falls back to root", () => {
    const s = createEmptyStore();
    createFolder(s, "孤儿", () => "f9", "nope");
    expect(s.tree.map(n => n.id)).toEqual(["f9"]);
  });

  it("removeNode removes a tag", () => {
    const s = createEmptyStore();
    addTag(s, tag("1"));
    removeNode(s, "1");
    expect(s.tree).toHaveLength(0);
  });
});

import { moveNode } from "../../src/lodestar/tree";

describe("moveNode", () => {
  it("reorders within root", () => {
    const s = createEmptyStore();
    addTag(s, tag("1")); addTag(s, tag("2")); addTag(s, tag("3"));
    moveNode(s, "3", null, 0);          // move tag 3 to front of root
    expect(s.tree.map(n => n.id)).toEqual(["3", "1", "2"]);
  });

  it("moves a tag into a folder at index", () => {
    const s = createEmptyStore();
    const f = createFolder(s, "F", () => "f1");
    addTag(s, tag("1"));                 // loose at root
    moveNode(s, "1", "f1", 0);
    expect(s.tree.map(n => n.id)).toEqual(["f1"]);
    expect((f.children as any).map((n: any) => n.id)).toEqual(["1"]);
  });
});

import {
  pushTrash, removeToTrash, restoreEntries, restoreSelection, findTagByLocation
} from "../../src/lodestar/tree";

describe("recycle bin", () => {
  it("removeToTrash removes from tree and adds to trash", () => {
    const s = createEmptyStore();
    addTag(s, tag("1"));
    const removed = removeToTrash(s, "1");
    expect(removed!.id).toBe("1");
    expect(s.tree).toHaveLength(0);
    expect(s.trash!).toHaveLength(1);
    expect(s.trash![0].node.id).toBe("1");
  });

  it("trash is most-recent-first and capped at 50", () => {
    const s = createEmptyStore();
    for (let i = 0; i < 55; i++) pushTrash(s, tag(String(i)));
    expect(s.trash!).toHaveLength(50);
    expect(s.trash![0].node.id).toBe("54"); // newest first
  });

  it("restoreEntries puts nodes back at root and clears them from trash", () => {
    const s = createEmptyStore();
    addTag(s, tag("1")); addTag(s, tag("2"));
    removeToTrash(s, "1");
    removeToTrash(s, "2");
    expect(s.tree).toHaveLength(0); // both deleted
    const toRestore = [s.trash![1]]; // the older one ("1")
    restoreEntries(s, toRestore);
    expect(s.tree.map(n => n.id)).toEqual(["1"]);
    expect(s.trash!).toHaveLength(1);
    expect(s.trash![0].node.id).toBe("2"); // "2" still in the bin
  });

  it("restoreSelection pulls individual tags out of a trashed folder", () => {
    const s = createEmptyStore();
    const f = createFolder(s, "F", () => "f1");
    addTag(s, tag("a"), "f1");
    addTag(s, tag("b"), "f1");
    addTag(s, tag("c"), "f1");
    removeToTrash(s, "f1"); // whole folder to bin
    const folderEntry = s.trash![0];
    const childB = (folderEntry.node as any).children.find((n: any) => n.id === "b");
    restoreSelection(s, [], [{ parent: folderEntry, child: childB }]);
    // only "b" came back to root; folder stays in bin with a + c
    expect(s.tree.map(n => n.id)).toEqual(["b"]);
    expect((s.trash![0].node as any).children.map((n: any) => n.id)).toEqual(["a", "c"]);
  });

  it("restoreSelection drops a trashed folder once all its tags are pulled out", () => {
    const s = createEmptyStore();
    const f = createFolder(s, "F", () => "f1");
    addTag(s, tag("a"), "f1");
    removeToTrash(s, "f1");
    const folderEntry = s.trash![0];
    const childA = (folderEntry.node as any).children[0];
    restoreSelection(s, [], [{ parent: folderEntry, child: childA }]);
    expect(s.tree.map(n => n.id)).toEqual(["a"]);
    expect(s.trash!).toHaveLength(0); // emptied folder removed from bin
  });

  it("restoreSelection pulls a NESTED sub-folder (with its tags) out of a trashed folder", () => {
    const s = createEmptyStore();
    // outer f1 → inner f2 → tag t2, plus a direct tag t1 in f1
    createFolder(s, "外层", () => "f1");
    createFolder(s, "内层", () => "f2", "f1");
    addTag(s, tag("t1"), "f1");
    addTag(s, tag("t2"), "f2");
    removeToTrash(s, "f1"); // delete the whole outer folder
    const folderEntry = s.trash![0];
    const innerSub = (folderEntry.node as any).children.find(
      (n: any) => n.id === "f2"
    );
    // restore ONLY the nested sub-folder
    restoreSelection(s, [], [{ parent: folderEntry, child: innerSub }]);
    // f2 (with t2) is back at root; f1 (with t1) stays in the bin
    expect(s.tree.map(n => n.id)).toEqual(["f2"]);
    expect((findNode(s, "f2")!.node as any).children.map((n: any) => n.id)).toEqual(["t2"]);
    expect(s.trash!).toHaveLength(1);
    expect((s.trash![0].node as any).children.map((n: any) => n.id)).toEqual(["t1"]);
  });
});

describe("findTagByLocation", () => {
  it("matches a tag by file + line, including inside folders", () => {
    const s = createEmptyStore();
    const f = createFolder(s, "F", () => "f1");
    addTag(s, { ...tag("1"), file: "x.c", line: 10 }, "f1");
    expect(findTagByLocation(s, "x.c", 10)!.id).toBe("1");
    expect(findTagByLocation(s, "x.c", 11)).toBeUndefined();
  });
});

describe("reorder via moveNode (up/down semantics)", () => {
  it("moves a middle node up", () => {
    const s = createEmptyStore();
    addTag(s, tag("1")); addTag(s, tag("2")); addTag(s, tag("3"));
    // move "2" up (index 1 -> 0)
    const f = findNode(s, "2")!;
    moveNode(s, "2", f.parent ? f.parent.id : null, f.index - 1);
    expect(s.tree.map(n => n.id)).toEqual(["2", "1", "3"]);
  });
  it("moves a middle node down", () => {
    const s = createEmptyStore();
    addTag(s, tag("1")); addTag(s, tag("2")); addTag(s, tag("3"));
    // move "2" down (index 1 -> 2)
    const f = findNode(s, "2")!;
    moveNode(s, "2", f.parent ? f.parent.id : null, f.index + 1);
    expect(s.tree.map(n => n.id)).toEqual(["1", "3", "2"]);
  });
});

import { shiftedLine, LineEdit } from "../../src/lodestar/tree";

describe("shiftedLine (live line tracking)", () => {
  // insert N blank lines at 0-based (line, col)
  function insertAt(line: number, col: number, n: number): LineEdit {
    return { start: line, end: line, endChar: col, delta: n };
  }
  // delete the 0-based whole-line range [from, to)
  function del(from: number, to: number): LineEdit {
    return { start: from, end: to, endChar: 0, delta: -(to - from) };
  }

  it("shifts a tag DOWN when lines are inserted above it", () => {
    // tag at 0-based 3936 (line 3937), insert 3 lines high above -> 3939
    expect(shiftedLine(3936, [insertAt(10, 0, 3)])).toBe(3939);
  });

  it("shifts a tag UP when lines are deleted above it", () => {
    expect(shiftedLine(3936, [del(10, 12)])).toBe(3934);
  });

  it("MOVES a tag when a newline is inserted at the START of its own line", () => {
    // cursor at (5,0), press Enter: the tagged code is pushed down to line 6
    expect(shiftedLine(5, [insertAt(5, 0, 1)])).toBe(6);
  });

  it("does NOT move a tag when the edit ends mid-line / at line end", () => {
    // newline at end of the tag's line: tagged code stays on line 5
    expect(shiftedLine(5, [insertAt(5, 12, 1)])).toBe(5);
  });

  it("does NOT move a tag when the edit is entirely below it", () => {
    expect(shiftedLine(5, [insertAt(8, 0, 4)])).toBe(5);
  });

  it("accumulates multiple edits above the tag", () => {
    expect(
      shiftedLine(20, [insertAt(2, 0, 1), del(5, 7), insertAt(9, 3, 5)])
    ).toBe(24);
  });

  it("ignores zero-delta (same-line text) edits", () => {
    expect(shiftedLine(5, [{ start: 1, end: 1, endChar: 0, delta: 0 }])).toBe(5);
  });
});

import { isSelfOrDescendant } from "../../src/lodestar/tree";

describe("isSelfOrDescendant (folder-drag guard)", () => {
  // root → f1 → f2 → (tag "1")
  function nested() {
    const s = createEmptyStore();
    createFolder(s, "f1", () => "f1");
    createFolder(s, "f2", () => "f2", "f1");
    addTag(s, tag("1"), "f2");
    return s;
  }

  it("a folder is its own self/descendant", () => {
    expect(isSelfOrDescendant(nested(), "f1", "f1")).toBe(true);
  });
  it("a nested folder is a descendant of its ancestor", () => {
    expect(isSelfOrDescendant(nested(), "f1", "f2")).toBe(true);
  });
  it("a deep tag is a descendant of the outer folder", () => {
    expect(isSelfOrDescendant(nested(), "f1", "1")).toBe(true);
  });
  it("an ancestor is NOT a descendant of its own child", () => {
    expect(isSelfOrDescendant(nested(), "f2", "f1")).toBe(false);
  });
});
