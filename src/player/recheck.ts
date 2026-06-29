import {
  ExtensionContext,
  Uri,
  window,
  workspace
} from "vscode";
import { getStore } from "../lodestar/persistence";
import { collectTagsInFile } from "../lodestar/selection";
import { classifyFileTags, setFileSuspects, FileTag } from "../lodestar/suspect";
import { updateDecorations } from "./decorator";
import { getRelativePath } from "../utils";

// Read a workspace-relative file's current text (open doc if loaded, else disk).
async function readFileText(file: string): Promise<string | undefined> {
  if (!workspace.workspaceFolders?.length) return undefined;
  const uri = Uri.joinPath(workspace.workspaceFolders[0].uri, file);
  try {
    const doc = await workspace.openTextDocument(uri);
    return doc.getText();
  } catch {
    return undefined;
  }
}

// Re-evaluate suspect state for every tag in ONE file, update the registry, and
// repaint if it changed. Cheap: only this file's tags, only matchAnchor.
export async function recheckFile(file: string): Promise<void> {
  const text = await readFileText(file);
  if (text === undefined) return;
  const tags = collectTagsInFile(getStore(), file);
  const fileTags: FileTag[] = tags.map(t => ({
    id: t.id,
    file: t.file,
    line: t.line,
    original: t.original,
    current: t.text
  }));
  const infos = classifyFileTags(fileTags, text);
  const changed = setFileSuspects(file, infos);
  if (changed && window.activeTextEditor) {
    updateDecorations(window.activeTextEditor);
  }
}

function activeFileRelative(): string | undefined {
  const editor = window.activeTextEditor;
  if (!editor || !workspace.workspaceFolders?.length) return undefined;
  return getRelativePath(
    workspace.workspaceFolders[0].uri.path,
    editor.document.uri.path
  );
}

function on(key: string, dflt: boolean): boolean {
  return workspace
    .getConfiguration("codeJumpTags")
    .get<boolean>(`recheckOn.${key}`, dflt);
}

// Wire the configurable trigger points. Each only re-checks the file that fired
// it (minimal footprint). Defaults: focus/open/externalChange on; save/idle off.
export function registerRecheckTriggers(context: ExtensionContext): void {
  // open / switch editor
  context.subscriptions.push(
    window.onDidChangeActiveTextEditor(() => {
      if (!on("open", true)) return;
      const f = activeFileRelative();
      if (f) recheckFile(f);
    })
  );

  // window regains focus
  context.subscriptions.push(
    window.onDidChangeWindowState(state => {
      if (!state.focused || !on("focus", true)) return;
      const f = activeFileRelative();
      if (f) recheckFile(f);
    })
  );

  // save
  context.subscriptions.push(
    workspace.onDidSaveTextDocument(doc => {
      if (!on("save", false) || !workspace.workspaceFolders?.length) return;
      const f = getRelativePath(workspace.workspaceFolders[0].uri.path, doc.uri.path);
      recheckFile(f);
    })
  );

  // external change (git pull / external tool): watch all files, recheck on change
  const watcher = workspace.createFileSystemWatcher("**/*");
  const onExternal = (uri: Uri) => {
    if (!on("externalChange", true) || !workspace.workspaceFolders?.length) return;
    const f = getRelativePath(workspace.workspaceFolders[0].uri.path, uri.path);
    recheckFile(f);
  };
  watcher.onDidChange(onExternal);
  context.subscriptions.push(watcher);

  // idle (debounced after edits) — opt-in
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    workspace.onDidChangeTextDocument(e => {
      if (!on("idle", false)) return;
      if (e.document !== window.activeTextEditor?.document) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const f = activeFileRelative();
        if (f) recheckFile(f);
      }, 1500);
    })
  );

  // initial pass for the already-open editor
  const f = activeFileRelative();
  if (f && on("open", true)) recheckFile(f);
}
