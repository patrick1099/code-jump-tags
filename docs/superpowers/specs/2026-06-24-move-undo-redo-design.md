# Code Jump Tags 0.6.1 设计：撤回 / 恢复标签移动（move undo/redo）

> 状态：设计稿，已与用户口头确认（"就这样"），待写成实现计划
> 日期：2026-06-24 ｜ 版本目标：0.6.1 ｜ 依赖：0.6.0（移动手势 + `retargetTag`）

## 背景与定位

0.6.0 把「把标签重新钉到某一行」做成了廉价手势（剪切→粘贴 / 移到光标行），底层是纯函数
`retargetTag`。移动是「廉价但有后果」的动作——移错或后悔时没有退路，会让人不敢用。本版补上
**撤回 / 恢复**，让整套移动手势真正敢用：撤回会跳回原来的文件、把标签移回上一处。

本版**纯加性**：不改 `retargetTag` 的契约、不改 0.6.0 已发布的任何行为，只在其上包一层
「移动日志 + 撤回/恢复」。

## 目标 / 非目标

**目标**
- 撤回最近一次显式移动（全局，像 Ctrl+Z），并跳转到被还原的位置。
- 恢复（redo）刚撤掉的那次移动（全局，像 Ctrl+Y）。
- 针对单个标签撤回它自己的上一次移动（树右键入口）。
- 撤回逻辑抽成**纯模块**，可单测——顺带补上 0.6.0 命令层无自动化测试的遗憾。

**非目标（本版明确不做）**
- **持久化**：撤回栈只活在内存，Reload / 重启即清空（与编辑器 Ctrl+Z 同性质）。标签存储不加任何字段。
- **完整历史**：不存每个标签的全量移动史；只保留一个有上限的近期栈（最近 N 次）。
- **自动跟踪也能撤回**：自动行跟踪、建标签、删标签都不算「移动」，不进栈。
- **删除 / 从回收站恢复 不进本撤回栈**：删除已有自己的退路——进**回收站**（`store.trash`，
  `types.ts:36`，**持久化、跨会话**），可从回收站恢复；删除的「撤回」=从回收站恢复，「恢复」=再删。
  这条链已存在且比内存栈更强。撤回这能力只补「本来没退路」的操作，移动正是那个洞；把删除塞进
  会话级栈只会造出第二条更弱的删除恢复路径，反而混淆。统一的「全操作 Ctrl+Z」是另一量级的设计，另立项。
- 绑定键盘快捷键（避免与编辑器 Ctrl+Z/Y 冲突）；标签视图标题栏按钮（留作可选后续）。
- 0.7.0 的 `original`/`current` 双版本身份（与本版正交，见末节）。

## 数据模型：纯模块 `src/lodestar/moveJournal.ts`

新建纯逻辑模块，**不得 `import vscode`**（与 `tree.ts`/`relocate.ts`/`adapter.ts` 同列）。

```ts
// 标签锚点的一份快照（与 retargetTag 入参同构）。
export type Anchor = {
  file: string;
  line: number;        // 1-based
  text?: string;
  pattern?: string;
};

// 一次显式移动：from=移动前的锚, to=移动后的锚。
export type MoveEntry = {
  tagId: string;
  from: Anchor;
  to: Anchor;
};

// 撤回 / 恢复两个栈，均 newest-last。
export type MoveJournal = {
  undo: MoveEntry[];
  redo: MoveEntry[];
};

export const UNDO_CAP = 20;   // 「最近几步」上限，溢出丢最旧
```

纯函数（全部不依赖 vscode，输入输出确定，易单测）：

- `createJournal(): MoveJournal` —— `{ undo: [], redo: [] }`。
- `recordMove(j, entry): void` —— push 到 `undo`；若超过 `UNDO_CAP` 丢最旧（`undo.shift()`）；
  **清空 `redo`**（新移动作废 redo 历史，标准编辑器语义）。
- `popUndo(j): MoveEntry | undefined` —— 弹出 `undo` 最新一条并 push 到 `redo`；空栈返回 undefined。
- `popRedo(j): MoveEntry | undefined` —— 弹出 `redo` 最新一条并 push 到 `undo`；空栈返回 undefined。
- `popUndoForTag(j, tagId): MoveEntry | undefined` —— 从 `undo` 栈里**从后往前**找第一条 `tagId`
  匹配的，从栈中间抽出，并 push 到 `redo`；没有返回 undefined。
- `pushBack(j, entry, side): void` —— apply 失败时回滚一次 pop：把 entry 放回 `side`（"undo"/"redo"）栈顶，
  并从另一栈移除刚才 pop 压入的那条。与 pop 系列对称。

> `popUndo`/`popRedo`/`popUndoForTag` 自己负责在两个栈之间倒腾——它们返回被取出的 entry，
> 命令层只负责「拿 entry 去 retarget + 跳转」，不碰栈结构。这样栈的不变量集中在纯模块里、可测。

## 命令层接线（`src/lodestar/commands.ts`）

模块级持有一个 `MoveJournal`：`const s_moveJournal = createJournal();`（内存态，随插件生命周期）。

**记录移动**：在 0.6.0 的 `placeTagAtCursor` 里，retarget **成功后**补一步——
把「移动前的锚」`from`（retarget 前从该标签节点读出的 file/line/text/pattern）与「移动后的锚」`to`
（即本次 target）组成 entry，调 `recordMove(s_moveJournal, entry)`。随后刷新两个上下文键。

> 需要在 retarget **之前**先把该标签当前锚读出来存为 `from`（一旦 retarget 就被覆盖）。

**应用一次还原**（撤回/恢复共用的私有助手 `applyMove(tagId, target: Anchor): boolean`）：
复用 0.6.0 的「一行一签」检查 + `retargetTag` + `saveStore` + 跳转，把标签放到 `target`：
- 目标行被**别的**标签占用 → 拒绝并提示「原位置已被标签『…』占用」，返回 false（调用方据此决定不倒栈）。
- `retargetTag` 返回 false（**标签已删除** / id 不存在）→ 提示「该标签已删除，无法撤回」，返回 false。
- 成功 → `saveStore()`，**跳转**：解析 `target.file`（workspaceRoot + 相对路径）→
  `window.showTextDocument` → 把光标/视口移到 `target.line`（0-based = line-1）。返回 true。

四条新命令：

| 命令 id | 入口 | 行为 |
|---|---|---|
| `codeJumpTags.undoMove` | 命令面板（`when: codeJumpTags:canUndoMove`） | `popUndo` → `applyMove(entry.tagId, entry.from)`。若 apply 失败（占用/已删）→ 把 entry 退回原栈状态（见下「失败回滚」）。刷新上下文键。 |
| `codeJumpTags.redoMove` | 命令面板（`when: codeJumpTags:canRedoMove`） | `popRedo` → `applyMove(entry.tagId, entry.to)`。失败回滚。刷新上下文键。 |
| `codeJumpTags.undoTagMove` | 树标签右键（move 组） | `popUndoForTag(node 的 tagId)` → `applyMove(entry.tagId, entry.from)`；无该标签条目 → 提示「该标签没有可撤回的移动」。失败回滚。刷新上下文键。 |
| （`redoMove` 已含全局恢复，无 per-tag redo——YAGNI） | | |

**失败回滚**：`popUndo`/`popRedo`/`popUndoForTag` 已经把 entry 挪到了另一个栈。若随后的 `applyMove`
失败，命令层用纯模块提供的 `pushBack(j, entry, side)` 把这次倒栈**撤销**，保持「失败不改变栈状态」：
- 行被**别的标签占用**（apply 因占用失败）→ `pushBack` 放回原栈（撤回失败 → 放回 `undo` 顶；
  恢复失败 → 放回 `redo` 顶），用户可腾出该行后重试。
- 标签**已删除**（`retargetTag` 返回 false）→ **不** `pushBack`，直接丢弃该 entry（它永远 apply 不了）。

`pushBack(j, entry, side: "undo" | "redo"): void` 也是纯模块函数：把 entry push 回指定栈顶（并从
另一栈移除刚才 pop 时压入的那条）。其行为与 pop 系列对称，一并单测。**原则：apply 失败（占用）后
栈状态与 apply 前完全一致。**

**上下文键**：`codeJumpTags:canUndoMove`（`undo` 非空）、`codeJumpTags:canRedoMove`（`redo` 非空），
每次 record/undo/redo 后用 `setContext` 刷新（与 0.6.0 的 `movingTag` 同法）。

## 菜单贡献（`package.json` → `contributes`）

- `commands`：新增 `undoMove`（撤回移动）/ `redoMove`（恢复移动）/ `undoTagMove`（撤回此标签的移动），中文 title。
- `commandPalette`：`undoMove` → `when: codeJumpTags:canUndoMove`；`redoMove` → `when: codeJumpTags:canRedoMove`；
  `undoTagMove` → `when: false`（依赖树节点参数，不在面板裸露，同 0.6.0 的 node-命令惯例）。
- `view/item/context`（标签项 `viewItem =~ /^codeJumpTags.tag/`）：`undoTagMove` 加进 0.6.0 的 `move` 组（`move@3`）。
- 版本号 `0.6.0` → `0.6.1`。

## 测试

- **`moveJournal.ts` 纯模块单测（vitest，新建 `test/lodestar/moveJournal.test.ts`）**：
  - `recordMove` 压栈、`UNDO_CAP` 溢出丢最旧、push 后 `redo` 被清空。
  - `popUndo` 弹最新并进 redo；空栈返回 undefined。
  - `popRedo` 弹最新并回 undo；空栈返回 undefined。
  - `popUndoForTag` 从栈中间抽出该标签最新条目；无匹配返回 undefined；抽出后其余顺序不变。
  - `pushBack` 回滚一次 pop 后，两栈状态与 pop 前完全一致（undo 侧、redo 侧各一例）。
  - 一次 record 后 redo 清空（连续移动作废 redo）。
- **命令层**：与 vscode 强耦合，照 0.6.0 惯例靠 build + 手动重载验：①移动一个标签→撤回→跳回原文件原行、标签回到原处；②撤回后恢复→又回到移动后的位置；③树里对某标签「撤回此标签的移动」；④撤回到「已被别的标签占用」的行→被拒绝并提示；⑤Reload 后撤回栈清空（撤回命令在面板消失/灰）。

## 边界与取舍（老实交代）

- **撤回不还原自动行跟踪的漂移**：若移动后该标签因上方编辑被行跟踪挪过，撤回仍把它放回记录时的
  `from` 锚——这与 Ctrl+Z「还原到记录态」一致，可接受。
- **跨会话不可撤回**：关窗即清空。比起为撤回引入持久化的复杂度，这是有意的取舍。
- **per-tag 撤回从栈中间抽条**会让全局撤回顺序不再严格按时间——这是「针对某标签」这一刻意动作的
  自然代价，可接受。

## 与 0.7.0 original/current 的衔接（仅记录，不在本版实现）

本套是「会话级、针对显式移动的临时撤回」，与 0.7.0 的 `original`（对机器只读的持久身份）**正交**：
- 撤回的 `from`/`to` 是短暂位置快照，不是身份。
- 将来 `retargetTag` 扩展为「人显式移动时顺手写 `original`」后，撤回因为**也走 `retargetTag`**，
  会自然把 `original` 一并还原回旧位置，语义自洽，无需为撤回特判 original。
