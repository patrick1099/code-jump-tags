# Change Log

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
- Added single-tag and folder link copying with `vscode://patrick.code-jump-tags/goto` links.
- Added unit coverage for the pure tag tree, adapter, relocation, and trash logic.

## Attribution

Code Jump Tags is derived from Microsoft CodeTour, licensed under MIT.
