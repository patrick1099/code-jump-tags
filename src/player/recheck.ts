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
import { isExcluded } from "../lodestar/exclude";
import { excludePatterns } from "./inlineNotes";
import { markExternalChange } from "./externalWatch";

// Read a workspace-relative file's current text (open doc if loaded, else disk),
// NORMALIZED for anchor matching: any line currently expanded with an inline
// note carries `//me: 私记` in the buffer, and comparing that against a tag's
// clean identity anchor drops similarity far below the threshold — every tag on
// that line (the note's own, plus any formal tag sharing the line) would be
// flagged suspect, and a suspect line stops painting its end-of-line note.
async function readFileText(file: string): Promise<string | undefined> {
  if (!workspace.workspaceFolders?.length) return undefined;
  const uri = Uri.joinPath(workspace.workspaceFolders[0].uri, file);
  try {
    const doc = await workspace.openTextDocument(uri);
    const { canonicalText } = await import("./inlineNotes");
    return canonicalText(doc);
  } catch {
    return undefined;
  }
}

// Re-evaluate suspect state for every tag in ONE file, update the registry, and
// repaint if it changed. Cheap: only this file's tags, only matchAnchor.
export async function recheckFile(file: string): Promise<void> {
  // 排除名单短路。除了「不该校验的文件别去校验」，这里还掐掉一条空转回路：
  // saveStore 写 .code-jump-tags/store.json → 下面那个 `**/*` 文件监听器立刻回弹
  // 一次 recheck → 又是一轮读盘。
  if (isExcluded(file, excludePatterns())) return;

  const text = await readFileText(file);
  if (text === undefined) return;
  // 随手私记不参与失配判定：它既不画失配标记，也不进侧边栏的「待处理」分组，
  // 让它进注册表只会让那个分组因为「有条目但全被过滤掉」而显示成空壳。
  const tags = collectTagsInFile(getStore(), file).filter(t => !t.inline);
  const fileTags: FileTag[] = tags.map(t => ({
    id: t.id,
    file: t.file,
    line: t.line,
    original: t.original,
    current: t.text,
    witnessed: t.witnessed
  }));
  const infos = classifyFileTags(fileTags, text);
  const changed = setFileSuspects(file, infos);
  if (changed) {
    const { refreshTagsTree } = await import("./tree");
    refreshTagsTree();
    if (window.activeTextEditor) updateDecorations(window.activeTextEditor);
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

  // 本编辑器自己的保存。文件监听器分不清「谁写的盘」——我们保存也会让它 onDidChange
  // 触发一次。这里记下刚保存过的文件，好让下面的监听器把「自己写的」排除掉，只对真正
  // 的外部改动作废「亲眼看见」的信任。
  // 一次保存只对应一个监听事件，所以认领后立刻消费掉：同一文件的**下一次**变更就
  // 又是「没看见的」了。时间窗只作兜底（保存后监听事件迟迟不来时别把它挂着）。
  const ourSaves = new Map<string, number>();
  const OUR_SAVE_WINDOW_MS = 1500;

  // save
  context.subscriptions.push(
    workspace.onDidSaveTextDocument(doc => {
      if (!workspace.workspaceFolders?.length) return;
      const f = getRelativePath(workspace.workspaceFolders[0].uri.path, doc.uri.path);
      ourSaves.set(f, Date.now());
      if (!on("save", false)) return;
      recheckFile(f);
    })
  );

  // external change (git pull / external tool): watch all files, recheck on change
  const watcher = workspace.createFileSystemWatcher("**/*");
  const onExternal = async (uri: Uri) => {
    if (!on("externalChange", true) || !workspace.workspaceFolders?.length) return;
    const f = getRelativePath(workspace.workspaceFolders[0].uri.path, uri.path);
    if (isExcluded(f, excludePatterns())) return;

    const savedAt = ourSaves.get(f);
    const ours = savedAt !== undefined && Date.now() - savedAt < OUR_SAVE_WINDOW_MS;
    if (savedAt !== undefined) ourSaves.delete(f); // 认领即消费
    if (!ours) {
      // 记下「这个文件刚被我们看不见的人改过」：紧接着 VS Code 会把这份外部内容
      // 载入 buffer 并触发文档变更事件，trackLineShifts 必须知道那不算「看见」。
      markExternalChange(f);
      // 这一刻我们「没看见」这份改动是怎么发生的（别的编辑器写盘、git 拉取…），
      // 于是这个文件里所有标签的现内容不再可信 —— 作废信任，让失配判定重新生效。
      // 这正是用户预期里唯一该出现失配的场景。
      const tags = collectTagsInFile(getStore(), f).filter(t => t.witnessed);
      if (tags.length > 0) {
        for (const t of tags) delete t.witnessed;
        const { saveStore } = await import("../lodestar/persistence");
        await saveStore();
      }
    }
    recheckFile(f);
  };
  watcher.onDidChange(uri => void onExternal(uri));
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
