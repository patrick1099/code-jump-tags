import {
  FolderNode,
  LodestarStore,
  TagNode,
  TreeNode,
  TrashedEntry
} from "./types";

const TRASH_LIMIT = 50;

export const INBOX_TITLE = "未分组";

export function newFolderId(): string {
  return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// The single new-tag inbox: the root-level folder flagged `inbox`. Returns it,
// or lazily creates one at the TOP of the root (matching where the old
// synthetic "(未分组)" group used to sit). At most one inbox ever exists.
export function getOrCreateInbox(
  store: LodestarStore,
  idGen: () => string
): FolderNode {
  // Self-heal the at-most-one-inbox invariant: a deleted inbox can be restored
  // from the recycle bin after a fresh one was lazily created, leaving two
  // flagged inboxes at root. Keep the first, graduate the rest.
  const inboxes = store.tree.filter(
    (n): n is FolderNode => n.type === "folder" && n.inbox === true
  );
  if (inboxes.length > 0) {
    for (let i = 1; i < inboxes.length; i++) delete inboxes[i].inbox;
    return inboxes[0];
  }
  const inbox: FolderNode = {
    type: "folder",
    id: idGen(),
    title: INBOX_TITLE,
    inbox: true,
    children: []
  };
  store.tree.unshift(inbox);
  return inbox;
}

// One-time, idempotent: wrap any root-level loose tags (from before the inbox
// model) into the inbox folder, preserving their order. Returns true if it moved
// anything. Safe to call on every load.
export function migrateLooseTags(
  store: LodestarStore,
  idGen: () => string
): boolean {
  const looseTags = store.tree.filter(
    (n): n is TagNode => n.type === "tag"
  );
  if (looseTags.length === 0) return false;
  store.tree = store.tree.filter(n => n.type !== "tag");
  const inbox = getOrCreateInbox(store, idGen);
  inbox.children.push(...looseTags);
  return true;
}

export function createEmptyStore(): LodestarStore {
  return { version: 1, tree: [] };
}

export function serialize(store: LodestarStore): string {
  return JSON.stringify(store, null, 2);
}

export function parse(json: string): LodestarStore {
  const data = JSON.parse(json);
  if (data.version !== 1 || !Array.isArray(data.tree)) {
    return createEmptyStore();
  }
  return data as LodestarStore;
}

// ── tree mutation helpers ────────────────────────────────────────────────────

export interface FoundNode {
  node: TreeNode;
  parent: FolderNode | null; // null == root
  siblings: TreeNode[];
  index: number;
}

export function findNode(store: LodestarStore, id: string): FoundNode | undefined {
  function search(siblings: TreeNode[], parent: FolderNode | null): FoundNode | undefined {
    for (let i = 0; i < siblings.length; i++) {
      const node = siblings[i];
      if (node.id === id) return { node, parent, siblings, index: i };
      if (node.type === "folder") {
        const hit = search(node.children, node);
        if (hit) return hit;
      }
    }
    return undefined;
  }
  return search(store.tree, null);
}

// Find the first tag anchored at a given file + (stored) line, anywhere in the
// tree. Used to keep one tag per line: adding on an already-tagged line edits
// the existing tag instead of stacking a duplicate.
export function findTagByLocation(
  store: LodestarStore,
  file: string,
  line: number
): TagNode | undefined {
  function search(siblings: TreeNode[]): TagNode | undefined {
    for (const node of siblings) {
      if (node.type === "tag" && node.file === file && node.line === line) {
        return node;
      }
      if (node.type === "folder") {
        const hit = search(node.children);
        if (hit) return hit;
      }
    }
    return undefined;
  }
  return search(store.tree);
}

// Re-anchor an existing tag to (file, line), replacing its content anchor.
// anchorText/anchorPattern are precomputed by the caller from the target line's
// text (same source as addTag: lineAnchorText/linePattern, both trim). A blank
// target line → pass undefined for both (weak anchor, as when tagging a blank
// line). Returns true if a tag with `id` was found and updated; false if the id
// is unknown or names a folder. note/id/createdAt/containing folder are untouched.
// Also writes `original` (this is the human-explicit re-identify channel).
export function retargetTag(
  store: LodestarStore,
  id: string,
  file: string,
  line: number,
  anchorText?: string,
  anchorPattern?: string
): boolean {
  const found = findNode(store, id);
  if (!found || found.node.type !== "tag") {
    return false;
  }
  found.node.file = file;
  found.node.line = line;
  found.node.text = anchorText;
  found.node.original = anchorText; // 人显式动作 = 重设身份, 同时写裁判
  found.node.pattern = anchorPattern;
  return true;
}

// Recover a tag to `line` WITHOUT changing its identity. The user chose「以
// original 为准」: drop the poisoned current, move to the line where original was
// found, refresh current (text/pattern) from that line — but `original` stays.
// Returns false if id is unknown or names a folder.
export function healTagToLine(
  store: LodestarStore,
  id: string,
  line: number,
  text?: string,
  pattern?: string
): boolean {
  const found = findNode(store, id);
  if (!found || found.node.type !== "tag") return false;
  found.node.line = line;
  found.node.text = text;
  found.node.pattern = pattern;
  return true; // original 一概不动
}

function childrenOf(store: LodestarStore, parentId?: string): TreeNode[] {
  if (!parentId) return store.tree;
  const found = findNode(store, parentId);
  if (!found || found.node.type !== "folder") return store.tree;
  return found.node.children;
}

export function addTag(store: LodestarStore, tag: TagNode, parentId?: string): void {
  childrenOf(store, parentId).push(tag);
}

// Create a folder. With no parentId it lands at the root; with a parentId it is
// nested inside that folder (the tree supports arbitrary depth). If the parent
// can't be found / isn't a folder, childrenOf falls back to the root.
export function createFolder(
  store: LodestarStore,
  title: string,
  idGen: () => string,
  parentId?: string
): FolderNode {
  const folder: FolderNode = { type: "folder", id: idGen(), title, children: [] };
  childrenOf(store, parentId).push(folder);
  return folder;
}

// True if `nodeId` is `ancestorId` itself, or lives anywhere inside it. Used to
// reject dragging a folder into its own subtree (which would detach the folder
// and then re-insert it under a now-orphaned descendant, losing nodes).
export function isSelfOrDescendant(
  store: LodestarStore,
  ancestorId: string,
  nodeId: string
): boolean {
  if (ancestorId === nodeId) return true;
  let cur = findNode(store, nodeId);
  while (cur && cur.parent) {
    if (cur.parent.id === ancestorId) return true;
    cur = findNode(store, cur.parent.id);
  }
  return false;
}

export function removeNode(store: LodestarStore, id: string): TreeNode | undefined {
  const found = findNode(store, id);
  if (!found) return undefined;
  return found.siblings.splice(found.index, 1)[0];
}

// Detach a descendant (by id) from anywhere inside `root`'s subtree, returning
// it. Unlike removeNode (which works on the live store), this walks a detached
// subtree — used by trash restore to pull one nested node out of a trashed
// folder that no longer lives in store.tree.
export function removeDescendantById(
  root: TreeNode,
  id: string
): TreeNode | undefined {
  if (root.type !== "folder") return undefined;
  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i];
    if (child.id === id) return root.children.splice(i, 1)[0];
    const hit = removeDescendantById(child, id);
    if (hit) return hit;
  }
  return undefined;
}

// ── recycle bin ──────────────────────────────────────────────────────────────

// Move a node into the recycle bin (most-recent first, capped at TRASH_LIMIT).
export function pushTrash(store: LodestarStore, node: TreeNode): void {
  if (!store.trash) store.trash = [];
  store.trash.unshift({ node, deletedAt: new Date().toISOString() });
  if (store.trash.length > TRASH_LIMIT) {
    store.trash.length = TRASH_LIMIT;
  }
}

// Remove node `id` and drop it into the recycle bin in one step.
export function removeToTrash(
  store: LodestarStore,
  id: string
): TreeNode | undefined {
  const removed = removeNode(store, id);
  if (removed) pushTrash(store, removed);
  return removed;
}

// Restore the given trash entries back to the tree root. Entries are matched by
// reference so restoring several at once doesn't get confused by index shifts.
export function restoreEntries(
  store: LodestarStore,
  entries: TrashedEntry[]
): void {
  if (!store.trash) return;
  for (const entry of entries) {
    const i = store.trash.indexOf(entry);
    if (i >= 0) {
      store.trash.splice(i, 1);
      store.tree.push(entry.node);
    }
  }
}

// A single node (tag OR sub-folder, at any depth) pulled out of a trashed folder
// rather than restoring the whole folder.
export interface ChildSelection {
  parent: TrashedEntry; // the trashed folder entry
  child: TreeNode;      // a node nested anywhere inside it
}

// Restore a mix of whole entries and individual nodes-inside-trashed-folders.
// Whole entries go back to root. A nested node (tag or sub-folder, any depth) is
// pulled out of its trashed folder to root (unless that whole folder was also
// selected, which covers it). Trashed folders left empty afterwards are dropped.
export function restoreSelection(
  store: LodestarStore,
  entries: TrashedEntry[],
  children: ChildSelection[]
): void {
  if (!store.trash) return;

  restoreEntries(store, entries);

  for (const { parent, child } of children) {
    // Parent already restored wholesale (no longer in the bin) -> child came
    // along with it; nothing to do.
    if (!store.trash.includes(parent) || parent.node.type !== "folder") {
      continue;
    }
    const removed = removeDescendantById(parent.node, child.id);
    if (removed) {
      store.tree.push(removed);
    }
  }

  store.trash = store.trash.filter(
    e => !(e.node.type === "folder" && e.node.children.length === 0)
  );
}

// ── live line tracking ───────────────────────────────────────────────────────

// One document edit's effect on line numbers, in 0-based lines/columns. `start`,
// `end`, `endChar` are the edit's range in the PRE-edit document (VS Code reports
// every change in an event relative to the document before any of them applied);
// `delta` is the net lines added minus removed.
export interface LineEdit {
  start: number;
  end: number;
  endChar: number;
  delta: number;
}

// New 0-based position for a marker currently at `line0` after the given edits.
// The marker is anchored to the START (column 0) of its line, so it moves by an
// edit's delta exactly when that edit ENDS at or before the anchor: either the
// edit ends on a higher line, or it ends right at column 0 of the marker's own
// line (e.g. a line-start newline, which pushes the tagged code down a row). An
// edit ending mid-line or at the line's end leaves the marker put. This mirrors
// VS Code's gutter-decoration tracking so the tag's note (a CodeLens, which does
// NOT auto-track) stays glued to the same line as its gutter icon.
export function shiftedLine(line0: number, edits: LineEdit[]): number {
  let result = line0;
  for (const e of edits) {
    if (e.delta === 0) {
      continue;
    }
    if (e.end < line0 || (e.end === line0 && e.endChar === 0)) {
      result += e.delta;
    }
  }
  return result;
}

// Move node `id` to be at `index` inside folder `toParentId` (null == root).
export function moveNode(
  store: LodestarStore,
  id: string,
  toParentId: string | null,
  index: number
): void {
  const node = removeNode(store, id);
  if (!node) return;
  // An inbox folder graduates (loses its inbox role) the moment it leaves the
  // root for another folder. Reordering within the root keeps it the inbox.
  if (node.type === "folder" && node.inbox && toParentId !== null) {
    delete node.inbox;
  }
  const target = toParentId ? childrenOf(store, toParentId) : store.tree;
  const clamped = Math.max(0, Math.min(index, target.length));
  target.splice(clamped, 0, node);
}

// Rename a folder. Renaming an inbox graduates it to a plain folder (its tags
// stay; the next new tag lazily spawns a fresh inbox). Returns false if `id`
// isn't a folder.
export function renameFolderNode(
  store: LodestarStore,
  id: string,
  title: string
): boolean {
  const found = findNode(store, id);
  if (!found || found.node.type !== "folder") return false;
  found.node.title = title;
  if (found.node.inbox) delete found.node.inbox;
  return true;
}
