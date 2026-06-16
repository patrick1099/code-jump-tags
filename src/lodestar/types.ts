// Lodestar on-disk model. No `vscode` import — keep this pure/testable.

export interface TagNode {
  type: "tag";
  id: string;
  note: string;        // annotation text (markdown allowed); label uses first line
  file: string;        // workspace-relative path
  line: number;        // 1-based
  pattern?: string;    // line-content regex for drift recovery
  ref?: string | null; // reserved: pin to a commit/branch later
  createdAt: string;   // ISO timestamp
}

export interface FolderNode {
  type: "folder";
  id: string;
  title: string;
  ref?: string | null;     // reserved
  children: TreeNode[];    // v1 UI: only TagNode; recursive type reserves nesting
}

export type TreeNode = FolderNode | TagNode;

// A removed tag/folder kept in the recycle bin so it can be restored.
export interface TrashedEntry {
  node: TreeNode;     // the removed subtree (tag, or folder + its children)
  deletedAt: string;  // ISO timestamp
}

export interface LodestarStore {
  version: 1;
  tree: TreeNode[];
  trash?: TrashedEntry[];
}
