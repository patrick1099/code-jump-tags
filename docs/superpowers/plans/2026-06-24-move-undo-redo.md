# 撤回 / 恢复标签移动（move undo/redo）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 0.6.0 的标签移动加会话级「撤回 / 恢复」：撤回跳回原文件、把标签移回上一处；恢复（redo）再做一遍。

**Architecture:** 新建纯模块 `src/lodestar/moveJournal.ts`（不 import vscode，两个内存栈 undo/redo + 7 个小函数，全可单测）承载全部撤回逻辑；命令层 `commands.ts` 在 0.6.0 的 `placeTagAtCursor` 成功后 `recordMove`，并新增 `undoMove`/`redoMove`/`undoTagMove` 三命令——它们把栈里取出的 entry 交给共享助手 `applyMove`（守一行一签 → `retargetTag` → 存盘 → 复用既有 `gotoLocation` 跳转）。`package.json` 加命令声明、菜单与上下文键。纯内存、零持久化、不改 `retargetTag` 契约。

**Tech Stack:** TypeScript、VS Code 扩展 API、vitest（纯模块单测）、webpack（生产构建）、vsce（打包发布）。

## Global Constraints

- 只在 `C:\Users\dell\Desktop\plugin-research\codetour` 仓库内改动；不碰 `C:\Users\dell\Desktop\需求`。
- 仓库直接在 `main` 上工作（个人 fork）。
- 每个 commit 末尾追加：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- 不提交 vsix（`*.vsix` 已 gitignore）。
- `src/lodestar/moveJournal.ts` 与 `tree.ts`/`relocate.ts`/`adapter.ts` 同列**纯净**——**不得 `import vscode`**。
- 撤回栈**纯内存、零持久化**：标签存储（`store.json` / `TagNode`）一个字段都不加；Reload 即清空。
- 只有显式移动手势（粘贴到此行 / 移到光标行，即 `placeTagAtCursor`）进栈；自动行跟踪、建/删标签不进栈。
- `UNDO_CAP = 20`（最近 N 次，溢出丢最旧）。
- `Anchor.line` 是 **1-based**（与 `TagNode.line`、`retargetTag` 入参一致）。
- 删除 / 从回收站恢复**不进**本撤回栈（删除已有持久化回收站，见 spec）。
- Bash 每次调用 cwd 重置 → 命令一律前缀 `cd /c/Users/dell/Desktop/plugin-research/codetour && ...`。

> **本计划对 spec 栈机制的细化（记录）**：spec 草稿写的是 `popUndo/popRedo/popUndoForTag` 自动把
> entry 移到另一栈 + `pushBack` 回滚。本计划改为 **pop 只弹出、不自动压另一栈，由命令层按 apply 结果
> 显式 `pushRedo`/`pushUndo`**。原因：spec 的 pop+pushBack 模型无法干净表达「标签已删 → 直接丢弃
> （既不留 undo 也不进 redo）」这一情形。细化后三种结果（ok / occupied / missing）各自清晰，且守住
> spec 的原则：**apply 因占用失败后栈状态与 apply 前一致；已删的那条直接丢弃**。

---

### Task 1: 纯模块 `moveJournal.ts` + 单测

**Files:**
- Create: `src/lodestar/moveJournal.ts`
- Test: `test/lodestar/moveJournal.test.ts`

**Interfaces:**
- Consumes: 无（纯数据结构，零依赖）。
- Produces:
  - `type Anchor = { file: string; line: number; text?: string; pattern?: string }`
  - `type MoveEntry = { tagId: string; from: Anchor; to: Anchor }`
  - `type MoveJournal = { undo: MoveEntry[]; redo: MoveEntry[] }`
  - `const UNDO_CAP = 20`
  - `createJournal(): MoveJournal`
  - `recordMove(j, entry): void` —— push undo、截断到 CAP、清空 redo。
  - `popUndo(j): MoveEntry | undefined` —— 弹 undo 顶（不碰 redo）。
  - `popRedo(j): MoveEntry | undefined` —— 弹 redo 顶（不碰 undo）。
  - `removeUndoForTag(j, tagId): MoveEntry | undefined` —— 从 undo 从后往前移除首个 tagId 匹配并返回。
  - `pushUndo(j, entry): void` —— 压 undo 顶（带 CAP 截断）。
  - `pushRedo(j, entry): void` —— 压 redo 顶。

- [ ] **Step 1: 写失败测试**（新建 `test/lodestar/moveJournal.test.ts`）

```ts
import { describe, it, expect } from "vitest";
import {
  createJournal,
  recordMove,
  popUndo,
  popRedo,
  removeUndoForTag,
  pushUndo,
  pushRedo,
  UNDO_CAP,
  MoveEntry
} from "../../src/lodestar/moveJournal";

function entry(tagId: string, fromLine = 1, toLine = 2): MoveEntry {
  return {
    tagId,
    from: { file: "a.c", line: fromLine },
    to: { file: "a.c", line: toLine }
  };
}

describe("moveJournal", () => {
  it("recordMove pushes onto undo and clears redo", () => {
    const j = createJournal();
    j.redo.push(entry("old"));
    recordMove(j, entry("1"));
    expect(j.undo.map(e => e.tagId)).toEqual(["1"]);
    expect(j.redo).toEqual([]);
  });

  it("recordMove caps undo at UNDO_CAP, dropping the oldest", () => {
    const j = createJournal();
    for (let i = 0; i < UNDO_CAP + 3; i++) {
      recordMove(j, entry(String(i)));
    }
    expect(j.undo.length).toBe(UNDO_CAP);
    expect(j.undo[0].tagId).toBe("3");
    expect(j.undo[j.undo.length - 1].tagId).toBe(String(UNDO_CAP + 2));
  });

  it("popUndo returns the newest and removes it without touching redo", () => {
    const j = createJournal();
    recordMove(j, entry("1"));
    recordMove(j, entry("2"));
    const e = popUndo(j);
    expect(e!.tagId).toBe("2");
    expect(j.undo.map(x => x.tagId)).toEqual(["1"]);
    expect(j.redo).toEqual([]);
  });

  it("popUndo on an empty undo stack returns undefined", () => {
    expect(popUndo(createJournal())).toBeUndefined();
  });

  it("popRedo returns the newest redo entry", () => {
    const j = createJournal();
    pushRedo(j, entry("9"));
    expect(popRedo(j)!.tagId).toBe("9");
    expect(j.redo).toEqual([]);
  });

  it("removeUndoForTag pulls the newest matching entry from the middle, keeping order", () => {
    const j = createJournal();
    recordMove(j, entry("a"));
    recordMove(j, entry("b"));
    recordMove(j, entry("a"));
    recordMove(j, entry("c"));
    const e = removeUndoForTag(j, "a");
    expect(e!.tagId).toBe("a");
    expect(j.undo.map(x => x.tagId)).toEqual(["a", "b", "c"]);
  });

  it("removeUndoForTag returns undefined when nothing matches", () => {
    const j = createJournal();
    recordMove(j, entry("a"));
    expect(removeUndoForTag(j, "zzz")).toBeUndefined();
    expect(j.undo.map(x => x.tagId)).toEqual(["a"]);
  });

  it("pop + push round-trip moves an entry undo->redo->undo cleanly", () => {
    const j = createJournal();
    recordMove(j, entry("1"));
    const e = popUndo(j)!;
    pushRedo(j, e);
    expect(j.undo).toEqual([]);
    expect(j.redo.map(x => x.tagId)).toEqual(["1"]);
    const e2 = popRedo(j)!;
    pushUndo(j, e2);
    expect(j.redo).toEqual([]);
    expect(j.undo.map(x => x.tagId)).toEqual(["1"]);
  });

  it("pushUndo caps at UNDO_CAP", () => {
    const j = createJournal();
    for (let i = 0; i < UNDO_CAP; i++) {
      recordMove(j, entry(String(i)));
    }
    pushUndo(j, entry("extra"));
    expect(j.undo.length).toBe(UNDO_CAP);
    expect(j.undo[j.undo.length - 1].tagId).toBe("extra");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /c/Users/dell/Desktop/plugin-research/codetour && npx vitest run test/lodestar/moveJournal.test.ts`
Expected: FAIL —— 模块不存在 / 函数未导出（Cannot find module './moveJournal'）。

- [ ] **Step 3: 写最小实现**（新建 `src/lodestar/moveJournal.ts`）

```ts
// 会话级标签移动撤回栈(纯逻辑,不 import vscode)。一条记录一次显式移动:
// from=移动前锚, to=移动后锚。撤回把标签放回 from,恢复(redo)放回 to。
// 仅在内存、随插件生命周期,不持久化。

export type Anchor = {
  file: string;
  line: number; // 1-based
  text?: string;
  pattern?: string;
};

export type MoveEntry = {
  tagId: string;
  from: Anchor;
  to: Anchor;
};

export type MoveJournal = {
  undo: MoveEntry[]; // newest last
  redo: MoveEntry[]; // newest last
};

export const UNDO_CAP = 20; // 「最近几步」上限,溢出丢最旧

export function createJournal(): MoveJournal {
  return { undo: [], redo: [] };
}

// 记一次新移动:压 undo、截断到 UNDO_CAP、清空 redo(新动作作废重做历史)。
export function recordMove(j: MoveJournal, entry: MoveEntry): void {
  j.undo.push(entry);
  if (j.undo.length > UNDO_CAP) {
    j.undo.shift();
  }
  j.redo = [];
}

// 弹出 undo 栈顶(不自动压 redo;由命令层按 apply 结果决定去向)。
export function popUndo(j: MoveJournal): MoveEntry | undefined {
  return j.undo.pop();
}

// 弹出 redo 栈顶。
export function popRedo(j: MoveJournal): MoveEntry | undefined {
  return j.redo.pop();
}

// 从 undo 栈从后往前移除第一条 tagId 匹配的并返回(per-tag 撤回用)。
export function removeUndoForTag(
  j: MoveJournal,
  tagId: string
): MoveEntry | undefined {
  for (let i = j.undo.length - 1; i >= 0; i--) {
    if (j.undo[i].tagId === tagId) {
      return j.undo.splice(i, 1)[0];
    }
  }
  return undefined;
}

// 压回 undo 栈顶(撤回成功后把 redo 来的压回,或占用失败回滚)。带 CAP 截断。
export function pushUndo(j: MoveJournal, entry: MoveEntry): void {
  j.undo.push(entry);
  if (j.undo.length > UNDO_CAP) {
    j.undo.shift();
  }
}

// 压回 redo 栈顶。
export function pushRedo(j: MoveJournal, entry: MoveEntry): void {
  j.redo.push(entry);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /c/Users/dell/Desktop/plugin-research/codetour && npx vitest run test/lodestar/moveJournal.test.ts`
Expected: PASS（9 条全绿）。

- [ ] **Step 5: 跑全量单测确认无回归**

Run: `cd /c/Users/dell/Desktop/plugin-research/codetour && npx vitest run`
Expected: 全绿（应为 100 passed —— 原 91 + 新 9）。

- [ ] **Step 6: 提交**

```bash
cd /c/Users/dell/Desktop/plugin-research/codetour && \
git add src/lodestar/moveJournal.ts test/lodestar/moveJournal.test.ts && \
git commit -m "$(cat <<'EOF'
feat(code-jump-tags): moveJournal 纯模块——会话级移动撤回/恢复栈

两个内存栈 undo/redo + 7 个纯函数(record/pop/push/removeForTag),
UNDO_CAP=20,新移动清空 redo。撤回逻辑全在此,可单测。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 命令层接线（commands.ts）

**Files:**
- Modify: `src/lodestar/commands.ts`（加 import；改 `placeTagAtCursor` 记录移动；新增 0.6.1 段：`s_moveJournal`/`refreshMoveContextKeys`/`applyMove`/`undoMove`/`redoMove`/`undoTagMove`；注册三命令）

**Interfaces:**
- Consumes: Task 1 的 `Anchor`、`createJournal`、`recordMove`、`popUndo`、`popRedo`、`removeUndoForTag`、`pushUndo`、`pushRedo`（`./moveJournal`）；既有 `gotoLocation`（同文件，`commands.ts:75`）、`findNode`/`findTagByLocation`/`retargetTag`（`./tree`，已 import）、`getStore`/`saveStore`（已 import）。
- Produces: 命令 `codeJumpTags.undoMove` / `.redoMove` / `.undoTagMove`；上下文键 `codeJumpTags:canUndoMove` / `codeJumpTags:canRedoMove`（Task 3 菜单 `when` 用）。

> 命令层与 vscode 强耦合，按本仓库惯例**不写自动化单测**（撤回逻辑已在 Task 1 纯模块测过），靠 Task 5 构建 + 手动重载验。本任务可门控交付物 = 一次零错零警生产构建。

- [ ] **Step 1: 加 import**（`src/lodestar/commands.ts`，在 `import { getRelativePath } from "../utils";`（约 `commands.ts:38`）之后新增一行）

```ts
import {
  Anchor,
  createJournal,
  popRedo,
  popUndo,
  pushRedo,
  pushUndo,
  recordMove,
  removeUndoForTag
} from "./moveJournal";
```

- [ ] **Step 2: 改 `placeTagAtCursor` 记录移动**（`src/lodestar/commands.ts:306-329`，整段替换为下文）

> 关键：`retargetTag` 是**原地改**标签节点对象,所以「移动前」的锚必须在调用 `retargetTag`
> **之前**就把字段值**拷贝出来**(不能持有节点引用,否则被一并改写)。只有真换了位置才进栈。

```ts
// 把 tagId 重锚到当前光标行;目标行已被「别的」标签占用 → 拒绝(守一行一签)。
async function placeTagAtCursor(tagId: string): Promise<boolean> {
  const target = cursorTarget();
  if (!target) return false;
  const store = getStore();
  const existing = findTagByLocation(store, target.file, target.line);
  if (existing && existing.id !== tagId) {
    const label =
      (existing.note || "").split(/\r?\n/)[0].trim() || "(无注释)";
    window.showInformationMessage(`Code Jump Tags: 该行已有标签「${label}」`);
    return false;
  }
  // 记录「移动前」的锚供撤回用:必须在 retargetTag 原地改写之前拷出字段值。
  const before = findNode(store, tagId);
  const fromAnchor: Anchor | undefined =
    before && before.node.type === "tag"
      ? {
          file: before.node.file,
          line: before.node.line,
          text: before.node.text,
          pattern: before.node.pattern
        }
      : undefined;
  if (
    !retargetTag(store, tagId, target.file, target.line, target.text, target.pattern)
  ) {
    window.showInformationMessage("Code Jump Tags: 找不到该标签");
    return false;
  }
  await saveStore();
  // 只有真正换了位置才进撤回栈(同文件同行原地不记)。
  if (
    fromAnchor &&
    (fromAnchor.file !== target.file || fromAnchor.line !== target.line)
  ) {
    recordMove(s_moveJournal, {
      tagId,
      from: fromAnchor,
      to: {
        file: target.file,
        line: target.line,
        text: target.text,
        pattern: target.pattern
      }
    });
    refreshMoveContextKeys();
  }
  window.setStatusBarMessage(
    `Code Jump Tags: 已移动到 ${target.file}:${target.line}`,
    2000
  );
  return true;
}
```

- [ ] **Step 3: 新增 0.6.1 撤回/恢复段**（接在 `cancelMoveTag` 函数的 `}` 之后，约 `commands.ts:370`）

```ts
// ── 0.6.1 撤回 / 恢复标签移动 ────────────────────────────────────────────────
// 会话级内存撤回栈;记录显式移动(粘贴到此行 / 移到光标行),撤回放回上一处并跳转。
// 纯内存,随插件生命周期,不持久化。
const s_moveJournal = createJournal();

function refreshMoveContextKeys() {
  commands.executeCommand(
    "setContext",
    "codeJumpTags:canUndoMove",
    s_moveJournal.undo.length > 0
  );
  commands.executeCommand(
    "setContext",
    "codeJumpTags:canRedoMove",
    s_moveJournal.redo.length > 0
  );
}

// 把标签放到一个明确的锚点(撤回/恢复用):守一行一签 → retargetTag → 存盘 → 跳转。
// 返回 ok | occupied(目标行被别的标签占用) | missing(标签已删/找不到)。
type ApplyResult = "ok" | "occupied" | "missing";
async function applyMove(tagId: string, target: Anchor): Promise<ApplyResult> {
  const store = getStore();
  const existing = findTagByLocation(store, target.file, target.line);
  if (existing && existing.id !== tagId) {
    const label =
      (existing.note || "").split(/\r?\n/)[0].trim() || "(无注释)";
    window.showInformationMessage(
      `Code Jump Tags: 原位置已被标签「${label}」占用`
    );
    return "occupied";
  }
  if (
    !retargetTag(store, tagId, target.file, target.line, target.text, target.pattern)
  ) {
    window.showInformationMessage("Code Jump Tags: 该标签已删除,无法撤回");
    return "missing";
  }
  await saveStore();
  await gotoLocation(target.file, target.line, target.pattern);
  return "ok";
}

// 全局撤回:退回最近一次移动并跳转。
export async function undoMove() {
  const entry = popUndo(s_moveJournal);
  if (!entry) return;
  const r = await applyMove(entry.tagId, entry.from);
  if (r === "ok") {
    pushRedo(s_moveJournal, entry);
  } else if (r === "occupied") {
    pushUndo(s_moveJournal, entry); // 失败回滚:留在 undo 可重试
  }
  // r === "missing": 丢弃(标签已删,永远 apply 不了)
  refreshMoveContextKeys();
}

// 全局恢复(redo):重做刚撤掉的那次移动并跳转。
export async function redoMove() {
  const entry = popRedo(s_moveJournal);
  if (!entry) return;
  const r = await applyMove(entry.tagId, entry.to);
  if (r === "ok") {
    pushUndo(s_moveJournal, entry);
  } else if (r === "occupied") {
    pushRedo(s_moveJournal, entry);
  }
  refreshMoveContextKeys();
}

// 针对某标签撤回它自己的上一次移动(树右键)。
export async function undoTagMove(node: any) {
  const tagId: string | undefined = node?.tagLink?.id ?? node?.tagId;
  if (!tagId) {
    window.showInformationMessage(
      "Code Jump Tags: 请在某个标签上右键使用「撤回此标签的移动」"
    );
    return;
  }
  const entry = removeUndoForTag(s_moveJournal, tagId);
  if (!entry) {
    window.showInformationMessage("Code Jump Tags: 该标签没有可撤回的移动");
    return;
  }
  const r = await applyMove(entry.tagId, entry.from);
  if (r === "ok") {
    pushRedo(s_moveJournal, entry);
  } else if (r === "occupied") {
    pushUndo(s_moveJournal, entry);
  }
  refreshMoveContextKeys();
}
```

- [ ] **Step 4: 注册三命令**（`registerLodestarCommands` 的 `push(...)` 末尾，把 `cancelMoveTag` 那行结尾补逗号并追加，`commands.ts:687`）

将：

```ts
    commands.registerCommand(`${EXTENSION_NAME}.cancelMoveTag`, cancelMoveTag)
  );
```

改为：

```ts
    commands.registerCommand(`${EXTENSION_NAME}.cancelMoveTag`, cancelMoveTag),
    commands.registerCommand(`${EXTENSION_NAME}.undoMove`, undoMove),
    commands.registerCommand(`${EXTENSION_NAME}.redoMove`, redoMove),
    commands.registerCommand(`${EXTENSION_NAME}.undoTagMove`, undoTagMove)
  );
```

- [ ] **Step 5: 生产构建确认零错零警**

Run: `cd /c/Users/dell/Desktop/plugin-research/codetour && npm run build`
Expected: webpack 两个 target 成功，无 error、无 warning。

- [ ] **Step 6: 提交**

```bash
cd /c/Users/dell/Desktop/plugin-research/codetour && \
git add src/lodestar/commands.ts && \
git commit -m "$(cat <<'EOF'
feat(code-jump-tags): 撤回/恢复/按标签撤回 移动命令 + 记录移动

placeTagAtCursor 成功换位后 recordMove(先拷贝移动前锚再 retarget);
undoMove/redoMove/undoTagMove 经 applyMove(守一行一签+retargetTag+
存盘+gotoLocation 跳转)还原,按 ok/occupied/missing 三结果决定栈去向;
canUndoMove/canRedoMove 上下文键联动。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 菜单贡献 + 版本号（package.json）

**Files:**
- Modify: `package.json`（`contributes.commands` 加 3 条；`commandPalette` 加 3 条；`view/item/context` 加 1 条；`version` 0.6.0 → 0.6.1）

**Interfaces:**
- Consumes: Task 2 的命令 id 与上下文键 `codeJumpTags:canUndoMove` / `codeJumpTags:canRedoMove`。
- Produces: 命令面板「撤回移动 / 恢复移动」（按可否撤回/恢复显隐）、树标签右键「撤回此标签的移动」。

- [ ] **Step 1: 加命令声明**（`contributes.commands` 数组内，`cancelMoveTag` 块之后、`saveTag` 之前，即 `package.json:106` 那个 `},` 之后插入）

```json
      {
        "command": "codeJumpTags.undoMove",
        "title": "撤回移动",
        "category": "Code Jump Tags"
      },
      {
        "command": "codeJumpTags.redoMove",
        "title": "恢复移动",
        "category": "Code Jump Tags"
      },
      {
        "command": "codeJumpTags.undoTagMove",
        "title": "撤回此标签的移动",
        "category": "Code Jump Tags"
      },
```

- [ ] **Step 2: 命令面板可见性**（`menus.commandPalette` 数组内，`cancelMoveTag` 那条之后、`saveTag` 之前，即 `package.json:231` 那个 `},` 之后插入）

```json
        {
          "command": "codeJumpTags.undoMove",
          "when": "codeJumpTags:canUndoMove"
        },
        {
          "command": "codeJumpTags.redoMove",
          "when": "codeJumpTags:canRedoMove"
        },
        {
          "command": "codeJumpTags.undoTagMove",
          "when": "false"
        },
```

> `undoTagMove` 依赖树节点参数，裸面板调用拿不到 → `when:false`（同既有 node-命令惯例）。`undoMove`/`redoMove` 仅在有可撤回/可恢复项时出现。

- [ ] **Step 3: 树标签右键加「撤回此标签的移动」**（`menus["view/item/context"]` 数组内，`moveTagToCursor`（`move@2`）那块之后、`newSubfolder` 之前，即 `package.json:416` 那个 `},` 之后插入）

```json
        {
          "command": "codeJumpTags.undoTagMove",
          "when": "viewItem =~ /^codeJumpTags.tag/",
          "group": "move@3"
        },
```

- [ ] **Step 4: 升版本号**

把 `package.json` 顶部 `"version": "0.6.0",`（`package.json:6`）改为 `"version": "0.6.1",`。

- [ ] **Step 5: 校验 JSON 合法 + 构建**

Run: `cd /c/Users/dell/Desktop/plugin-research/codetour && node -e "require('./package.json'); console.log('package.json OK')" && npm run build`
Expected: 打印 `package.json OK`，webpack 零错零警。

- [ ] **Step 6: 提交**

```bash
cd /c/Users/dell/Desktop/plugin-research/codetour && \
git add package.json && \
git commit -m "$(cat <<'EOF'
feat(code-jump-tags): 撤回/恢复菜单贡献 + 版本 0.6.1

命令面板「撤回移动/恢复移动」按 canUndoMove/canRedoMove 显隐;
树标签右键加「撤回此标签的移动」(move@3);undoTagMove 面板 when:false。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 文档（CHANGELOG + 功能-代码对照）

**Files:**
- Modify: `CHANGELOG.md`（顶部新增 `## 0.6.1` 段）
- Modify: `docs/code-jump-tags/功能-代码对照.md`（新增撤回/恢复条目）

**Interfaces:** 无代码接口；纯文档。

- [ ] **Step 1: 写 CHANGELOG**（`CHANGELOG.md`，在 `# Change Log` 与 `## 0.6.0` 之间插入）

```markdown
## 0.6.1 - 2026-06-24

- 给「移动标签」加了撤回 / 恢复:移错或后悔时,一步把标签放回上一处,并跳回它原来的文件那一行。
  - 「撤回移动」退回最近一次移动;「恢复移动」把刚撤掉的再做一遍(像编辑器的撤销/重做)。
  - 也能在树里右键某个标签「撤回此标签的移动」,只退它自己的上一次。
- 撤回是会话级的:只记最近若干次移动,关掉窗口就清空(和编辑器的撤销一样,不跨重启)。
- 撤回到的原位置若已被别的标签占用,会提示并跳过,维持「一行一签」。
- 删除标签不走这个撤回——删除本来就进回收站、可从回收站恢复(而且跨会话保留)。
```

- [ ] **Step 2: 写功能-代码对照**

先 Read `docs/code-jump-tags/功能-代码对照.md` 全文，找到 0.6.0「移动 / 剪切粘贴标签」那段之后的合适位置，追加：

```markdown
**撤回 / 恢复标签移动(0.6.1 加)**

会话级内存撤回栈,纯模块 `src/lodestar/moveJournal.ts`(不 import vscode):两个栈 `undo`/`redo`,
每条 `MoveEntry { tagId, from, to }` 记一次显式移动的前/后锚;`recordMove`(压 undo+截断 `UNDO_CAP=20`
+清空 redo)、`popUndo`/`popRedo`/`removeUndoForTag`/`pushUndo`/`pushRedo`。pop 只弹出、不自动压另一栈,
由命令层按 apply 结果显式压回——这样能干净区分「标签已删→直接丢弃」与「占用→回滚重试」。

命令层(`src/lodestar/commands.ts`):模块级 `s_moveJournal`;0.6.0 的 `placeTagAtCursor` 成功换位后
`recordMove`(先把移动前锚的字段**拷出来**再 `retargetTag`,因为 retargetTag 原地改节点)。
`undoMove`/`redoMove`/`undoTagMove` 三命令都经共享 `applyMove(tagId, anchor)`:守一行一签 → `retargetTag`
→ `saveStore` → 复用既有 `gotoLocation` 跳转;按返回 ok/occupied/missing 决定 entry 进 redo/回滚/丢弃。
`refreshMoveContextKeys` 维护 `canUndoMove`/`canRedoMove`,联动命令面板显隐。菜单见 package.json
的 `view/item/context`(move@3)与 `commandPalette`。

只记**显式移动**(粘贴到此行 / 移到光标行);自动行跟踪、建/删标签不进栈。删除有自己的持久化回收站,
不进本栈。为 0.7.0 衔接:撤回也走 `retargetTag`,将来它顺手写 `original` 后,撤回会自然一并还原 original。
```

- [ ] **Step 3: 提交**

```bash
cd /c/Users/dell/Desktop/plugin-research/codetour && \
git add CHANGELOG.md docs/code-jump-tags/功能-代码对照.md && \
git commit -m "$(cat <<'EOF'
docs(code-jump-tags): 0.6.1 撤回/恢复移动 CHANGELOG + 功能-代码对照

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 构建 + 安装 + 手动验收 + 发版

**Files:** 无源码改动；产物 `code-jump-tags-0.6.1.vsix`（不提交）。

**Interfaces:** 终态——0.6.1 推到 marketplace + main 与 tag `v0.6.1` 已推。

- [ ] **Step 1: 全量单测 + 生产构建**

Run: `cd /c/Users/dell/Desktop/plugin-research/codetour && npx vitest run && npm run build`
Expected: 单测全绿（100 passed）；webpack 零错零警。

- [ ] **Step 2: 打包并强制安装 vsix**

> 注意:本机 `code` 在 PATH 指向 `Code.exe`(GUI)而非 CLI,直接 `code --install-extension` 会静默不装。
> 必须用真正的 CLI `bin\code.cmd`。

Run（打包）: `cd /c/Users/dell/Desktop/plugin-research/codetour && npx vsce package`
Expected: 生成 `code-jump-tags-0.6.1.vsix`。

Run（安装，PowerShell）:
```
& cmd /c '"C:\Users\dell\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd" --install-extension "C:\Users\dell\Desktop\plugin-research\codetour\code-jump-tags-0.6.1.vsix" --force'
```
Expected: 打印 `Extension 'code-jump-tags-0.6.1.vsix' was successfully installed.`；
`C:\Users\dell\.vscode\extensions\` 下出现 `patrick1099.code-jump-tags-0.6.1`。

- [ ] **Step 3: 手动验收（提示用户 Reload Window 后验，HOLD 发布等用户确认）**

向用户报告，请其确认：
1. 移动一个标签 →「撤回移动」→ 跳回原文件原行、标签回到原处。
2. 撤回后「恢复移动」→ 又回到移动后的位置。
3. 树里右键某标签「撤回此标签的移动」→ 只退它自己的上一次。
4. 撤回到的原位置已被别的标签占用 → 提示「原位置已被标签『…』占用」并跳过。
5. Reload Window 后撤回栈清空（「撤回移动」从命令面板消失）。

- [ ] **Step 4: 推 main + 轻量 tag 触发发布**（仅在用户确认手动验收通过后执行）

```bash
cd /c/Users/dell/Desktop/plugin-research/codetour && \
git push origin main && \
git tag v0.6.1 && \
git push origin v0.6.1
```

Expected: tag 推送触发 `.github/workflows/publish.yml`（`npm ci → npm run test:unit → vsce publish`）。

- [ ] **Step 5: 确认 CI 发布成功**

Run: `cd /c/Users/dell/Desktop/plugin-research/codetour && gh run list --workflow=publish.yml --limit 1`
Expected: 最新一条 `v0.6.1` 触发的 run 为 `completed / success`（必要时 `gh run watch <id> --exit-status`）。提醒用户 Reload Window 生效。

---

## Self-Review

- **Spec coverage:** ① 全局撤回最近一次移动 + 跳转（Task 2 `undoMove` + `applyMove`/`gotoLocation`）✅；② 恢复 redo（Task 2 `redoMove`）✅；③ per-tag 撤回（Task 2 `undoTagMove` + Task 1 `removeUndoForTag`）✅；④ 纯模块可单测（Task 1 `moveJournal.ts` + 9 测）✅；⑤ 不持久化、标签存储不加字段（`s_moveJournal` 内存态，`recordMove` 只动栈）✅；⑥ 只记显式移动（Task 2 仅 `placeTagAtCursor` 调 `recordMove`）✅；⑦ `UNDO_CAP=20` 截断（Task 1 `recordMove`/`pushUndo` + 测）✅；⑧ 占用拒绝 + 回滚 / 已删丢弃（Task 2 `applyMove` 三结果 + undo/redo/undoTag 分支）✅；⑨ 删除不进栈（不在 delete 路径加 record；文档 Task 4 交代）✅；⑩ 上下文键 + 菜单（Task 3）✅；⑪ 0.7.0 衔接仅文档记录（Task 4）✅。
- **Placeholder scan:** 无 TBD/TODO；每个代码步骤含完整代码与确切命令；安装命令给出本机 `bin\code.cmd` 实路径。
- **Type consistency:** `Anchor` 在 Task 1 定义、Task 2 `applyMove` 入参与 `placeTagAtCursor` 的 `fromAnchor`/`recordMove` 实参同构（file/line/text?/pattern?）；7 个 journal 函数名在 Task 1 导出、Task 2 import 与调用一致；上下文键 `codeJumpTags:canUndoMove`/`canRedoMove` 在 Task 2（setContext）与 Task 3（menus when）字面一致；命令 id `undoMove`/`redoMove`/`undoTagMove` 在 Task 2 注册、Task 3 声明一致；`gotoLocation(file,line,pattern)` 与 `commands.ts:75` 既有签名一致。
