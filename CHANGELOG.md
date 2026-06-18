# Change Log

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
