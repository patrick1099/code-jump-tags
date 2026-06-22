// The edit box for a tag's note. It is a NON-empty comment thread holding one
// comment in EDITING mode, pre-filled with the current note so it can be edited
// in place. Non-empty keeps a real collapse chevron (an empty thread would show
// a discard trash icon instead). Editing mode is the only way VS Code lets us
// pre-fill the text box — it carries a bordered editor; the borderless reply
// input cannot be pre-filled. Backed by a dedicated controller so it works
// regardless of edit mode / active tour.

import * as vscode from "vscode";
import {
  BLANK_ICON_URL,
  NOTE_INPUT_PLACEHOLDER,
  NOTE_INPUT_PROMPT
} from "../constants";
import { getStore, saveStore } from "./persistence";
import { resolveAnchoredLine } from "./relocate";
import { findNode, removeToTrash } from "./tree";

let controller: vscode.CommentController | undefined;

// Maps an open edit thread back to the tag it edits.
const threadToTag = new WeakMap<vscode.CommentThread, string>();

// At most ONE edit bubble lives at a time. VS Code exposes no way to hide a
// thread's collapse twistie nor an event to detect a collapse, so a collapsed
// bubble would otherwise linger forever. Tracking the single live thread lets us
// (a) drop the previous bubble whenever a new editor opens and (b) dispose a
// tag's bubble when that tag is deleted (see closeTagEditor).
let liveThread: vscode.CommentThread | undefined;
let liveTagId: string | undefined;

function disposeLiveThread() {
  if (liveThread) {
    try {
      liveThread.dispose();
    } catch {
      /* already gone */
    }
  }
  liveThread = undefined;
  liveTagId = undefined;
}

// Close the open edit bubble. With no argument, close whatever is open; with a
// tagId, close it only if the open bubble belongs to that tag. Called when a tag
// is deleted (from the tree or the editor) or a folder is removed, so the bubble
// doesn't survive its tag as a stale, manually-cleared artifact.
export function closeTagEditor(tagId?: string) {
  if (tagId === undefined || liveTagId === tagId) {
    disposeLiveThread();
  }
}

// The single comment in the edit thread, opened in Editing mode and pre-filled
// with the current note. Keeping one comment makes the thread non-empty, so VS
// Code shows a real collapse chevron (not a discard trash). Blank avatar + empty
// name keep it iconless.
class NoteComment implements vscode.Comment {
  public author: vscode.CommentAuthorInformation = {
    name: "",
    iconPath: vscode.Uri.parse(BLANK_ICON_URL)
  };
  public contextValue = "codeJumpTagsEdit";
  public mode = vscode.CommentMode.Editing;
  constructor(
    public body: string | vscode.MarkdownString,
    public parent: vscode.CommentThread
  ) {}
}

function ensureController(): vscode.CommentController {
  if (!controller) {
    controller = vscode.comments.createCommentController(
      "codeJumpTags-edit",
      "Code Jump Tags"
    );
    // Same input-box text as the player's "+" box, so the two boxes read alike.
    controller.options = {
      prompt: NOTE_INPUT_PROMPT,
      placeHolder: NOTE_INPUT_PLACEHOLDER
    };
    // No commentingRangeProvider: this controller never shows a gutter "+",
    // its threads are created programmatically by openTagEditor.
  }
  return controller;
}

// Open the edit box on a tag's line: one comment pre-filled with the current
// note, in editing mode, edited in place and saved with the ✓ button.
export async function openTagEditor(tagId: string) {
  const found = findNode(getStore(), tagId);
  if (!found || found.node.type !== "tag") {
    vscode.window.showInformationMessage("Code Jump Tags: 找不到该标签");
    return;
  }
  const tag = found.node;
  // Reflect THIS tag's note position on the ↑/→ toggle in the box title bar.
  vscode.commands.executeCommand(
    "setContext",
    "codeJumpTags:notePosition",
    tag.notePosition === "end" ? "end" : "above"
  );
  const root = vscode.workspace.workspaceFolders![0].uri;
  const uri = vscode.Uri.joinPath(root, tag.file);
  const doc = await vscode.workspace.openTextDocument(uri);
  const resolved = resolveAnchoredLine(doc.getText(), tag.line, tag.text, tag.pattern);
  const lineIdx = Math.max(0, resolved - 1);
  await vscode.window.showTextDocument(doc, { preview: false });

  // Single bubble: drop any previously-open edit thread before opening this one.
  disposeLiveThread();

  const ctrl = ensureController();
  const range = new vscode.Range(lineIdx, 0, lineIdx, 0);
  const thread = ctrl.createCommentThread(uri, range, []);
  threadToTag.set(thread, tagId);
  liveThread = thread;
  liveTagId = tagId;
  thread.label = "注释";
  // @ts-ignore - canReply isn't in older typings
  thread.canReply = false;
  // One comment pre-filled with the note, in editing mode. Non-empty thread →
  // real collapse chevron instead of the empty-thread discard trash.
  thread.comments = [new NoteComment(tag.note ?? "", thread)];
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
}

// Save handler for the ✓ button: write the edited body back to the tag. VS Code
// passes the edited Comment (its `.body` holds the new text, `.parent` the thread).
export async function saveTagEdit(comment: any) {
  const thread: vscode.CommentThread | undefined = comment?.parent;
  if (!thread) return;
  const tagId = threadToTag.get(thread);
  if (tagId) {
    const body =
      comment.body instanceof vscode.MarkdownString
        ? comment.body.value
        : String(comment.body ?? "");
    const found = findNode(getStore(), tagId);
    if (found && found.node.type === "tag") {
      found.node.note = body;
      await saveStore();
    }
  }
  closeTagEditorThread(thread);
}

// Cancel handler (✗): close the box, leave the tag untouched. Receives the
// Comment (from comments/comment/context) whose `.parent` is the thread.
export function cancelTagEdit(arg: any) {
  const thread: vscode.CommentThread | undefined = arg?.comments
    ? arg
    : arg?.parent ?? arg;
  closeTagEditorThread(thread);
}

// Dispose a specific edit thread and, if it was the tracked live one, clear the
// tracking so no stale bubble is left behind.
function closeTagEditorThread(thread: vscode.CommentThread | undefined) {
  if (!thread) return;
  if (thread === liveThread) {
    disposeLiveThread();
    return;
  }
  try {
    thread.dispose();
  } catch {
    /* already gone */
  }
}

// Toggle THIS tag's note position (above <-> end). Bound to the ↑/→ icon in the
// edit box title bar, which passes the CommentThread. The note moves live: a
// saveStore() rebuilds store.tours and decorator.ts's reaction re-renders it.
export async function toggleNotePosition(thread: vscode.CommentThread) {
  const tagId = threadToTag.get(thread);
  if (!tagId) return;
  const found = findNode(getStore(), tagId);
  if (!found || found.node.type !== "tag") return;
  const next = found.node.notePosition === "end" ? "above" : "end";
  found.node.notePosition = next;
  await saveStore();
  vscode.commands.executeCommand(
    "setContext",
    "codeJumpTags:notePosition",
    next
  );
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
  closeTagEditorThread(thread);
}
