// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { reaction } from "mobx";
import * as vscode from "vscode";
import { FS_SCHEME_CONTENT, ICON_URL } from "../constants";
import { CodeTourStepTuple, store } from "../store";
import { getStepFileUri, getWorkspaceUri } from "../utils";

const DISABLED_SCHEMES = [FS_SCHEME_CONTENT, "comment"];

// Where the tag note is rendered: "above" = a CodeLens on the line above
// (CodeTour style), "end" = inline text at the end of the marked line.
function getNotePosition(): "above" | "end" {
  return vscode.workspace
    .getConfiguration("codeJumpTags")
    .get<"above" | "end">("notePosition", "above");
}

const TOUR_DECORATOR = vscode.window.createTextEditorDecorationType({
  gutterIconPath: vscode.Uri.parse(ICON_URL),
  gutterIconSize: "contain",
  overviewRulerColor: "rgb(246,232,154)",
  overviewRulerLane: vscode.OverviewRulerLane.Right,
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
});

// Resolve every tag/step that lands in `document`, returning [tour, step,
// stepNumber, line] tuples (line is 0-based, relocated by pattern when needed).
export async function getTourSteps(
  document: vscode.TextDocument
): Promise<CodeTourStepTuple[]> {
  const steps: CodeTourStepTuple[] = store.tours.flatMap(tour =>
    tour.steps.map(
      (step, stepNumber) => [tour, step, stepNumber] as CodeTourStepTuple
    )
  );

  const contents = document.getText();
  const tourSteps = await Promise.all(
    steps.map(async ([tour, step, stepNumber]) => {
      const workspaceRoot = getWorkspaceUri(tour);
      const uri = await getStepFileUri(step, workspaceRoot);

      if (uri.toString().localeCompare(document.uri.toString()) === 0) {
        let line;
        if (step.line) {
          line = step.line - 1;
        } else if (step.pattern) {
          const match = contents.match(new RegExp(step.pattern, "m"));
          if (match) {
            line = document.positionAt(match.index!).line;
          }
        }

        return [tour, step, stepNumber, line];
      }
    })
  );

  // @ts-ignore
  return tourSteps.filter(i => i);
}

export async function updateDecorations(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor
) {
  if (!editor || DISABLED_SCHEMES.includes(editor.document.uri.scheme)) {
    return;
  }

  store.activeEditorSteps = await getTourSteps(editor.document);
  if (store.activeEditorSteps.length === 0) {
    return clearDecorations(editor);
  }

  // Gutter icon on the marked line + the full note as a hoverMessage (so
  // hovering anywhere on the line shows it). The note text is rendered either
  // ABOVE the line as a CodeLens (see TagCodeLensProvider) or inline at the end
  // of the line, per the codeJumpTags.notePosition setting.
  const inline = getNotePosition() === "end";
  const decorations: vscode.DecorationOptions[] = store.activeEditorSteps!.map(
    ([, step, , line]) => {
      const full = (step.description || "").trim();
      const note = full.split(/\r?\n/)[0];
      const hover = new vscode.MarkdownString(full);
      hover.isTrusted = true;
      // Make the hover offer a re-edit link (works in both note positions).
      if (step.id) {
        const args = encodeURIComponent(JSON.stringify([step.id]));
        hover.appendMarkdown(
          `${full ? "\n\n" : ""}[✎ 编辑注释](command:codeJumpTags.editNote?${args})`
        );
      }
      return {
        range: new vscode.Range(line!, 0, line!, 1000),
        hoverMessage: full ? hover : undefined,
        renderOptions:
          inline && note
            ? {
                after: {
                  contentText: `    ${note}`,
                  color: new vscode.ThemeColor("editorCodeLens.foreground"),
                  fontStyle: "italic"
                }
              }
            : undefined
      };
    }
  );
  editor.setDecorations(TOUR_DECORATOR, decorations);
}

function clearDecorations(editor: vscode.TextEditor) {
  store.activeEditorSteps = undefined;
  editor.setDecorations(TOUR_DECORATOR, []);
}

// CodeLens shown on the line ABOVE each marked line, displaying the tag note
// (first line). Non-clickable: it's a label, not an action.
const onDidChangeCodeLenses = new vscode.EventEmitter<void>();
class TagCodeLensProvider implements vscode.CodeLensProvider {
  public onDidChangeCodeLenses = onDidChangeCodeLenses.event;

  async provideCodeLenses(
    document: vscode.TextDocument
  ): Promise<vscode.CodeLens[]> {
    if (
      !store.showMarkers ||
      getNotePosition() !== "above" ||
      DISABLED_SCHEMES.includes(document.uri.scheme)
    ) {
      return [];
    }

    const steps = await getTourSteps(document);
    return steps
      .filter(([, , , line]) => line !== undefined && line !== null)
      .map(([, step, , line]) => {
        const note = (step.description || "").split(/\r?\n/)[0].trim();
        // Clicking the lens re-edits the tag's note (CodeTour-like).
        return new vscode.CodeLens(new vscode.Range(line!, 0, line!, 0), {
          title: note ? `⌖ ${note}` : "⌖",
          command: step.id ? "codeJumpTags.editNote" : "",
          arguments: step.id ? [step.id] : undefined
        });
      });
  }
}

let disposables: vscode.Disposable[] = [];
export async function registerDecorators() {
  vscode.languages.registerCodeLensProvider("*", new TagCodeLensProvider());

  // Switching note position (above CodeLens <-> inline end-of-line) re-renders
  // both the CodeLenses and the active editor's decorations.
  vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration("codeJumpTags.notePosition")) {
      onDidChangeCodeLenses.fire();
      if (vscode.window.activeTextEditor) {
        updateDecorations(vscode.window.activeTextEditor);
      }
    }
  });

  reaction(
    () => [
      store.showMarkers,
      store.tours.map(tour => [tour.title, tour.steps])
    ],
    () => {
      const activeEditor = vscode.window.activeTextEditor;

      // Refresh the above-line note labels whenever tags or visibility change.
      onDidChangeCodeLenses.fire();

      if (store.showMarkers) {
        disposables.push(
          vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
              updateDecorations(editor);
            }
          })
        );

        if (activeEditor) {
          updateDecorations(activeEditor);
        }
      } else if (activeEditor) {
        clearDecorations(activeEditor);

        disposables.forEach(disposable => disposable.dispose());
        disposables = [];
      }
    }
  );

  // Code Jump Tags: keep markers on, and refresh the active editor whenever tours change.
  reaction(
    () => store.tours.map(tour => tour.steps.length),
    () => {
      onDidChangeCodeLenses.fire();
      if (vscode.window.activeTextEditor) {
        updateDecorations(vscode.window.activeTextEditor);
      }
    }
  );

  store.showMarkers = vscode.workspace
    .getConfiguration("codeJumpTags")
    .get("showMarkers", true);

  vscode.commands.executeCommand(
    "setContext",
    "codeJumpTags:showingMarkers",
    store.showMarkers
  );
}
