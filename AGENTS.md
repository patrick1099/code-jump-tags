# Code Jump Tags

## 先读
1. docs/HANDOFF.md —— 现在做到哪了（没有这个文件 = 没有进行中的工作）
2. docs/BLUEPRINT.md —— 它是什么、行为契约、store.json / 链接 / cjtag 格式
3. docs/CHANGELOG.md —— 最近 5 条；要改哪块，再搜那块相关的「没选的路」

更细的「功能 ↔ 代码」索引在 `docs/code-jump-tags/功能-代码对照.md`（按版本堆的，0.9.x 之后没再更新，以代码为准）。
`docs/superpowers/` 下是历次改动的 spec / plan，只在要深挖某个设计时翻。

## 命令
- 装依赖：`npm install`
- 测：`npm run test:unit`（vitest，只覆盖不碰 vscode 的纯逻辑）
- 构建：`npm run build`（webpack，产出 `dist/`：扩展本体 + `dist/cli.js`）
- 打包并装到本机：`npx @vscode/vsce package --no-dependencies` → `code --install-extension code-jump-tags-<版本>.vsix --force`，然后在 VS Code 里 Reload Window
- cjtag 本地试：`node dist/cli.js --ai-help`

## 代码地图（改哪类东西去哪）
| 要改的 | 去哪 |
|---|---|
| store.json 的节点字段 | `src/lodestar/types.ts`（改了同步 BLUEPRINT 的 I/O 契约） |
| 树的增删改查、回收站、隐藏标志 | `src/lodestar/tree.ts` |
| 树 → 派生 tour（显示 / 树 / 顺读的数据源，含隐藏继承） | `src/lodestar/adapter.ts` |
| 读写 store.json、外部改动自动重载 | `src/lodestar/persistence.ts` |
| 位置找回、锚点、可疑判定 | `src/lodestar/relocate.ts`、`src/lodestar/suspect.ts`；触发点在 `src/player/recheck.ts` |
| 扩展自有命令（跳转、文件夹、复制链接、移动 / 撤回、顺读、隐藏） | `src/lodestar/commands.ts` 末尾 `registerLodestarCommands` |
| 新建标签（`+` 提交） | `src/recorder/commands.ts` 的 `addTag` |
| 编辑气泡 | `src/lodestar/editThread.ts` |
| 编辑器里的图标 / 批注 / 悬停、行号跟随 | `src/player/decorator.ts` |
| 侧边栏树、拖放 | `src/player/tree/index.ts`、`src/player/tree/nodes.ts` |
| 随手私记 | 纯逻辑 `src/lodestar/inlineNote.ts`，编辑器胶水 `src/player/inlineNotes.ts` |
| cjtag 命令行 | 参数与帮助 `src/cli/index.ts`，逻辑 `src/cli/import.ts`（不许 import vscode） |
| 命令 / 菜单 / 设置 / 快捷键的声明 | `package.json` 的 `contributes` |

## 坑
- **推 `v*` tag 就会发布到插件市场**（`.github/workflows/publish.yml`）。只想推代码别打 tag；发版流程见 `docs/code-jump-tags/发布流程.md`。
- 这是 Microsoft CodeTour 的 fork，`src/` 里仍有大量 CodeTour 原代码和概念：tour = 文件夹，step = 标签。「lodestar」是本扩展的旧名，只剩目录名和类型名。
- `src/lodestar/` 下除 `persistence` / `commands` / `editThread` 外都不许 import vscode，单测靠这一点。
- 标签身份字段 `original` 只能由「新建标签」和 `retargetTag`（用户显式移动 / 采纳）写；自动路径一律不许碰。
- 行号跟随要覆盖**所有**标签（含隐藏的、随手私记）；只能在画的时候过滤，不能在取标签那一步过滤。
- `store.showMarkers` 初值是 `false`，启动时由配置设成真值来触发首次绘制；改启动流程别让这次触发丢了。
- `@types/vscode` 钉在 `~1.66.0`，升上去会编译不过。
- 编辑器里的显示效果（装饰、气泡、拖放、菜单）单测覆盖不到，只能打包装上后 Reload Window 手动看。
- 仓库公开：文档、测试、注释里别写本机路径、真实邮箱、公司 / 客户相关的词。
