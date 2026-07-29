# 设计稿:失配「实时采纳」——我盯着改的默认最新,只有背着我改才报失配

> 日期:2026-07-27 ｜ 状态:**设计定稿,暂不实现(用户 parked)** ｜ 目标分支:待新建
> 背景:当前只要锚定行内容和 `original` 不一致就报失配(⚠ 可疑),不区分「是不是我此刻亲手改的」。用户希望换成「我在会话里盯着改 = 默认最新,自动采纳;只有不是我此刻动手的改动才报失配」。

## 一句话目标

**锚点在「我正盯着的这个 VS Code 会话里被我亲手改」时,静默采纳为最新内容(更新 `original`/`text`/`pattern`),永不报失配;失配只在「改动来自会话之外」时出现——① 关掉 VS Code 后被外部/别的编辑器改、② `git pull`/`checkout`/`merge` 拉入、③ VS Code 开着但被别的编辑器改。**

## 心智模型 / 一个事实

失配的语义要从「内容和我打标签那一刻不同」改成「**趁我没盯着时,内容被别人/别的手段动了**」。分三种情况,只有第一种要改逻辑:

| 情况 | 现状 | 目标 | 要不要改 |
|---|---|---|---|
| 会话内我亲手改锚定行 | 报失配 | **静默采纳最新** | **要改** |
| 关掉 VS Code、外部/别的编辑器改,再打开 | 打开时复查报失配 | 报失配 | 不用改(现状即对,靠 open/focus 复查) |
| git pull / 同步拉入(VS Code 开着) | 报失配 | 报失配 | 逻辑对,换触发方式(认 git 动作,不靠磁盘监听) |
| **VS Code 开着、被别的编辑器改** | 报失配 | **报失配** | **要改**(用户明确不接受漏掉;需落盘记账) |

## 关键难点:用户开着自动保存(autosave)

autosave 下「你打字」也会很快落盘,和 git pull / 外部工具写盘**都触发文件系统监听**,所以**不能靠「磁盘动没动」区分**你的编辑和外来改动。必须靠**落盘来源记账**来分辨「这次磁盘写入是不是我自己(autosave)造成的」。

## 现有骨架(可复用,`src/player/recheck.ts`)

复查是**触发点驱动**、非每键重算,且每个触发点可单独开关(`codeJumpTags.recheckOn.*`):
- `open`(`onDidChangeActiveTextEditor`,默认开)、`focus`(`onDidChangeWindowState`,默认开)、`save`(默认关)、`externalChange`(`createFileSystemWatcher("**/*")` 的 `onDidChange`,默认开)、`idle`(编辑后 1.5s 防抖,默认关)。
- 每次只复查触发的那个文件:`recheckFile(file)` → `classifyFileTags(tags, text)`(纯,`src/lodestar/suspect.ts`)→ `setFileSuspects` → 变了就重绘。
- 失配状态**运行时态、从不持久化**(`suspect.ts` registry Map)。

## 设计:落盘来源记账 + 实时采纳 + 重载守卫 + git 信号

### ① 会话内实时采纳(正式标签)
- 订阅 `onDidChangeTextDocument`;当改动落在某**正式标签**的锚定行且改了内容,且该事件**可归因为用户键入**(见 ③ 判定),就对该标签 `reanchorTag` 采纳最新:更新 `original`/`text`/`pattern`,并清除它的 suspect 状态。
- `reason === Undo/Redo` 视为用户自己的操作 → 一样采纳(采纳到回退后的内容)。

### ② 落盘来源记账(autosave 下区分「我存的」vs「外人写的」)
- 订阅 `onDidSaveTextDocument`(必要时配 `onWillSaveTextDocument`):每当我们的会话把某文件写盘,记一条 per-file `{ 内容哈希, 时间戳 }` = 「这是我自己刚写的」。
- 文件系统监听 `onDidChange(uri)` 触发时:与最近一条「我自己写的」记录比对(时间窗 + 内容哈希)。
  - **匹配** → 是我自己 autosave 的回声 → 忽略(前面 ① 已采纳)。
  - **不匹配**(没有近期自存,或磁盘内容≠我存的)→ **外来写入** → 对该文件跑失配复查(**不采纳**)。

### ③ 重载守卫(把「外来写盘后 VS Code 重载」与「用户键入」分开)
- 检测到「外来写入」(② 中不匹配的监听事件)后,给该文件打一个短时「**预期重载**」标记。
- 紧接着 VS Code 重新加载该文件触发的 `onDidChangeTextDocument`,在标记窗口内 → 判为**外来重载**(→ 失配复查,**不采纳**),而非用户键入。
- 用户键入的 `onDidChangeTextDocument`:活动编辑器、无未匹配的外来磁盘事件在先 → 判为**用户键入**(→ ① 采纳)。

### ④ git 信号(pull/checkout/merge 的可靠专用触发)
- 除磁盘监听外,挂内置 Git 扩展信号(`gitExtension` 的 `repository.state.onDidChange`)或盯 `.git/logs/HEAD`:一旦发生 pull/checkout/merge,对受影响文件强制失配复查。
- 这是用户点名的首要场景,belt-and-suspenders,即便 ②③ 边界抖动也不漏 git。

### ⑤ 关掉会话后外部改 → 免费覆盖
- 会话关闭期间无 ① 采纳发生,重开时 `open`/`focus` 复查发现 `original` 与磁盘不符 → 失配。**现状即如此,不用改。**

## 隐私铁律(不可破)
- **实时采纳只对正式标签**。inline 随手 `//me:` 标签**绝不**由 `onDidChangeTextDocument` 采纳——它在 `trackLineShifts` 里本就 `if (node.inline) continue` 跳过行内重锚(防展开态 marker 文字漏进锚点=私记泄漏);本设计必须沿用,inline 锚点仍只由 `collapseLine` 从剥净 code 唯一重写。设计与实现都要显式守住这条。

## 边界 / 开放题(实现前要定)
- autosave 去抖与监听事件的先后次序不稳:用**内容哈希**而非纯时间戳兜底误判回声。
- 多编辑器 / 分屏 / 同文件多视图下的归因。
- 「采纳」要不要设相似度地板(现引擎 0.9):用户原话是「盯着的就是最新、无条件采纳」→ 倾向无条件;但若一次大重构把锚定行卷没,无条件采纳会把标签静默挂到无关代码上——需和用户确认要不要保底。
- 配置开关:是否加 `codeJumpTags.suspect.liveAdopt`(默认?)在「实时采纳」与现「一有分歧就失配」两种模式间切换。
- 外部工具「原子替换写入」(先写临时文件再 rename)可能让监听事件表现为 create/delete 而非 change,记账要覆盖 `onDidCreate`/`onDidDelete`。

## 测试思路
- 纯逻辑(`suspect.ts` classify、记账比对、归因判定)抽成不依赖 vscode 的纯函数上 vitest。
- vscode 胶水(采纳、重载守卫、git 信号)靠 F5:会话内改→不失配且锚更新;关掉外部改→失配;开着 git pull→失配;开着外部编辑器改→失配;inline 全程不被采纳、源码不泄漏。

## 依赖 / 顺序
- 独立于「一行多签」,但共用 `recheck.ts`/`suspect.ts`/`relocate.ts`。可单独成一个 SDD 计划。实现前建议先补一轮 brainstorm 把上面开放题定死。
