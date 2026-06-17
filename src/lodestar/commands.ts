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
import { LOOSE_TOUR_ID } from "./adapter";
import {
  closeTagEditor,
  openTagEditor,
  saveTagEdit,
  cancelTagEdit,
  deleteFromEditor,
  toggleNotePosition
} from "./editThread";
import { getStore, saveStore } from "./persistence";
import { resolveLine } from "./relocate";
import {
  createFolder,
  findNode,
  removeToTrash,
  restoreSelection
} from "./tree";
import { TagNode, TrashedEntry } from "./types";

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
export async function copyFolderLinks(node: any) {
  const steps: any[] = node?.tour?.steps ?? [];
  if (steps.length === 0) {
    window.showInformationMessage("Code Jump Tags: 该文件夹下没有标签");
    return;
  }
  const links = steps.map(s =>
    tagLinkMarkdown({
      note: s.description,
      file: s.file,
      line: s.line,
      pattern: s.pattern
    })
  );
  await env.clipboard.writeText(links.join("\n"));
  window.setStatusBarMessage(`Code Jump Tags: 已复制 ${links.length} 条链接`, 2000);
}

// Rename a folder. The synthetic "(未分组)" group can't be renamed.
export async function renameFolder(node: any) {
  const tourId: string | undefined = node?.tour?.id;
  const folderId = tourId ? tourId.split("::")[1] : undefined;
  if (!folderId || folderId === LOOSE_TOUR_ID) {
    window.showInformationMessage("Code Jump Tags:「(未分组)」无法重命名");
    return;
  }
  const found = findNode(getStore(), folderId);
  if (!found || found.node.type !== "folder") {
    window.showInformationMessage("Code Jump Tags: 找不到该文件夹");
    return;
  }
  const title = await window.showInputBox({
    prompt: "文件夹名称",
    value: found.node.title
  });
  if (title === undefined || title.trim() === "") return;
  found.node.title = title.trim();
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

// Delete a folder (and the tags inside it) from the store. Invoked from the
// tree's folder node. The synthetic "(未分组)" group isn't a real folder, so
// it can't be deleted.
export async function deleteFolder(node: any) {
  const tourId: string | undefined = node?.tour?.id;
  const folderId = tourId ? tourId.split("::")[1] : undefined;
  if (!folderId || folderId === LOOSE_TOUR_ID) {
    window.showInformationMessage(
      "Code Jump Tags:「(未分组)」不是真实文件夹,无法删除"
    );
    return;
  }

  const store = getStore();
  const found = findNode(store, folderId);
  if (!found || found.node.type !== "folder") {
    window.showInformationMessage("Code Jump Tags: 找不到该文件夹");
    return;
  }

  const count = found.node.children.length;
  const ok = await confirmDelete(
    count > 0
      ? `删除文件夹「${found.node.title}」及其中 ${count} 个标签?`
      : `删除文件夹「${found.node.title}」?`
  );
  if (!ok) return;

  removeToTrash(store, folderId);
  await saveStore();
  // A deleted folder takes its child tags with it; close any open edit bubble so
  // it doesn't outlive the tag it was editing.
  closeTagEditor();
}

// Restore one or more deleted tags/folders from the recycle bin back to the
// tree root. Lists the bin in a multi-select QuickPick (most recent first).
export async function restoreFromTrash() {
  const store = getStore();
  const trash = store.trash ?? [];
  if (trash.length === 0) {
    window.showInformationMessage("Code Jump Tags: 回收站是空的");
    return;
  }

  // Flatten the bin: each trashed folder is one selectable row, with its tags
  // listed (indented) right under it as individually selectable rows. Picking
  // the folder restores it whole; picking only some child tags pulls just those
  // out to the root.
  // NB: don't name the discriminant `kind` — QuickPickItem already has a `kind`
  // field (separators), which would collide.
  interface TrashPick extends QuickPickItem {
    row: "entry" | "child";
    entry?: TrashedEntry; // set when row === "entry"
    parent?: TrashedEntry; // the trashed folder, when row === "child"
    child?: TagNode; // the tag inside it, when row === "child"
  }

  const tagLabel = (note: string) =>
    note.split(/\r?\n/)[0].trim() || "(空注释)";

  const items: TrashPick[] = [];
  for (const entry of trash) {
    const node = entry.node;
    if (node.type === "folder") {
      items.push({
        row: "entry",
        entry,
        label: `$(folder) ${node.title}`,
        description: `文件夹 · ${node.children.length} 个标签 · ${relativeTime(
          entry.deletedAt
        )}`
      });
      for (const child of node.children) {
        if (child.type !== "tag") continue;
        items.push({
          row: "child",
          parent: entry,
          child,
          label: `      ↳ $(bookmark) ${tagLabel(child.note)}`,
          description: `${child.file}:${child.line}`
        });
      }
    } else {
      items.push({
        row: "entry",
        entry,
        label: `$(bookmark) ${tagLabel(node.note)}`,
        description: `${node.file}:${node.line} · ${relativeTime(
          entry.deletedAt
        )}`
      });
    }
  }

  const picked = await window.showQuickPick(items, {
    canPickMany: true,
    placeHolder:
      "选择要恢复的项(可多选):勾文件夹=整个还原,勾里面的标签=只取出那几个;恢复到根目录"
  });
  if (!picked || picked.length === 0) return;

  const entries = picked
    .filter(p => p.row === "entry")
    .map(p => p.entry!);
  const children = picked
    .filter(p => p.row === "child")
    .map(p => ({ parent: p.parent!, child: p.child! }));

  restoreSelection(store, entries, children);
  await saveStore();
  window.setStatusBarMessage(`Code Jump Tags: 已恢复 ${picked.length} 项`, 2000);
}

const folderIdGen = () =>
  `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

export async function newFolder() {
  const title = await window.showInputBox({ prompt: "文件夹名称" });
  if (!title) return;
  createFolder(getStore(), title, folderIdGen);
  await saveStore();
}

// Create a sub-folder inside the right-clicked folder. The synthetic "(未分组)"
// group isn't a real folder, so it can't hold sub-folders. Folders nest to any
// depth; the tree renders the nesting and findNode/moveNode already recurse.
export async function newSubfolder(node: any) {
  const tourId: string | undefined = node?.tour?.id;
  const folderId = tourId ? tourId.split("::").pop() : undefined;
  if (!folderId || folderId === LOOSE_TOUR_ID) {
    window.showInformationMessage(
      "Code Jump Tags:「(未分组)」里不能新建子文件夹"
    );
    return;
  }
  const found = findNode(getStore(), folderId);
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
    commands.registerCommand(`${EXTENSION_NAME}.newSubfolder`, newSubfolder)
  );
}
