import { describe, it, expect } from "vitest";
import { createEmptyStore } from "../../src/lodestar/tree";
import { getOrCreateInbox, INBOX_TITLE } from "../../src/lodestar/tree";
import { migrateLooseTags } from "../../src/lodestar/tree";
import { FolderNode, TagNode } from "../../src/lodestar/types";

let seq = 0;
const idGen = () => `f${++seq}`;

function folder(id: string, inbox = false): FolderNode {
  return { type: "folder", id, title: "F" + id, inbox: inbox || undefined, children: [] };
}

describe("getOrCreateInbox", () => {
  it("creates an inbox folder at the top of the root when none exists", () => {
    seq = 0;
    const s = createEmptyStore();
    s.tree.push(folder("a"));
    const inbox = getOrCreateInbox(s, idGen);
    expect(inbox.inbox).toBe(true);
    expect(inbox.title).toBe(INBOX_TITLE);
    expect(s.tree[0]).toBe(inbox);          // placed at index 0
    expect(s.tree).toHaveLength(2);
  });

  it("reuses the existing inbox and never creates a second one", () => {
    seq = 0;
    const s = createEmptyStore();
    s.tree.push(folder("a", true));
    const first = getOrCreateInbox(s, idGen);
    const second = getOrCreateInbox(s, idGen);
    expect(first).toBe(second);
    expect(s.tree.filter(n => n.type === "folder" && (n as FolderNode).inbox)).toHaveLength(1);
  });
});

function tag(id: string): TagNode {
  return { type: "tag", id, note: "n" + id, file: "a.c", line: 1, createdAt: "t" };
}

describe("migrateLooseTags", () => {
  it("moves root-level loose tags into a new top inbox, preserving order", () => {
    seq = 0;
    const s = createEmptyStore();
    s.tree.push(tag("t1"), folder("a"), tag("t2"));
    const changed = migrateLooseTags(s, idGen);
    expect(changed).toBe(true);
    expect(s.tree[0].type).toBe("folder");
    const inbox = s.tree[0] as FolderNode;
    expect(inbox.inbox).toBe(true);
    expect(inbox.children.map(c => c.id)).toEqual(["t1", "t2"]);
    // only the folder "a" remains beside the inbox at root
    expect(s.tree.filter(n => n.type === "tag")).toHaveLength(0);
    expect(s.tree.map(n => n.id)).toEqual([inbox.id, "a"]);
  });

  it("does nothing and returns false when there are no loose tags", () => {
    seq = 0;
    const s = createEmptyStore();
    s.tree.push(folder("a"));
    expect(migrateLooseTags(s, idGen)).toBe(false);
    expect(s.tree.map(n => n.id)).toEqual(["a"]);
  });

  it("is idempotent (second run is a no-op)", () => {
    seq = 0;
    const s = createEmptyStore();
    s.tree.push(tag("t1"));
    expect(migrateLooseTags(s, idGen)).toBe(true);
    expect(migrateLooseTags(s, idGen)).toBe(false);
    const inbox = s.tree[0] as FolderNode;
    expect(inbox.children.map(c => c.id)).toEqual(["t1"]);
  });
});

import { moveNode, renameFolderNode } from "../../src/lodestar/tree";

describe("inbox graduation", () => {
  it("moveNode clears the inbox flag when moved under another folder", () => {
    seq = 0;
    const s = createEmptyStore();
    const inbox = getOrCreateInbox(s, idGen); // at root, inbox:true
    s.tree.push(folder("host"));
    moveNode(s, inbox.id, "host", 0);
    expect(inbox.inbox).toBeFalsy();          // graduated
  });

  it("moveNode keeps the inbox flag when reordered within the root", () => {
    seq = 0;
    const s = createEmptyStore();
    const inbox = getOrCreateInbox(s, idGen);
    s.tree.push(folder("a"));
    moveNode(s, inbox.id, null, 1);           // still at root
    expect(inbox.inbox).toBe(true);
  });

  it("renameFolderNode renames and graduates the inbox", () => {
    seq = 0;
    const s = createEmptyStore();
    const inbox = getOrCreateInbox(s, idGen);
    expect(renameFolderNode(s, inbox.id, "链路A")).toBe(true);
    expect(inbox.title).toBe("链路A");
    expect(inbox.inbox).toBeFalsy();
  });

  it("renameFolderNode returns false for a missing id", () => {
    seq = 0;
    const s = createEmptyStore();
    expect(renameFolderNode(s, "nope", "x")).toBe(false);
  });
});
