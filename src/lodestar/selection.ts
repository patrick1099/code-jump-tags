import { findNode } from "./tree";
import { LodestarStore, TagNode, TreeNode } from "./types";

// Remove ids whose ancestor is also in the selection — deleting/operating on a
// folder already covers its descendants, so a mixed multi-select doesn't
// double-handle nested nodes.
export function pruneCovered(store: LodestarStore, ids: string[]): string[] {
  const set = new Set(ids);
  return ids.filter(id => {
    let cur = findNode(store, id);
    while (cur && cur.parent) {
      if (set.has(cur.parent.id)) return false;
      cur = findNode(store, cur.parent.id);
    }
    return true;
  });
}

// Expand a selection (tags + folders) into the flat list of tag nodes under it,
// in tree order, deduped. Folders contribute all of their nested tags.
export function collectTagsUnder(
  store: LodestarStore,
  ids: string[]
): TagNode[] {
  const out: TagNode[] = [];
  const seen = new Set<string>();
  function walk(node: TreeNode): void {
    if (node.type === "tag") {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        out.push(node);
      }
    } else {
      for (const child of node.children) walk(child);
    }
  }
  for (const id of ids) {
    const found = findNode(store, id);
    if (found) walk(found.node);
  }
  return out;
}
