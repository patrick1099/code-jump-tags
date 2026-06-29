// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { reaction } from "mobx";
import { debounce } from "throttle-debounce";
import * as vscode from "vscode";
import { FS_SCHEME_CONTENT, ICON_URL } from "../constants";
import { getStore, rebuildTours, saveStore } from "../lodestar/persistence";
import { findNode, LineEdit } from "../lodestar/tree";
import {
  reanchorTag,
  resolveTagLine,
  lineAnchorText,
  linePattern
} from "../lodestar/relocate";
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
          // Resolve the display line through the content pattern, so the gutter
          // crosshair + note recover their line after a wholesale overwrite /
          // reload (the stored line goes stale, but the line's text is found
          // again). This is the SAME recovery the jump command uses, so the
          // marker and the jump target always agree.
          line = resolveTagLine(contents, step.line, step.original, step.text, step.pattern) - 1;
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
  // RC3: a pure same-line edit (no lines added/removed) doesn't move any tag,
  // but it DOES change the edited line's text — refresh those tags' anchors so
  // they never go stale and prime a wrong fuzzy jump on the next structural
  // edit / reopen.
  if (edits.every(edit => edit.delta === 0)) {
    const editedLines0 = new Set<number>();
    for (const c of e.contentChanges) {
      for (let ln = c.range.start.line; ln <= c.range.end.line; ln++) {
        editedLines0.add(ln);
      }
    }
    const steps0 = await getTourSteps(e.document);
    const lines0 = e.document.getText().split(/\r?\n/);
    const cache0 = getStore();
    let touched = 0;
    for (const [, step] of steps0) {
      if (!step.id) continue;
      const found = findNode(cache0, step.id);
      if (!found || found.node.type !== "tag") continue;
      const node = found.node;
      if (!editedLines0.has(node.line - 1)) continue;
      const cur = lines0[node.line - 1];
      if (cur === undefined) continue;
      const t = lineAnchorText(cur);
      const p = linePattern(cur);
      if (t !== node.text || p !== node.pattern) {
        node.text = t;
        node.pattern = p;
        touched++;
      }
    }
    if (touched > 0) {
      rebuildTours();
      debouncedSaveStore();
    } else if (vscode.window.activeTextEditor?.document === e.document) {
      updateDecorations(vscode.window.activeTextEditor);
    }
    return;
  }

  // Which tags live in this document (resolves each tag's file uri the same way
  // the decorations do, so matching is exact).
  const steps = await getTourSteps(e.document);
  const text = e.document.getText();
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
    const node = found.node;
    // Re-anchor: shift by the edit, let content recovery override a wrong guess
    // (overwrite case), and refresh the anchor pattern from the new line text so
    // the stored anchor never goes stale. Persist BOTH line and pattern.
    const after = reanchorTag(
      text,
      { line: node.line, text: node.text, pattern: node.pattern },
      edits
    );
    if (
      after.line !== node.line ||
      after.pattern !== node.pattern ||
      after.text !== node.text
    ) {
      node.line = after.line;
      node.pattern = after.pattern;
      node.text = after.text;
      changed++;
    }
  }

  if (changed > 0) {
    // rebuildTours triggers the decorator reaction, which repaints the gutter as
    // fresh single-line ranges from the updated stored lines (and moves the note
    // CodeLens with it). debounced save persists the new positions.
    rebuildTours();
    debouncedSaveStore();
  } else if (vscode.window.activeTextEditor?.document === e.document) {
    // Lines were added/removed but no tag moved — e.g. a newline typed INSIDE a
    // tagged line. VS Code auto-expands the existing gutter decoration's range
    // across the new lines (smearing the icon down several rows). Repaint so the
    // gutter is a clean single-line range again from the (unchanged) stored line.
    updateDecorations(vscode.window.activeTextEditor);
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
