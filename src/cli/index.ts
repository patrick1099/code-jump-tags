// cjtag — code-jump-tags 的命令行入口。只做 argv 解析与 JSON 信封输出，
// 业务逻辑全在 ./import，绝不 import vscode。

import * as fs from "fs";
import * as path from "path";
import {
  CliError,
  ImportEntry,
  clearFolder,
  importEntries,
  listTags,
  resolveWorkspaceRoot,
  setFolderHiddenByPath
} from "./import";

const HELP = `# cjtag — Code Jump Tags 命令行写标签工具

给 code-jump-tags 扩展批量写标签：给出「文件 + 行号 + 文件夹层级 + 一句讲解」，
其余锚点字段自动补齐并写入工作区的 .code-jump-tags/store.json。

## Quick Reference

    cjtag import tags.json                # 从文件批量导入
    cjtag import - < tags.json            # 从 stdin 导入
    cjtag add --file a.c --line 28 --note "初始化 Systick" --folder "第1章 上电/1.1 时钟"
    cjtag list --folder "第1章 上电"
    cjtag clear --folder "第1章 上电/1.1 时钟"
    cjtag hide --folder "第1章 上电"          # 编辑器里不画该文件夹的标记
    cjtag show --folder "第1章 上电"

AI 调用请用 subprocess.run([...]) 传 list argv，不要拼命令行字符串。

## When to Use

- 让 AI 按阅读顺序批量埋标签，生成「顺读式代码教程」
- 从脚本 / CI 写入、查看或清空标签

## Command Reference

所有命令接受 --cwd DIR（默认 process.cwd()）。工作区根 = 从 --cwd 向上找第一个
含 .git 或 .code-jump-tags 的目录，决定标签写进哪个仓库。
注意 import 的输入文件与 --note-file 始终相对「调用者的当前目录」解析，不跟着
--cwd 走 —— 常见用法就是在自己目录备好 tags.json，再用 --cwd 指向目标仓库。

cjtag import <file.json|-> [--cwd DIR]
    从文件（或 - 从 stdin）读一个扁平数组，逐条写入 store。
    每条:
      {"folder":"第1章 上电/1.1 时钟","file":"Code/drv.c","line":28,
       "note":"初始化 Systick","text":"可选，该行原文"}
    folder 用 / 分层，路径上不存在的层级逐级自动创建；省略 / null / 空串进
    「未分组」收件箱。数组顺序即阅读顺序。

cjtag add --file F --line N --note TEXT [--folder "A/B"] [--cwd DIR]
    等价于导入一条。--note-file PATH 可代替 --note 从文件读（两者同给报错）。

cjtag list [--folder "A/B"] [--cwd DIR]
    输出树的精简形态；带 --folder 只列该文件夹子树。

cjtag clear --folder "A/B" [--cwd DIR]
    删除该文件夹及其全部标签，进回收站，可在侧边栏「从回收站恢复」。

cjtag hide --folder "A/B" [--cwd DIR]
cjtag show --folder "A/B" [--cwd DIR]
    隐藏 / 显示该文件夹在编辑器里的标签标记(行号栏图标、注释、悬停),子文件夹
    跟着隐藏。侧边栏照常列出,点标签跳过去时那一条会临时显示。list 输出里隐藏的
    文件夹带 "hidden": true。

## Side Effects & Safety

- import / add 会创建并写入 <工作区根>/.code-jump-tags/store.json（不存在则建目录和空 store）
- clear 把整个文件夹移入 store 的回收站，可从侧边栏恢复
- 全部命令输出 JSON 信封：成功走 stdout，失败走 stderr；stdout 永远只有一行 JSON

## Exit Codes

- 0 成功
- 1 运行 / 业务失败（E_NOT_FOUND / E_IO / E_INTERNAL）
- 2 参数或用法错误（E_VALIDATION）

## Errors & Recovery

- 未找到工作区根 → 用 --cwd 指向工作区内的目录
- 某条校验不过（note 空 / file 越界 / line 越界）→ 整批拒绝、不写入；看 error.details 的 index / field
- store.json 损坏 → 修复或删除后重试`;

interface ParsedArgs {
  flags: Map<string, string>;
  positionals: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const name = a.slice(2);
        if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
          flags.set(name, args[i + 1]);
          i++;
        } else {
          flags.set(name, "true");
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

function ok(data: unknown): void {
  process.stdout.write(
    JSON.stringify({ ok: true, data, error: null, meta: {} }) + "\n"
  );
}

function fail(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
  suggestion?: string
): void {
  const envelope = {
    ok: false,
    data: null,
    error: {
      code,
      message,
      details,
      retryable: false,
      suggestion: suggestion ?? ""
    },
    meta: {}
  };
  process.stderr.write(JSON.stringify(envelope) + "\n");
}

function readStdin(): string {
  if (process.stdin.isTTY) {
    throw new CliError(
      "E_VALIDATION",
      "期望从 stdin 读 JSON，但 stdin 是终端",
      {},
      "用管道输入，如: cat tags.json | cjtag import -"
    );
  }
  try {
    return fs.readFileSync(0, "utf8");
  } catch (e) {
    throw new CliError("E_IO", "从 stdin 读取失败", { detail: String(e) });
  }
}

function runImport(rest: string[]): void {
  const { flags, positionals } = parseArgs(rest);
  const cwd = flags.get("cwd") || process.cwd();
  const root = resolveWorkspaceRoot(cwd);
  const fileArg = positionals[0];
  if (!fileArg) {
    throw new CliError(
      "E_VALIDATION",
      "缺少 import 的文件参数",
      {},
      "cjtag import <file.json|->"
    );
  }
  let raw: string;
  if (fileArg === "-") {
    raw = readStdin();
  } else {
    const p = path.resolve(fileArg);
    try {
      raw = fs.readFileSync(p, "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err && err.code === "ENOENT") {
        throw new CliError("E_NOT_FOUND", `文件不存在: ${fileArg}`, {
          file: fileArg
        });
      }
      throw new CliError("E_IO", `读取文件失败: ${fileArg}`, {
        file: fileArg,
        detail: String(e)
      });
    }
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new CliError(
      "E_VALIDATION",
      "import 文件不是合法 JSON",
      { source: fileArg, detail: String(e) },
      "检查文件内容"
    );
  }
  if (!Array.isArray(data)) {
    throw new CliError("E_VALIDATION", "import 输入必须是数组", {
      source: fileArg
    });
  }
  ok(importEntries(root, data as ImportEntry[]));
}

function runAdd(rest: string[]): void {
  const { flags } = parseArgs(rest);
  const cwd = flags.get("cwd") || process.cwd();
  const root = resolveWorkspaceRoot(cwd);
  const file = flags.get("file");
  const lineRaw = flags.get("line");
  const note = flags.get("note");
  const noteFile = flags.get("note-file");
  const folder = flags.get("folder");
  if (!file) {
    throw new CliError(
      "E_VALIDATION",
      "缺少 --file",
      {},
      'cjtag add --file F --line N --note TEXT [--folder "A/B"]'
    );
  }
  if (!lineRaw) {
    throw new CliError("E_VALIDATION", "缺少 --line", {});
  }
  if (note === undefined && noteFile === undefined) {
    throw new CliError("E_VALIDATION", "缺少 --note", {});
  }
  if (note !== undefined && noteFile !== undefined) {
    throw new CliError("E_VALIDATION", "--note 与 --note-file 不能同时给", {});
  }
  let noteText: string;
  if (noteFile !== undefined) {
    const p = path.resolve(noteFile);
    try {
      noteText = fs.readFileSync(p, "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err && err.code === "ENOENT") {
        throw new CliError("E_NOT_FOUND", `--note-file 不存在: ${noteFile}`, {
          file: noteFile
        });
      }
      throw new CliError("E_IO", `读取 --note-file 失败: ${noteFile}`, {
        detail: String(e)
      });
    }
  } else {
    noteText = note!;
  }
  const entry: ImportEntry = {
    folder: folder || undefined,
    file,
    line: Number(lineRaw),
    note: noteText
  };
  ok(importEntries(root, [entry]));
}

function runList(rest: string[]): void {
  const { flags } = parseArgs(rest);
  const cwd = flags.get("cwd") || process.cwd();
  const root = resolveWorkspaceRoot(cwd);
  const folder = flags.get("folder");
  ok(listTags(root, folder || undefined));
}

function runClear(rest: string[]): void {
  const { flags } = parseArgs(rest);
  const cwd = flags.get("cwd") || process.cwd();
  const root = resolveWorkspaceRoot(cwd);
  const folder = flags.get("folder");
  if (!folder) {
    throw new CliError(
      "E_VALIDATION",
      "clear 需要 --folder",
      {},
      'cjtag clear --folder "A/B"'
    );
  }
  ok(clearFolder(root, folder));
}

function runSetHidden(rest: string[], hidden: boolean): void {
  const { flags } = parseArgs(rest);
  const cwd = flags.get("cwd") || process.cwd();
  const root = resolveWorkspaceRoot(cwd);
  const folder = flags.get("folder");
  if (!folder) {
    const cmd = hidden ? "hide" : "show";
    throw new CliError(
      "E_VALIDATION",
      `${cmd} 需要 --folder`,
      {},
      `cjtag ${cmd} --folder "A/B"`
    );
  }
  ok(setFolderHiddenByPath(root, folder, hidden));
}

function run(argv: string[]): void {
  // --ai-help 要在完整解析之前扫描（eager），否则未知子命令/缺参数会先拦下；
  // 尊重 "--" 终止语义，"--" 之后是操作数不算标志。
  const dashIdx = argv.indexOf("--");
  const pre = dashIdx >= 0 ? argv.slice(0, dashIdx) : argv;
  if (pre.includes("--ai-help")) {
    ok({ help: HELP });
    return;
  }

  const [cmd, ...rest] = argv;
  if (!cmd) {
    throw new CliError(
      "E_VALIDATION",
      "缺少子命令",
      {},
      "用 cjtag --ai-help 查看用法"
    );
  }
  switch (cmd) {
    case "import":
      runImport(rest);
      break;
    case "add":
      runAdd(rest);
      break;
    case "list":
      runList(rest);
      break;
    case "clear":
      runClear(rest);
      break;
    case "hide":
      runSetHidden(rest, true);
      break;
    case "show":
      runSetHidden(rest, false);
      break;
    default:
      throw new CliError(
        "E_VALIDATION",
        `未知子命令: ${cmd}`,
        { command: cmd },
        "用 cjtag --ai-help 查看用法"
      );
  }
}

function main(): void {
  let exitCode = 0;
  try {
    run(process.argv.slice(2));
  } catch (e) {
    if (e instanceof CliError) {
      exitCode = e.code === "E_VALIDATION" ? 2 : 1;
      fail(e.code, e.message, e.details, e.suggestion);
    } else {
      exitCode = 1;
      fail("E_INTERNAL", e instanceof Error ? e.message : String(e));
    }
  }
  if (exitCode !== 0) process.exitCode = exitCode;
}

main();
