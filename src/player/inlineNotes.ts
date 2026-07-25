// inline note 折叠/展开胶水层。把「光标进出行」翻译成：
//   折叠 = 创建/归并一条 inline TagNode + 把 buffer 剥回干净代码 + 存盘；
//   展开 = 把 note 文本按 marker 注回 buffer（不动 sidecar）。
//
// 这是本特性里唯一 import `vscode` 的地方。所有纯逻辑（解析/剥离/展开/marker 拼装）
// 都住在 `lodestar/inlineNote.ts`（Task 1），这里只做「事件 -> 纯函数 -> 编辑器/存储」的
// 编排，绝不在此重新实现解析。
//
// 身份锚永不含 marker：写进 `original`/`text`/`pattern` 的一律是剥净后的代码
// （`parsed.code`），marker 只落在 `inlineMarker`（仅供回展）。

import * as vscode from "vscode";
import { getStore, saveStore } from "../lodestar/persistence";
import {
  addTag,
  findTagByLocation,
  getOrCreateInbox,
  newFolderId
} from "../lodestar/tree";
import { lineAnchorText, linePattern } from "../lodestar/relocate";
import {
  fullMarkers,
  parseInlineNote,
  toInlineText
} from "../lodestar/inlineNote";
import { TagNode } from "../lodestar/types";
import { getRelativePath } from "../utils";

// ── 配置 ────────────────────────────────────────────────────────────────────

interface InlineConfig {
  enabled: boolean;
  markers: string[];
}

// 每次现读，跟着用户设置走（与 decorator 读 getConfiguration 的做法一致）。
function inlineConfig(): InlineConfig {
  const cfg = vscode.workspace.getConfiguration("codeJumpTags");
  return {
    enabled: cfg.get<boolean>("inlineNote.enabled", true),
    markers: cfg.get<string[]>("inlineNote.markers", ["me:"])
  };
}

// ── 要点 1：完整 marker 来源 ─────────────────────────────────────────────────
//
// VS Code 没有同步公开 API 直接取语言的 `comments.lineComment`，一张小表足够覆盖
// 主流语言，查不到退回 "//"，后续可扩展。
const LINE_COMMENTS: Record<string, string> = {
  // // 家族
  javascript: "//",
  javascriptreact: "//",
  typescript: "//",
  typescriptreact: "//",
  c: "//",
  cpp: "//",
  csharp: "//",
  java: "//",
  go: "//",
  rust: "//",
  php: "//",
  swift: "//",
  kotlin: "//",
  scala: "//",
  dart: "//",
  json: "//",
  jsonc: "//",
  // # 家族
  python: "#",
  shellscript: "#",
  bash: "#",
  ruby: "#",
  perl: "#",
  yaml: "#",
  toml: "#",
  makefile: "#",
  dockerfile: "#",
  r: "#",
  coffeescript: "#",
  powershell: "#",
  // -- 家族
  lua: "--",
  sql: "--",
  haskell: "--"
};

export function lineCommentFor(languageId: string): string {
  return LINE_COMMENTS[languageId] ?? "//";
}

export function markersForDocument(doc: vscode.TextDocument): string[] {
  return fullMarkers(lineCommentFor(doc.languageId), inlineConfig().markers);
}

// ── 要点 5：re-entrancy 防抖 ─────────────────────────────────────────────────
//
// `collapseLine`/`expandLine` 里的 `editor.edit` 会回头触发 `onDidChangeTextDocument`
// （decorator.ts 的 trackLineShifts）与可能的 selection 事件。模块级 `busy` 在进入
// edit 前置位、`finally` 复位；所有事件回调开头 `if (busy) return;`，避免自触发递归。
let busy = false;

// per-editor 的「当前展开行」，键用 document uri（editor 对象本身是易变的）。
const expandedLines = new Map<string, number | null>();

// 工作区相对路径：取法与 recorder/commands.ts 建 tag 时完全一致
// （getRelativePath(workspaceFolders[0].uri.path, doc.uri.path)）。
function relFileFor(editor: vscode.TextEditor): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return getRelativePath(folders[0].uri.path, editor.document.uri.path);
}

// 只在真实磁盘文件上工作：相对路径锚只对 file scheme 有意义。
function isEligible(editor: vscode.TextEditor): boolean {
  return editor.document.uri.scheme === "file";
}

// ── 要点 2：折叠 ─────────────────────────────────────────────────────────────
//
// 光标离开一条含 marker 的行时触发：解析出 code/note/marker，upsert 一条 inline tag，
// 再把 buffer 剥回干净代码并存盘。
export async function collapseLine(
  editor: vscode.TextEditor,
  line0: number
): Promise<void> {
  if (line0 < 0 || line0 >= editor.document.lineCount) return;

  const doc = editor.document;
  const markers = markersForDocument(doc);
  const lineText = doc.lineAt(line0).text;

  const parsed = parseInlineNote(lineText, markers);
  if (!parsed) return; // 该行已无 marker（例如用户把它删了）——无事可做

  const file = relFileFor(editor);
  if (file === undefined) return;
  const line1 = line0 + 1;

  const existing = findTagByLocation(getStore(), file, line1);

  // 用户把 note 删空、且该行原本没有 tag → 视为「不要这条 note」，仅剥净 buffer、不建 tag。
  if (parsed.note.length === 0 && !existing) {
    await stripBuffer(editor, line0, parsed.code);
    return;
  }

  // 身份锚一律用剥净后的代码，绝不含 marker。
  const anchorText = lineAnchorText(parsed.code);
  const pattern = linePattern(parsed.code);

  // IMPORTANT#2：先剥净 buffer 并检查结果。editor.edit 无法应用时 resolve false（不
  // throw）。若失败，绝不继续 upsert + saveStore——那会把「buffer 已干净」的假象落盘，
  // 而 buffer 里的 //me: 私密文本仍在，造成锚与磁盘状态说谎。
  const stripped = await stripBuffer(editor, line0, parsed.code);
  if (!stripped) return;

  if (existing) {
    // 一行一签：命中已有 tag 就并入其 note，不新建第二条。
    existing.note = parsed.note;
    // 折叠是 inline tag 锚的唯一改写点（decorator 不再随同行编辑刷新 inline 锚），
    // 故每次折叠都从剥净后的干净代码重锚，避免曾被编辑过的底层代码留下旧锚。
    existing.text = anchorText;
    existing.pattern = pattern;
    // 若命中的是正式标签则不强制置 inline（遵 brief 原话「只更 note」）；只有本就是
    // inline 的 tag 才记 inlineMarker（对正式标签它无意义）。
    if (existing.inline) {
      existing.inlineMarker = parsed.marker;
    }
  } else {
    // 照抄 recorder/commands.ts:430-439 的构造，另加 inline 三件套。
    const tag: TagNode = {
      type: "tag",
      id: `t_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 6)}`,
      note: parsed.note,
      file,
      line: line1,
      pattern,
      text: anchorText,
      original: anchorText,
      createdAt: new Date().toISOString(),
      inline: true,
      notePosition: "end",
      inlineMarker: parsed.marker
    };
    const inbox = getOrCreateInbox(getStore(), newFolderId);
    addTag(getStore(), tag, inbox.id);
  }

  await saveStore();
}

// 把整行替换为干净代码。要点 6：undoStopBefore/After:false 让这次编辑并入相邻用户
// 编辑，撤销时不至于突兀（已知残留见文件尾注）。busy 包住 edit 防自触发递归。
// 返回 editor.edit 的布尔结果：VS Code 无法应用编辑时 resolve false（不 throw），
// 调用方据此避免在剥净失败时误报成功。
async function stripBuffer(
  editor: vscode.TextEditor,
  line0: number,
  code: string
): Promise<boolean> {
  const range = editor.document.lineAt(line0).range;
  busy = true;
  try {
    return await editor.edit(
      b => b.replace(range, code),
      { undoStopBefore: false, undoStopAfter: false }
    );
  } finally {
    busy = false;
  }
}

// ── 要点 3：展开 ─────────────────────────────────────────────────────────────
//
// 光标进入一条有 inline tag、且当前行不含 marker 的行时触发：按 tag 记住的 marker 把
// note 文本注回行尾。只改 buffer，不动 sidecar。
export async function expandLine(
  editor: vscode.TextEditor,
  line0: number
): Promise<void> {
  if (line0 < 0 || line0 >= editor.document.lineCount) return;

  const doc = editor.document;
  const file = relFileFor(editor);
  if (file === undefined) return;

  const tag = findTagByLocation(getStore(), file, line0 + 1);
  if (!tag || tag.inline !== true) return;

  const lineText = doc.lineAt(line0).text;
  const markers = markersForDocument(doc);
  // 已经含 marker 就别重复注入（防御：正常触发路径已排除含 marker 的行）。
  if (parseInlineNote(lineText, markers) !== null) return;

  const marker = tag.inlineMarker ?? markers[0];
  if (!marker) return;
  const text = toInlineText(lineText, tag.note, marker);

  const range = doc.lineAt(line0).range;
  let ok = false;
  busy = true;
  try {
    // IMPORTANT#2：同样检查 editor.edit 结果。展开不落盘，失败仅意味着注入没发生；
    // 早退即可，调用方后续的折叠会因该行不含 marker 而自然成为 no-op。
    ok = await editor.edit(
      b => b.replace(range, text),
      { undoStopBefore: false, undoStopAfter: false }
    );
  } finally {
    busy = false;
  }
  if (!ok) return;
}

// ── 要点 4：触发器 onDidChangeTextEditorSelection ────────────────────────────
//
// 维护 per-editor 的「当前展开行」expandedLine：
//   - 光标离开展开行 → 折叠它，清空 expandedLine；
//   - 光标进入一条有 inline tag 且不含 marker 的行 → 展开它，记成 expandedLine；
//   - 光标在一条含 marker 但没 tag 的行（用户刚敲的）→ 不立即折叠（人还在打字），
//     只把它记成 expandedLine，等光标离开时由第一条分支折叠。
async function onSelectionChange(
  e: vscode.TextEditorSelectionChangeEvent
): Promise<void> {
  if (busy) return; // 自己的 edit 引发的 selection 事件，忽略
  if (!inlineConfig().enabled) return; // 整层短路

  const editor = e.textEditor;
  if (!isEligible(editor)) return;
  if (e.selections.length === 0) return;

  const doc = editor.document;
  const key = doc.uri.toString();
  const cur0 = e.selections[0].active.line;
  const prev = expandedLines.get(key) ?? null;

  // 离开上一条展开/待折叠行 → 折叠它。
  if (prev !== null && prev !== cur0) {
    await collapseLine(editor, prev);
    expandedLines.set(key, null);
  }

  // 重新评估当前行（折叠可能已改动文档，重新读取）。
  if (cur0 < 0 || cur0 >= doc.lineCount) {
    expandedLines.set(key, null);
    return;
  }
  const lineText = doc.lineAt(cur0).text;
  const markers = markersForDocument(doc);

  if (parseInlineNote(lineText, markers) !== null) {
    // 含 marker（用户刚敲的，或刚被展开的）：记住，等离开再折叠，别打断打字。
    expandedLines.set(key, cur0);
    return;
  }

  const file = relFileFor(editor);
  if (file === undefined) {
    expandedLines.set(key, null);
    return;
  }
  const tag = findTagByLocation(getStore(), file, cur0 + 1);
  if (tag && tag.inline === true) {
    await expandLine(editor, cur0);
    expandedLines.set(key, cur0);
  } else {
    expandedLines.set(key, null);
  }
}

// ── 注册 ─────────────────────────────────────────────────────────────────────
//
// 与 decorator.ts 的做法一致：直接挂 vscode 监听器，不 push 到 context.subscriptions
// （随扩展生命周期存活）。
export function registerInlineNotes(): void {
  vscode.window.onDidChangeTextEditorSelection(e => {
    // fire-and-forget：selection 回调不能 await，内部自带 busy 防抖。
    void onSelectionChange(e);
  });

  // 编辑器关闭时清掉它的展开状态，避免 Map 无限增长。
  vscode.workspace.onDidCloseTextDocument(doc => {
    expandedLines.delete(doc.uri.toString());
  });
}

// ── 要点 6：undo 交织（显式验收项，非自动化测试）───────────────────────────────
//
// 折叠/展开的编辑都用 undoStopBefore/After:false，并入相邻用户编辑、减少突兀。
// 已知残留：光标停在展开行时按 Ctrl+Z，可能撤出一次折叠让 marker 文本短暂复活——
// 属外观毛刺，非数据/隐私问题，靠 Task 6 的扫残留兜底堵磁盘泄漏。验收时须实测记录。
