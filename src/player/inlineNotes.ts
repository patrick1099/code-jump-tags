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
import { EXTENSION_NAME } from "../constants";
import { getStore, saveStore } from "../lodestar/persistence";
import {
  addTag,
  findInlineTagByLocation,
  findNode,
  getOrCreateInbox,
  newFolderId,
  removeToTrash,
  setInline
} from "../lodestar/tree";
import { lineAnchorText, linePattern } from "../lodestar/relocate";
import {
  findMarker,
  fullMarkers,
  parseInlineNote,
  stripInlineNotesFromText,
  toInlineText
} from "../lodestar/inlineNote";
import { removeSuspects } from "../lodestar/suspect";
import { DEFAULT_EXCLUDE, isExcluded } from "../lodestar/exclude";

// 排除名单也现读，跟着用户设置走（同 inlineConfig）。
export function excludePatterns(): string[] {
  return vscode.workspace
    .getConfiguration("codeJumpTags")
    .get<string[]>("exclude", DEFAULT_EXCLUDE);
}
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

// 「归一化文本」：把文档里所有展开态的 marker 尾巴剥掉后的全文，行数不变。
//
// 任何要拿去做锚匹配的文件文本都必须走这里，否则一条正在展开的行会让该行上的所有
// 标签（含同行并存的正式标签）被判成失配 —— 身份锚存的是剥净的代码，而 buffer 此刻
// 带着 `//me: 私记`。功能关闭时原样返回：没人会注入 marker，也就无需剥。
export function canonicalText(doc: vscode.TextDocument, text?: string): string {
  const raw = text ?? doc.getText();
  if (!inlineConfig().enabled) return raw;
  return stripInlineNotesFromText(raw, markersForDocument(doc));
}

// 删除一条随手私记：连同它在可疑注册表里的残留一起清掉。走回收站（与树上的删除
// 同一条路），所以误删可从「回收站」里捞回来。
async function deleteInlineTag(tagId: string): Promise<void> {
  removeToTrash(getStore(), tagId);
  removeSuspects([tagId]);
  await saveStore();
}

// ── 要点 5：re-entrancy 防抖 ─────────────────────────────────────────────────
//
// `collapseLine`/`expandLine` 里的 `editor.edit` 会回头触发 `onDidChangeTextDocument`
// （decorator.ts 的 trackLineShifts）与可能的 selection 事件。模块级 `busy` 在进入
// edit 前置位、`finally` 复位；所有事件回调开头 `if (busy) return;`，避免自触发递归。
// 计数而非布尔：折叠/展开会嵌套在 handleCursor 的临界区里，布尔的 finally 会在内层
// 提前把闸放掉。
let busyDepth = 0;
const isBusy = (): boolean => busyDepth > 0;

// ── 串行闸 ───────────────────────────────────────────────────────────────────
//
// selection / active-editor 回调都是 fire-and-forget 的，VS Code 不会等上一个跑完再
// 投递下一个。而 `collapseLine` 末尾的 `await saveStore()` 是个 busy 已复位的窗口——
// 第二个事件能在此挤进来，对同一行再折叠/再展开一次：marker 被重新注回刚剥净的行，
// 或刚建好的标签被当成「用户删了」删掉。所有会改 buffer / store 的路径统一排队。
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

// per-editor 的「当前展开行」，键用 document uri（editor 对象本身是易变的）。
// 它同时是「这一行的 marker 是我们注进去的」这一事实的唯一记录——删除手势要靠它
// 区分「用户把私记删了」和「这行本来就没 marker」。
const expandedLines = new Map<string, number | null>();

// 工作区相对路径：取法与 recorder/commands.ts 建 tag 时完全一致
// （getRelativePath(workspaceFolders[0].uri.path, doc.uri.path)）。
function relFileFor(editor: vscode.TextEditor): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return getRelativePath(folders[0].uri.path, editor.document.uri.path);
}

// 只在真实磁盘文件上工作：相对路径锚只对 file scheme 有意义。并且跳过排除名单——
// 尤其是扩展自己的 `.code-jump-tags/`：store.json 里存着 note 文本，被当普通文件扫描
// 时其中的 marker 会被折叠、反过来改写 store.json。
function isEligible(editor: vscode.TextEditor): boolean {
  if (editor.document.uri.scheme !== "file") return false;
  const file = relFileFor(editor);
  if (file === undefined) return false;
  return !isExcluded(file, excludePatterns());
}

// ── 要点 2：折叠 ─────────────────────────────────────────────────────────────
//
// 光标离开一条含 marker 的行时触发：解析出 code/note/marker，upsert 一条 inline tag，
// 再把 buffer 剥回干净代码并存盘。
export async function collapseLine(
  editor: vscode.TextEditor,
  line0: number,
  // 只有「光标离开一条我们展开过的行」这条路径才带 true。删除是个不可逆的手势，
  // 必须确认这一行的 marker 本来就是我们注进去的、现在被用户抹掉了；扫残留兜底
  // （rescanDocument）遍历的是任意行，绝不能把「这行本来就没 marker」当成删除意图。
  wasExpanded = false
): Promise<void> {
  if (line0 < 0 || line0 >= editor.document.lineCount) return;

  const doc = editor.document;
  const markers = markersForDocument(doc);
  const lineText = doc.lineAt(line0).text;

  const parsed = parseInlineNote(lineText, markers);

  const file = relFileFor(editor);
  if (file === undefined) return;
  const line1 = line0 + 1;

  // 只找 INLINE tag：同一行若已有正式标签，绝不把它当「existing」误覆盖——
  // 正式标签与随手 note 必须能在同一行共存，互不覆盖对方的 note。
  const existing = findInlineTagByLocation(getStore(), file, line1);

  // 「删掉行内那段文字 = 删掉这条私记」。sidecar 是唯一真源，所以在此之前，把
  // `//me: 私记` 从行里删掉是**没有意义**的：tag 还在，光标一回来 expandLine 就把它
  // 原样注回去，用户看到的就是「删不掉、还越删越多」。这里补上那个出口——光标离开
  // 一条已无 marker 的行时，若该行挂着 inline tag，就删掉它。
  if (!parsed) {
    if (wasExpanded && existing) await deleteInlineTag(existing.id);
    return;
  }

  // note 被清空（只剩一个光秃秃的 marker）同样按「不要这条」处理：剥净 buffer，
  // 该行若有 inline tag 一并删掉——留着它只会渲染一条空小字，并在下次展开时把
  // `//me: ` 再吐回行尾，是同一个「删不掉」的另一张脸。绝不碰同行的正式标签。
  if (parsed.note.length === 0) {
    await stripBuffer(editor, line0, parsed.code);
    if (existing) await deleteInlineTag(existing.id);
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
    // 命中的是这一行已有的 INLINE tag（findInlineTagByLocation 保证，绝不会是
    // 该行上可能并存的正式标签）→ 并入其 note，不新建第二条，也绝不去动同一行
    // 若有的正式标签。
    existing.note = parsed.note;
    // 折叠是 inline tag 锚的唯一改写点（decorator 不再随同行编辑刷新 inline 锚），
    // 故每次折叠都从剥净后的干净代码重锚，避免曾被编辑过的底层代码留下旧锚。
    existing.text = anchorText;
    existing.pattern = pattern;
    existing.inlineMarker = parsed.marker;
  } else {
    // 该行没有 inline tag——可能压根没 tag，也可能只有一个正式标签（此时新建一条
    // 独立的 inline tag 与它并存在同一行，绝不合并进正式标签、不碰它的 note）。
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
  busyDepth++;
  try {
    return await editor.edit(
      b => b.replace(range, code),
      { undoStopBefore: false, undoStopAfter: false }
    );
  } finally {
    busyDepth--;
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

  const tag = findInlineTagByLocation(getStore(), file, line0 + 1);
  if (!tag) return;

  const lineText = doc.lineAt(line0).text;
  const markers = markersForDocument(doc);
  // 已经含 marker 就别重复注入（防御：正常触发路径已排除含 marker 的行）。
  if (parseInlineNote(lineText, markers) !== null) return;

  const marker = tag.inlineMarker ?? markers[0];
  if (!marker) return;

  // 残骸守卫：toInlineText 是把 note 拼到**当前行文本尾巴**上。若用户只删掉了 marker
  // 而把 note 文字留在了行里，再展开就变成 `code  私记  //me: 私记`，每删一轮多沉淀
  // 一份——正是「无限增殖」。当前行已经含有这段 note 时一律不注入。
  if (tag.note && lineText.includes(tag.note)) return;

  const text = toInlineText(lineText, tag.note, marker);

  const range = doc.lineAt(line0).range;
  let ok = false;
  busyDepth++;
  try {
    // IMPORTANT#2：同样检查 editor.edit 结果。展开不落盘，失败仅意味着注入没发生；
    // 早退即可，调用方后续的折叠会因该行不含 marker 而自然成为 no-op。
    ok = await editor.edit(
      b => b.replace(range, text),
      { undoStopBefore: false, undoStopAfter: false }
    );
  } finally {
    busyDepth--;
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
  if (isBusy()) return; // 自己的 edit 引发的 selection 事件，忽略
  if (!inlineConfig().enabled) return; // 整层短路

  const editor = e.textEditor;
  if (!isEligible(editor)) return;
  if (e.selections.length === 0) return;

  // 排队执行。事件里带的 selection 到临界区时可能已经过期（用户还在动光标），
  // 所以 handleCursor 里一律现读 editor.selection，不用事件负载。
  await serialize(() => handleCursor(editor));
}

async function handleCursor(editor: vscode.TextEditor): Promise<void> {
  busyDepth++;
  try {
    const doc = editor.document;
    const key = doc.uri.toString();
    const cur0 = editor.selection?.active.line;
    if (cur0 === undefined) return;
    const prev = expandedLines.get(key) ?? null;

    // 光标没离开这一行 —— 用户正在这行上编辑，什么都别做。
    //
    // 这是「无限增殖」的病灶：以前这里只跳过了折叠，却继续往下走到「这行有标签吗？
    // 有 → 展开」。用户在展开态一路按退格，把 `//me:` 啃成 `//me` 的那一刻 marker 就
    // 认不出来了，于是这条路径判定「有标签、没展开」，当场把整条私记原地重注一份，
    // 拼在残骸后面：`code  //me  //me: 私记`。再退格再啃坏，再注一份——越删越长。
    //
    // 展开/折叠的语义本来就只跟「进入/离开这一行」挂钩，行内编辑一律不该触发任何注入。
    // 注意 expandedLines 这里保持不动（仍指向本行）：用户若把 marker 删干净再点走，
    // 离开时的折叠会带着删除意图执行，正好就是「删掉私记」那个手势。
    if (prev === cur0) return;

    // 离开上一条展开/待折叠行 → 折叠它。prev 非空即代表这行的 marker 是我们注进去
    // 的（或用户刚敲、还没折叠），所以这条路径带上删除意图：marker 没了就是用户删了。
    if (prev !== null && prev !== cur0) {
      expandedLines.set(key, null); // 先清，失败也不留下会被二次折叠的悬空状态
      await collapseLine(editor, prev, true);
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
    const tag = findInlineTagByLocation(getStore(), file, cur0 + 1);
    if (tag) {
      await expandLine(editor, cur0);
      expandedLines.set(key, cur0);
    } else {
      expandedLines.set(key, null);
    }
  } finally {
    busyDepth--;
  }
}

// ── 要点 7：扫残留兜底 ────────────────────────────────────────────────────────
//
// 堵「光标停在展开行时被 autosave/提交」的漏：selection 触发器只在光标离开一行时
// 折叠它，若那次离开被跳过（例如切换到别的编辑器/文件，没经过同文档内的 selection
// 事件），marker 文本连同私密 note 就可能原样留在 buffer 里被存盘/提交。这里在编辑
// 器变为 active 时，把整份文档过一遍：任何命中 marker 的行都折叠掉，兜住上述漏洞。
//
// 从后往前遍历：折叠只改写本行、不删行，理论上正反向都安全，但从后往前对未来若扩展
// 出「跨行」的折叠更稳（不会因为前面行数变化打乱后面行号）。跳过光标当前行——那行
// 可能是用户正在敲的 note，被吞掉会打断输入（同 onSelectionChange 的「待折叠」语义）。
export async function rescanDocument(editor: vscode.TextEditor): Promise<void> {
  if (isBusy()) return; // 有折叠/展开 edit 正在进行，避免重入
  if (!isEligible(editor)) return;
  if (!inlineConfig().enabled) return;

  await serialize(async () => {
    busyDepth++;
    try {
      const doc = editor.document;
      const key = doc.uri.toString();
      const markers = markersForDocument(doc);

      for (let line0 = doc.lineCount - 1; line0 >= 0; line0--) {
        // 光标行每次迭代都现读，不在循环外缓存：collapseLine 内部会 await（editor.edit
        // IPC + saveStore 落盘），光标在此期间可能被用户移到别处；缓存的旧值会让"正在
        // 敲的行"在后续迭代里被误判成非光标行而遭吞掉，正是要避免的那种漏。
        if (line0 === editor.selection?.active.line) continue; // 光标所在行可能正在被编辑，留给 selection 触发器
        const lineText = doc.lineAt(line0).text;
        if (findMarker(lineText, markers) === null) continue; // 无 marker，无事可做
        // 不带删除意图：这里遍历的是任意行，"没 marker"不等于"用户删了私记"。
        await collapseLine(editor, line0);
        // 这一行的 marker 已被扫掉，展开态记录必须同步作废——否则光标稍后离开时，
        // 那条 stale 的 expandedLine 会带着删除意图再折叠一次干净的行，把标签误删。
        if (expandedLines.get(key) === line0) expandedLines.set(key, null);
      }
    } finally {
      busyDepth--;
    }
  });
}

// ── 提权 / 降格命令 ───────────────────────────────────────────────────────────
//
// 与仓库其它树右键命令（见 lodestar/commands.ts 的 tagIdOf）同一套参数约定：命令
// 参数要么是裸 tagId 字符串，要么是带 `.tagLink.id` / `.tagId` 的树节点对象。
function tagIdOf(arg: string | any): string | undefined {
  if (typeof arg === "string") return arg;
  return arg?.tagLink?.id ?? arg?.tagId;
}

// 「提权为标签」：随手 note → 正式标签（setInline 清 inline/inlineMarker）。
// package.json 里这条命令的右键菜单挂在所有 `codeJumpTags.tag` 行上 —— 现有 when
// 词汇没法单独圈出「随手 note 行」（随手 note 只出现在 __inline__ 合成分组里，树
// 节点本身不带这个信息），因此命令内部按 inline 判空自行兜底：对本就是正式标签的
// 目标直接 no-op，不当噪音提示。
export async function promoteInlineNote(arg: string | any): Promise<void> {
  const tagId = tagIdOf(arg);
  if (!tagId) return;
  const store = getStore();
  const found = findNode(store, tagId);
  if (!found || found.node.type !== "tag" || !found.node.inline) return;
  setInline(store, tagId, false);
  await saveStore();
}

// 「降格为随手」：正式标签 → 随手 note（setInline 打 inline 标志），note 位置固定
// 挪到行尾（`notePosition = "end"`），呼应折叠时的落位约定。同 promoteInlineNote，
// 命令内部对已是随手 note 的目标 no-op。
export async function demoteToInlineNote(arg: string | any): Promise<void> {
  const tagId = tagIdOf(arg);
  if (!tagId) return;
  const store = getStore();
  const found = findNode(store, tagId);
  if (!found || found.node.type !== "tag" || found.node.inline) return;
  setInline(store, tagId, true);
  found.node.notePosition = "end";
  await saveStore();
}

// ── 注册 ─────────────────────────────────────────────────────────────────────
//
// 与 decorator.ts 的做法一致：直接挂 vscode 监听器，不 push 到 context.subscriptions
// （随扩展生命周期存活）。命令注册同样不进 subscriptions，照抄 commands.ts 的做法。
export function registerInlineNotes(): void {
  vscode.window.onDidChangeTextEditorSelection(e => {
    // fire-and-forget：selection 回调不能 await，内部自带 busy 防抖。
    void onSelectionChange(e);
  });

  // 编辑器变为 active（含切换回一个早已打开的文件）→ 扫一遍残留 marker。
  // fire-and-forget：事件回调不能 await，rescanDocument 内部自带 busy 防抖。
  vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor) {
      void rescanDocument(editor);
    }
  });

  // 手动兜底：给关掉了自动折叠触发点（或想立即清一遍当前文件）的人一个命令面板入口。
  vscode.commands.registerCommand(`${EXTENSION_NAME}.rescanInlineNotes`, () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      void rescanDocument(editor);
    }
  });

  // 树右键：提权/降格。均 fire-and-forget（命令回调不强制 await 亦可，但这里
  // 保持一致简单地不 await——两条命令内部自成一体，无需调用方等待）。
  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.promoteInlineNote`,
    (arg: any) => void promoteInlineNote(arg)
  );
  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.demoteToInlineNote`,
    (arg: any) => void demoteToInlineNote(arg)
  );

  // 编辑器关闭时清掉它的展开状态，避免 Map 无限增长。
  vscode.workspace.onDidCloseTextDocument(doc => {
    expandedLines.delete(doc.uri.toString());
  });

  // 启动时已经打开的编辑器也要扫一遍（同 decorator.ts registerDecorators 的
  // "Initial paint for the editor already open on startup" 做法）。
  if (vscode.window.activeTextEditor) {
    void rescanDocument(vscode.window.activeTextEditor);
  }
}

// ── 要点 6：undo 交织（显式验收项，非自动化测试）───────────────────────────────
//
// 折叠/展开的编辑都用 undoStopBefore/After:false，并入相邻用户编辑、减少突兀。
// 已知残留：光标停在展开行时按 Ctrl+Z，可能撤出一次折叠让 marker 文本短暂复活——
// 属外观毛刺，非数据/隐私问题，靠 Task 6 的扫残留兜底堵磁盘泄漏。验收时须实测记录。
