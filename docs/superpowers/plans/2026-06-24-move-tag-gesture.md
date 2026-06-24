# 移动 / 剪切粘贴标签（re-anchor 手势）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「把标签重新钉到某一行」成为一个廉价手势（剪切→粘贴 / 移到光标行），底层是一个纯函数 `retargetTag`。

**Architecture:** 在纯逻辑层 `tree.ts` 新增 `retargetTag`（findNode + 赋值，不 import vscode）；命令层 `commands.ts` 加三条手势命令 + 一条取消，用模块级 `s_movingTagId` 与上下文键 `codeJumpTags:movingTag` 串起「剪切中」状态；`package.json` 加命令声明与菜单（含新增 `editor/context` 节）。锚点 text/pattern 由命令层按目标行文字算好传入纯函数，避免 tree.ts 反向依赖 relocate.ts 形成循环。

**Tech Stack:** TypeScript、VS Code 扩展 API、vitest（纯函数单测）、webpack（生产构建）、vsce（打包发布）。

## Global Constraints

- 只在 `C:\Users\dell\Desktop\plugin-research\codetour` 仓库内改动；不碰 `C:\Users\dell\Desktop\需求`。
- 仓库直接在 `main` 上工作（个人 fork）。
- 每个 commit 末尾追加：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- 不提交 vsix（`*.vsix` 已 gitignore）。
- `src/lodestar/tree.ts`、`relocate.ts`、`adapter.ts` 必须保持纯净——**不得 `import vscode`**。
- 锚点采集只用 `linePattern(lineText)` 与 `lineAnchorText(lineText)`（二者内部各自 trim）；空行 → 传 `undefined`。
- `TagNode.line` 是 **1-based**；`file = getRelativePath(workspaceRoot.path, uri.path)`。
- 守「一行一签」不变量：粘到「已有别的标签」的行 → 拒绝并提示，**不允许两签**。
- Bash 每次调用 cwd 重置 → 命令一律前缀 `cd /c/Users/dell/Desktop/plugin-research/codetour && ...`。
- 不改动既有模块常量（`SIMILARITY_THRESHOLD=0.9`、`SEARCH_RADII=[8,40,Infinity]`、`MAX_CMP_LEN=200`）。

---

### Task 1: `retargetTag` 纯函数（tree.ts）

**Files:**
- Modify: `src/lodestar/tree.ts`（在 `findTagByLocation` 之后、`childrenOf` 之前新增 `retargetTag`）
- Test: `test/lodestar/tree.test.ts`（文件末尾新增 `describe("retargetTag", ...)`）

**Interfaces:**
- Consumes: `findNode(store, id): FoundNode | undefined`（同文件已有）、`TagNode`、`LodestarStore`（`./types`）。
- Produces: `retargetTag(store: LodestarStore, id: string, file: string, line: number, anchorText?: string, anchorPattern?: string): boolean` —— Task 2 与未来 0.7.0 共用。命中并更新 → `true`；id 不存在或指向文件夹 → `false`。只改 `file/line/text/pattern`，`note/id/createdAt/所属文件夹` 一律不动。

- [ ] **Step 1: 写失败测试**（追加到 `test/lodestar/tree.test.ts` 末尾）

```ts
import { retargetTag } from "../../src/lodestar/tree";

describe("retargetTag", () => {
  it("re-anchors a tag's file/line/text/pattern and returns true", () => {
    const s = createEmptyStore();
    addTag(s, tag("1"));
    const ok = retargetTag(s, "1", "b.c", 42, "foo();", "^\\s*foo\\(\\);");
    expect(ok).toBe(true);
    const node = findNode(s, "1")!.node as TagNode;
    expect(node.file).toBe("b.c");
    expect(node.line).toBe(42);
    expect(node.text).toBe("foo();");
    expect(node.pattern).toBe("^\\s*foo\\(\\);");
  });

  it("returns false and leaves the store unchanged for an unknown id", () => {
    const s = createEmptyStore();
    addTag(s, tag("1"));
    const before = serialize(s);
    expect(retargetTag(s, "nope", "b.c", 9)).toBe(false);
    expect(serialize(s)).toBe(before);
  });

  it("returns false when the id names a folder", () => {
    const s = createEmptyStore();
    createFolder(s, "通信", () => "f1");
    const before = serialize(s);
    expect(retargetTag(s, "f1", "b.c", 9)).toBe(false);
    expect(serialize(s)).toBe(before);
  });

  it("re-anchors a tag nested in a folder, leaving note/id/createdAt/folder intact", () => {
    const s = createEmptyStore();
    createFolder(s, "通信", () => "f1");
    addTag(s, tag("1"), "f1");
    expect(retargetTag(s, "1", "b.c", 7, "x", undefined)).toBe(true);
    const found = findNode(s, "1")!;
    const node = found.node as TagNode;
    expect(found.parent!.id).toBe("f1");
    expect(node.note).toBe("n1");
    expect(node.createdAt).toBe("t");
    expect(node.id).toBe("1");
  });

  it("clears text/pattern to undefined for a blank target line", () => {
    const s = createEmptyStore();
    addTag(s, tag("1"));
    retargetTag(s, "1", "b.c", 3, "had", "hadp");
    retargetTag(s, "1", "b.c", 4, undefined, undefined);
    const node = findNode(s, "1")!.node as TagNode;
    expect(node.text).toBeUndefined();
    expect(node.pattern).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /c/Users/dell/Desktop/plugin-research/codetour && npx vitest run test/lodestar/tree.test.ts`
Expected: FAIL —— `retargetTag is not a function` / 未导出。

- [ ] **Step 3: 写最小实现**（`src/lodestar/tree.ts`，紧跟 `findTagByLocation` 的 `}` 之后插入）

```ts
// Re-anchor an existing tag to (file, line), replacing its content anchor.
// anchorText/anchorPattern are precomputed by the caller from the target line's
// text (same source as addTag: lineAnchorText/linePattern, both trim). A blank
// target line → pass undefined for both (weak anchor, as when tagging a blank
// line). Returns true if a tag with `id` was found and updated; false if the id
// is unknown or names a folder. note/id/createdAt/containing folder are untouched.
export function retargetTag(
  store: LodestarStore,
  id: string,
  file: string,
  line: number,
  anchorText?: string,
  anchorPattern?: string
): boolean {
  const found = findNode(store, id);
  if (!found || found.node.type !== "tag") {
    return false;
  }
  found.node.file = file;
  found.node.line = line;
  found.node.text = anchorText;
  found.node.pattern = anchorPattern;
  return true;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /c/Users/dell/Desktop/plugin-research/codetour && npx vitest run test/lodestar/tree.test.ts`
Expected: PASS（新增 5 条全绿，旧 tree 测试不受影响）。

- [ ] **Step 5: 跑全量单测确认无回归**

Run: `cd /c/Users/dell/Desktop/plugin-research/codetour && npx vitest run`
Expected: 全绿（应为 91 passed —— 原 86 + 新 5）。

- [ ] **Step 6: 提交**

```bash
cd /c/Users/dell/Desktop/plugin-research/codetour && \
git add src/lodestar/tree.ts test/lodestar/tree.test.ts && \
git commit -m "$(cat <<'EOF'
feat(code-jump-tags): retargetTag 纯函数——把标签重锚到 (file,line)

0.6.0 移动手势的原子操作。findNode + 赋值 file/line/text/pattern;
note/id/createdAt/所属文件夹不动;id 未知或指向文件夹返回 false。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 命令层三手势 + 取消（commands.ts）

**Files:**
- Modify: `src/lodestar/commands.ts`（扩展 import；新增模块级状态与 4 个导出函数；在 `registerLodestarCommands` 的 `push(...)` 末尾注册）

**Interfaces:**
- Consumes: `retargetTag`、`findTagByLocation`（`./tree`）；`linePattern`、`lineAnchorText`（`./relocate`）；`getRelativePath`（`../utils`）；`getStore`、`saveStore`（`./persistence`，已 import）；`window`、`workspace`、`commands`（`vscode`，已 import）。
- Produces: 命令 `codeJumpTags.cutTag` / `.pasteTagHere` / `.moveTagToCursor` / `.cancelMoveTag`；上下文键 `codeJumpTags:movingTag`（Task 3 菜单 `when` 用）。

> 命令层与 vscode 强耦合，按本仓库既有惯例（renameTag/editNote 等同样）**不写自动化单测**，靠 Task 5 的构建 + 手动重载验。本任务的可门控交付物 = 一次零错零警的生产构建。

- [ ] **Step 1: 扩展 import**（`src/lodestar/commands.ts` 顶部）

把 `import { resolveLine } from "./relocate";` 改为：

```ts
import { resolveLine, linePattern, lineAnchorText } from "./relocate";
```

把 `./tree` 的 import 块改为同时引入 `retargetTag` 与 `findTagByLocation`：

```ts
import {
  createFolder,
  findNode,
  findTagByLocation,
  removeToTrash,
  renameFolderNode,
  restoreSelection,
  retargetTag
} from "./tree";
```

在 `import { TreeNode, TrashedEntry } from "./types";` 之后新增一行：

```ts
import { getRelativePath } from "../utils";
```

- [ ] **Step 2: 新增模块级状态与命令**（接在 `editNote` 函数 `}` 之后，约 `commands.ts:262`）

```ts
// ── 0.6.0 移动 / 剪切粘贴标签 ────────────────────────────────────────────────
// 正被「剪切」、等待粘贴目标的标签 id。movingTag 上下文键据此决定编辑器右键是否
// 显示「粘贴标签到此行」。
let s_movingTagId: string | undefined;

function setMovingTag(id: string | undefined) {
  s_movingTagId = id;
  commands.executeCommand(
    "setContext",
    "codeJumpTags:movingTag",
    id !== undefined
  );
}

// 读当前光标作为重锚目标:工作区相对路径、1-based 行号、该行内容锚(与 addTag 同源)。
function cursorTarget():
  | { file: string; line: number; text?: string; pattern?: string }
  | undefined {
  const editor = window.activeTextEditor;
  if (!editor) {
    window.showInformationMessage("Code Jump Tags: 请把光标放到目标代码行");
    return undefined;
  }
  const doc = editor.document;
  const workspaceRoot = workspace.workspaceFolders![0].uri;
  const file = getRelativePath(workspaceRoot.path, doc.uri.path);
  const lineIndex = editor.selection.active.line;
  const line = lineIndex + 1;
  const lineText = doc.lineAt(lineIndex).text.trim();
  const text = lineText ? lineAnchorText(lineText) : undefined;
  const pattern = lineText ? linePattern(lineText) : undefined;
  return { file, line, text, pattern };
}

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
  if (
    !retargetTag(store, tagId, target.file, target.line, target.text, target.pattern)
  ) {
    window.showInformationMessage("Code Jump Tags: 找不到该标签");
    return false;
  }
  await saveStore();
  window.setStatusBarMessage(
    `Code Jump Tags: 已移动到 ${target.file}:${target.line}`,
    2000
  );
  return true;
}

// 剪切标签:记下要移动的标签,等待编辑器里右键「粘贴标签到此行」。
export async function cutTag(node: any) {
  const tagId: string | undefined = node?.tagLink?.id ?? node?.tagId;
  if (!tagId) {
    window.showInformationMessage(
      "Code Jump Tags: 请在某个标签上右键使用「剪切标签」"
    );
    return;
  }
  setMovingTag(tagId);
  window.setStatusBarMessage(
    "Code Jump Tags: 标签移动中——把光标放到目标行,右键「粘贴标签到此行」",
    4000
  );
}

// 粘贴到此行:把剪切中的标签钉到当前光标行(可跨文件)。
export async function pasteTagHere() {
  if (!s_movingTagId) return;
  const ok = await placeTagAtCursor(s_movingTagId);
  if (ok) setMovingTag(undefined);
}

// 移到光标行:一步到位,把树里选中的标签钉到当前光标行。
export async function moveTagToCursor(node: any) {
  const tagId: string | undefined = node?.tagLink?.id ?? node?.tagId;
  if (!tagId) {
    window.showInformationMessage(
      "Code Jump Tags: 请在某个标签上右键使用「移到光标行」"
    );
    return;
  }
  await placeTagAtCursor(tagId);
}

// 取消移动:清掉剪切中的标签。
export async function cancelMoveTag() {
  setMovingTag(undefined);
  window.setStatusBarMessage("Code Jump Tags: 已取消标签移动", 2000);
}
```

- [ ] **Step 3: 注册四条命令**（`registerLodestarCommands` 的 `push(...)` 末尾，把 `newSubfolder` 那行的结尾逗号补上并追加）

将：

```ts
    commands.registerCommand(`${EXTENSION_NAME}.newFolder`, newFolder),
    commands.registerCommand(`${EXTENSION_NAME}.newSubfolder`, newSubfolder)
  );
```

改为：

```ts
    commands.registerCommand(`${EXTENSION_NAME}.newFolder`, newFolder),
    commands.registerCommand(`${EXTENSION_NAME}.newSubfolder`, newSubfolder),
    commands.registerCommand(`${EXTENSION_NAME}.cutTag`, cutTag),
    commands.registerCommand(`${EXTENSION_NAME}.pasteTagHere`, pasteTagHere),
    commands.registerCommand(
      `${EXTENSION_NAME}.moveTagToCursor`,
      moveTagToCursor
    ),
    commands.registerCommand(`${EXTENSION_NAME}.cancelMoveTag`, cancelMoveTag)
  );
```

- [ ] **Step 4: 生产构建确认零错零警**

Run: `cd /c/Users/dell/Desktop/plugin-research/codetour && npm run build`
Expected: webpack 成功，无 error、无 warning（TS 类型全部通过）。

- [ ] **Step 5: 提交**

```bash
cd /c/Users/dell/Desktop/plugin-research/codetour && \
git add src/lodestar/commands.ts && \
git commit -m "$(cat <<'EOF'
feat(code-jump-tags): 剪切/粘贴/移到光标行 三手势 + 取消

cutTag 记下 s_movingTagId 置 movingTag 上下文键;pasteTagHere 把它钉到
当前光标行(跨文件);moveTagToCursor 一步到位;cancelMoveTag 复位。
目标行已有别的标签则拒绝,守一行一签。锚点 text/pattern 由命令层按光标
行文字算好传给纯函数 retargetTag。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 菜单贡献 + 版本号（package.json）

**Files:**
- Modify: `package.json`（`contributes.commands` 加 4 条；`contributes.menus.commandPalette` 加 4 条；`view/item/context` 加 2 条；新增 `editor/context` 节；`version` 0.5.1 → 0.6.0）

**Interfaces:**
- Consumes: Task 2 注册的命令 id 与上下文键 `codeJumpTags:movingTag`。
- Produces: 树标签右键「剪切标签 / 移到光标行」、编辑器右键「粘贴标签到此行」、命令面板对 node 命令隐藏。

- [ ] **Step 1: 加命令声明**（`contributes.commands` 数组内，`renameTag` 块之后插入）

```json
      {
        "command": "codeJumpTags.cutTag",
        "title": "剪切标签",
        "category": "Code Jump Tags"
      },
      {
        "command": "codeJumpTags.pasteTagHere",
        "title": "粘贴标签到此行",
        "category": "Code Jump Tags"
      },
      {
        "command": "codeJumpTags.moveTagToCursor",
        "title": "移到光标行",
        "category": "Code Jump Tags"
      },
      {
        "command": "codeJumpTags.cancelMoveTag",
        "title": "取消标签移动",
        "category": "Code Jump Tags"
      },
```

- [ ] **Step 2: 命令面板可见性**（`menus.commandPalette` 数组内，`renameTag` 那条之后插入）

```json
        {
          "command": "codeJumpTags.cutTag",
          "when": "false"
        },
        {
          "command": "codeJumpTags.moveTagToCursor",
          "when": "false"
        },
        {
          "command": "codeJumpTags.pasteTagHere",
          "when": "codeJumpTags:movingTag"
        },
        {
          "command": "codeJumpTags.cancelMoveTag",
          "when": "codeJumpTags:movingTag"
        },
```

> `cutTag` / `moveTagToCursor` 依赖树节点参数，裸面板调用拿不到 → `when:false` 隐藏（同既有 node-命令惯例）。`pasteTagHere` / `cancelMoveTag` 仅在「剪切中」可见。

- [ ] **Step 3: 树标签右键加「move」组**（`menus["view/item/context"]` 数组内，`copyTagLink` 那条之后插入）

```json
        {
          "command": "codeJumpTags.cutTag",
          "when": "viewItem =~ /^codeJumpTags.tag/",
          "group": "move@1"
        },
        {
          "command": "codeJumpTags.moveTagToCursor",
          "when": "viewItem =~ /^codeJumpTags.tag/",
          "group": "move@2"
        },
```

- [ ] **Step 4: 新增 `editor/context` 节**（在 `view/item/context` 数组的闭合 `]` 之后；给该 `]` 补一个逗号，再加新键）

把 `view/item/context` 结尾的：

```json
          "group": "manage@3"
        }
      ]
    },
```

改为：

```json
          "group": "manage@3"
        }
      ],
      "editor/context": [
        {
          "command": "codeJumpTags.pasteTagHere",
          "when": "codeJumpTags:movingTag",
          "group": "codeJumpTags@1"
        }
      ]
    },
```

- [ ] **Step 5: 升版本号**

把 `package.json` 顶部 `"version": "0.5.1",` 改为 `"version": "0.6.0",`。

- [ ] **Step 6: 校验 JSON 合法 + 构建**

Run: `cd /c/Users/dell/Desktop/plugin-research/codetour && node -e "require('./package.json'); console.log('package.json OK')" && npm run build`
Expected: 打印 `package.json OK`，webpack 零错零警。

- [ ] **Step 7: 提交**

```bash
cd /c/Users/dell/Desktop/plugin-research/codetour && \
git add package.json && \
git commit -m "$(cat <<'EOF'
feat(code-jump-tags): 移动手势菜单贡献 + 版本 0.6.0

树标签右键加「剪切标签 / 移到光标行」(move 组);新增 editor/context
节放「粘贴标签到此行」(movingTag 时可见);node 命令在命令面板 when:false。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 文档（CHANGELOG + 功能-代码对照）

**Files:**
- Modify: `CHANGELOG.md`（顶部新增 `## 0.6.0` 段）
- Modify: `docs/code-jump-tags/功能-代码对照.md`（新增 retargetTag / 移动手势条目）

**Interfaces:** 无代码接口；纯文档。

- [ ] **Step 1: 写 CHANGELOG**（`CHANGELOG.md`，在 `# Change Log` 与 `## 0.5.1` 之间插入）

```markdown
## 0.6.0 - 2026-06-24

- 新增「快速移动标签」手势,让把一个标签重新钉到某一行变成一秒钟的事:
  - 树里右键标签 →「剪切标签」,再把光标放到目标行(可在别的文件)→ 编辑器右键
    「粘贴标签到此行」。
  - 树里右键标签 →「移到光标行」,一步把它挪到当前光标所在行。
  - 标签的笔记、链接、所属文件夹都原样跟随,只换它锚定的位置与该行内容。
- 目标行若已有别的标签,会拒绝并提示「该行已有标签『…』」,维持「一行一签」。
- 不改动自动匹配:这一版只把手动纠正做成廉价手势,自动跟随真实的剪切/粘贴
  代码移动仍不去猜。
```

- [ ] **Step 2: 写功能-代码对照**

先 Read `docs/code-jump-tags/功能-代码对照.md` 全文，找到记录各版本/特性的合适位置（紧接 0.5.1 那段之后），追加：

```markdown
**移动 / 剪切粘贴标签(0.6.0 加)**

把标签重锚到任意行的廉价手势,底层是纯函数 `retargetTag(store, id, file, line,
anchorText?, anchorPattern?)`(`src/lodestar/tree.ts`):findNode 命中 tag 后只改
`file/line/text/pattern`,`note/id/createdAt/所属文件夹` 不动;非 tag 返回 false。
锚点 text/pattern 由命令层按目标行文字用 `linePattern`/`lineAnchorText` 算好传入
(避免 tree.ts 反向 import relocate.ts 形成循环依赖)。

命令层(`src/lodestar/commands.ts`):模块级 `s_movingTagId` 记「剪切中」的标签,
`setMovingTag` 同步维护上下文键 `codeJumpTags:movingTag`。`cutTag`(树右键)记下
id;`pasteTagHere`(编辑器右键,movingTag 时可见)与 `moveTagToCursor`(树右键,一步
到位)都走 `placeTagAtCursor`→读当前光标行→`findTagByLocation` 命中别的标签则拒绝
(守一行一签)→`retargetTag`+`saveStore`。`cancelMoveTag` 复位。菜单见 package.json
的 `view/item/context`(move 组)与新增的 `editor/context` 节。

为后续双版本(0.7.0)铺路:`retargetTag` 是「人显式把标签指向某行」的唯一通道,将来
加 `original` 字段时由它顺手一并写 original(加性扩展,不返工)。
```

- [ ] **Step 3: 提交**

```bash
cd /c/Users/dell/Desktop/plugin-research/codetour && \
git add CHANGELOG.md docs/code-jump-tags/功能-代码对照.md && \
git commit -m "$(cat <<'EOF'
docs(code-jump-tags): 0.6.0 移动手势 CHANGELOG + 功能-代码对照

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 构建 + 安装 + 手动验收 + 发版

**Files:** 无源码改动；产物 `code-jump-tags-0.6.0.vsix`（不提交）。

**Interfaces:** 终态——0.6.0 推到 marketplace + main 与 tag `v0.6.0` 已推。

- [ ] **Step 1: 全量单测 + 生产构建**

Run: `cd /c/Users/dell/Desktop/plugin-research/codetour && npx vitest run && npm run build`
Expected: 单测全绿；webpack 零错零警。

- [ ] **Step 2: 打包并强制安装 vsix**

Run: `cd /c/Users/dell/Desktop/plugin-research/codetour && npx vsce package && code --install-extension code-jump-tags-0.6.0.vsix --force`
Expected: 生成 `code-jump-tags-0.6.0.vsix`；安装输出含 `patrick1099.code-jump-tags@0.6.0`。

- [ ] **Step 3: 手动验收三场景**（提示用户在 VS Code 里 Reload Window 后验）

向用户报告，请其确认：
1. 树里「剪切标签」→ 切到另一个文件某行 → 编辑器右键「粘贴标签到此行」→ 标签连同笔记到位、复制的链接仍指向新位置。
2. 树里选一个标签 →「移到光标行」→ 同文件就近挪动一步到位。
3. 把标签粘/移到「已有别的标签」的行 → 被拒绝并弹「该行已有标签『…』」。

- [ ] **Step 4: 推 main + 轻量 tag 触发发布**

```bash
cd /c/Users/dell/Desktop/plugin-research/codetour && \
git push origin main && \
git tag v0.6.0 && \
git push origin v0.6.0
```

Expected: tag 推送触发 `.github/workflows/publish.yml`（`npm ci → npm run test:unit → vsce publish --no-dependencies`）。

- [ ] **Step 5: 确认 CI 发布成功**

Run: `cd /c/Users/dell/Desktop/plugin-research/codetour && gh run list --workflow=publish.yml --limit 1`
Expected: 最新一条 `v0.6.0` 触发的 run 为 `completed / success`（必要时 `gh run watch <id>`）。提醒用户 Reload Window 生效。

---

## Self-Review

- **Spec coverage:** ① `retargetTag` 纯函数（Task 1）✅；② 三入口手势 cutTag/pasteTagHere/moveTagToCursor + cancelMoveTag（Task 2）✅；③ 一行一签拒绝（Task 2 `placeTagAtCursor` + Task 5 验收③）✅；④ 不动 note/id/folder（Task 1 测试 + retargetTag 实现）✅；⑤ 空行弱锚（Task 1 blank 测试 + cursorTarget 传 undefined）✅；⑥ 跨文件（cursorTarget 按活动编辑器算 file）✅；⑦ 菜单 + editor/context + 命令面板隐藏（Task 3）✅；⑧ 前向兼容 original（文档 Task 4 记录，retargetTag 留作唯一写入口）✅；⑨ 纯函数单测 + 命令手动验（Task 1 vitest / Task 5 验收）✅。
- **Placeholder scan:** 无 TBD/TODO；每个代码步骤含完整代码与确切命令。
- **Type consistency:** `retargetTag` 签名在 Task 1 定义、Task 2 按相同参数顺序调用；`cursorTarget` 返回 `{file,line,text?,pattern?}` 与 `retargetTag` 入参对齐；`findTagByLocation(store,file,line)` 与既有签名一致；上下文键 `codeJumpTags:movingTag` 在 Task 2（setContext）与 Task 3（menus when）字面一致。
