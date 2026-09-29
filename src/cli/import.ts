// cjtag 核心逻辑：所有命令都从工作区根出发操作 <root>/.code-jump-tags/store.json。
// 标签字段配方与 src/recorder/commands.ts 的 addTag 完全一致（id / pattern / text /
// original / createdAt），锚点由目标行真实内容算出来，保证插件能正常漂移恢复。
// 只依赖 lodestar 的纯模块（types / tree / relocate），绝不 import vscode。

import * as fs from "fs";
import * as path from "path";
import {
  LodestarStore,
  FolderNode,
  TagNode,
  TreeNode
} from "../lodestar/types";
import {
  addTag,
  createEmptyStore,
  createFolder,
  getOrCreateInbox,
  INBOX_TITLE,
  newFolderId,
  removeToTrash,
  serialize
} from "../lodestar/tree";
import { lineAnchorText, linePattern } from "../lodestar/relocate";

export const STORE_DIR = ".code-jump-tags";
export const STORE_FILE = "store.json";
export const INBOX_PATH = INBOX_TITLE;

// 结构化的命令错误：index.ts 按 code 决定退出码（E_VALIDATION -> 2，其余 -> 1），
// 其余字段原样进信封的 error 块。
export class CliError extends Error {
  code: string;
  details: Record<string, unknown>;
  suggestion?: string;

  constructor(
    code: string,
    message: string,
    details: Record<string, unknown> = {},
    suggestion?: string
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
    this.suggestion = suggestion;
  }
}

export interface ImportEntry {
  folder?: string | null;
  file: string;
  line: number;
  note: string;
  text?: string | null;
}

export interface ImportResult {
  added: number;
  folders_created: string[];
  store: string;
}

export interface TagSummary {
  type: "tag";
  id: string;
  note: string;
  file: string;
  line: number;
}

export interface FolderSummary {
  type: "folder";
  title: string;
  path: string;
  hidden?: boolean;
  children: SummaryNode[];
}

export type SummaryNode = FolderSummary | TagSummary;

// 从 startDir 向上找第一个含 .git 或 .code-jump-tags 的祖先，即工作区根。
// .git 可能是文件（git worktree 场景），所以只用 existsSync 判断存在即可。
export function resolveWorkspaceRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (;;) {
    if (
      fs.existsSync(path.join(dir, ".git")) ||
      fs.existsSync(path.join(dir, STORE_DIR))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new CliError(
    "E_NOT_FOUND",
    "未找到工作区根(向上找不到 .git 或 .code-jump-tags)",
    { cwd: startDir },
    "用 --cwd 指向工作区内的目录"
  );
}

// 读目标文件并解码：不少嵌入式 C 工程是 GB2312，先按 UTF-8 无强校验解，解出替换符
// U+FFFD 就整体换 GBK 重解。按 /\r?\n/ 切行（与 relocate 的切法一致）。
function readLines(absPath: string): string[] {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(absPath);
  } catch (e) {
    throw new CliError("E_IO", `读取文件失败: ${absPath}`, {
      path: absPath,
      detail: String(e)
    });
  }
  let text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  if (text.includes("\uFFFD")) {
    text = new TextDecoder("gbk").decode(buf);
  }
  return text.split(/\r?\n/);
}

interface ValidatedEntry {
  folder: string | undefined;
  file: string;
  line: number;
  note: string;
  text: string | undefined;
  lines: string[];
}

// 校验单条输入。任何一条不过整批拒绝，所以这里遇到第一条问题就抛，不写入任何东西。
function validateEntry(
  root: string,
  rec: unknown,
  index: number,
  linesCache: Map<string, string[]>
): ValidatedEntry {
  // 类型注解写在变量上而不是箭头函数上：TS 只对「显式标注了返回 never 的标识符」
  // 做控制流终止分析，光在箭头函数体上写 : never 不算，调用点之后 unknown 不会被窄化。
  const fail: (field: string, message: string) => never = (field, message) => {
    throw new CliError(
      "E_VALIDATION",
      `第 ${index} 条导入无效: ${message}`,
      { index, field, message },
      "修正后重试"
    );
  };

  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) {
    fail("entry", "不是对象");
  }
  const r = rec as Record<string, unknown>;

  const note = r.note;
  if (typeof note !== "string" || note.trim().length === 0) {
    fail("note", "note 必须是非空字符串");
  }

  const file = r.file;
  if (typeof file !== "string" || file.length === 0) {
    fail("file", "file 必须是字符串");
  }
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    fail("file", `路径越界: ${file}`);
  }

  let lines = linesCache.get(abs);
  if (!lines) {
    if (!fs.existsSync(abs)) {
      fail("file", `文件不存在: ${file}`);
    }
    if (!fs.statSync(abs).isFile()) {
      fail("file", `不是文件: ${file}`);
    }
    lines = readLines(abs);
    linesCache.set(abs, lines);
  }

  const lineRaw = r.line;
  const lineNum = typeof lineRaw === "number" ? lineRaw : Number(lineRaw);
  const looksNumeric =
    typeof lineRaw === "number" ||
    (typeof lineRaw === "string" && lineRaw.trim() !== "");
  if (!looksNumeric) {
    fail("line", "line 必须是整数");
  }
  if (!Number.isInteger(lineNum) || lineNum < 1) {
    fail("line", "line 必须是 >= 1 的整数");
  }
  if (lineNum > lines.length) {
    fail("line", `line ${lineNum} 超过文件总行数 ${lines.length}`);
  }

  const textRaw = r.text;
  return {
    folder: typeof r.folder === "string" && r.folder.trim() !== "" ? r.folder : undefined,
    file,
    line: lineNum,
    note,
    text: typeof textRaw === "string" ? textRaw : undefined,
    lines
  };
}

// 批量导入：逐条校验全过后才写盘。数组顺序即阅读顺序，同一文件夹内按出现先后 push。
export function importEntries(root: string, entries: ImportEntry[]): ImportResult {
  const store = loadStore(root);
  const linesCache = new Map<string, string[]>();
  const validated: ValidatedEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    validated.push(validateEntry(root, entries[i], i, linesCache));
  }

  const createdFolders: string[] = [];
  const usedIds = collectIds(store);

  for (const v of validated) {
    // 显式给了 text 就用它当 lineText（跳过读文件）；否则用文件第 line 行 trim 后的内容。
    const lineText =
      v.text !== undefined ? v.text : v.lines[v.line - 1].trim();
    const pattern = lineText ? linePattern(lineText) : undefined;
    const text = lineText ? lineAnchorText(lineText) : undefined;
    const tag: TagNode = {
      type: "tag",
      id: nextTagId(usedIds),
      note: v.note,
      // 存盘用正斜杠的相对路径，与插件 getRelativePath 的约定一致
      file: v.file.replace(/\\/g, "/"),
      line: v.line,
      pattern,
      text,
      original: text,
      createdAt: new Date().toISOString()
    };

    if (v.folder === undefined) {
      const hadInbox = hasInbox(store);
      const inbox = getOrCreateInbox(store, newFolderId);
      if (!hadInbox) createdFolders.push(INBOX_PATH);
      addTag(store, tag, inbox.id);
    } else {
      const node = resolveFolderPath(store, v.folder, createdFolders);
      addTag(store, tag, node.id);
    }
  }

  writeStore(root, store);
  return {
    added: validated.length,
    folders_created: createdFolders,
    store: storeFilePath(root)
  };
}

// 按 "/" 分层逐级找/建文件夹：已存在的同名层级必须复用，只有真正新建的才记进 created。
function resolveFolderPath(
  store: LodestarStore,
  folderPath: string,
  created: string[]
): FolderNode {
  const parts = folderPath.split("/").filter(s => s.length > 0);
  let parentId: string | undefined;
  let children: TreeNode[] = store.tree;
  let node: FolderNode | undefined;
  let prefix = "";
  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part;
    const found = children.find(
      (n): n is FolderNode => n.type === "folder" && n.title === part
    );
    if (found) {
      node = found;
    } else {
      node = createFolder(store, part, newFolderId, parentId);
      created.push(prefix);
    }
    parentId = node.id;
    children = node.children;
  }
  return node!;
}

function hasInbox(store: LodestarStore): boolean {
  return store.tree.some(n => n.type === "folder" && n.inbox === true);
}

// 新标签 id：与插件同款配方，但必须保证一批内以及和 store 既有 id 都不撞，
// 撞了重新生成（随机部分重抽）。
function nextTagId(used: Set<string>): string {
  for (;;) {
    const id = `t_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
}

function collectIds(store: LodestarStore): Set<string> {
  const ids = new Set<string>();
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      ids.add(n.id);
      if (n.type === "folder") walk(n.children);
    }
  };
  walk(store.tree);
  if (store.trash) for (const t of store.trash) walk([t.node]);
  return ids;
}

// 列标签树：不带 --folder 列整树，带 --folder 只列该文件夹子树。
export function listTags(
  root: string,
  folderPath?: string
): { tree: SummaryNode[] } {
  const store = loadStore(root);
  if (folderPath) {
    const found = findFolderByPath(store, folderPath);
    if (!found) {
      throw new CliError("E_NOT_FOUND", `文件夹不存在: ${folderPath}`, {
        folder: folderPath
      });
    }
    // 传父路径而不是该文件夹自己的路径：summarize 会再拼一次 title，
    // 传 folderPath 会拼成「冒烟测试/冒烟测试」。
    const parentPath = folderPath.split("/").filter(s => s).slice(0, -1).join("/");
    return { tree: [summarize(found.folder, parentPath)] };
  }
  return { tree: store.tree.map(n => summarize(n, "")) };
}

function findFolderByPath(
  store: LodestarStore,
  folderPath: string
): { folder: FolderNode } | undefined {
  const parts = folderPath.split("/").filter(s => s.length > 0);
  let children: TreeNode[] = store.tree;
  let folder: FolderNode | undefined;
  for (const part of parts) {
    const hit = children.find(
      (n): n is FolderNode => n.type === "folder" && n.title === part
    );
    if (!hit) return undefined;
    folder = hit;
    children = hit.children;
  }
  return folder ? { folder } : undefined;
}

function summarize(n: TreeNode, prefix: string): SummaryNode {
  if (n.type === "folder") {
    const p = prefix ? `${prefix}/${n.title}` : n.title;
    const summary: FolderSummary = {
      type: "folder",
      title: n.title,
      path: p,
      children: n.children.map(c => summarize(c, p))
    };
    if (n.hidden) summary.hidden = true;
    return summary;
  }
  return { type: "tag", id: n.id, note: n.note, file: n.file, line: n.line };
}

// 删除一个文件夹及其全部标签。走回收站(removeToTrash)而不是直接摘掉：
// 重写教程时整章清掉是常事，删错了还能从侧边栏的「从回收站恢复」捞回来。
export function clearFolder(
  root: string,
  folderPath: string
): { removed_folder: string; removed_tags: number } {
  const store = loadStore(root);
  const found = findFolderByPath(store, folderPath);
  if (!found) {
    throw new CliError("E_NOT_FOUND", `文件夹不存在: ${folderPath}`, {
      folder: folderPath
    });
  }
  const count = countTags(found.folder);
  removeToTrash(store, found.folder.id);
  writeStore(root, store);
  return { removed_folder: folderPath, removed_tags: count };
}

// 隐藏/显示文件夹在编辑器里的标记(子文件夹随之继承),侧边栏照常列出。
export function setFolderHiddenByPath(
  root: string,
  folderPath: string,
  hidden: boolean
): { folder: string; hidden: boolean } {
  const store = loadStore(root);
  const found = findFolderByPath(store, folderPath);
  if (!found) {
    throw new CliError("E_NOT_FOUND", `文件夹不存在: ${folderPath}`, {
      folder: folderPath
    });
  }
  if (hidden) found.folder.hidden = true;
  else delete found.folder.hidden;
  writeStore(root, store);
  return { folder: folderPath, hidden };
}

function countTags(node: TreeNode): number {
  if (node.type === "tag") return 1;
  return node.children.reduce((sum, c) => sum + countTags(c), 0);
}

function storeFilePath(root: string): string {
  return path.join(root, STORE_DIR, STORE_FILE);
}

// store.json 不存在视为空 store；存在但损坏/结构不合法则报错，绝不静默清空。
function loadStore(root: string): LodestarStore {
  const p = storeFilePath(root);
  if (!fs.existsSync(p)) return createEmptyStore();
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    throw new CliError("E_IO", "读取 store 失败", { path: p, detail: String(e) });
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new CliError(
      "E_IO",
      "store.json 解析失败",
      { path: p, detail: String(e) },
      "修复或删除 store.json"
    );
  }
  if (
    data !== null &&
    typeof data === "object" &&
    (data as { version?: unknown }).version === 1 &&
    Array.isArray((data as { tree?: unknown }).tree)
  ) {
    return data as LodestarStore;
  }
  throw new CliError("E_IO", "store.json 结构不合法", { path: p });
}

function writeStore(root: string, store: LodestarStore): void {
  const p = storeFilePath(root);
  try {
    fs.mkdirSync(path.join(root, STORE_DIR), { recursive: true });
    fs.writeFileSync(p, serialize(store), "utf8");
  } catch (e) {
    throw new CliError("E_IO", "写入 store 失败", { path: p, detail: String(e) });
  }
}
