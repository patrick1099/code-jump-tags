import {
  commands,
  ConfigurationTarget,
  env,
  ExtensionContext,
  Position,
  QuickPickItem,
  Range,
  Selection,
  TextEditorRevealType,
  Uri,
  window,
  workspace
} from "vscode";
import { AMBIENT_TOUR_ID, EXTENSION_NAME } from "../constants";
import { store as runtime } from "../store";
import { endCurrentCodeTour, startCodeTour } from "../store/actions";
import {
  closeTagEditor,
  openTagEditor,
  saveTagEdit,
  cancelTagEdit,
  deleteFromEditor,
  toggleNotePosition
} from "./editThread";
import { getStore, saveStore } from "./persistence";
import { resolveLine, linePattern, lineAnchorText } from "./relocate";
import {
  createFolder,
  findNode,
  findTagByLocation,
  removeToTrash,
  renameFolderNode,
  restoreSelection,
  retargetTag
} from "./tree";
import { TreeNode, TrashedEntry } from "./types";
import { getRelativePath } from "../utils";

// Confirm a delete, honoring the codeJumpTags.confirmDelete setting. The modal
// offers a "删除并不再询问" choice that turns the setting off for next time.
export async function confirmDelete(message: string): Promise<boolean> {
  const cfg = workspace.getConfiguration(EXTENSION_NAME);
  if (!cfg.get<boolean>("confirmDelete", true)) {
    return true;
  }
  const choice = await window.showWarningMessage(
    message,
    { modal: true },
    "删除",
    "删除并不再询问"
  );
  if (choice === "删除并不再询问") {
    await cfg.update("confirmDelete", false, ConfigurationTarget.Global);
    return true;
  }
  return choice === "删除";
}

// Short "x 分钟前 / x 小时前 / x 天前" relative label for the recycle bin.
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(iso).toLocaleDateString();
}

// Open a workspace-relative file and reveal the (possibly relocated) line.
// No tour start, no comment thread (bubble).
export async function gotoLocation(
  file: string,
  line: number,
  pattern?: string
): Promise<void> {
  const root = workspace.workspaceFolders![0].uri;
  const uri = Uri.joinPath(root, file);
  const doc = await workspace.openTextDocument(uri);
  const text = doc.getText();
  const resolved = resolveLine(text, line, pattern);
  const zero = Math.max(0, resolved - 1);
  const editor = await window.showTextDocument(doc, { preview: false });
  const pos = new Position(zero, 0);
  editor.selection = new Selection(pos, pos);
  editor.revealRange(new Range(pos, pos), TextEditorRevealType.InCenter);
}

// Turn the comment "+" gutter on/off globally, with no tour-creation prompt.
//
// NOTE: the gutter "+" is produced by the player's CommentController, whose
// `commentingRangeProvider` only returns ranges when `store.isRecording` is
// true. But that controller is created lazily inside `startPlayer()`, which is
// only called from `startCodeTour()`. So flipping `isRecording` alone is a
// no-op visually — there would be no controller registered to show the "+".
//
// To make the affordance actually appear with NO tour prompt/title/git-ref
// pick, we spin up a lightweight in-memory "ambient" tour (empty steps, never
// written to disk) via `startCodeTour(..., startInEditMode=true)`. That both
// instantiates the controller and sets `isRecording`/`isEditing` plus the
// `codeJumpTags:recording` / `codeJumpTags:isEditing` context keys. Toggling off tears
// the ambient tour down again.
//
// AMBIENT_TOUR_ID lives in ../constants (a leaf module) so that the player's
// tree and status-bar code can import it to hide the ambient tour, without
// pulling in this file's heavier dependency chain.

function isAmbientEditMode(): boolean {
  return (
    runtime.isRecording &&
    !!runtime.activeTour &&
    runtime.activeTour.tour.id === AMBIENT_TOUR_ID
  );
}

export async function toggleEditMode(): Promise<void> {
  if (isAmbientEditMode()) {
    // Turn the gutter "+" off: tear down the ambient tour. Pass fireEvent=false
    // since there's no real tour to notify listeners about.
    await endCurrentCodeTour(false);
    window.setStatusBarMessage("Code Jump Tags: 注释编辑模式已关闭", 2000);
    return;
  }

  // Turn the gutter "+" on. Create an ambient, in-memory tour that is never
  // persisted; startInEditMode=true flips isRecording/isEditing and sets the
  // recording/isEditing context keys, which makes the comment controller
  // expose the per-line "+" affordance across the workspace.
  const workspaceRoot = workspace.workspaceFolders![0].uri;
  const ambientTour = {
    id: AMBIENT_TOUR_ID,
    title: "",
    steps: []
  };

  startCodeTour(
    ambientTour,
    -1,
    workspaceRoot,
    /* startInEditMode */ true,
    /* canEditTag */ true
  );

  window.setStatusBarMessage("Code Jump Tags: 注释编辑模式已开启", 2000);
}

// `[note](vscode://patrick1099.code-jump-tags/goto?file=..&line=..&pattern=..)`
// The URI authority MUST be the extension id (publisher.name), NOT EXTENSION_NAME
// (the command prefix). It is filled in from the running extension at
// registration (see registerLodestarCommands) so it always matches however the
// extension is published; the literal is only a fallback for older VS Code
// (< 1.74, where context.extension is unavailable) and must stay in sync with
// package.json's publisher.name.
let EXTENSION_ID = "patrick1099.code-jump-tags";
function tagLinkMarkdown(args: {
  note?: string;
  file: string;
  line: number | string;
  pattern?: string;
}): string {
  const params = new URLSearchParams();
  params.set("file", args.file);
  params.set("line", String(args.line));
  if (args.pattern) params.set("pattern", args.pattern);
  const label = (args.note || args.file).trim().split(/\r?\n/)[0];
  return `[${label}](vscode://${EXTENSION_ID}/goto?${params.toString()})`;
}

// Copy a single tag as a clickable markdown link. VS Code passes the tree node
// as the first arg; the node carries the tag fields on `tagLink`.
export async function copyTagLink(node: any) {
  const args = node?.tagLink ?? node;
  if (!args || !args.file || args.line === undefined || args.line === null) {
    window.showInformationMessage(
      "Code Jump Tags: 请在某个标签(步骤)上右键使用「复制为链接」"
    );
    return;
  }
  await env.clipboard.writeText(tagLinkMarkdown(args));
  window.setStatusBarMessage("Code Jump Tags: 链接已复制", 2000);
}

// Copy every tag under a folder (or the (未分组) group) as markdown links, one
// per line. Reads the folder's derived tour steps, so it works for both.
export async function copyFolderLinks(node: any, additionalNodes?: any[]) {
  const store = getStore();
  const idOf = (n: any): string | undefined =>
    n?.tagLink?.id ?? n?.tagId ?? n?.step?.id ??
    (n?.tour?.id ? n.tour.id.split("::").pop() : undefined);
  const selected =
    additionalNodes && additionalNodes.length > 0 ? additionalNodes : [node];
  const ids = selected.map(idOf).filter((x): x is string => !!x);

  const { collectTagsUnder } = await import("./selection");
  const tags = collectTagsUnder(store, ids);
  if (tags.length === 0) {
    window.showInformationMessage("Code Jump Tags: 没有可复制的标签");
    return;
  }
  const links = tags.map(t =>
    tagLinkMarkdown({ note: t.note, file: t.file, line: t.line, pattern: t.pattern })
  );
  await env.clipboard.writeText(links.join("\n"));
  window.setStatusBarMessage(`Code Jump Tags: 已复制 ${links.length} 条链接`, 2000);
}

// Rename a folder. The inbox is a real folder and can be renamed (graduation).
export async function renameFolder(node: any) {
  const tourId: string | undefined = node?.tour?.id;
  const folderId = tourId ? tourId.split("::")[1] : undefined;
  const store = getStore();
  const found = folderId ? findNode(store, folderId) : undefined;
  if (!found || found.node.type !== "folder") {
    window.showInformationMessage("Code Jump Tags: 找不到该文件夹");
    return;
  }
  const title = await window.showInputBox({
    prompt: "文件夹名称",
    value: found.node.title
  });
  if (title === undefined || title.trim() === "") return;
  renameFolderNode(store, folderId!, title.trim());
  await saveStore();
}

// Rename a tag from the tree, the same way folders are renamed: a quick input
// box (NOT the inline comment editor) pre-filled with the current note. A tag's
// "name" is its note; the tree label is the note's first line. saveStore()
// rebuilds the derived tours and decorator.ts's reaction re-renders the in-editor
// annotation, so the marker text updates too.
export async function renameTag(node: any) {
  const tagId: string | undefined = node?.tagLink?.id ?? node?.tagId;
  if (!tagId) {
    window.showInformationMessage(
      "Code Jump Tags: 请在某个标签上右键使用「重命名标签」"
    );
    return;
  }
  const found = findNode(getStore(), tagId);
  if (!found || found.node.type !== "tag") {
    window.showInformationMessage("Code Jump Tags: 找不到该标签");
    return;
  }
  const note = await window.showInputBox({
    prompt: "标签注释",
    value: found.node.note
  });
  if (note === undefined || note.trim() === "") return;
  found.node.note = note;
  await saveStore();
  // If this tag's inline edit bubble happens to be open, drop it so it doesn't
  // linger showing the old text.
  closeTagEditor(tagId);
}

// Re-edit a tag's note. Invoked by clicking the above-line CodeLens or the
// "编辑注释" link in a marked line's hover. Opens the same inline comment box
// used when creating, prefilled with the current note (unified editing).
export async function editNote(tagId?: string) {
  if (!tagId) return;
  await openTagEditor(tagId);
}

// ── 0.6.0 移动 / 剪切粘贴标签 ────────────────────────────────────────────────
// 正被「剪切」、等待粘贴目标的标签 id。movingTag 上下文键据此决定编辑器右键是否
// 显示「粘贴标签到此行」。
let s_movingTagId: string | undefined;

function setMovingTag(id: string | undefined) {
  s_movingTagId = id;
  commands.executeCommand(
    "setContext",
    "codeJumpTags:movingTag",
    id !== undefined
  );
}

// 读当前光标作为重锚目标:工作区相对路径、1-based 行号、该行内容锚(与 addTag 同源)。
function cursorTarget():
  | { file: string; line: number; text?: string; pattern?: string }
  | undefined {
  const editor = window.activeTextEditor;
  if (!editor) {
    window.showInformationMessage("Code Jump Tags: 请把光标放到目标代码行");
    return undefined;
  }
  const doc = editor.document;
  const workspaceRoot = workspace.workspaceFolders![0].uri;
  const file = getRelativePath(workspaceRoot.path, doc.uri.path);
  const lineIndex = editor.selection.active.line;
  const line = lineIndex + 1;
  const lineText = doc.lineAt(lineIndex).text.trim();
  const text = lineText ? lineAnchorText(lineText) : undefined;
  const pattern = lineText ? linePattern(lineText) : undefined;
  return { file, line, text, pattern };
}

// 把 tagId 重锚到当前光标行;目标行已被「别的」标签占用 → 拒绝(守一行一签)。
async function placeTagAtCursor(tagId: string): Promise<boolean> {
  const target = cursorTarget();
  if (!target) return false;
  const store = getStore();
  const existing = findTagByLocation(store, target.file, target.line);
  if (existing && existing.id !== tagId) {
    const label =
      (existing.note || "").split(/\r?\n/)[0].trim() || "(无注释)";
    window.showInformationMessage(`Code Jump Tags: 该行已有标签「${label}」`);
    return false;
  }
  if (
    !retargetTag(store, tagId, target.file, target.line, target.text, target.pattern)
  ) {
    window.showInformationMessage("Code Jump Tags: 找不到该标签");
    return false;
  }
  await saveStore();
  window.setStatusBarMessage(
    `Code Jump Tags: 已移动到 ${target.file}:${target.line}`,
    2000
  );
  return true;
}

// 剪切标签:记下要移动的标签,等待编辑器里右键「粘贴标签到此行」。
export async function cutTag(node: any) {
  const tagId: string | undefined = node?.tagLink?.id ?? node?.tagId;
  if (!tagId) {
    window.showInformationMessage(
      "Code Jump Tags: 请在某个标签上右键使用「剪切标签」"
    );
    return;
  }
  setMovingTag(tagId);
  window.setStatusBarMessage(
    "Code Jump Tags: 标签移动中——把光标放到目标行,右键「粘贴标签到此行」",
    4000
  );
}

// 粘贴到此行:把剪切中的标签钉到当前光标行(可跨文件)。
export async function pasteTagHere() {
  if (!s_movingTagId) return;
  const ok = await placeTagAtCursor(s_movingTagId);
  if (ok) setMovingTag(undefined);
}

// 移到光标行:一步到位,把树里选中的标签钉到当前光标行。
export async function moveTagToCursor(node: any) {
  const tagId: string | undefined = node?.tagLink?.id ?? node?.tagId;
  if (!tagId) {
    window.showInformationMessage(
      "Code Jump Tags: 请在某个标签上右键使用「移到光标行」"
    );
    return;
  }
  await placeTagAtCursor(tagId);
}

// 取消移动:清掉剪切中的标签。
export async function cancelMoveTag() {
  setMovingTag(undefined);
  window.setStatusBarMessage("Code Jump Tags: 已取消标签移动", 2000);
}

// Shared batch-delete helper: count tags vs folders among `ids`, build a
// confirmation summary (with named single-item wording for both a single tag
// and a single folder), prompt via confirmDelete, and on confirmation loop
// removeToTrash + close affected editors. Returns true if the items were
// deleted, false if the user cancelled.
//
// closeTagEditor semantics: for each removed tag id we call closeTagEditor(id)
// so only that tag's bubble is closed. If any folder was removed we
// additionally call closeTagEditor() with no arg once, matching the old
// deleteFolder behavior (close whatever bubble is open, since we don't track
// which individual tag id the user was editing inside the folder).
export async function batchDeleteByIds(
  store: import("./types").LodestarStore,
  ids: string[]
): Promise<boolean> {
  if (ids.length === 0) return false;

  let tagCount = 0;
  let folderCount = 0;
  let singleTagNote = "";
  let singleFolderTitle = "";
  for (const id of ids) {
    const f = findNode(store, id);
    if (f?.node.type === "folder") {
      folderCount++;
      if (ids.length === 1) singleFolderTitle = f.node.title;
    } else {
      tagCount++;
      if (ids.length === 1 && f?.node.type === "tag") {
        singleTagNote = f.node.note;
      }
    }
  }

  let summary: string;
  if (ids.length === 1 && tagCount === 1) {
    const label = singleTagNote.split(/\r?\n/)[0].trim() || "(空注释)";
    summary = `删除标签「${label}」?`;
  } else if (ids.length === 1 && folderCount === 1) {
    summary = `删除文件夹「${singleFolderTitle}」?`;
  } else {
    const parts: string[] = [];
    if (tagCount) parts.push(`${tagCount} 个标签`);
    if (folderCount) parts.push(`${folderCount} 个文件夹(及其中的标签)`);
    summary = `删除${parts.join("、")}?`;
  }

  if (!(await confirmDelete(summary))) return false;

  let anyFolder = false;
  for (const id of ids) {
    const f = findNode(store, id);
    const isFolder = f?.node.type === "folder";
    removeToTrash(store, id);
    if (isFolder) {
      anyFolder = true;
    } else {
      closeTagEditor(id);
    }
  }
  if (anyFolder) closeTagEditor();
  await saveStore();
  return true;
}

// Delete a folder (and the tags inside it) from the store. Invoked from the
// tree's folder node. Supports multi-selection: additionalNodes is the VS Code
// selected-items array forwarded as the second command argument.
export async function deleteFolder(node: any, additionalNodes?: any[]) {
  const store = getStore();
  const { pruneCovered } = await import("./selection");
  const idOf = (n: any): string | undefined =>
    n?.tour?.id ? n.tour.id.split("::").pop() : n?.step?.id;
  const selected =
    additionalNodes && additionalNodes.length > 0 ? additionalNodes : [node];
  const ids = pruneCovered(
    store,
    selected.map(idOf).filter((x): x is string => !!x)
  );
  if (ids.length === 0) {
    window.showInformationMessage("Code Jump Tags: 找不到该文件夹");
    return;
  }
  await batchDeleteByIds(store, ids);
}

// Restore deleted tags/folders from the recycle bin back to the tree root. The
// bin is a tree-shaped multi-select QuickPick: each trashed folder lists its
// whole subtree (sub-folders + tags, any depth) as indented rows. Checkboxes
// cascade like a file tree — checking a folder checks everything under it, and a
// folder stays checked only while all its children are checked (uncheck them all
// and the folder unchecks itself).
export async function restoreFromTrash() {
  const store = getStore();
  const trash = store.trash ?? [];
  if (trash.length === 0) {
    window.showInformationMessage("Code Jump Tags: 回收站是空的");
    return;
  }

  interface TrashRow extends QuickPickItem {
    node: TreeNode;
    entry: TrashedEntry; // the top-level trash entry this row belongs to
    isEntry: boolean; // true => this row IS the top-level entry
    parentRow?: TrashRow; // the row one level up (undefined for entries)
    depth: number; // 0 for an entry row, increasing downward
  }

  const tagLabel = (note: string) =>
    note.split(/\r?\n/)[0].trim() || "(空注释)";
  const countTags = (node: TreeNode): number =>
    node.type === "tag"
      ? 1
      : node.children.reduce((n, c) => n + countTags(c), 0);

  // Build one row per node (entries + every nested descendant), keeping the
  // parent-row link so the checkbox cascade can walk the hierarchy.
  const rows: TrashRow[] = [];
  const addRow = (
    node: TreeNode,
    entry: TrashedEntry,
    isEntry: boolean,
    parentRow: TrashRow | undefined,
    depth: number
  ) => {
    const prefix = isEntry ? "" : `${"   ".repeat(depth)}↳ `;
    const glyph = node.type === "folder" ? "$(folder)" : "$(bookmark)";
    const title =
      node.type === "folder" ? node.title : tagLabel(node.note);
    let description: string;
    if (node.type === "folder") {
      description = isEntry
        ? `文件夹 · ${countTags(node)} 个标签 · ${relativeTime(entry.deletedAt)}`
        : `子文件夹 · ${countTags(node)} 个标签`;
    } else {
      description = isEntry
        ? `${node.file}:${node.line} · ${relativeTime(entry.deletedAt)}`
        : `${node.file}:${node.line}`;
    }
    const row: TrashRow = {
      node, entry, isEntry, parentRow, depth,
      label: `${prefix}${glyph} ${title}`,
      description
    };
    rows.push(row);
    if (node.type === "folder") {
      for (const child of node.children) {
        addRow(child, entry, false, row, depth + 1);
      }
    }
  };
  for (const entry of trash) addRow(entry.node, entry, true, undefined, 0);

  const childrenOf = (row: TrashRow) => rows.filter(r => r.parentRow === row);
  const descendantsOf = (row: TrashRow): TrashRow[] => {
    const out: TrashRow[] = [];
    const stack = childrenOf(row);
    while (stack.length) {
      const r = stack.pop()!;
      out.push(r);
      stack.push(...childrenOf(r));
    }
    return out;
  };
  // Deepest first so a child folder's state is settled before its parent reads it.
  const folderRowsDeepestFirst = rows
    .filter(r => r.node.type === "folder")
    .sort((a, b) => b.depth - a.depth);

  const qp = window.createQuickPick<TrashRow>();
  qp.items = rows;
  qp.canSelectMany = true;
  qp.placeholder =
    "勾选要恢复的项(恢复到根目录):勾文件夹会连同里面的子文件夹/标签一起勾选";

  let current = new Set<TrashRow>();
  let updating = false;
  qp.onDidChangeSelection(selected => {
    if (updating) return;
    const next = new Set(selected);
    const added = [...next].filter(r => !current.has(r));
    const removed = [...current].filter(r => !next.has(r));

    // Checking/unchecking a folder cascades to its whole subtree.
    const result = new Set(next);
    for (const r of added) descendantsOf(r).forEach(d => result.add(d));
    for (const r of removed) descendantsOf(r).forEach(d => result.delete(d));

    // A folder is checked iff it has children and they're ALL checked.
    for (const folder of folderRowsDeepestFirst) {
      const kids = childrenOf(folder);
      if (kids.length > 0 && kids.every(k => result.has(k))) result.add(folder);
      else result.delete(folder);
    }

    current = result;
    const sameSet =
      result.size === next.size && [...result].every(r => next.has(r));
    if (!sameSet) {
      // Re-writing the selection re-fires this event; the flag + sameSet guard
      // keep it from looping.
      updating = true;
      qp.selectedItems = [...result];
      updating = false;
    }
  });

  const picked = await new Promise<TrashRow[] | undefined>(resolve => {
    qp.onDidAccept(() => resolve([...qp.selectedItems]));
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();
  if (!picked || picked.length === 0) return;

  // Whole top-level entries restore wholesale; nested picks pull a node out to
  // the root. Sort nested by depth ascending so an ancestor is extracted before
  // its own descendants (the descendant then comes along and is skipped).
  const entries = picked.filter(r => r.isEntry).map(r => r.entry);
  const children = picked
    .filter(r => !r.isEntry)
    .sort((a, b) => a.depth - b.depth)
    .map(r => ({ parent: r.entry, child: r.node }));

  restoreSelection(store, entries, children);
  await saveStore();
  window.setStatusBarMessage("Code Jump Tags: 已从回收站恢复所选项", 2000);
}

const folderIdGen = () =>
  `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

export async function newFolder() {
  const title = await window.showInputBox({ prompt: "文件夹名称" });
  if (!title) return;
  createFolder(getStore(), title, folderIdGen);
  await saveStore();
}

// Create a sub-folder inside the right-clicked folder. Folders nest to any
// depth; the tree renders the nesting and findNode/moveNode already recurse.
export async function newSubfolder(node: any) {
  const tourId: string | undefined = node?.tour?.id;
  const folderId = tourId ? tourId.split("::").pop() : undefined;
  const found = folderId ? findNode(getStore(), folderId) : undefined;
  if (!found || found.node.type !== "folder") {
    window.showInformationMessage("Code Jump Tags: 找不到该文件夹");
    return;
  }
  const title = await window.showInputBox({ prompt: "子文件夹名称" });
  if (!title || !title.trim()) return;
  createFolder(getStore(), title.trim(), folderIdGen, folderId);
  await saveStore();
}

export function registerLodestarCommands(context: ExtensionContext) {
  // Use the real published id (publisher.name) for tag links, so they keep
  // working through any publisher rename. context.extension exists since VS Code
  // 1.74; on older hosts we keep the literal fallback above.
  const extId = (context as any).extension?.id;
  if (typeof extId === "string" && extId.length > 0) {
    EXTENSION_ID = extId;
  }
  context.subscriptions.push(
    commands.registerCommand(
      `${EXTENSION_NAME}.goto`,
      (file: string, line: number, pattern?: string) =>
        gotoLocation(file, line, pattern)
    ),
    commands.registerCommand(
      `${EXTENSION_NAME}.toggleEditMode`,
      toggleEditMode
    ),
    // Same toggle, separate command id so the view title can show a distinct
    // "exit" icon while editing (a command's icon is fixed, so two ids are the
    // only way to swap the glyph by state).
    commands.registerCommand(
      `${EXTENSION_NAME}.exitEditMode`,
      toggleEditMode
    ),
    commands.registerCommand(`${EXTENSION_NAME}.copyTagLink`, copyTagLink),
    commands.registerCommand(
      `${EXTENSION_NAME}.copyFolderLinks`,
      copyFolderLinks
    ),
    commands.registerCommand(`${EXTENSION_NAME}.renameFolder`, renameFolder),
    commands.registerCommand(`${EXTENSION_NAME}.renameTag`, renameTag),
    commands.registerCommand(`${EXTENSION_NAME}.editNote`, editNote),
    commands.registerCommand(`${EXTENSION_NAME}.saveTagEdit`, saveTagEdit),
    commands.registerCommand(`${EXTENSION_NAME}.cancelTagEdit`, cancelTagEdit),
    commands.registerCommand(
      `${EXTENSION_NAME}.deleteFromEditor`,
      deleteFromEditor
    ),
    commands.registerCommand(
      `${EXTENSION_NAME}.notePositionAbove`,
      toggleNotePosition
    ),
    commands.registerCommand(
      `${EXTENSION_NAME}.notePositionEnd`,
      toggleNotePosition
    ),
    commands.registerCommand(`${EXTENSION_NAME}.deleteFolder`, deleteFolder),
    commands.registerCommand(
      `${EXTENSION_NAME}.restoreFromTrash`,
      restoreFromTrash
    ),
    commands.registerCommand(`${EXTENSION_NAME}.newFolder`, newFolder),
    commands.registerCommand(`${EXTENSION_NAME}.newSubfolder`, newSubfolder),
    commands.registerCommand(`${EXTENSION_NAME}.cutTag`, cutTag),
    commands.registerCommand(`${EXTENSION_NAME}.pasteTagHere`, pasteTagHere),
    commands.registerCommand(
      `${EXTENSION_NAME}.moveTagToCursor`,
      moveTagToCursor
    ),
    commands.registerCommand(`${EXTENSION_NAME}.cancelMoveTag`, cancelMoveTag)
  );
}
