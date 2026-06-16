# Contributing

Thanks for helping improve Code Jump Tags.

## Local Setup

```powershell
npm install
npm run build
npm run test:unit
```

## Packaging Locally

```powershell
npx @vscode/vsce package --no-dependencies -o code-jump-tags.vsix
code --install-extension .\code-jump-tags.vsix --force
```

Reload the VS Code window after installing a local VSIX.

## Change Guidelines

- Keep Marketplace-facing docs focused on Code Jump Tags, not CodeTour.
- Preserve the MIT license and fork attribution.
- Keep runtime behavior changes covered by focused tests where the code can run outside VS Code.
- For VS Code UI behavior, test manually in a real VS Code window before publishing.
