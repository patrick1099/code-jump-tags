# 设计稿:恢复「正式标签一行多签」

> 日期:2026-07-27 ｜ 状态:**定稿,待写实现计划** ｜ 分支:`feat/inline-me-notes`(与 0.8.0 inline 同分支,未发布)
> 背景:正式标签本来支持一行多条(hover/CodeLens 逐条渲染),后来被特意加了「一行一签」限制。现撤回,恢复一行多条独立正式标签。

## 一句话目标

撤回「正式标签一行一签」的三处写入侧守卫,让一行可以有多条独立正式标签;行上方每条显示为一个独立可点的 `⌖ 注释`(多条以 ` | ` 分隔),**点哪条编辑哪条,不共享编辑框**。

## 心智模型 / 一个事实

「一行一签」从来不在渲染层——`decorator.ts` 的装饰与 CodeLens 一直是**逐条标签(per-step)** 生成的,一行两条就画两条。限制全在三处**写入侧守卫**里。撤回 = 拆掉这三处守卫 + 把行上方多条 CodeLens 排好序、加分隔符。渲染层几乎不用动。

## 改动清单

### ① `+` 总是新建(核心)

`src/recorder/commands.ts` 的 `addTag` 回复处理器(约 :410-428):删掉「`findTagByLocation` 命中已有标签 → `openTagEditor` 改去编辑那条 / 或把输入并进无注释的那条」的整个 `if (existing) { … }` 分支。`+` 提交后**一律**走下面的「构造新 `TagNode` → `addTag` 进 inbox → 存盘」。

- 空文本提交的行为**不变**(与今天在空行按 `+` 提交空文本一致;不是本次要解的问题)。
- **inline 隔离不受影响**:inline 折叠/展开走的是 `findInlineTagByLocation`(0.8.0 加),只认该行 `inline===true` 的标签;正式标签走 `+`/树,两条路互不干扰。

### ② 行上方多签渲染:`⌖ A | ⌖ B`,各自可点

`src/player/decorator.ts` 的 `TagCodeLensProvider.provideCodeLenses`(约 :343-370)现在是把所有 above 位置的 step **平铺** map 成 CodeLens。改成:

1. 先按**行**分组(同一 `line` 的 step 归一组)。
2. 每组内按 `createdAt` **升序稳定排序**(决定 `|` 左右顺序,保证稳定)。
3. 组内逐条生成 CodeLens(仍是 `Range(line,0,line,0)`、`command: editNote`、`arguments: [step.id]` —— 每条各自可点、各编辑各的),标题由纯函数给:
   - 第 1 条:`⌖ ${note}`(无注释 → `⌖`)。
   - 第 2 条起:`| ⌖ ${note}`(前缀 `| `,视觉上与前一条拼成 `⌖ A | ⌖ B`)。

**纯函数(可单测)**:`lineLensTitles(notes: string[]): string[]` —— 入参是**已排好序**的该行各标签注释首行,返回等长的标题数组,首条 `⌖ …`、后续 `| ⌖ …`(空注释 → `⌖` / `| ⌖`)。放进一个无 `vscode` 依赖的小模块(如 `src/player/lensTitles.ts` 或并入现有纯工具),`decorator.ts` 只负责分组、排序、把 `note`/`line`/`step.id` 喂给它并组装 `vscode.CodeLens`。

- gutter 图标:一行仍一个(多条装饰 range 相同,VS Code 合并),不用动。
- hover:多条 step 的 hover 挂在重叠 range 上,VS Code 自动把它们拼在同一个悬浮框里逐条列出,每条各带自己的「✎ 编辑注释」(现状,不动)。

### ③ 放开另两处占用守卫(一致性)

否则 `+` 能叠、移动却不能落在已占行,自相矛盾。

- `src/lodestar/commands.ts` `placeTagAtCursor`(约 :317-328):删掉「`findTagByLocation` 命中别的标签 → 提示『该行已有标签』并 `return false`」的整段占用拒绝。移到光标行可落在已有标签的行。
- `src/lodestar/commands.ts` `applyMove`(撤回/恢复移动,约 :430-445):同样删掉占用拒绝分支,撤回/恢复可把标签放回已被占用的原行。

### ④ `findTagByLocation` 保留、更新注释

`src/lodestar/tree.ts` 的 `findTagByLocation` 仍被 `gotoLocation`(深链跳转,commands.ts:95)使用——它只是拿「该行任一标签」的 `original`/`text` 锚把行号解析回真行;多条标签共享同一行,取第一条即可,**无碍**。保留函数,只把它「用于保证一行一签」的注释更新成「取该行首条标签的锚用于行号解析」。

## 边界 / 明确不动的

- **「点小字编辑」只对行上方样式有效**。行尾静态装饰(普通标签 `notePosition:"end"`)不能带点击命令(VS Code 限制)——记进已知限制。用户用行上方,不受影响。
- **行尾 inline 随手 `//me:`(0.8.0)另有一套编辑方式**:光标移回该行自动展开成文字改,不靠点击;**一行仍只能一条 inline**(buffer 往返最右 marker 会把前一条并进锚点=泄漏)。本次不改这套。
- **inline 随手与正式标签同行共存**已在 0.8.0 做好(`findInlineTagByLocation` + 正式在上方、inline 在行尾),本次不动。
- 不碰 inline 折叠/展开、删除/回收站、拖拽。

## 测试

- **纯逻辑**:`lineLensTitles` 用 vitest 覆盖——单条 `⌖ A`;多条 `["⌖ A","| ⌖ B","| ⌖ C"]`;空注释 `⌖` / `| ⌖`;空数组 `[]`。
- **vscode 胶水(无自动化单测,F5 手动验收)**:
  - 同一行 `+` 两次 → 行上方出现 `⌖ A | ⌖ B` 两条,点各自那条分别打开各自编辑框(不共享)。
  - 「移到光标行」/「撤回移动」能落在已有标签的行,不再被拒。
  - 删除其中一条,另一条不受影响。
  - 一行:多条正式标签(上方)+ 一条 inline 随手(行尾)共存正常。

## 版本

0.8.0 尚未发布/合并,**并进 0.8.0**:`CHANGELOG.md` 的 `## 0.8.0` 段补一句「正式标签恢复一行多条:同行 `+` 每次新建一条,行上方多条 `⌖ 注释` 以 `|` 分隔、点哪条编辑哪条;『移到光标行/撤回移动』可落在已有标签的行」。不单开 0.8.1。同步更新 `docs/code-jump-tags/功能-代码对照.md`(§2 `+` 行为、CodeLens 渲染那几处的对应描述)。

## 依赖顺序

依赖 0.8.0 已落地的 `findInlineTagByLocation`(已在 commit 9d58b9d)。本设计与 inline 代码基本不沾,可独立实现。
