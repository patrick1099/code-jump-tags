# Code Jump Tags

**中文** | [English](https://github.com/patrick1099/code-jump-tags/blob/main/README.md)

你在啃一份不熟的代码，到周四已经找不回当初真正要紧的那五行。Code Jump Tags 把一条私有的、
可点击的批注钉在某一行上，代码在它周围怎么挪都跟着走，之后从树里或一条链接跳回去。

它不是导览。源码里不写入任何东西，也不需要分享给谁。

```
  src/protocol/parser.c
   41   ⌖ 入口在这  |  ⌖ 这里的顺序要再看
   42   static int parse_frame(const uint8_t *buf, size_t n)
   43   {
   44       if (!buf) return -1;                        💬 为什么不用 assert?
   45       uint16_t crc = crc16(buf, n - 2);
 ? 46       return crc == read_u16(buf + n - 2);
```

第 41 行挂了两条标签，渲染在行的上方。第 44 行那条随手私记住在旁存文件里，不在源码里。
第 46 行的 `?` 表示这一行在插件看不见的地方被改过，所以标签被标成可疑，而不是默默指向错的代码。

## 上手

1. 装上插件。
2. 在 VS Code 里打开一个文件夹或工作区。
3. 打开资源管理器里的 Code Jump Tags 视图。
4. 点视图标题栏的加号，或者从命令面板运行 `Code Jump Tags: Enter Tag Edit Mode`。
5. 点目标行左边空白处的 `+`，写下批注。
6. 从树里、行内悬浮框里或复制出来的链接点回该处代码。

标签存在当前工作区的 `.code-jump-tags/store.json`。若存在旧的 `.lodestar` 目录，加载时自动迁移。

## 它能做什么

- 一行可以挂多条标签。每点一次 `+` 就新增一条，它们并排渲染在行上方，形如 `⌖ A | ⌖ B`，
  该行的悬浮框会列出全部。
- 随手私记：在行尾打 `//me: 想说的话`，光标一离开就折叠起来。标记文字从缓冲区消失，内容存进
  旁存文件，因此永远不会进入提交。光标放回该行又会展开，可以就地编辑。
- 标签跟着代码走。改变量名、剪切粘贴整行、就地编辑，标签都还钉在你要的那一行。
- 文件在插件看不见的地方被改动时，标签把自己标成**可疑**。
- 资源管理器视图里可建文件夹，任意层级嵌套，支持拖放和重排。
- 单条标签或整个文件夹都能复制成 `vscode://` 链接。
- 删除进的是可恢复的回收列表。

## 常用操作

### 改一条标签

点该标签在行上方的短批注，或点它在悬浮框里的 `✎`，或从树里重命名。编辑气泡里可以保存、取消或删除。

### 随手私记（`//me:`）

用来写那种想放在代码旁边、但不想进仓库的念头。要删掉一条就把它展开、清掉标记后面的文字，
然后把光标移开该行，它会进回收站，可以再恢复。

随手私记刻意不打扰你：没有行号旁的标记，不参与可疑检测，默认也不进侧边栏。想要一个只读的
汇总分组就打开 `codeJumpTags.inlineNote.showSummaryGroup`。标记词可配置，注释前缀跟着文件语言走
（`//`、`#`、`--` 等）。

### 标签找不到自己那一行时

每条标签把所在行的文本记成一个不可变的身份。你在 VS Code 里编辑时，插件看着改动发生并跟上，
所以编辑一条带标签的行永远不会把它标成可疑。

当文件在插件看不见的地方发生变化（别的编辑器写了它、`git pull` 重写了它、VS Code 关着的时候
被改了），身份对不上的标签变成可疑：行号旁一个灰色 `?`，悬浮框里给出原身份与当前内容的对照。
你可以采纳新位置，把当前行提升为该标签的新身份，也可以手动把标签移到光标所在行。可疑标签还会
被收进树顶的 `⚠ 待处理` 分组，方便一次清完。

可疑检测在若干触发点上跑，不是每次按键都跑。见下面的 `codeJumpTags.recheckOn.*` 设置。

### 复制链接

`Copy as Link` 生成一条 Markdown 链接，背后是 `vscode://patrick1099.code-jump-tags/goto` 深链。
`Copy Folder Links` 复制某个文件夹里的全部链接。

## 设置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `codeJumpTags.showMarkers` | `true` | 是否在带标签的行旁显示标记。 |
| `codeJumpTags.confirmDelete` | `true` | 删除标签或文件夹前询问。删除对话框里可以关掉。 |
| `codeJumpTags.exclude` | 见下 | 完全不参与标签功能的 glob：不折叠随手私记，也不做可疑复检。 |
| `codeJumpTags.inlineNote.enabled` | `true` | 启用随手私记（行尾 `//me:`）。 |
| `codeJumpTags.inlineNote.markers` | `["me:"]` | 跟在行注释前缀后面的标记词。加 `"?"` 就同时认 `//?`。 |
| `codeJumpTags.inlineNote.showSummaryGroup` | `false` | 在树顶显示只读的 `💬 随手` 分组，汇总全部随手私记。 |
| `codeJumpTags.recheckOn.open` | `true` | 打开或切到某文件时复检它的标签。 |
| `codeJumpTags.recheckOn.focus` | `true` | 窗口重新获得焦点时复检。 |
| `codeJumpTags.recheckOn.externalChange` | `true` | 文件被本编辑器之外的东西改动时复检。 |
| `codeJumpTags.recheckOn.save` | `false` | 保存时复检。 |
| `codeJumpTags.recheckOn.idle` | `false` | 编辑停顿后复检。 |

`codeJumpTags.exclude` 的默认值是 `**/.code-jump-tags/**`、`**/.git/**`、`**/.vscode/**`、
`**/node_modules/**`、`**/out/**`、`**/dist/**`、`**/build/**`。

## 存储格式

工作区数据文件是 `.code-jump-tags/store.json`：一棵文件夹与标签的树，外加一个小的回收列表。
批注要共享就提交它，标签是私人的就忽略它。随手私记本来就是为了不进提交而设计的，所以把
`.code-jump-tags/` 留在版本控制之外是通常的选择。

## 开发

```powershell
npm install
npm run build
npm run test:unit   # 纯逻辑单测 (vitest)
npm run test:e2e    # 真实 VS Code 扩展宿主里的端到端测试
npx @vscode/vsce package --no-dependencies -o code-jump-tags.vsix
```

本地测试：

```powershell
code --install-extension .\code-jump-tags.vsix --force
```

装完新打的 VSIX 后要重载 VS Code 窗口。

## 来源

Code Jump Tags 源自 Microsoft CodeTour，沿用其 MIT 许可证。对外的产品形态从「导览」改成了
轻量的代码标签与跳转链接。
