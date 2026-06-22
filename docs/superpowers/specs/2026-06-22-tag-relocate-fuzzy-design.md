# 标签行重定位：就近 + 模糊匹配 设计

日期：2026-06-22
范围：Code Jump Tags（patrick1099.code-jump-tags）标签的“跟随代码行”机制
相关文件：`src/lodestar/relocate.ts`（核心）、`src/player/decorator.ts`、`src/lodestar/editThread.ts`、`src/lodestar/commands.ts`、`src/lodestar/types.ts`、`src/recorder/commands.ts`

## 背景 / 问题（根因）

当前每个标签把它那行的文字编译成一个正则 `pattern`（`^[^\S\n]*` + trim 后文字逐字转义），重定位时若当前行不再匹配，就用 `text.match(re)` 在**整个文件里找第一个**匹配的行。读代码确认了用户报告的三个根因：

- **RC1 完全精确匹配，无任何容忍**：`linePattern` 逐字 literal 匹配 trim 文字。行内插一个字符、删一个词间空格都会当场失配。
- **RC2 失配后取“全文件第一个匹配”，不看远近**：`resolveLine` 的 `text.match(re)`（带 `m`）从文件开头扫，返回最靠前的命中。文件里有重复代码（被 `#if 0` 宏关掉的孪生函数、重复样板）时，标签会跳到靠前那一份——常常是被宏关掉的那个。
- **RC3 行内编辑（delta=0）不刷新锚点**：`trackLineShifts`（decorator.ts）在 `edits.every(delta===0)` 时早退，所以行内敲字从不更新存储的锚点，锚点变“过期”，为下一次结构性编辑/重开时的错跳埋雷。

三者叠加解释了全部现象：插字符/删空格失配（RC1）、乱跳到宏孪生函数（RC2，用户自己的猜测，代码已证实）、逐字改写后再删换行触发刷新又能跟上（RC3）。

## 目标

- 行内小改动（插/删几个字符、删空格）后标签仍稳定跟随原行。
- 失配时优先就近匹配，绝不被远处的重复副本吸走。
- 全文件都无合格匹配时保持原行不动，绝不乱跳。
- 锚点永不过期：行内编辑也实时刷新。
- 核心保持纯函数、不 import vscode，可单测。

## 决策（已与用户确认）

| 决策 | 选择 |
|---|---|
| 模糊判定 | 空白归一化后的 Levenshtein 归一化相似度 |
| 相似度阈值 | `0.9` |
| 搜索策略 | 距离优先 / 同心扩圈，近处合格者优先于远处精确副本 |
| 存储模型 | **加性**：保留 `pattern`（正则，供旧层/URL），新增 `text`（原始 trim 文字，供模糊解析） |
| RC3 | 行内编辑去掉早退，针对性刷新被改行上的标签锚点 |

## 0. 两层分工：实时追踪是主力，模糊只是恢复兜底

容易误解的关键点，先讲清楚：**模糊匹配不是日常追踪的主力，它只在“我们没看见的变动”时才真正发力。** 两层互补，不可二选一。

- **实时记录（主力，字符级精确）** —— 文档打开、扩展在跑时，每个编辑都有 `onDidChangeTextDocument` 事件。`trackLineShifts`（含 RC3）对每个事件刷新锚点（行号 + `text`），所以**所有“我们亲眼看见的编辑”都是精确追踪的**，包括“行中插字符再换行”这类：插字符（delta=0）刷新该行文字、换行（delta=+1）`shiftedLine` 精确移行。这类情况下中心行刷新后相似度恒为 1.0，**模糊的窗口搜索压根不执行**（只做一次中心行命中检查即返回）。
- **内容恢复（兜底，仅限未见变动）** —— 实时记录的前提是“文档开着、我们收得到事件”。有一整类变动**没有事件可记**，实时层对它们是瞎的：
  1. 编辑器/工作区**关着时**被改（vim、未装扩展的窗口、CLI）；
  2. **git 操作**：`pull` / `checkout` 切分支 / `merge` / `rebase` / `stash` 在磁盘整文件重写，无逐字事件；
  3. **外部工具**：sed、外部格式化、跨文件查找替换等；
  4. **重新打开文件的第一帧**：从存储行号起算（`decorator.ts:65`），文件若在关闭后变过则行号已过期。

  这些场景我们手里什么都没记，只能靠“这行长什么样”去内容里找回——这才是模糊/`pattern` 层存在的唯一理由。没有它，`git pull` 后重开文件标签会钉错行或乱跳。

**推论**：第 2 节的阈值 `0.9`、窗口半径等调参，**正常编辑时一次都用不上**，只在“重开一个被外部改过的文件”那一刻决定能否找回。

## 1. 数据模型（加性，不破坏既有契约）

> 修正：`pattern`（正则）不止是 lodestar 标签的私有字段，它还是两层之间的通用语和一个对外契约——不能直接替换：
> - 被适配进**继承自 CodeTour 的 step 模型**（`adapter.ts`、`store/index.ts`），原 CodeTour player/recorder 多处把 `step.pattern` 当 live 正则用（`player/index.ts:314`、`recorder/watcher.ts:18-44`、`player/tree/nodes.ts`、`decorator.ts:66-67` 的兜底）。
> - 被编进 **`vscode://` 深链 URL scheme**（`extension.ts:63`、`commands.ts:147-164,530`）——已复制出去的标签链接带 `pattern=`。改名会破坏旧链接并殃及一个与本 bug 无关的子系统。

因此采用**加性**改动：

- **保留 `pattern`**（正则）原样，继续服务旧 step 层 + URL 深链，**不动那套机制**。
- `TagNode` / `TagAnchor` **新增 `text?: string`**（原始 trim 文字），**仅**供新模糊解析器使用。
- 空白行：`text = undefined`（无可用锚点，重定位直接信任行号）。
- 新增 `lineAnchorText(lineText)`：返回 `lineText.trim()`，空行返回 `undefined`（不转义）。`linePattern()` 保留，建标签 / 刷新时**两者都生成**，`pattern` 与 `text` 同步保持新鲜。

**旧数据兼容（无破坏性迁移）**：旧 store 的标签只有 `pattern` 没有 `text`。加载规整时，对缺 `text` 的标签由 `pattern` 反推 `text`（剥前缀 `^[^\S\n]*`，把 `\X` 反转义为 `X`；反推不出则留 `undefined`），`pattern` 原样保留。这样旧标签升级后立即享有模糊解析，且不触碰 URL/step 层。

## 2. 核心匹配器（纯函数，relocate.ts）

新增：

- `normalizeWs(s: string): string` —— 去首尾空白、中间连续空白压成单个空格。
- `similarity(a: string, b: string): number` —— 对归一化后的两串算 Levenshtein 距离，返回 `1 - dist / max(len(a), len(b))`（两串皆空记为 1）。为性能对超长行设字符上限（如各取前 200 字符）。

新增 `resolveLineFuzzy(text, centerLine, anchorText): number`（1-based，纯函数；旧 `resolveLine(text,line,pattern)` 保留给 URL 深链/旧 step 层兜底）：

1. `anchorText` 为空 → 直接返回 `centerLine`（无锚点）。
2. **中心优先**：若 `similarity(centerLine 当前文字, anchorText) ≥ 阈值` → 返回 `centerLine`（常见情况，不搜索）。
3. **同心扩圈**：依次用半径 `R0`（默认 8）、`R1`（默认 40）、全文件，在 `[center-R, center+R]` 内收集所有 `similarity ≥ 阈值` 的行；只要某一圈非空，就在该圈里**取相似度最高、平手取离 center 最近**的行返回。
4. 全文件仍无 ≥ 阈值候选 → 返回 `centerLine`（保持不动）。

“先近后远、近处有合格的就停”天然让身边被改过的那行（模糊 ~0.9）先被选中，远处的精确副本（宏孪生）轮不到——消除 RC2。同圈内精确匹配（1.0）自然胜过模糊，无需特判。

`reanchorTag` 保持现有结构：先 `shiftedLine` 增量移动得到 center，再用 `resolveLineFuzzy` 校正，最后用解析行的当前文字**同步刷新 `text` 和 `pattern`**。

## 3. 接入点（模糊解析路径统一用 `text`）

模糊解析路径改用 `resolveLineFuzzy(text, line, tag.text)`：`reanchorTag`（live 编辑，decorator.ts:202）、`editThread.ts:106`、`commands.ts:81`。`decorator.ts:65` 走的是 step 模型——通过 `adapter.ts` 把 `tag.text` 一并适配进 step（`step.text`），或就近用 `findNode(cache, step.id)` 取 `tag.text`（与 `trackLineShifts` 同款查法），二选一在计划阶段定。`decorator.ts:66-67` 的旧正则兜底与 URL `gotoLocation` 仍用 `pattern`，不改。`recorder/commands.ts:394` 建标签处在生成 `pattern` 的同时也存 `text = lineAnchorText(lineText)`。

## 4. RC3：行内编辑刷新（decorator.ts `trackLineShifts`）

去掉 `edits.every(delta===0) → return` 早退：

- delta=0 时不做扩圈搜索（行号未变，无必要），但对**落在任一编辑范围行上**的标签，把其 `text` 刷新为该行当前文字（空行则置 `undefined`），有变更则 `rebuildTours()` + `debouncedSaveStore()`。
- 只触碰受影响的行，开销小。锚点永不过期，杜绝逐字改写后跳走。

## 4b. 行被从中间拆开的策略（由现有层次自然覆盖）

把一行从中间敲回车拆成两行（如 `if (a > b) { foo(); }` → `if (a > b) {` + `foo(); }`），两半各约 50% 相似度。**不需要任何额外代码**，现有层次已给出确定行为：

1. 这是 delta=+1 的结构性编辑，走 `reanchorTag`。换行点在行中间（endChar≠0），`shiftedLine` 规则下标签**不移动，留在原物理行 L = 上半行**（仅当回车敲在行首 endChar=0 时整行才被推到下一行，那是另一条已处理分支）。
2. `resolveLineFuzzy` 以 L 为中心，拿候选去和**原始整行锚点**比：上下两半各 ~0.5、全文件无 ≥0.9 → 命中“无可信匹配 → 不动”，保持在 L；随后把 `text` 刷新成上半行。

**策略 = 留在上半行并重锚到上半行。** 这里 50% 相似度是“沉默”而非“乱认”——因为拆行属于实时层看得见的局部编辑，行号本就正确，模糊层的安全规则“全文件无 ≥0.9 绝不移动”保证它不会把标签拽去别处。拆开后再删换行合回，标签全程黏在 L 行。

> 备选（未采纳）：检测拆行并让标签“跟相似度更高的那半走”。需专门比较两半、可能与原生 gutter 装饰打架，复杂度明显高，YAGNI。

测试补一例：中间拆行后标签留在上半行、`text` 刷新为上半、且不跳到他处。

## 5. 阈值与窗口常量

`relocate.ts` 模块常量：`SIMILARITY_THRESHOLD = 0.9`、`SEARCH_RADII = [8, 40, Infinity]`、`MAX_CMP_LEN = 200`。集中、可调。

权衡记录：阈值 0.9 偏严，误判少；代价是很短的行上单字符编辑可能跌破阈值（短行本就难唯一锚定，影响有限）。

## 6. 测试（TDD，vitest，纯函数）

`test/lodestar/relocate.test.ts` RED→GREEN 覆盖：

- 行内插一个字符 / 删一个词间空格后仍命中中心行。
- 文件里有远处精确副本（宏孪生）时，近处模糊行胜出，不被吸走。
- 全文件无 ≥ 阈值匹配 → 返回中心行不动。
- 空白行 / 空 `text` → 信任行号。
- 同圈内精确匹配胜过模糊匹配。
- `similarity` / `normalizeWs` 边界（空串、全空白、超长截断）。
- 由旧 `pattern` 反推 `text`（含转义字符还原），`pattern` 原样保留。
- 行内逐字改写后锚点跟随、不跳。
- 中间拆行后标签留在上半行、`text` 刷新为上半、不跳他处（见 4b）。

## 非目标（YAGNI）

- 不引入跨文件标签迁移。
- 不做基于 AST/语法的锚定，纯文本相似度即可。
- 不改回收站 / 撤销机制（另议）。
