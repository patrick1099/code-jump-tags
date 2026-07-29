# Code Jump Tags 设计定稿：inline `//me:` 私有注释

> 状态：**定稿，实现计划已写（`plans/2026-07-26-inline-me-notes-v1.md`），目标版本 0.8.0**。
> 日期：2026-07-05（2026-07-26 更新范围）｜ 依赖：0.7.x 的锚点引擎（`relocate.ts`）、可疑态引擎（`suspect.ts`）、装饰层（`decorator.ts`）、树（`player/tree`）。
> 范围切分：**v1 只做「行尾 marker」**（本稿主体）；**v2「上方注释」已弃**（末章存档，不实现）。
>
> **2026-07-26 范围决定（git filter 实验结论 + 用户拍板）：**
> 1. **建 v1，正式作为 0.8.0。** git filter 方案弃用——它逼出「debug 分支带注释 / main 分支不带」这种 per-branch 特殊处理，太费劲；纯插件方案天然免疫（注释根本不落源码，任何分支 commit 都干净）。
> 2. **marker 可自定义、支持多种并存。** 不再固定「词 + 冒号」，改为一个 **token 列表**（每个 token 自带标点），如 `["me:", "?"]` → 触发 `//me:` 与 `//?`。见「注释前缀」节。
> 3. **v2（上方注释）弃掉。** 上方那套「三选二」死结不好设计，砍掉；末章仅存档避免重开讨论。

## 为什么要这套（动机）

公司项目里想写点注释帮自己理解代码，但这些私货**不该提交到公司仓库**。现有做法要么污染 commit（真注释），要么手动打标签（进编辑模式→点 gutter→弹框，太重）。

关键认识：**「注释代码但不进 commit」这件事，Code Jump Tags 现在就能做**——标签存 sidecar（`.code-jump-tags/store.json`，gitignore 掉即可），源码一个字不动。用户真正缺的不是新的存储体系，而是一个**像敲注释一样快的输入手势**：直接在代码里敲 `//me: xxx`，它自动变成悬浮标签；想改时又变回 `//me:` 文本。

所以本特性的定位：**inline `//me:` 是「创建/编辑标签」的语法糖，不是一套平行的注释系统。** 底层复用现有 TagNode + 锚点引擎，几乎全是「authoring / editing 前端」。

## 核心原则（地基）

1. **私有注释的文字，绝不落进 git 能看见的地方。** 折叠态文件 100% 干净；展开态的文字只在「你光标正在这行」的几秒内存在。
2. **安全靠时机，不靠 git 配置（v1）。** 纯插件实现：光标离开即折叠 + 打开文件时扫残留兜底。不要求用户配 clean filter（留作将来可选硬化，见「已知取舍」）。
3. **复用胜过新建。** inline note 与正式标签是**同一个 `TagNode`**，只差一个 `inline` 标志位；锚点/跳转/装饰/可疑态全共享，不复制引擎。
4. **身份锚永不含标记词。** 匹配/存储用的锚文字，永远是「剥掉 `//me:...` 之后的干净代码」，标记词不得污染 `original`/`current`。

## 三种形态、一套存储

| 形态 | 存哪 | 进 git? | 长相 | 编辑方式 |
|---|---|---|---|---|
| **inline note**（本特性新增）| sidecar，`inline: true` | 否 | 行尾悬浮 💬 小字 | 光标进入 → 展开成 `//me:` 文本就地改 |
| **正式 tag**（现有）| sidecar | 否 | 行尾 / 上方 note | 点标签 → 编辑泡（**不**展开成文本）|
| 真实代码注释 | 代码里 | 是 | 普通注释 | 本特性不碰（未来的「提权到真注释」不在此期）|

前两者靠 `inline` 标志位互转（提权 / 降格）。**gutter 建的正式标签行为完全不变**——只有 inline note 会往返成文本。这是「两类」而非「一类」：随手碎念不默认塞进正式标签树。

## 数据模型（`src/lodestar/types.ts`）

`TagNode` **新增两个可选字段**（加性，旧数据无需回填即安全）：

- **`inline?: boolean`**：`true` = 这是一条 inline note（默认不进主树、光标进入展开成文本）。缺省 / `false` = 正式标签，行为同今天。
- **`inlineMarker?: string`**：折叠时记下这条 note 当初用的**完整 marker**（如 `"//me:"` 或 `"//?"`），光标回来展开就还原成用户敲的那种;缺省则退回该文件「首个配置 marker」。仅 inline note 用。

其余字段（`note` / `file` / `line` / `original` / `current`(=`text`) / `pattern` / `notePosition`）**全部沿用不改**。inline note 的 `notePosition` 恒为 `end`（v1 只做行尾）。

## 生命周期状态机（inline note 的核心）

```
[你敲]    int x = compute();  //me: 这里会溢出
   │  光标离开这行（blur）
   ▼
[折叠]    int x = compute();                    ← 文件干净，git 看不见
          💬这里会溢出   sidecar: { note:"这里会溢出", line, original:"int x = compute();", inline:true }
   │  光标回到这行（focus）
   ▼
[展开]    int x = compute();  //me: 这里会溢出   ← 可直接改
   │  光标再离开 → 回到折叠
```

三个转换 + 一个兜底：

1. **折叠（光标离开该行）**：
   - 解析行尾的 `<marker> 内容`（marker 见下节），取「内容」为 note、「marker 之前的干净代码」为锚文字。
   - 若该行**已有 tag**：更新其 `note`（遵「一行一签」，不新建第二个；保留其原 class）。
   - 否则**新建** `inline:true` 的 TagNode，锚 = 干净代码文字（走现有 `lineAnchorText`/`linePattern` 与 `original` 写入）。
   - 从该行删掉 `<marker> 内容` 那一段，把干净 buffer **存盘**（保证磁盘干净）。
2. **展开（光标进入该行，且该行有 inline note）**：把 note 以 ` <marker> 内容` 追加回行尾，光标落在内容处可改。**不改 sidecar，只改 buffer。**
3. **打开 / 载入文件时扫残留**：文件里任何遗留的 `<marker>` 行（上次没来得及折叠、或 autosave/崩溃写进磁盘的）一律执行一次折叠。带 + 兜底，堵住「光标停在展开行时被保存」的漏。
4. **（正式标签不参与展开）**：光标进入一条 `inline:false` 标签所在行时，**不**注入文本。

### 折叠 / 展开的边界

- **锚剥离**：`matchAnchor` / 锚写入前，先把行文字末尾的 `<marker> ...` 剥掉再比较，保证展开态不把 marker 写进 `original`。抽成纯函数 `stripInlineNote(lineText, marker)`。
- **行内已有真注释**：`foo(); // real //me: 私记` —— 只认**最后一个** marker 段为 note，`// real` 留在锚文字里。（取「最后一个 marker」而非第一个，避免把真注释里的字当 note。）
- **一行一签**：`//me:` 落在已有标签的行 → 归并进那条标签的 note，不产生第二签；class 维持原样。

## 注释前缀（跨语言、可自定义、多 marker 并存）

一个**完整 marker** = 当前语言的**行注释符** + 一个可配置 **token**（token 自带标点）。用户配一个 token 列表，每个都触发；跨语言自动换行注释符。

- 设置项 **`codeJumpTags.inlineNote.markers`**：`string[]`，默认 `["me:"]`。每项是「跟在行注释符后面的那截」，**自带标点**（所以能表达无冒号的 `?`）。
- 设置项 **`codeJumpTags.inlineNote.enabled`**（默认 `true`）：整特性总开关。

例：配 `["me:", "?"]`：

| 语言 | 行注释符 | 完整 markers |
|---|---|---|
| JS/TS/C/C++/Java/Go/Rust | `//` | `//me:`、`//?` |
| Python/Shell/YAML | `#` | `#me:`、`#?` |
| Lua/SQL | `--` | `--me:`、`--?` |

- 行注释符从 VS Code 语言配置取（语言 `comments.lineComment`），取不到退回 `//`。
- **解析规则**：一行里从右往左找**任意一个完整 marker**的最后一次出现;前面（trimEnd）是干净代码（锚文字），后面（trim）是 note。多 marker 并存靠「取所有 marker 里最靠右的那次匹配」统一处理。
- **回展保真**：折叠记下命中的完整 marker 进 `inlineMarker`，展开就用它（`//?` 不会被展成 `//me:`）;缺省退回列表首个。
- **纯/胶水分层**：纯函数只吃「完整 marker 列表」（语言无关，好测）；把 token 拼上行注释符得到完整 marker 是胶水层（读 vscode 语言配置）的活。

## 锚点与可疑态：直接复用，不新增引擎

- inline note 的锚 = 剥掉 marker 后的干净代码文字，写进 `original`/`current`，**和行尾正式标签走一模一样的 `relocate.ts`**：随代码编辑跟随、git pull 后按身份找回、失配转可疑态。
- 可疑态：inline note 复用现有软/硬可疑与「移到光标行」动作。**唯一差异**：inline note 默认不在主树，所以它的可疑提示主要落在 gutter + hover（树顶「待处理」分组是否纳入 inline note，作为一个 UI 小开关，默认纳入，便于一处清理）。

## 树视图 & 提权 / 降格

- inline note **默认不进主树**，避免几十条碎念刷屏。
- 树顶可选一个 **「💬 随手」只读汇总分组**（仿现有「待处理」`suspectTour` 的做法：引用、不搬动真实归属），设置项可开关。
- **提权为标签**（右键 inline note）：清 `inline` 标志 + 移入所选文件夹 → 立刻变正式标签（进树、可复制链接）。
- **降格为随手**（右键正式标签）：置 `inline:true` → 移出主树显示。
- 底层就是「翻 `inline` 标志位 + 刷新树」，纯 `tree.ts` 加性小函数（`setInline(store, id, boolean)`）。

## 命令 / 贡献点（`package.json`）

- `codeJumpTags.promoteInlineNote`（提权为标签）
- `codeJumpTags.demoteToInlineNote`（降格为随手）
- `codeJumpTags.rescanInlineNotes`（手动扫当前文件残留 `//me:` 并折叠——给关了自动折叠触发点的人兜底）
- 折叠/展开由编辑器事件驱动，不占显式命令：`onDidChangeTextEditorSelection`（判定光标进入/离开某行）、`onDidChangeActiveTextEditor` + 载入时扫残留。

## 测试（TDD，纯逻辑先行）

无 vscode 依赖的纯函数先写 vitest，再接胶水层（沿用 `lodestar/` 既有约定）：

- `parseInlineNote(lineText, markers)` → `{ code, note, marker } | null`：取所有 marker 里最靠右的那次匹配，前为 code、后为 note、`marker` 为命中的那个完整 marker。
- `stripInlineNote(lineText, markers)` → 干净代码（用于锚比较）。
- `toInlineText(code, note, marker)` → 展开后的行文字（`code` + 分隔 + `marker` + ` ` + `note`）。
- **往返幂等**（对已 trim 的 code/note、m ∈ markers）：`parseInlineNote(toInlineText(code, note, m), markers) == {code, note, marker: m}`；`stripInlineNote(toInlineText(code, note, m), markers) == code`。
- **边界**：行内已有真注释只认最后一段；空 note；marker 出现在字符串字面量里（v1 接受「宁可多认」的已知局限，见下）。
- **锚不含 marker**：折叠写入的 `original` 等于干净代码，不含 marker。
- **一行一签归并**：`//me:` 落已有标签行 → 归并不新建。
- **提权/降格**：`inline` 标志翻转 + 树可见性。
- 胶水层（光标进出折叠/展开、载入扫残留）薄，靠上述纯函数覆盖；现有测试须全绿 + 新增。

## 已知取舍与风险（v1）

- **展开态被保存 = 短暂落盘**：光标停在展开行时手动 `Ctrl+S` / autosave，会把 `//me:` 写进磁盘。**缓解**：光标离开即折叠（提交前你必然把焦点移走）+ 载入扫残留。**残余风险**：光标死停展开行且从别处提交——现实中近乎构造不出。可选硬化（不在 v1）：本地 git clean filter 剥 `//me:` 行，放 `.git/info/attributes`（不提交）。
- **undo 交织**：折叠/展开是插件对 buffer 的编辑，会和你的 undo 栈交织，可能出现「Ctrl+Z 撤出一个折叠、`//me:` 文本复活」。**实现须处理**：折叠/展开尽量用不进 undo 栈的方式，或把注入/剥离做成可被单步撤销且不污染用户历史的编辑（实现计划里定具体手法，列为验收项）。
- **marker 误伤字符串字面量**：`s = "http://me: x"` 里的 `//me:` 会被误认。v1 接受「宁可多认、可手动降格/删除」，不做语法感知解析（YAGNI）。
- **whitespace / 行号**：v1 只做行尾，折叠只改本行、不删行，无行号漂移、无空行 diff。

---

# v2 方向（已弃 —— 仅存档，不实现）

> **2026-07-26 决定：v2（上方独占一行注释）弃掉。** 上方那套「三选二」死结不好设计，性价比不足。本章仅作存档，记录已达成的设计结论与被否决的路，避免将来有人重开同样的讨论。**v1 到此为止，不做上方注释。**

## v2 定案：上方注释锚在下方真代码行，用 CodeLens 渲染

- **authoring**：在代码上方独占一行敲 `//me: xxx`（可连续多行）。
- **锚**：折叠时**整行删掉**（文件零 git diff），note **锚到下面最近一条非空真代码行**的文字——**复用 v1 行尾同一把硬锚**（真代码行文字，跟随/冷恢复全是铁的）。上方注释是这条宿主代码行的「卫星」。
- **渲染**：用 **CodeLens 画在宿主代码行上方**。**接受字体与行尾 inline 装饰不一致**——换来位置稳、无 git 噪音、无空行脆弱性。
- **多行堆叠**：连续几条上方注释挂在同一宿主代码行上，按序成块。
- **EOF 兜底**：底下没代码行可锚 → 反向锚**上面**那条代码行（记 offset 在下方），或退化按行号弱跟随。
- **存储形状（v2 再定）**：甲＝一条代码行 tag 复合装「行尾 note + 上方块数组」；乙＝上方各是独立 tag 引用宿主行。

## v2 被否决的路（不要重开）

**「留空行 + inline 装饰」模型已否决。** 曾为了字体一致而想「折叠只删注释文字、保留空行、在空行上贴 inline 💬」。它引出一连串补丁，根因是**把小字画在一条非真代码行上**，在 VS Code 里是个三选二死结：

| 做法 | 位置稳 | 字体一致 | 无 git 噪音 |
|---|---|---|---|
| CodeLens 上方（v2 采纳）| ✅ | ❌ | ✅ |
| 留空行 + inline 装饰（否决）| ❌ 外部编辑一填就乱 | ✅ | ❌ 累积空行 diff |
| 贴真代码行尾（= v1）| ✅ | ✅ | ✅ |

「留空行」的连锁坑（均已在讨论中暴露）：空行没文字可锚 → 加次级锚 → offset 在缝里插删行时会飘 → **git pull 把那条空行填成有内容的行时，💬 直接飘在别人代码上** → 又得加「检测空行不空 → 退回贴宿主 / 打可疑态」补丁。每补一个洞冒俩新洞。故 v2 直接走 CodeLens，`原样接受字体差`，不再走空行路。

## v2 未定小尾巴（留待 v2 开工时拍）

1. **offset 精度**：卫星靠「宿主上方第 N 行」定位，缝里被插删行会歪一两行——可容忍降级，或改「一律贴紧宿主、不保留中间空行」。
2. **宿主锚要不要露标记**：被「偷偷打锚」的代码行，gutter 是否显示宿主标记，还是全隐形。
3. **存储甲/乙** 二选一（见上）。
