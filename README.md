# Code Jump Tags

Code Jump Tags is a small VS Code extension for leaving private, clickable notes on important lines of code. Add a tag beside a line, organize tags into folders, and jump back later without turning the repo into a full guided tour.

It is useful when you are reverse-engineering a codebase, tracking review discoveries, leaving breadcrumbs for yourself, or collecting links you want to share with another developer.

## Features

- Add annotated line tags from the editor gutter. A line can hold **several** tags.
- See a gutter marker on tagged lines, with the note rendered either above the line or at the end of it.
- Hover a marked line to read every note on it, each with its own edit action.
- **Scratch notes** — type `//me: something` at the end of a line and it folds away into a tag the moment your cursor leaves. The marker text disappears from the source; the note lives in the sidecar, never in your commits.
- Tags follow their code. Rename a variable, cut and paste a whole line, edit in place — the tag stays on the line you meant.
- Tags flag themselves as **suspect** when the file changed behind your back (another editor, a `git pull`, edits made while VS Code was closed), with a one-click way to re-point them.
- Manage tags in the **Code Jump Tags** Explorer view: folders, nesting, drag and drop, reordering.
- Copy a single tag or a whole folder as `vscode://` links.
- Delete tags and folders into a recoverable trash list.
- Store workspace tags in `.code-jump-tags/store.json`.

## Getting Started

1. Install the extension.
2. Open a folder or workspace in VS Code.
3. Open the **Code Jump Tags** view in Explorer.
4. Click the plus button in the view title, or run **Code Jump Tags: Enter Tag Edit Mode** from the command palette.
5. Click the gutter `+` beside a line and enter your note.
6. Click a tag in the tree, gutter hover, or copied link to jump back to that code location.

Tags are stored inside the current workspace. If an older `.lodestar` store exists, Code Jump Tags migrates it to `.code-jump-tags` on load.

## Common Workflows

### Add A Tag

Enter tag edit mode, click the gutter `+` on the target line, write the note, and save it. Every `+` click adds a **new** tag — a line that already carries one still offers the `+`, so you can leave several independent notes on the same line. They render side by side above the line as `⌖ A | ⌖ B`, and the line's hover lists them all.

### Edit A Tag

Click that tag's own short note above the line, or its `✎` in the gutter hover, or rename it from the tree. The edit bubble lets you save, cancel, or delete the note.

### Scratch Notes (`//me:`)

For a thought you want next to the code but *not* in the repo: type `//me: ` followed by your note at the end of a line. Move the cursor away and the text folds — the marker vanishes from the buffer, the note is stored in `.code-jump-tags/`, and the line keeps only a small italic label floating at its end. Put the cursor back on that line and the text expands again so you can edit it in place.

To delete one, expand it and delete the note text (or just clear the text after the marker), then move the cursor off the line. It goes to the trash and can be restored from there.

Scratch notes deliberately stay out of your way: no gutter marker, no suspect marker, and by default no entry in the sidebar. Turn on `codeJumpTags.inlineNote.showSummaryGroup` if you do want a read-only summary group at the top of the tree. The marker token is configurable, and the comment prefix follows the file's language (`//`, `#`, `--`, …).

### When A Tag Loses Its Line

Every tag remembers the line's text as an immutable *identity*. While you edit inside VS Code the extension watches the change happen and simply keeps up — editing a tagged line never marks it suspect.

When the file changes where the extension could not see it — another editor wrote to it, `git pull` rewrote it, it was edited while VS Code was closed — a tag whose identity no longer matches turns **suspect**: a grey `?` in the gutter, and a hover showing *original identity vs. current content*. From there you can **adopt the new position** (promote the current line to the tag's new identity) or **move the tag to the cursor line** by hand. Suspect tags are also collected into a `⚠ 待处理` group at the top of the tree so you can clear them in one pass.

Suspect checks run at trigger points, not on every keystroke — see the `codeJumpTags.recheckOn.*` settings.

### Organize Tags

Use the **Code Jump Tags** tree to create folders, rename folders, move tags up or down, and drag tags into folders. Folders nest to any depth. A folder maps to a group of tags, not to a filesystem directory.

### Copy Links

Use **Copy as Link** on a tag to create a Markdown link backed by a `vscode://patrick1099.code-jump-tags/goto` deep link. Use **Copy Folder Links** to copy all links inside a folder.

### Restore Deleted Tags

Deleted tags and folders move to a trash list instead of being removed immediately. Use **Restore from Trash** from the view title to recover recent deletions.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `codeJumpTags.showMarkers` | `true` | Show or hide gutter markers for tagged lines. |
| `codeJumpTags.confirmDelete` | `true` | Ask before deleting tags or folders. The delete dialog can turn this off. |
| `codeJumpTags.exclude` | see below | Globs that take no part in tagging: no scratch-note folding, no suspect re-checks. |
| `codeJumpTags.inlineNote.enabled` | `true` | Enable scratch notes (`//me:` at end of line). |
| `codeJumpTags.inlineNote.markers` | `["me:"]` | Tokens that follow the line-comment prefix. Add `"?"` to also accept `//?`. |
| `codeJumpTags.inlineNote.showSummaryGroup` | `false` | Show a read-only `💬 随手` group at the top of the tree collecting every scratch note. |
| `codeJumpTags.recheckOn.open` | `true` | Re-check the file's tags when you open or switch to it. |
| `codeJumpTags.recheckOn.focus` | `true` | Re-check when the window regains focus. |
| `codeJumpTags.recheckOn.externalChange` | `true` | Re-check when a file is changed by something outside this editor. |
| `codeJumpTags.recheckOn.save` | `false` | Re-check on save. |
| `codeJumpTags.recheckOn.idle` | `false` | Re-check after a pause in editing. |

`codeJumpTags.exclude` defaults to `**/.code-jump-tags/**`, `**/.git/**`, `**/.vscode/**`, `**/node_modules/**`, `**/out/**`, `**/dist/**`, `**/build/**`.

## Storage Format

The workspace data file is `.code-jump-tags/store.json`. It contains a tree of folders and tags plus a small trash list. You can commit this file if the notes are meant to be shared, or ignore it if the tags are personal — scratch notes in particular are meant to stay out of your commits, so keeping `.code-jump-tags/` untracked is the usual choice.

## Development

```powershell
npm install
npm run build
npm run test:unit   # pure-logic unit tests (vitest)
npm run test:e2e    # end-to-end tests in a real VS Code extension host
npx @vscode/vsce package --no-dependencies -o code-jump-tags.vsix
```

For local testing:

```powershell
code --install-extension .\code-jump-tags.vsix --force
```

Reload the VS Code window after installing a newly packaged VSIX.

## Credits

Code Jump Tags is derived from Microsoft CodeTour and keeps the upstream MIT license. The public user experience has been refocused from guided tours to lightweight code tags and jump links.
