# Change Log

## 0.6.1 - 2026-06-24

- 给「移动标签」加了撤回 / 恢复:移错或后悔时,一步把标签放回上一处,并跳回它原来的文件那一行。
  - 「撤回移动」退回最近一次移动;「恢复移动」把刚撤掉的再做一遍(像编辑器的撤销/重做)。
  - 标签视图标题栏常驻「撤回 / 恢复」两个按钮,随手可点;没有可撤回/可恢复时点一下会提示。
  - 也能在树里右键某个标签「撤回此标签的移动」,只退它自己的上一次。
- 撤回是会话级的:只记最近若干次移动,关掉窗口就清空(和编辑器的撤销一样,不跨重启)。
- 撤回到的原位置若已被别的标签占用,会提示并跳过,维持「一行一签」。
- 删除标签不走这个撤回——删除本来就进回收站、可从回收站恢复(而且跨会话保留)。

## 0.6.0 - 2026-06-24

- 新增「快速移动标签」手势,让把一个标签重新钉到某一行变成一秒钟的事:
  - 树里右键标签 →「剪切标签」,再把光标放到目标行(可在别的文件)→ 编辑器右键
    「粘贴标签到此行」。
  - 树里右键标签 →「移到光标行」,一步把它挪到当前光标所在行。
  - 标签的笔记、链接、所属文件夹都原样跟随,只换它锚定的位置与该行内容。
- 目标行若已有别的标签,会拒绝并提示「该行已有标签『…』」,维持「一行一签」。
- 不改动自动匹配:这一版只把手动纠正做成廉价手势,自动跟随真实的剪切/粘贴
  代码移动仍不去猜。

## 0.5.1 - 2026-06-24

- 修了「剪掉一整行（Ctrl+X）或删掉一整行，再撤回，标签飞到别处」。
  根因：剪行的瞬间标签那行文字暂时没了，重定位只能盲回退到原行号——而那一行此刻
  坐着顶上来的相邻代码行，旧逻辑就把标签的锚点改写成了那行相邻代码的文字。这个被
  改坏的锚点在撤回之后仍然生效，于是标签被钉死在相邻行上。现在只有在确信「定位到的
  那行真的是这个标签的行」时才会刷新锚点，剪行那种拿不准的情况保留原锚点，撤回后标签
  就能按内容找回原位。
- 行内原地小改、上下插删行、行中回车拆行等正常编辑的锚点刷新行为不变。

## 0.5.0 - 2026-06-23

- 标签跟随代码行的匹配大改，修了三类老毛病：
  - 在标签行里插一个字符、删一个词间空格，标签不再当场失配——改用「空白归一化的编辑距离相似度」做模糊匹配（阈值 0.9），小改动照样跟住。
  - 标签不再乱跳到远处的重复代码（比如被 `#if 0` 宏关掉的同名孪生函数）。找回时改成「由近及远同心扩圈」：身边改过的那行先被认领，远处的精确副本轮不到。
  - 在标签行里逐字改写时，锚点会实时刷新，不会越用越旧、也不会给下一次结构性编辑埋下跳错的雷。
- 把一行从中间敲回车拆成两行时，标签稳定留在上半行。
- 兼容旧数据：原有标签自动获得新的模糊匹配能力，复制出去的 `vscode://` 链接不受影响。
- 仍有的死角：如果标签所在行的文字被大改（相似度跌破阈值且全文件再无近似行），仍然无法找回——这是按行内容锚定的固有上限。

## 0.4.0 - 2026-06-22

- 「未分组」现在是一个真正的文件夹:可以重命名、拖进别的文件夹、删除、在其下新建子文件夹。
  它仍然是新标签的落脚点(收件箱);一旦你给它改名、把它拖出根级或删除,它就变成普通文件夹,
  下次新建标签时根级会自动出现一个新的空「未分组」接着收。打开旧数据时,原先散落的标签会被
  自动归入「未分组」文件夹。
- 侧边栏支持多选批量操作:多选标签/文件夹后可一次性拖动、复制链接、删除(删除走一个汇总确认框)。

## 0.3.6 - 2026-06-18

- Fixed the marker drifting to the old line after you overwrite a file wholesale
  (copy the whole file out, edit it, paste it all back). The jump already
  recovered the right line by searching for the tagged line's text, but the
  gutter crosshair + note kept reading the stale stored line, so they pointed at
  the wrong place while clicking the tag jumped correctly. The display now goes
  through the same content recovery as the jump, so the marker and the jump
  target always agree. The stored anchor (line + content pattern) is also
  refreshed live as you edit, so recovery stays accurate over time. Limitation:
  if the tagged line's own text changes, there is nothing left to anchor to and
  the tag can't be recovered.

## 0.3.5 - 2026-06-18

- Fixed the gutter icon smearing down several lines when you type newlines
  inside a tagged line (e.g. join the line above, then press Enter a few times).
  The tag's line number was correct, but the icon's decoration range was being
  auto-expanded across the new lines and never repainted. The gutter is now
  repainted as a clean single-line marker on every line-changing edit, even when
  the tag itself doesn't move.

## 0.3.4 - 2026-06-18

- Fixed line tracking for a newline typed at the very START of a line (column 0),
  which pushes that line's code down a row. 0.3.3 missed this case — the edit
  "ends" on the tag's own line, so neither the icon nor the note moved while the
  tagged code slid down. The anchor is now treated as the start of the tag's
  line, so a line-start newline (or joining the previous line onto it) moves the
  tag with its code.

## 0.3.3 - 2026-06-18

- Tags now follow your code as you edit above them. Previously the gutter icon
  auto-tracked edits (it slid down when you inserted lines above) but the note
  shown above the line stayed pinned to the original line number, so the two
  drifted apart. Editing above a tag now shifts the tag's stored line by the
  same amount, so the icon and the note move together — and the new position is
  saved, so the marker no longer jumps back to the old line after a reload.

## 0.3.2 - 2026-06-17

- Recycle bin checkboxes now cascade like a file tree: checking a folder checks
  every sub-folder and tag under it, and a folder stays checked only while all of
  its children are checked — uncheck them all and the folder unchecks itself.

## 0.3.1 - 2026-06-17

- Recycle bin now shows nested sub-folders. When you delete a folder that
  contains sub-folders, the bin lists its whole subtree (sub-folders and tags, at
  every depth) as indented rows — previously it only showed the folder's direct
  tags and hid the sub-folders. Any nested node can be restored on its own, or
  pick the folder to restore everything. The folder row's tag count is now
  accurate (counts tags recursively, no longer miscounts sub-folders).

## 0.3.0 - 2026-06-17

- Folders now behave like a file system: drag a folder (or tag) anywhere — into
  another folder, or onto empty space to move it back to the root. Dropping a
  folder into its own subtree is rejected.
- The folder right-click command is now just 「新建文件夹」 (was 「新建子文件夹」),
  matching how a file explorer reads — it creates a folder inside the one you
  clicked.
- Fixed: tags inside a nested sub-folder now show their gutter marker, CodeLens
  note, and hover. Previously the editor decorations only covered top-level
  folders, so tags moved into sub-folders lost their markers.

## 0.2.0 - 2026-06-17

- Folders can now be nested to any depth. Right-click a folder and choose
  「新建子文件夹」 to create a sub-folder inside it; the tree renders the nesting.
  Sub-folders are purely for organizing — expand/collapse only, no tour playback.
- Renaming, deleting, copying a folder's links, and reordering tags up/down all
  work the same inside nested folders.

## 0.1.4 - 2026-06-17

- Tags can now be renamed straight from the tree: right-click a tag and choose
  「重命名标签」 to edit its note in a quick input box (the same box folders use),
  without opening the inline comment editor. The change refreshes both the tree
  label and the in-editor annotation.

## 0.1.3 - 2026-06-17

- Code Jump Tags now lives in its own Activity Bar container with a crosshair
  icon, instead of a panel buried in the Explorer. Click the icon in the left
  Activity Bar to open the tags view directly.

## 0.1.2 - 2026-06-17

- Cleaned up leftover CodeTour identifiers so the Marketplace "Feature
  Contributions" page no longer shows `.tour` / tour wording: removed the
  unused `.tour` language + JSON validation, and renamed the contributed
  command ids (`addTag`, `deleteTag`, `saveTag`, `moveTagForward`,
  `moveTagBack`), the tree view id (`codeJumpTags.tags`), and the related
  context keys/values. No user-facing behavior change.

## 0.1.1 - 2026-06-17

- Fixed copied tag links opening to "extension not found": the `vscode://` link
  authority now uses the published extension id (`patrick1099.code-jump-tags`)
  and is resolved from the running extension so it survives publisher renames.

## 0.1.0 - 2026-06-16

Initial preview release of Code Jump Tags.

- Rebranded the extension as **Code Jump Tags**.
- Added workspace tag storage under `.code-jump-tags/store.json`.
- Added folder-based tag organization and tree actions.
- Added annotated line markers, hover notes, and configurable note placement.
- Added tag editing, delete confirmation, trash, and restore flows.
- Added single-tag and folder link copying with `vscode://patrick1099.code-jump-tags/goto` links.
- Added unit coverage for the pure tag tree, adapter, relocation, and trash logic.

## Attribution

Code Jump Tags is derived from Microsoft CodeTour, licensed under MIT.
