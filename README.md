# Code Jump Tags

Code Jump Tags is a small VS Code extension for leaving private, clickable notes on important lines of code. Add a tag beside a line, organize tags into folders, and jump back later without turning the repo into a full guided tour.

It is useful when you are reverse-engineering a codebase, tracking review discoveries, leaving breadcrumbs for yourself, or collecting links you want to share with another developer.

## Features

- Add annotated line tags from the editor gutter.
- See tag markers in the gutter and short notes above the tagged line or at the end of the line.
- Hover a marked line to read the full note.
- Manage tags in the **Code Jump Tags** Explorer view.
- Organize tags into folders and reorder them with the tree view.
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

Enter tag edit mode, click the gutter `+` on the target line, write the note, and save it. If the line already has a tag, Code Jump Tags opens the existing note for editing instead of overwriting it.

### Edit A Tag

Click the short note above the line, or use the tag actions in the tree. The edit bubble lets you save, cancel, or delete the note.

### Organize Tags

Use the **Code Jump Tags** tree to create folders, rename folders, move tags up or down, and drag tags into folders. A folder maps to a group of tags, not to a filesystem directory.

### Copy Links

Use **Copy as Link** on a tag to create a Markdown link backed by a `vscode://patrick1099.code-jump-tags/goto` deep link. Use **Copy Folder Links** to copy all links inside a folder.

### Restore Deleted Tags

Deleted tags and folders move to a trash list instead of being removed immediately. Use **Restore from Trash** from the view title to recover recent deletions.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `codeJumpTags.showMarkers` | `true` | Show or hide gutter markers for tagged lines. |
| `codeJumpTags.notePosition` | `above` | Show short notes above the line with CodeLens, or inline at line end with `end`. |
| `codeJumpTags.confirmDelete` | `true` | Ask before deleting tags or folders. The delete dialog can turn this off. |

## Storage Format

The workspace data file is `.code-jump-tags/store.json`. It contains a tree of folders and tags plus a small trash list. You can commit this file if the notes are meant to be shared, or ignore it if the tags are personal.

## Development

```powershell
npm install
npm run build
npm run test:unit
npx @vscode/vsce package --no-dependencies -o code-jump-tags.vsix
```

For local testing:

```powershell
code --install-extension .\code-jump-tags.vsix --force
```

Reload the VS Code window after installing a newly packaged VSIX.

## Credits

Code Jump Tags is derived from Microsoft CodeTour and keeps the upstream MIT license. The public user experience has been refocused from guided tours to lightweight code tags and jump links.
