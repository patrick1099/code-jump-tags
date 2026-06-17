import {
  FolderNode,
  LodestarStore,
  TagNode,
  TreeNode,
  TrashedEntry
} from "./types";

const TRASH_LIMIT = 50;

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

// A single tag pulled out of a trashed folder (rather than the whole folder).
export interface ChildSelection {
  parent: TrashedEntry; // the trashed folder entry
  child: TagNode;       // a tag inside it
}

// Restore a mix of whole entries and individual tags-inside-trashed-folders.
// Whole entries go back to root. A child tag is pulled out of its trashed
// folder to root (unless that whole folder was also selected, which covers it).
// Trashed folders left empty afterwards are dropped from the bin.
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
    const ci = parent.node.children.indexOf(child);
    if (ci >= 0) {
      parent.node.children.splice(ci, 1);
      store.tree.push(child);
    }
  }

  store.trash = store.trash.filter(
    e => !(e.node.type === "folder" && e.node.children.length === 0)
  );
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
  const target = toParentId ? childrenOf(store, toParentId) : store.tree;
  const clamped = Math.max(0, Math.min(index, target.length));
  target.splice(clamped, 0, node);
}
