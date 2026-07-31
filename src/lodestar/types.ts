// Lodestar on-disk model. No `vscode` import — keep this pure/testable.

export interface TagNode {
  type: "tag";
  id: string;
  note: string;        // annotation text (markdown allowed); label uses first line
  file: string;        // workspace-relative path
  line: number;        // 1-based
  pattern?: string;    // line-content regex for drift recovery (URL/legacy)
  text?: string;       // raw trimmed line text — current anchor (live, may be poisoned)
  original?: string;   // identity anchor: trimmed line text at创建/人显式重设. 机器只读, 匹配裁判
  ref?: string | null; // reserved: pin to a commit/branch later
  createdAt: string;   // ISO timestamp
  notePosition?: "above" | "end"; // per-tag note placement; unset => "above"
  inline?: boolean;      // true = 一条 inline note：默认不进主树，光标进入展开成文本
  inlineMarker?: string; // 该 inline note 折叠时命中的完整 marker（如 "//me:"），仅回展用

  // 「这一行的现内容(text)是我们在编辑器里亲眼看着它变成这样的」。
  //
  // 设计本就分两套机制：编辑器内亲眼看见 = 确定，按 current 精确追踪；编辑器外没看见
  // = 不确定，才走模糊二重匹配。但可疑判定原先不分这两者，任何 recheck 触发点都拿
  // `original` 去比，于是用户亲手改过的行必然被判软可疑 —— 与「失配只该在文件被别的
  // 编辑器 / git 改过时出现」的预期相悖。
  //
  // 注意它**不是** original 的替身：`original` 依然只由建标签和用户显式 retargetTag
  // 写入（机器路径绝不自动写 original 这条铁律不变），冷恢复照旧靠它把行找回来。
  // 这个标志只回答「现内容可不可信」。外部改动（文件监听器报告的、非本编辑器保存
  // 引起的变更）会把它清掉，因为那一刻我们就"没看见"了。
  witnessed?: boolean;
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
