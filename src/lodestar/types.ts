// Lodestar on-disk model. No `vscode` import — keep this pure/testable.

export interface TagNode {
  type: "tag";
  id: string;
  note: string;        // annotation text (markdown allowed); label uses first line
  file: string;        // workspace-relative path
  line: number;        // 1-based
  pattern?: string;    // line-content regex for drift recovery (URL/legacy)
  text?: string;       // raw trimmed line text — anchor for fuzzy recovery
  ref?: string | null; // reserved: pin to a commit/branch later
  createdAt: string;   // ISO timestamp
  notePosition?: "above" | "end"; // per-tag note placement; unset => "above"
}

export interface FolderNode {
  type: "folder";
  id: string;
  title: string;
  inbox?: boolean;         // 该文件夹是「新标签收件箱」;改名/移出根级/删除即毕业
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
