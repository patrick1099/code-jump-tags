# Code Jump Tags 0.6.0 设计：移动 / 剪切粘贴标签（re-anchor 手势）

> 状态：设计稿，待用户审阅
> 日期：2026-06-24
> 版本目标：0.6.0

## 背景与战略定位

标签跟随代码行的自动匹配，一路在「锚位置 vs 锚内容」两个互相矛盾的目标之间打补丁
（0.3.x 位置追踪 → 0.3.6 内容找回 → 0.5.0 模糊+就近 → 0.5.1 防锚点污染）。讨论后确立的
方向是**不再赌机器全知全能**，而是「机器可预测 + 人工纠正零成本」：机器拿不准时老实认怂，
人一个手势就能把标签放到正确的行。

本 spec 只做这一子——**让「把标签重新钉到某一行」变成一个廉价手势**。它有两层价值：

1. **直接降低后续 matching 重构的赌注**：自动匹配只要处理好常见情况，剩下的交给一秒钟的
   手动修正。original/current 双版本那套（identity 只读 + position 缓存可丢弃 + 重设权只在人手里）
   本版**不做**，留待后续。
2. **铺好共享地基**：未来「冲突时点『是，采纳 current』」与「重命名后重指」复用的，正是本版的
   同一个原子操作——只是行号来源不同（光标 vs current 建议位置）。

## 目标 / 非目标

**目标**
- 一个纯函数原子操作 `retargetTag`：把指定标签重新锚到 `(file, line)`，按该行文字重采 `text`/`pattern`。
- 两个入口手势（均复用上述原子操作）：
  - **剪切标签 → 粘贴到此行**（可跨文件）。
  - **移到光标行**（一步到位，最适合近处同文件挪动）。
- 不动笔记内容 / id / 所属文件夹 / createdAt；只改位置与锚点。

**非目标（本版明确不做）**
- `original`/`current` 双版本数据模型与冲突解决 UI（后续版本）。
- 让标签自动跟随真实的 Ctrl+X/Ctrl+V 代码移动——这需要靠内容启发式去猜「粘进来的=刚剪掉的」，
  正是我们一直在杀的「猜来猜去」，**明确排除**。
- 拖动行号边 gutter 图标——VS Code 对编辑器装饰**没有拖拽/点击 API**，平台做不到；入口只能是
  树菜单 / 右键菜单 / 命令。

## 核心抽象：`retargetTag`（纯函数，可单测）

位置：`src/lodestar/tree.ts`（与 `findNode`/`moveNode` 等树操作并列；纯逻辑、不 import vscode）。

```ts
// 把标签 id 重新锚到 (file, line)，并替换其内容锚 text/pattern。
// anchorText/anchorPattern 由调用方按目标行文字算好传入（与 addTag 同源：
// lineAnchorText/linePattern，二者都内部 trim）。空行 → 传 undefined（弱锚，
// 与在空行建标签一致）。返回是否更新成功（id 不存在或不是 tag → false）。
export function retargetTag(
  store: LodestarStore,
  id: string,
  file: string,
  line: number,            // 1-based，与 TagNode.line 一致
  anchorText?: string,
  anchorPattern?: string
): boolean;
```

实现：`findNode(store, id)`；非 tag → 返回 false；否则赋值 `node.file/line/text/pattern`，返回 true。
笔记 `note`、`id`、`createdAt`、所在文件夹一律不动。

> 为什么不让它自己从原始行算 text/pattern：`lineAnchorText`/`linePattern` 在 `relocate.ts`，而
> `relocate.ts` 已 `import { LineEdit, shiftedLine } from "./tree"`。若 `tree.ts` 反向 import
> `relocate.ts` 会成循环依赖。故由命令层（本就同时 import 两者）算好再传入，纯函数只赋值。

## 命令与交互（命令层 `src/lodestar/commands.ts`）

模块级状态：`let s_movingTagId: string | undefined;`（"剪切中"的标签 id）。
上下文键：`codeJumpTags:movingTag`（true 时才显示「粘贴到此行」菜单），用 `commands.executeCommand("setContext", ...)` 维护。

新增三条命令（均在 `registerLodestarCommands` 末尾注册，模式同现有命令）：

| 命令 id | 行为 |
|---|---|
| `codeJumpTags.cutTag` | 入口=树标签项右键。`s_movingTagId = tagId`（取 `node?.tagLink?.id ?? node?.tagId`，同 `renameTag`），置 `movingTag` 上下文键，状态栏提示「标签移动中：把光标放到目标行，右键『粘贴标签到此行』」。 |
| `codeJumpTags.pasteTagHere` | 入口=编辑器右键（`when: codeJumpTags:movingTag`）。读 `window.activeTextEditor` 与光标行 `selection.active.line`(0-based)→`+1`；`file = getRelativePath(workspaceRoot.path, doc.uri.path)`；行文字算 `text`/`pattern`；调 `retargetTag` → `saveStore()`；清 `s_movingTagId` 与上下文键；状态栏「已移动到 file:line」。 |
| `codeJumpTags.moveTagToCursor` | 入口=树标签项右键。一步到位：tagId 取自 node，`file`/`line`/行文字取自 `window.activeTextEditor` 当前光标，直接 `retargetTag` + `saveStore()`。无中间态。 |

辅助：`codeJumpTags.cancelMoveTag`（清状态，供「剪切」后反悔；命令面板可见，`when: codeJumpTags:movingTag`）。

**保存与重绘**：`saveStore()` = 写盘 + `rebuildTours()`，decorator 的 reaction 自动重画 gutter/CodeLens、树刷新，无需手动触发（同现有所有改 store 的命令）。

## 菜单贡献（`package.json` → `contributes`）

`commands`：新增 4 条声明（cutTag / pasteTagHere / moveTagToCursor / cancelMoveTag），中文 title。

`menus`：
- `commandPalette`：cutTag / moveTagToCursor 置 `when:false`（依赖树节点参数，不在面板裸露，同现有 node-命令惯例）；pasteTagHere / cancelMoveTag 用 `when: codeJumpTags:movingTag` 守。
- `view/item/context`（标签项 `viewItem =~ /^codeJumpTags.tag/`）：加 cutTag 与 moveTagToCursor，归入一个新 `move@N` 组（与 change/manage 分开）。
- `editor/context`（**新增该节**）：pasteTagHere，`when: codeJumpTags:movingTag`，放一个独立 group。

## 数据模型

本版**不加新字段**，沿用 `TagNode` 现有 `file/line/text?/pattern?`（`src/lodestar/types.ts`）。

**前向兼容**：后续加 `original` 字段时，`retargetTag` 顺手再写 `original`（加性扩展，不返工）——因为
「人显式把标签指向某行」正是后续设计里**唯一允许重设 original 的动作**。

## 边界与取舍

- **目标行已有别的标签**：`findTagByLocation(store, file, line)` 命中且非本标签 → 拒绝并提示
  「该行已有标签『…』」，守「一行一签」不变量（与 addTag 一致）。
- **无活动编辑器 / 无光标**：提示「请把光标放到目标代码行」。
- **空行 / 纯空白行**：`text`/`pattern` 为 undefined（弱锚），允许，与在空行建标签同。
- **跨文件**：剪切粘贴天然支持（file 按目标编辑器重算）；moveTagToCursor 亦按活动编辑器算（即跨到光标所在文件）。
- **文件夹归属**：不变（只改位置，不动树结构）。

## 测试（vitest，`test/lodestar/tree.test.ts`）

`retargetTag` 纯函数单测：
- 移动后 `file/line/text/pattern` 全部更新，返回 true。
- 未知 id / 指向文件夹节点 → 返回 false、store 不变。
- 命中嵌套在文件夹里的标签。
- `note`/`id`/`createdAt`/所属文件夹保持不变。

命令层（cutTag/pasteTagHere/moveTagToCursor）与 vscode 耦合，按本仓库惯例靠**构建 + 手动重载验**
（在交付说明里点名要验：①树里剪一个标签→另一文件某行右键粘贴→标签连同笔记到位、链接仍对；
②树里选标签→「移到光标行」就近挪动；③粘到已有标签的行→被拒绝并提示）。

## 与未来 original/current 重构的衔接（仅记录，不在本版实现）

后续做双版本匹配时：
- 跳转/恢复**只用 original 匹配**（不可被追踪过程改写的那份才有资格当裁判）。
- current 不当裁判，只做实时显示 + 「original 失配时」预填好的「新身份建议」。
- 重开/pull 时 original 失配 → 标签转「可疑态」，给两个动作：「采纳 current」与「以 original 找回」，
  二者都只是带不同行号去调**本版的 `retargetTag`**。

## 实施顺序

1. `retargetTag` 纯函数 + 单测（TDD）。
2. 命令层三条命令 + 状态/上下文键。
3. `package.json` 命令声明与菜单（含新增 `editor/context`）。
4. 构建零错零警 + 安装 + 手动验三项 → 发 0.6.0。
5. 更新 `docs/code-jump-tags/功能-代码对照.md` 与 `CHANGELOG.md`。
