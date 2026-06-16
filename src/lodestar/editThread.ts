// A CodeTour-style comment box for editing a tag's note, so editing uses the
// same inline bubble as creating (instead of a separate input box). Backed by a
// dedicated CommentController so it works regardless of edit mode / active tour.

import * as vscode from "vscode";
import { SMALL_ICON_URL } from "../constants";
import { getStore, saveStore } from "./persistence";
import { resolveLine } from "./relocate";
import { findNode, removeToTrash } from "./tree";

let controller: vscode.CommentController | undefined;

// Maps an open edit thread back to the tag it edits.
const threadToTag = new WeakMap<vscode.CommentThread, string>();

class EditComment implements vscode.Comment {
  // An iconPath is required, otherwise the avatar slot renders as a black box.
  public author: vscode.CommentAuthorInformation = {
    name: "Code Jump Tags",
    iconPath: vscode.Uri.parse(SMALL_ICON_URL)
  };
  public contextValue = "codeJumpTagsEdit";
  constructor(
    public body: string | vscode.MarkdownString,
    public mode: vscode.CommentMode,
    public parent: vscode.CommentThread
  ) {}
}

function ensureController(): vscode.CommentController {
  if (!controller) {
    controller = vscode.comments.createCommentController(
      "codeJumpTags-edit",
      "Code Jump Tags"
    );
    // No commentingRangeProvider: this controller never shows a gutter "+",
    // its threads are created programmatically by openTagEditor.
  }
  return controller;
}

// Open the editable comment bubble on a tag's line, prefilled with its note
// (or `seedBody` when continuing from a fresh "+" on an already-tagged line).
export async function openTagEditor(tagId: string, seedBody?: string) {
  const found = findNode(getStore(), tagId);
  if (!found || found.node.type !== "tag") {
    vscode.window.showInformationMessage("Code Jump Tags: 找不到该标签");
    return;
  }
  const tag = found.node;
  const root = vscode.workspace.workspaceFolders![0].uri;
  const uri = vscode.Uri.joinPath(root, tag.file);
  const doc = await vscode.workspace.openTextDocument(uri);
  const resolved = resolveLine(doc.getText(), tag.line, tag.pattern);
  const lineIdx = Math.max(0, resolved - 1);
  await vscode.window.showTextDocument(doc, { preview: false });

  const ctrl = ensureController();
  const range = new vscode.Range(lineIdx, 0, lineIdx, 0);
  const thread = ctrl.createCommentThread(uri, range, []);
  threadToTag.set(thread, tagId);
  thread.label = "编辑标签注释(改完点 ✓ 保存)";
  // @ts-ignore - canReply isn't in older typings
  thread.canReply = false;
  const comment = new EditComment(
    seedBody ?? tag.note,
    vscode.CommentMode.Editing,
    thread
  );
  thread.comments = [comment];
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
}

// Save handler for the ✓ button: write the edited body back to the tag.
export async function saveTagEdit(comment: any) {
  const thread: vscode.CommentThread | undefined = comment?.parent;
  if (!thread) return;
  const tagId = threadToTag.get(thread);
  if (!tagId) {
    thread.dispose();
    return;
  }
  const body =
    comment.body instanceof vscode.MarkdownString
      ? comment.body.value
      : String(comment.body ?? "");

  const found = findNode(getStore(), tagId);
  if (found && found.node.type === "tag") {
    found.node.note = body;
    await saveStore();
  }
  thread.dispose();
}

// Cancel handler for the ✗ button: discard the edit, leave the tag untouched.
export function cancelTagEdit(comment: any) {
  comment?.parent?.dispose?.();
}

// Trash-icon handler in the edit bubble's title bar: delete the whole tag
// (recoverable from the recycle bin) and close the bubble. The arg is the
// CommentThread (from commentThread/title) or a Comment (has .parent).
export async function deleteFromEditor(arg: any) {
  const thread: vscode.CommentThread | undefined = arg?.comments
    ? arg
    : arg?.parent;
  if (!thread) return;
  const tagId = threadToTag.get(thread);
  if (tagId) {
    removeToTrash(getStore(), tagId);
    await saveStore();
  }
  thread.dispose();
}
