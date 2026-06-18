// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { reaction } from "mobx";
import { debounce } from "throttle-debounce";
import * as vscode from "vscode";
import { FS_SCHEME_CONTENT, ICON_URL } from "../constants";
import { getStore, rebuildTours, saveStore } from "../lodestar/persistence";
import { findNode, LineEdit, shiftedLine } from "../lodestar/tree";
import { CodeTourStep, CodeTourStepTuple, store } from "../store";
import { getStepFileUri, getWorkspaceUri } from "../utils";

const DISABLED_SCHEMES = [FS_SCHEME_CONTENT, "comment"];

// Per-tag note placement: "above" = a CodeLens on the line above (CodeTour
// style, clickable), "end" = inline text at the end of the marked line. Stored
// on each tag/step; unset means "above" (the default for new tags).
function stepNotePosition(step: CodeTourStep): "above" | "end" {
  return step.notePosition === "end" ? "end" : "above";
}

const TOUR_DECORATOR = vscode.window.createTextEditorDecorationType({
  gutterIconPath: vscode.Uri.parse(ICON_URL),
  gutterIconSize: "contain",
  overviewRulerColor: "rgb(246,232,154)",
  overviewRulerLane: vscode.OverviewRulerLane.Right,
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
});

// Separate type for the end-of-line note. ClosedOpen lets the anchor range grow
// at its end, so when you append code to the line the note keeps trailing AFTER
// your code instead of staying at a fixed column and getting overrun.
const INLINE_NOTE_DECORATOR = vscode.window.createTextEditorDecorationType({
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen
});

// Resolve every tag/step that lands in `document`, returning [tour, step,
// stepNumber, line] tuples (line is 0-based, relocated by pattern when needed).
export async function getTourSteps(
  document: vscode.TextDocument
): Promise<CodeTourStepTuple[]> {
  // Use allTours (every nesting depth), not tours (top-level only), so tags
  // inside sub-folders are decorated too.
  const steps: CodeTourStepTuple[] = store.allTours.flatMap(tour =>
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

  if (!store.showMarkers) {
    return clearDecorations(editor);
  }

  store.activeEditorSteps = await getTourSteps(editor.document);
  if (store.activeEditorSteps.length === 0) {
    return clearDecorations(editor);
  }

  // Gutter icon + full-note hover on every marked line. Each note renders either
  // ABOVE the line as a CodeLens (see TagCodeLensProvider) or inline at the end
  // of the line, per that tag's own notePosition (default "above").
  const gutterDecorations: vscode.DecorationOptions[] = [];
  const inlineDecorations: vscode.DecorationOptions[] = [];

  for (const [, step, , line] of store.activeEditorSteps!) {
    if (line === undefined || line === null || line >= editor.document.lineCount) {
      continue;
    }
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

    // Gutter icon + whole-line hover live on the wide ClosedClosed range.
    gutterDecorations.push({
      range: new vscode.Range(line, 0, line, 1000),
      hoverMessage: full ? hover : undefined
    });

    // End-of-line note is a separate ClosedOpen decoration anchored at the
    // line's true end, so it always trails the code as the line grows.
    if (stepNotePosition(step) === "end" && note) {
      const endCol = editor.document.lineAt(line).text.length;
      inlineDecorations.push({
        range: new vscode.Range(line, endCol, line, endCol),
        renderOptions: {
          after: {
            contentText: `    ${note}`,
            color: new vscode.ThemeColor("editorCodeLens.foreground"),
            fontStyle: "italic"
          }
        }
      });
    }
  }

  editor.setDecorations(TOUR_DECORATOR, gutterDecorations);
  editor.setDecorations(INLINE_NOTE_DECORATOR, inlineDecorations);
}

function clearDecorations(editor: vscode.TextEditor) {
  store.activeEditorSteps = undefined;
  editor.setDecorations(TOUR_DECORATOR, []);
  editor.setDecorations(INLINE_NOTE_DECORATOR, []);
}

// Persist line shifts off the keystroke path: re-render is immediate (via
// rebuildTours below), but writing store.json is debounced so we don't hit disk
// on every keypress.
const debouncedSaveStore = debounce(800, () => {
  saveStore();
});

// Keep tags glued to their code as you edit ABOVE them. The gutter icon already
// auto-tracks (VS Code shifts decoration ranges on edits), but the note CodeLens
// recomputes from the stored line and does NOT — so without this they drift
// apart. Here we shift each affected tag's stored line by the edit's delta, then
// re-derive the tours so BOTH markers paint from the same updated line (and the
// new position persists, fixing the marker jumping back on reload).
async function trackLineShifts(e: vscode.TextDocumentChangeEvent) {
  if (!store.showMarkers || DISABLED_SCHEMES.includes(e.document.uri.scheme)) {
    return;
  }
  if (e.contentChanges.length === 0) {
    return;
  }

  const edits: LineEdit[] = e.contentChanges.map(c => ({
    start: c.range.start.line,
    end: c.range.end.line,
    endChar: c.range.end.character,
    delta: (c.text.match(/\n/g)?.length ?? 0) - (c.range.end.line - c.range.start.line)
  }));
  if (edits.every(edit => edit.delta === 0)) {
    return; // pure same-line text edit — no lines added/removed
  }

  // Which tags live in this document (resolves each tag's file uri the same way
  // the decorations do, so matching is exact).
  const steps = await getTourSteps(e.document);
  const cache = getStore();
  let changed = 0;
  for (const [, step] of steps) {
    if (!step.id) {
      continue;
    }
    const found = findNode(cache, step.id);
    if (!found || found.node.type !== "tag") {
      continue;
    }
    const line0 = found.node.line - 1;
    const shifted = shiftedLine(line0, edits);
    if (shifted !== line0 && shifted >= 0) {
      found.node.line = shifted + 1;
      changed++;
    }
  }

  if (changed > 0) {
    rebuildTours(); // immediate live re-render of gutter + note together
    debouncedSaveStore();
  }
}

// CodeLens shown on the line ABOVE each marked line, displaying the tag note
// (first line). Non-clickable: it's a label, not an action.
const onDidChangeCodeLenses = new vscode.EventEmitter<void>();
class TagCodeLensProvider implements vscode.CodeLensProvider {
  public onDidChangeCodeLenses = onDidChangeCodeLenses.event;

  async provideCodeLenses(
    document: vscode.TextDocument
  ): Promise<vscode.CodeLens[]> {
    if (!store.showMarkers || DISABLED_SCHEMES.includes(document.uri.scheme)) {
      return [];
    }

    const steps = await getTourSteps(document);
    return steps
      .filter(
        ([, step, , line]) =>
          line !== undefined &&
          line !== null &&
          stepNotePosition(step) === "above"
      )
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

export async function registerDecorators() {
  vscode.languages.registerCodeLensProvider("*", new TagCodeLensProvider());

  // Render markers as soon as an editor becomes active (e.g. opening a file), so
  // a tagged line shows its ⌖ gutter marker immediately — not only after some
  // later interaction. updateDecorations self-gates on store.showMarkers.
  vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor) {
      updateDecorations(editor);
    }
  });
  vscode.window.onDidChangeVisibleTextEditors(() => {
    if (vscode.window.activeTextEditor) {
      updateDecorations(vscode.window.activeTextEditor);
    }
  });

  // Track edits so a tag's note follows its code (and its gutter icon) instead of
  // staying pinned to the original line number.
  vscode.workspace.onDidChangeTextDocument(trackLineShifts);

  // Re-render whenever tags change (added / edited / removed / repositioned) or
  // marker visibility toggles. saveStore() rebuilds store.tours, so toggling a
  // single tag's note position flows through here and moves it live.
  reaction(
    () => [
      store.showMarkers,
      store.allTours.map(tour => [tour.title, tour.steps])
    ],
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

  // Initial paint for the editor already open on startup.
  if (vscode.window.activeTextEditor) {
    updateDecorations(vscode.window.activeTextEditor);
  }
}
