# Code Jump Tags

[中文](https://github.com/patrick1099/code-jump-tags/blob/main/README.zh-CN.md) | **English**

You are reverse-engineering an unfamiliar codebase, and by Thursday you have lost the five lines
that actually mattered. Code Jump Tags pins a private, clickable note to a line, keeps the note on
that line while the code moves around it, and lets you jump back from a tree or a copied link.

It is not a guided tour. Nothing is written into the source, and nothing has to be shared.

```
  src/protocol/parser.c
   41   ⌖ entry point  |  ⌖ check ordering here
   42   static int parse_frame(const uint8_t *buf, size_t n)
   43   {
   44       if (!buf) return -1;                        💬 why not assert here?
   45       uint16_t crc = crc16(buf, n - 2);
 ? 46       return crc == read_u16(buf + n - 2);
```

Line 41 carries two tags rendered above the line. Line 44 carries a scratch note that lives in the
sidecar, not in the file. The `?` on line 46 means the line changed where the extension could not
watch it, so the tag is flagged rather than silently pointing at the wrong code.

## Getting started

1. Install the extension.
2. Open a folder or workspace in VS Code.
3. Open the Code Jump Tags view in Explorer.
4. Click the plus button in the view title, or run `Code Jump Tags: Enter Tag Edit Mode` from the
   command palette.
5. Click the gutter `+` beside a line and enter your note.
6. Click a tag in the tree, in the gutter hover, or in a copied link to jump back.

Tags are stored in `.code-jump-tags/store.json` inside the current workspace. If an older
`.lodestar` store exists, it is migrated on load.

## What it does

- Several tags can share one line. Every `+` click adds another; they render side by side above the
  line as `⌖ A | ⌖ B`, and the line's hover lists them all.
- Scratch notes: type `//me: something` at the end of a line and it folds away the moment your
  cursor leaves. The marker text disappears from the buffer and the note lives in the sidecar, so it
  never reaches your commits. Put the cursor back and it expands again for editing.
- Tags follow their code. Rename a variable, cut and paste the line, edit in place: the tag stays on
  the line you meant.
- Tags flag themselves as **suspect** when the file changed behind the extension's back.
- Folders in the Explorer view, nested to any depth, with drag and drop and reordering.
- Copy a tag or a whole folder as `vscode://` links.
- Deletions go to a recoverable trash list.

## Common workflows

### Edit a tag

Click the tag's own short note above the line, or its `✎` in the gutter hover, or rename it from the
tree. The edit bubble lets you save, cancel, or delete.

### Scratch notes (`//me:`)

For a thought you want next to the code but out of the repo. To delete one, expand it and clear the
text after the marker, then move the cursor off the line; it goes to the trash and can be restored.

Scratch notes deliberately stay out of your way: no gutter marker, no suspect marker, and no sidebar
entry by default. Turn on `codeJumpTags.inlineNote.showSummaryGroup` for a read-only summary group at
the top of the tree. The marker token is configurable, and the comment prefix follows the file's
language (`//`, `#`, `--`, and so on).

### When a tag loses its line

Every tag remembers the line's text as an immutable identity. While you edit inside VS Code the
extension watches the change happen and keeps up, so editing a tagged line never marks it suspect.

When the file changes where the extension could not see it (another editor wrote to it, `git pull`
rewrote it, it was edited while VS Code was closed), a tag whose identity no longer matches turns
suspect: a grey `?` in the gutter, and a hover showing original identity against current content.
From there you can adopt the new position, promoting the current line to the tag's new identity, or
move the tag to the cursor line by hand. Suspect tags are also collected into a `⚠ 待处理` group at
the top of the tree so you can clear them in one pass.

Suspect checks run at trigger points rather than on every keystroke. See the
`codeJumpTags.recheckOn.*` settings below.

### Copy links

`Copy as Link` builds a Markdown link backed by a `vscode://patrick1099.code-jump-tags/goto` deep
link. `Copy Folder Links` copies every link inside a folder.

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

`codeJumpTags.exclude` defaults to `**/.code-jump-tags/**`, `**/.git/**`, `**/.vscode/**`,
`**/node_modules/**`, `**/out/**`, `**/dist/**`, `**/build/**`.

## Storage format

The workspace data file is `.code-jump-tags/store.json`: a tree of folders and tags plus a small
trash list. Commit it if the notes are meant to be shared, or ignore it if the tags are personal.
Scratch notes in particular are meant to stay out of commits, so keeping `.code-jump-tags/`
untracked is the usual choice.

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

Code Jump Tags is derived from Microsoft CodeTour and keeps the upstream MIT license. The public
user experience has been refocused from guided tours to lightweight code tags and jump links.
