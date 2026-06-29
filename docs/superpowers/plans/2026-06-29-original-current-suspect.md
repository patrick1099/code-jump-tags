# 0.7.0 original/current 匹配 — Plan 2/3：可疑态引擎 + 编辑器内呈现 + 动作 + 触发点 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **依赖 Plan 1**（`2026-06-29-original-current-core.md`）已落地：`TagNode.original`、`matchAnchor`/`resolveTagLine`/`findAnchorLine`/`backfillOriginal`、`retargetTag` 写 original、建标签写 original。开工前确认 Plan 1 已 merge 到 main 且 `npx vitest run` 全绿。

> **预检校准（2026-06-29，对照 Plan 1 已实现代码逐锚点核验，结论：本计划无需结构性调整）。** 已确认存在且形状一致：`src/extension.ts` 的 `activate`（`export async function`）、decorator `updateDecorations`/`clearDecorations` 及其循环 `for (const [, step, , line] of store.activeEditorSteps!)`（`line` 为 **0-based** 已解析显示行）、commands.ts 的 `./relocate`(`resolveTagLine,linePattern,lineAnchorText`)与 `./tree` import 组、`getStore/saveStore`(persistence)、`getRelativePath(root,filePath)`(utils)、`Uri/window/workspace`(vscode)、`undoTagMove`、`registerLodestarCommands` 的 `commands.registerCommand(...)` 列表、`gotoLocation`、tree.ts `findNode`、selection.ts 已 import `LodestarStore/TagNode/TreeNode/findNode`、`moveTagToCursor` 命令、package.json `confirmDelete`/`restoreFromTrash`/`commandPalette`。实施时仅留意以下 4 点：
>
> 1. **Task 5 硬可疑 hover 调 `moveTagToCursor?[{tagId: step.id}]`**：真实 `moveTagToCursor(node: any)`（commands.ts:394）按 0.6.1 惯例解析 `node?.tagLink?.id ?? node?.tagId`——开工时先确认它读得到 `.tagId`，否则按它真正接受的形状传参。
> 2. **Task 5 标记落点**：suspect 行用循环里的 0-based `line`（getTourSteps→resolveTagLine 算出的显示行），不要用 1-based 的 `suspect.line`；后者只进 hover 的命令参数（`promoteToOriginal` 内部 `doc.lineAt(line-1)` 要 1-based）。两者都源自同一 `matchAnchor`，对软可疑会指向同一候选行——保持这条不变量即可。
> 3. **Task 4 的 `createFileSystemWatcher("**/*")`** 在大仓库会对每个文件改动触发；`recheckFile` 对无标签文件是空操作（`collectTagsInFile` 返回空→早退），成本有界，但可考虑排除 `node_modules`/产物目录或只 watch「有标签的文件」以降噪。非阻塞。
> 4. **Task 3 Step 4 故意不 build**（动态 `import("../player/recheck")` 要等 Task 4 建文件）——保持该跨任务顺序，build 留到 Task 4 末尾。
>
> 另：本计划 Task 1 的可疑分类模型（original 命中→健康跳过；仅 current 命中→软可疑；皆失→硬可疑）已被「全选剪切→改→粘回」手势的集成测试（`test/lodestar/{cold-recovery,select-all-roundtrip}.integration.test.ts`）侧面验证——只要被标记行内容还在，original 优先匹配使其判为健康、不会误报可疑。

> ⚠️ **收尾修正（2026-06-29，终审后）：删除了「找回原行」(`recoverToOriginal`/`healTagToLine`)。** 它在任何可疑标签上结构性必然失败——可疑 ⟺ original 在文件里找不到，而该动作又靠同一个 `findAnchorLine(original)` 去找，必然扑空（它本想救的「current 被污染但 original 还在」场景已被 original-first 自愈、不会变可疑）。用户要的「漂移时更新身份」由〔采纳新位置〕(`promoteToOriginal`) 覆盖。故 Task 2 的 `healTagToLine`、Task 3 的 `recoverToOriginal`、Task 5 hover 里的「找回原行」按钮、Task 6 的对应命令/面板条目**均已连根删除**（commit 353067e）。最终：软可疑 hover =〔采纳新位置〕+〔移到光标行〕；硬可疑 =〔移到光标行〕。下文这些任务里仍写着「找回原行」的部分以本注为准、视为作废。

**Goal:** 在编辑器内把「失配」的标签如实呈现（灰 + ?gutter、hover 双行对照 + 动作按钮），并提供「采纳新位置 / 找回原行 / 手动校验」三个动作与可配置的重新校验触发点。

**Architecture:** 纯逻辑（可疑分类 `classifyFileTags` + 运行时可疑注册表，零 `vscode`，vitest 覆盖）+ 薄胶水（按文件 recheck、触发点监听、decorator 渲染、命令）。可疑状态**不持久化**，只活在运行时注册表里，靠触发点按文件填充。

**Tech Stack:** TypeScript、vitest、VS Code 扩展 API、webpack。

## Global Constraints

- 只在 `C:\Users\dell\Desktop\plugin-research\codetour` 工作；不碰 `C:\Users\dell\Desktop\需求`。
- 每个 commit 末尾追加：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- 不提交 vsix；`src/lodestar/` 纯模块禁 `import vscode`；在 `main` 上工作。
- 设计依据：`docs/superpowers/specs/2026-06-29-original-current-matching-design.md`。
- **铁律：本期新代码不得自动写 `original`。** 写 original 仅限：建标签、`retargetTag`（用户「采纳新位置」经它）。「找回原行」用新函数 `healTagToLine`，**保留 original 不动**。
- 单阈值 `SIMILARITY_THRESHOLD = 0.9`，复用，不新增阈值常量。
- 可疑判定**只按文件、只在触发点跑，不每键判**。
- 本期 **不** 改版本号、CHANGELOG、**不** 发版（留 Plan 3）。
- vitest：`npx vitest run [file]`；构建：`npm run build`。提交前缀 `feat/refactor/test/docs(code-jump-tags):`。

---

## File Structure

- `src/lodestar/suspect.ts`（新建，纯）— `SuspectInfo`、`classifyFileTags`、运行时注册表（Map + `setFileSuspects`/`getSuspect`/`allSuspects`/`clearSuspects`）。
- `src/lodestar/selection.ts`（改，纯）— 新增 `collectTagsInFile`。
- `src/lodestar/tree.ts`（改，纯）— 新增 `healTagToLine`（恢复行号但不动 original）。
- `src/player/recheck.ts`（新建，胶水）— `recheckFile`、`registerRecheckTriggers`、设置读取、FileSystemWatcher、手动命令。
- `src/player/decorator.ts`（改，胶水）— 可疑 gutter（灰 + ?）+ 可疑 hover（双行 + 动作链接）。
- `src/lodestar/commands.ts`（改，胶水）— `promoteToOriginal`、`recoverToOriginal`、`recheckCurrentFile` 命令 + 注册。
- `package.json`（改）— `recheckOn.*` 设置、新命令、commandPalette 可见性。
- 测试：`test/lodestar/suspect.test.ts`（新）、`test/lodestar/selection.test.ts`（追加）、`test/lodestar/tree.test.ts`（追加）。

---

## Task 1: 纯逻辑 — `classifyFileTags` + 可疑注册表

**Files:**
- Create: `src/lodestar/suspect.ts`
- Test: `test/lodestar/suspect.test.ts`

**Interfaces:**
- Consumes: `matchAnchor`（Plan 1，relocate.ts）。
- Produces:
  ```ts
  export interface FileTag { id: string; file: string; line: number; original?: string; current?: string; }
  export interface SuspectInfo { id: string; file: string; status: "current" | "lost"; line: number; original?: string; current?: string; }
  export function classifyFileTags(tags: FileTag[], fileText: string): SuspectInfo[];
  // 运行时注册表(不持久化):
  export function setFileSuspects(file: string, infos: SuspectInfo[]): boolean; // 改变了返回 true
  export function getSuspect(id: string): SuspectInfo | undefined;
  export function allSuspects(): SuspectInfo[];
  export function clearSuspects(): void;
  ```

- [ ] **Step 1: 写失败测试**

新建 `test/lodestar/suspect.test.ts`：

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyFileTags,
  setFileSuspects,
  getSuspect,
  allSuspects,
  clearSuspects,
  FileTag
} from "../../src/lodestar/suspect";

describe("classifyFileTags", () => {
  const text = ["int foo(a)", "int renamed(b)", "third"].join("\n");

  it("skips tags whose original still matches (not suspect)", () => {
    const tags: FileTag[] = [
      { id: "t1", file: "a.ts", line: 1, original: "int foo(a)", current: "int foo(a)" }
    ];
    expect(classifyFileTags(tags, text)).toEqual([]);
  });

  it("reports a soft suspect (current matches, original gone)", () => {
    const tags: FileTag[] = [
      { id: "t2", file: "a.ts", line: 1, original: "int original(b)", current: "int renamed(b)" }
    ];
    expect(classifyFileTags(tags, text)).toEqual([
      { id: "t2", file: "a.ts", status: "current", line: 2, original: "int original(b)", current: "int renamed(b)" }
    ]);
  });

  it("reports a hard suspect (neither matches) at the fallback line", () => {
    const tags: FileTag[] = [
      { id: "t3", file: "a.ts", line: 3, original: "gone-aaa", current: "gone-bbb" }
    ];
    expect(classifyFileTags(tags, text)).toEqual([
      { id: "t3", file: "a.ts", status: "lost", line: 3, original: "gone-aaa", current: "gone-bbb" }
    ]);
  });
});

describe("suspect registry", () => {
  beforeEach(() => clearSuspects());

  it("stores and reads by id", () => {
    setFileSuspects("a.ts", [{ id: "t1", file: "a.ts", status: "lost", line: 5 }]);
    expect(getSuspect("t1")?.status).toBe("lost");
    expect(allSuspects()).toHaveLength(1);
  });

  it("clears stale entries for a file on re-set", () => {
    setFileSuspects("a.ts", [{ id: "t1", file: "a.ts", status: "lost", line: 5 }]);
    setFileSuspects("a.ts", []); // t1 healed
    expect(getSuspect("t1")).toBeUndefined();
    expect(allSuspects()).toHaveLength(0);
  });

  it("re-set of one file does not touch other files' entries", () => {
    setFileSuspects("a.ts", [{ id: "ta", file: "a.ts", status: "lost", line: 1 }]);
    setFileSuspects("b.ts", [{ id: "tb", file: "b.ts", status: "current", line: 2 }]);
    setFileSuspects("a.ts", []);
    expect(getSuspect("tb")?.status).toBe("current");
  });

  it("returns changed=false when nothing changed", () => {
    const info = { id: "t1", file: "a.ts", status: "lost" as const, line: 5 };
    setFileSuspects("a.ts", [info]);
    expect(setFileSuspects("a.ts", [{ ...info }])).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试看它失败**

Run: `npx vitest run test/lodestar/suspect.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

新建 `src/lodestar/suspect.ts`：

```ts
// Suspect-state engine — PURE (no vscode). A tag is "suspect" when, at a recheck
// point, its immutable `original` no longer matches near its line. Soft suspect:
// `current` still matches (we have a candidate). Hard suspect: neither matches.
// Suspect state is runtime-only (never persisted) — a Map filled per file by the
// recheck triggers.
import { matchAnchor } from "./relocate";

export interface FileTag {
  id: string;
  file: string;
  line: number;
  original?: string;
  current?: string;
}

export interface SuspectInfo {
  id: string;
  file: string;
  status: "current" | "lost"; // current = soft (has candidate), lost = hard
  line: number;               // candidate line (soft) / fallback line (hard)
  original?: string;
  current?: string;
}

export function classifyFileTags(tags: FileTag[], fileText: string): SuspectInfo[] {
  const out: SuspectInfo[] = [];
  for (const t of tags) {
    const m = matchAnchor(fileText, t.line, t.original, t.current);
    if (m.status === "original") continue; // healthy
    out.push({
      id: t.id,
      file: t.file,
      status: m.status,
      line: m.line,
      original: t.original,
      current: t.current
    });
  }
  return out;
}

const registry = new Map<string, SuspectInfo>();

// Replace all suspect entries for one file. Returns true if the registry changed
// (so callers can skip a repaint when nothing moved).
export function setFileSuspects(file: string, infos: SuspectInfo[]): boolean {
  let changed = false;
  for (const [id, info] of registry) {
    if (info.file === file && !infos.some(i => i.id === id)) {
      registry.delete(id);
      changed = true;
    }
  }
  for (const info of infos) {
    const prev = registry.get(info.id);
    if (!prev || prev.status !== info.status || prev.line !== info.line) {
      registry.set(info.id, info);
      changed = true;
    }
  }
  return changed;
}

export function getSuspect(id: string): SuspectInfo | undefined {
  return registry.get(id);
}

export function allSuspects(): SuspectInfo[] {
  return [...registry.values()];
}

export function clearSuspects(): void {
  registry.clear();
}
```

- [ ] **Step 4: 跑测试看它通过**

Run: `npx vitest run test/lodestar/suspect.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lodestar/suspect.ts test/lodestar/suspect.test.ts
git commit -m "feat(code-jump-tags): 可疑态引擎 classifyFileTags + 运行时注册表(纯)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: 纯逻辑 — `collectTagsInFile` + `healTagToLine`

**Files:**
- Modify: `src/lodestar/selection.ts`
- Modify: `src/lodestar/tree.ts`
- Test: `test/lodestar/selection.test.ts`、`test/lodestar/tree.test.ts`

**Interfaces:**
- Produces:
  - `collectTagsInFile(store: LodestarStore, file: string): TagNode[]`（selection.ts）— 全树里 `file` 命中的标签。
  - `healTagToLine(store: LodestarStore, id: string, line: number, text?: string, pattern?: string): boolean`（tree.ts）— 设 line/text/pattern，**不动 original**（「找回原行」用）。

- [ ] **Step 1: 写失败测试（collectTagsInFile）**

在 `test/lodestar/selection.test.ts` 顶部 import 加 `collectTagsInFile`，追加：

```ts
describe("collectTagsInFile", () => {
  const store: any = {
    version: 1,
    tree: [
      { type: "folder", id: "f", title: "x", children: [
        { type: "tag", id: "t1", note: "", file: "a.ts", line: 1 },
        { type: "tag", id: "t2", note: "", file: "b.ts", line: 2 },
        { type: "folder", id: "g", title: "y", children: [
          { type: "tag", id: "t3", note: "", file: "a.ts", line: 3 }
        ] }
      ] }
    ]
  };
  it("returns all tags in the given file across nesting", () => {
    expect(collectTagsInFile(store, "a.ts").map((t: any) => t.id)).toEqual(["t1", "t3"]);
  });
  it("returns [] for a file with no tags", () => {
    expect(collectTagsInFile(store, "z.ts")).toEqual([]);
  });
});
```

- [ ] **Step 2: 写失败测试（healTagToLine）**

在 `test/lodestar/tree.test.ts` 顶部 import 加 `healTagToLine`，追加：

```ts
describe("healTagToLine keeps original", () => {
  it("updates line/text/pattern but leaves original untouched", () => {
    const store: any = {
      version: 1,
      tree: [{ type: "folder", id: "f", title: "x", children: [
        { type: "tag", id: "t", note: "", file: "a.ts", line: 1, text: "poison", original: "frozen", pattern: "p" }
      ] }]
    };
    expect(healTagToLine(store, "t", 7, "fresh", "^fresh")).toBe(true);
    const tag = store.tree[0].children[0];
    expect(tag.line).toBe(7);
    expect(tag.text).toBe("fresh");
    expect(tag.pattern).toBe("^fresh");
    expect(tag.original).toBe("frozen"); // ← 关键: original 不动
  });
});
```

- [ ] **Step 3: 跑测试看它们失败**

Run: `npx vitest run test/lodestar/selection.test.ts test/lodestar/tree.test.ts`
Expected: FAIL — 两个函数未导出。

- [ ] **Step 4: 实现 collectTagsInFile**

在 `src/lodestar/selection.ts` 末尾新增（确认顶部已 `import { LodestarStore, TagNode, TreeNode } from "./types";`）：

```ts
// All tags anchored to `file`, anywhere in the tree. Used by the per-file
// suspect recheck.
export function collectTagsInFile(store: LodestarStore, file: string): TagNode[] {
  const out: TagNode[] = [];
  const walk = (nodes: TreeNode[]): void => {
    for (const node of nodes) {
      if (node.type === "tag") {
        if (node.file === file) out.push(node);
      } else {
        walk(node.children);
      }
    }
  };
  walk(store.tree);
  return out;
}
```

- [ ] **Step 5: 实现 healTagToLine**

在 `src/lodestar/tree.ts` 的 `retargetTag` 函数下方新增：

```ts
// Recover a tag to `line` WITHOUT changing its identity. The user chose「以
// original 为准」: drop the poisoned current, move to the line where original was
// found, refresh current (text/pattern) from that line — but `original` stays.
// Returns false if id is unknown or names a folder.
export function healTagToLine(
  store: LodestarStore,
  id: string,
  line: number,
  text?: string,
  pattern?: string
): boolean {
  const found = findNode(store, id);
  if (!found || found.node.type !== "tag") return false;
  found.node.line = line;
  found.node.text = text;
  found.node.pattern = pattern;
  return true; // original 一概不动
}
```

- [ ] **Step 6: 跑测试看它们通过**

Run: `npx vitest run test/lodestar/selection.test.ts test/lodestar/tree.test.ts`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/lodestar/selection.ts src/lodestar/tree.ts test/lodestar/selection.test.ts test/lodestar/tree.test.ts
git commit -m "feat(code-jump-tags): collectTagsInFile + healTagToLine(找回原行不动original)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: 动作命令 — 采纳新位置 / 找回原行 / 手动校验

**Files:**
- Modify: `src/lodestar/commands.ts`（新增三个导出函数 + 在 `registerLodestarCommands` 注册）

**Interfaces:**
- Consumes: `getStore`、`saveStore`、`findNode`、`retargetTag`、`healTagToLine`、`findAnchorLine`、`lineAnchorText`、`linePattern`、`gotoLocation`（同文件/同层）。`recheckFile`（Task 4，`../player/recheck`）。
- Produces：
  - `promoteToOriginal(tagId: string, line?: number)` — 把 tag 的 original 升为目标行内容（line 缺省=tag 当前 candidate/光标）。经 `retargetTag`。
  - `recoverToOriginal(tagId: string)` — 用 `original` 找回真行，`healTagToLine` 定位、刷新 current、original 不动。
  - `recheckCurrentFile()` — 对当前活动编辑器文件跑一次 recheck（不受触发点设置影响）。

- [ ] **Step 1: 加 import**

`src/lodestar/commands.ts`：
- 把 `healTagToLine` 加进从 `./tree` 的 import（第 28-36 行那组）。
- 把 `findAnchorLine` 加进从 `./relocate` 的 import（Plan 1 已把该 import 改过；并入即可）。

- [ ] **Step 2: 实现 promoteToOriginal**

在 `src/lodestar/commands.ts` 的 0.6.1 区块之后（`undoTagMove` 函数下方）新增：

```ts
// ── 0.7.0 可疑态动作 ─────────────────────────────────────────────────────────
// 读某文件某行(1-based)的内容锚(与 addTag 同源)。
async function lineAnchorsAt(
  file: string,
  line: number
): Promise<{ text?: string; pattern?: string } | undefined> {
  const root = workspace.workspaceFolders![0].uri;
  const doc = await workspace.openTextDocument(Uri.joinPath(root, file));
  const raw = doc.lineAt(Math.max(0, line - 1)).text.trim();
  if (!raw) return { text: undefined, pattern: undefined };
  return { text: lineAnchorText(raw), pattern: linePattern(raw) };
}

// 「采纳新位置」: 把标签身份(original)升级为目标行的内容。line 缺省时用光标行。
export async function promoteToOriginal(tagId: string, line?: number) {
  const store = getStore();
  const found = findNode(store, tagId);
  if (!found || found.node.type !== "tag") {
    window.showInformationMessage("Code Jump Tags: 找不到该标签");
    return;
  }
  const file = found.node.file;
  const targetLine =
    line ?? (window.activeTextEditor?.selection.active.line ?? found.node.line - 1) + 1;
  const anchors = await lineAnchorsAt(file, targetLine);
  if (!anchors) return;
  // retargetTag 同时写 original = 用户确认 → 重设身份。
  retargetTag(store, tagId, file, targetLine, anchors.text, anchors.pattern);
  await saveStore();
  const { recheckFile } = await import("../player/recheck");
  await recheckFile(file);
  await gotoLocation(file, targetLine, anchors.pattern);
  window.setStatusBarMessage("Code Jump Tags: 已采纳为新身份", 2000);
}

// 「找回原行」: 拿 original 找回真行, 丢掉被污染的 current, original 不动。
export async function recoverToOriginal(tagId: string) {
  const store = getStore();
  const found = findNode(store, tagId);
  if (!found || found.node.type !== "tag") {
    window.showInformationMessage("Code Jump Tags: 找不到该标签");
    return;
  }
  const tag = found.node;
  const root = workspace.workspaceFolders![0].uri;
  const doc = await workspace.openTextDocument(Uri.joinPath(root, tag.file));
  const text = doc.getText();
  const hit = findAnchorLine(text, tag.line, tag.original);
  if (hit <= 0) {
    window.showInformationMessage(
      "Code Jump Tags: 按原内容找不到真行,请用「移到光标行」手动重指"
    );
    return;
  }
  const raw = doc.lineAt(hit - 1).text.trim();
  healTagToLine(
    store,
    tagId,
    hit,
    raw ? lineAnchorText(raw) : undefined,
    raw ? linePattern(raw) : undefined
  );
  await saveStore();
  const { recheckFile } = await import("../player/recheck");
  await recheckFile(tag.file);
  await gotoLocation(tag.file, hit, tag.pattern);
  window.setStatusBarMessage("Code Jump Tags: 已按原内容找回", 2000);
}

// 「重新校验当前文件」: 手动触发, 不受 recheckOn.* 设置影响。
export async function recheckCurrentFile() {
  const editor = window.activeTextEditor;
  if (!editor || !workspace.workspaceFolders?.length) {
    window.showInformationMessage("Code Jump Tags: 请先打开一个工作区文件");
    return;
  }
  const file = getRelativePath(
    workspace.workspaceFolders![0].uri.path,
    editor.document.uri.path
  );
  const { recheckFile } = await import("../player/recheck");
  await recheckFile(file);
  window.setStatusBarMessage("Code Jump Tags: 已重新校验当前文件", 2000);
}
```

- [ ] **Step 3: 注册命令**

在 `registerLodestarCommands` 的 `commands.registerCommand(...undoTagMove)` 之后追加（注意补逗号）：

```ts
    commands.registerCommand(`${EXTENSION_NAME}.promoteToOriginal`, promoteToOriginal),
    commands.registerCommand(`${EXTENSION_NAME}.recoverToOriginal`, recoverToOriginal),
    commands.registerCommand(`${EXTENSION_NAME}.recheckCurrentFile`, recheckCurrentFile)
```

- [ ] **Step 4: 构建（此时 `../player/recheck` 还不存在，Task 4 建。先跳过构建，留到 Task 4 末尾一起构建）**

仅做语法自检：确认无明显括号/逗号错。本任务不单独 build（动态 import 的 `../player/recheck` 在 Task 4 才创建）。

- [ ] **Step 5: Commit**

```bash
git add src/lodestar/commands.ts
git commit -m "feat(code-jump-tags): 采纳新位置/找回原行/手动校验 命令

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: 按文件 recheck + 触发点 + 设置

**Files:**
- Create: `src/player/recheck.ts`
- Modify: `src/extension.ts`（或扩展激活入口，调 `registerRecheckTriggers`）

**Interfaces:**
- Consumes: `getStore`、`getRelativePath`、`collectTagsInFile`、`classifyFileTags`、`setFileSuspects`、`rebuildTours`（触发树/装饰刷新）、`updateDecorations`。
- Produces:
  - `recheckFile(file: string): Promise<void>` — 读该文件内容、分类、写注册表、变则刷新装饰与树。
  - `registerRecheckTriggers(context: ExtensionContext): void` — 按 `codeJumpTags.recheckOn.*` 设置挂监听 + FileSystemWatcher。

- [ ] **Step 1: 实现 recheck.ts**

新建 `src/player/recheck.ts`：

```ts
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
```

- [ ] **Step 2: 在激活入口注册触发点**

定位激活入口：`grep -n "export function activate" src/extension.ts`。在 `activate(context)` 体内、其它 `register*` 调用旁加：

```ts
import { registerRecheckTriggers } from "./player/recheck";
// ... 在 activate(context) 里:
registerRecheckTriggers(context);
```
（若导入路径相对位置不同，按文件实际位置调整为正确相对路径。）

- [ ] **Step 3: 构建通过**

Run: `npm run build`
Expected: webpack 成功，0 error（此时 Task 3 的动态 import `../player/recheck` 已可解析）。

- [ ] **Step 4: Commit**

```bash
git add src/player/recheck.ts src/extension.ts
git commit -m "feat(code-jump-tags): 按文件 recheck + 可配置触发点(focus/open/external/save/idle)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: decorator 渲染可疑态（灰 + ? gutter + hover 双行 + 按钮）

**Files:**
- Modify: `src/player/decorator.ts`

**Interfaces:**
- Consumes: `getSuspect`（suspect.ts）。

- [ ] **Step 1: 加 import + 可疑装饰类型与图标**

`src/player/decorator.ts`：
- import 区加：`import { getSuspect } from "../lodestar/suspect";`
- 在 `INLINE_NOTE_DECORATOR` 定义下方新增灰 ? gutter 图标与装饰类型：

```ts
// Suspect gutter icon: a grey ringed "?" (data-URI SVG, no asset file).
const SUSPECT_ICON = vscode.Uri.parse(
  "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="#9aa0a6" stroke-width="1.5"/><text x="8" y="11.5" font-size="9" text-anchor="middle" fill="#9aa0a6" font-family="sans-serif">?</text></svg>`
    )
);
const SUSPECT_DECORATOR = vscode.window.createTextEditorDecorationType({
  gutterIconPath: SUSPECT_ICON,
  gutterIconSize: "contain",
  overviewRulerColor: "rgba(154,160,166,0.7)",
  overviewRulerLane: vscode.OverviewRulerLane.Right,
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
});
```

- [ ] **Step 2: updateDecorations 分流正常 / 可疑**

把 `updateDecorations` 里现有循环改为：先取 `const suspect = step.id ? getSuspect(step.id) : undefined;`，可疑的进 `suspectDecorations`（灰图标 + 可疑 hover），其余进 `gutterDecorations`。具体：

在 `const gutterDecorations ...` / `const inlineDecorations ...` 旁加一行：
```ts
  const suspectDecorations: vscode.DecorationOptions[] = [];
```

把循环体里构造 `hover` 之后、`gutterDecorations.push({...})` 之前插入分流（保留原 inline note 逻辑不变）：

```ts
    const suspect = step.id ? getSuspect(step.id) : undefined;
    if (suspect) {
      const sh = new vscode.MarkdownString();
      sh.isTrusted = true;
      sh.appendMarkdown(`⚠ 此标签可能失配\n\n`);
      sh.appendMarkdown(`- 原身份: \`${suspect.original ?? "(无)"}\`\n`);
      sh.appendMarkdown(`- 现内容: \`${suspect.current ?? "(无)"}\`\n\n`);
      if (suspect.status === "current") {
        const adopt = encodeURIComponent(JSON.stringify([step.id, suspect.line]));
        const recover = encodeURIComponent(JSON.stringify([step.id]));
        sh.appendMarkdown(
          `[采纳新位置](command:codeJumpTags.promoteToOriginal?${adopt}) · ` +
            `[找回原行](command:codeJumpTags.recoverToOriginal?${recover})`
        );
      } else {
        const recover = encodeURIComponent(JSON.stringify([step.id]));
        const move = encodeURIComponent(JSON.stringify([{ tagId: step.id }]));
        sh.appendMarkdown(
          `[找回原行](command:codeJumpTags.recoverToOriginal?${recover}) · ` +
            `[移到光标行](command:codeJumpTags.moveTagToCursor?${move})`
        );
      }
      suspectDecorations.push({
        range: new vscode.Range(line, 0, line, 1000),
        hoverMessage: sh
      });
      continue; // 可疑行不再进普通 gutter
    }
```

在函数末尾 `editor.setDecorations(TOUR_DECORATOR, ...)` 那两行旁加：
```ts
  editor.setDecorations(SUSPECT_DECORATOR, suspectDecorations);
```
并在 `clearDecorations` 里补一行 `editor.setDecorations(SUSPECT_DECORATOR, []);`。

- [ ] **Step 3: 构建 + 全量单测**

Run: `npm run build && npx vitest run`
Expected: 构建 0 error/warning；测试全绿。

- [ ] **Step 4: Commit**

```bash
git add src/player/decorator.ts
git commit -m "feat(code-jump-tags): 可疑态 gutter(灰+?) + hover 双行对照 + 动作按钮

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: package.json — 设置 + 命令 + 命令面板可见性

**Files:**
- Modify: `package.json`（configuration / commands / menus.commandPalette）

- [ ] **Step 1: 加触发点设置**

在 `package.json` 的 `configuration.properties`（约 45-56 行）里，`codeJumpTags.confirmDelete` 之后追加：

```json
        ,
        "codeJumpTags.recheckOn.focus": {
          "type": "boolean",
          "default": true,
          "description": "切回窗口(重获焦点)时,重新校验当前文件的标签是否失配。"
        },
        "codeJumpTags.recheckOn.open": {
          "type": "boolean",
          "default": true,
          "description": "打开/切换到某编辑器时,重新校验该文件的标签是否失配。"
        },
        "codeJumpTags.recheckOn.externalChange": {
          "type": "boolean",
          "default": true,
          "description": "文件被外部(git pull / 其它工具)改动时,重新校验其标签是否失配。"
        },
        "codeJumpTags.recheckOn.save": {
          "type": "boolean",
          "default": false,
          "description": "保存时重新校验该文件的标签是否失配。"
        },
        "codeJumpTags.recheckOn.idle": {
          "type": "boolean",
          "default": false,
          "description": "编辑停顿(空闲)后重新校验当前文件的标签是否失配。"
        }
```

- [ ] **Step 2: 加命令**

在 `commands` 数组末尾（`restoreFromTrash` 命令对象之后，数组 `]` 之前）追加：

```json
      ,
      {
        "command": "codeJumpTags.promoteToOriginal",
        "title": "采纳为新身份",
        "category": "Code Jump Tags"
      },
      {
        "command": "codeJumpTags.recoverToOriginal",
        "title": "找回原行",
        "category": "Code Jump Tags"
      },
      {
        "command": "codeJumpTags.recheckCurrentFile",
        "title": "重新校验当前文件的标签",
        "category": "Code Jump Tags"
      }
```

- [ ] **Step 3: 命令面板可见性**

在 `menus.commandPalette` 数组末尾追加：`promoteToOriginal` / `recoverToOriginal` 走命令链接/树菜单，不在面板手敲（`when: false`）；`recheckCurrentFile` 保留在面板可用（不加条目即默认可见）。

```json
        ,
        {
          "command": "codeJumpTags.promoteToOriginal",
          "when": "false"
        },
        {
          "command": "codeJumpTags.recoverToOriginal",
          "when": "false"
        }
```

- [ ] **Step 4: 校验 JSON + 构建**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('ok')" && npm run build`
Expected: 打印 `ok`，构建 0 error。

- [ ] **Step 5: 装机自验**

Run:
```bash
npx vsce package
"/c/Users/dell/AppData/Local/Programs/Microsoft VS Code/bin/code.cmd" --install-extension code-jump-tags-*.vsix --force
```
Reload Window 后手动验证：建标签 → 关文件 → 外部改名该行（git/外部编辑）→ 切回/重开 → 该标签 gutter 变灰 +?，hover 显示 original/current 与两个按钮；点「采纳新位置」→ 标签身份更新、灰 ? 消失；改用「找回原行」→ 跳回原内容所在行。

- [ ] **Step 6: Commit**

```bash
git add package.json
git commit -m "feat(code-jump-tags): recheckOn.* 设置 + 可疑态命令贡献

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: 知识沉淀

**Files:**
- Modify: `docs/code-jump-tags/功能-代码对照.md`

- [ ] **Step 1: 记录**

增一节「0.7.0 可疑态引擎（Plan 2）」：`suspect.ts`（classifyFileTags + 运行时注册表，不持久化）、`recheck.ts`(按文件 recheck + 触发点)、decorator 可疑渲染、三个命令（promoteToOriginal 经 retargetTag 写 original；recoverToOriginal 经 healTagToLine 不动 original；recheckCurrentFile）。强调铁律落点。

- [ ] **Step 2: Commit**

```bash
git add docs/code-jump-tags/功能-代码对照.md
git commit -m "docs(code-jump-tags): 0.7.0 可疑态引擎(Plan2) 功能-代码对照

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage（本期 = 可疑态判定 + 编辑器内呈现 + 两个动作 + 触发点 + 手动命令）：**
- 软/硬可疑判定（original→current→lost）：Task 1 `classifyFileTags`（消费 Plan 1 `matchAnchor`）✓
- 运行时不持久化注册表：Task 1 ✓
- 灰 + ? gutter / hover 双行 + 按钮：Task 5 ✓
- 采纳新位置（current/候选 → original，经 retargetTag）：Task 3 `promoteToOriginal` ✓
- 找回原行（拿 original 找回真行、original 不动）：Task 2 `healTagToLine` + Task 3 `recoverToOriginal` ✓
- 可配置触发点(focus/open/externalChange 默认开；save/idle 默认关)、只校验当前文件：Task 4 + Task 6 设置 ✓
- 手动校验命令：Task 3 `recheckCurrentFile` + Task 6 ✓
- 铁律「机器永不写 original」：本期自动路径仅 `setFileSuspects`/`healTagToLine`（不写 original）；写 original 只在用户点「采纳」→ retargetTag ✓
- **本期不覆盖（留 Plan 3）**：树 ? 角标、「待处理」汇总分组、树右键动作、版本/CHANGELOG/发版。

**Placeholder scan:** 无 TBD/TODO；代码步骤均给完整代码与命令。唯一「按文件实际位置调整」是 Task 4 Step 2 的 activate 入口 import 相对路径——已给定位命令 `grep -n "export function activate" src/extension.ts`。

**Type consistency:** `FileTag`/`SuspectInfo`/`classifyFileTags`/`setFileSuspects`/`getSuspect` 跨 Task 一致；`recheckFile(file)` 在 Task 3/4/5 调用一致；命令 id `promoteToOriginal`/`recoverToOriginal`/`recheckCurrentFile` 在 commands.ts、decorator hover、package.json 三处一致；`healTagToLine` 签名 Task 2 定义、Task 3 调用一致。

---

## Execution Handoff（落在 Plan 2 全部任务之后）

Plan 2 完成后进入 Plan 3（`2026-06-29-original-current-tree-release.md`）：树 ? 角标 +「待处理」汇总分组 + 树右键动作 + CHANGELOG/版本 0.7.0/发版（发版前 HOLD 等用户手动验证）。
