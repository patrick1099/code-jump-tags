import { describe, it, expect } from "vitest";
import { createEmptyStore } from "../../src/lodestar/tree";
import { getOrCreateInbox, INBOX_TITLE } from "../../src/lodestar/tree";
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
