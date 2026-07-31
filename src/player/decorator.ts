// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { reaction } from "mobx";
import { debounce } from "throttle-debounce";
import * as vscode from "vscode";
import { FS_SCHEME_CONTENT, ICON_URL } from "../constants";
import { getStore, rebuildTours, saveStore } from "../lodestar/persistence";
import { findNode, LineEdit, shiftedLine } from "../lodestar/tree";
import {
  reanchorTag,
  resolveTagLine,
  lineAnchorText,
  linePattern
} from "../lodestar/relocate";
import { CodeTourStep, CodeTourStepTuple, store } from "../store";
import { getSuspect } from "../lodestar/suspect";
import { getStepFileUri, getWorkspaceUri } from "../utils";
import { lineLensTitles } from "./lensTitles";
import { canonicalText } from "./inlineNotes";
import { recentlyExternal } from "./externalWatch";

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

// Suspect gutter icon: a grey ringed "?" (data-URI SVG, no asset file).
const SUSPECT_ICON = vscode.Uri.parse(
  "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="#9aa0a6" stroke-width="1.5"/><text x="8" y="11.5" font-size="9" text-anchor="middle" fill="#9aa0a6" font-family="sans-serif">?</text></svg>`
    )
);
const SUSPECT_DECORATOR = vscode.window.createTextEditorDecorationType({
  gutterIconPath: SUSPECT_ICON,
  gutterIconSize: "contain",
  overviewRulerColor: "rgba(154,160,166,0.7)",
  overviewRulerLane: vscode.OverviewRulerLane.Right,
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
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
  // 锚匹配一律用归一化文本：展开态的行带着 `//me: 私记`，拿原文去比身份锚会把该行上
  // 的标签（含并存的正式标签）判成失配，而失配行在下面会被 `continue` 掉——行尾小字
  // 跟着一起消失。legacy 的 pattern 分支仍用原文，因为它要 document.positionAt 的偏移。
  const anchorContents = canonicalText(document, contents);
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
          line = resolveTagLine(anchorContents, step.line, step.original, step.text, step.pattern) - 1;
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
  const suspectDecorations: vscode.DecorationOptions[] = [];
  // A line can hold multiple formal tags. VS Code shows only ONE hover for
  // overlapping same-type decorations, so we collect each line's tags here and
  // merge them into a single gutter hover listing every note + its own ✎.
  const gutterLines = new Map<
    number,
    { createdAt: string; id: string; md: string }[]
  >();

  for (const [, step, , line] of store.activeEditorSteps!) {
    if (line === undefined || line === null || line >= editor.document.lineCount) {
      continue;
    }
    const full = (step.description || "").trim();
    const note = full.split(/\r?\n/)[0];

    // 随手私记只画行尾那条小字 —— 不画 gutter 的 ⌖ 标记，也不画失配的 ? 标记。
    // 它是行尾的一次性便条，不该占用「这一行有正式标签」的视觉语汇；失配对它也没有
    // triage 意义（同理它已被排除在侧边栏的「待处理」分组之外）。
    if (step.inline) {
      if (note) {
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
      continue;
    }

    const suspect = step.id ? getSuspect(step.id) : undefined;
    if (suspect) {
      const sh = new vscode.MarkdownString();
      sh.isTrusted = true;
      sh.appendMarkdown(`⚠ 此标签可能失配\n\n`);
      sh.appendMarkdown(`- 原身份: \`${suspect.original ?? "(无)"}\`\n`);
      sh.appendMarkdown(`- 现内容: \`${suspect.current ?? "(无)"}\`\n\n`);
      // 可疑态只给「真正能成」的动作:软可疑(current 命中)给「采纳新位置」(把候选行
      // 升为新身份 = 更新 original)+「移到光标行」;硬可疑(都没命中)只给「移到光标行」。
      // 「找回原行」已废弃删除:可疑 ⟺ original 在文件里找不到,而它又靠 original 去找,
      // 必然扑空(设计矛盾,见 specs/2026-06-29-original-current-matching-design.md)。
      const move = encodeURIComponent(JSON.stringify([{ tagId: step.id }]));
      if (suspect.status === "current") {
        const adopt = encodeURIComponent(JSON.stringify([step.id, suspect.line]));
        sh.appendMarkdown(
          `[采纳新位置](command:codeJumpTags.promoteToOriginal?${adopt}) · ` +
            `[移到光标行](command:codeJumpTags.moveTagToCursor?${move})`
        );
      } else {
        sh.appendMarkdown(
          `[移到光标行](command:codeJumpTags.moveTagToCursor?${move})`
        );
      }
      suspectDecorations.push({
        range: new vscode.Range(line, 0, line, 1000),
        hoverMessage: sh
      });
      continue; // 可疑行不再进普通 gutter
    }

    // Register this display line (the gutter icon shows even for an empty-note
    // tag) and, when the tag has a note, add its own block — note + a ✎ edit
    // link keyed to THIS tag — to the line's merged hover.
    let entries = gutterLines.get(line);
    if (!entries) {
      entries = [];
      gutterLines.set(line, entries);
    }
    if (full) {
      const editLink = step.id
        ? `\n\n[✎ 编辑注释](command:codeJumpTags.editNote?${encodeURIComponent(
            JSON.stringify([step.id])
          )})`
        : "";
      entries.push({
        createdAt: step.createdAt ?? "",
        id: step.id ?? "",
        md: `${full}${editLink}`
      });
    }

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

  // One gutter decoration per line, its hover merging all that line's tags in
  // createdAt order (id tiebreak) — same order as the above-line CodeLenses.
  for (const [line, entries] of gutterLines) {
    entries.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    let hover: vscode.MarkdownString | undefined;
    if (entries.length) {
      hover = new vscode.MarkdownString(
        entries.map(e => e.md).join("\n\n---\n\n")
      );
      hover.isTrusted = true;
    }
    gutterDecorations.push({
      range: new vscode.Range(line, 0, line, 1000),
      hoverMessage: hover
    });
  }

  editor.setDecorations(TOUR_DECORATOR, gutterDecorations);
  editor.setDecorations(INLINE_NOTE_DECORATOR, inlineDecorations);
  editor.setDecorations(SUSPECT_DECORATOR, suspectDecorations);
}

function clearDecorations(editor: vscode.TextEditor) {
  store.activeEditorSteps = undefined;
  editor.setDecorations(TOUR_DECORATOR, []);
  editor.setDecorations(INLINE_NOTE_DECORATOR, []);
  editor.setDecorations(SUSPECT_DECORATOR, []);
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
    // 归一化后再取行文本：否则同一行上并存的正式标签会在这里被刷成含 `//me: 私记`
    // 的脏锚，并由下面的 debouncedSaveStore 落盘——私记就从「不落源码」变成「落进了
    // 正式标签的身份锚」，且立刻触发失配。
    const lines0 = canonicalText(e.document).split(/\r?\n/);
    const cache0 = getStore();
    let touched = 0;
    for (const [, step] of steps0) {
      if (!step.id) continue;
      const found = findNode(cache0, step.id);
      if (!found || found.node.type !== "tag") continue;
      const node = found.node;
      // inline tag 的锚由 inlineNotes 的折叠路径独占改写（永远写剥净后的干净代码）。
      // 展开态的行文本此刻含 marker + 私密 note，若在此从当前行文本刷新锚，会把私密
      // 内容漏进 node.text/pattern 并被 debouncedSaveStore 落盘（违反「身份锚永不含
      // marker」）。故 inline tag 完全跳过同行锚刷新。
      if (node.inline) continue;
      if (!editedLines0.has(node.line - 1)) continue;
      const cur = lines0[node.line - 1];
      if (cur === undefined) continue;
      const t = lineAnchorText(cur);
      const p = linePattern(cur);
      if (t !== node.text || p !== node.pattern) {
        node.text = t;
        node.pattern = p;
        // 这次 buffer 变化是我们看着发生的 → 现内容可信，不该被判失配。
        // 唯一的例外是「刚有外部写盘」——那时这次变化其实是外部内容被载入进来。
        if (!recentlyExternal(node.file)) node.witnessed = true;
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
  // 同上：reanchorTag 会从解析出的行重新采纳锚文本，必须喂归一化文本。
  const text = canonicalText(e.document);
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
    // inline tag：只跟随行号位移，绝不从当前行文本刷新锚。若此刻它正处于展开态，当前行
    // 含 marker + 私密 note；reanchorTag 会把该文本当作新锚采纳（漏进 text/pattern 并落
    // 盘）。锚的文本刷新由 inlineNotes 的折叠路径独占（每次折叠都从剥净代码重锚）。
    if (node.inline) {
      const shifted = shiftedLine(node.line - 1, edits) + 1;
      if (shifted !== node.line) {
        node.line = shifted;
        changed++;
      }
      continue;
    }
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
      // 同上：只有不是「刚被外部写盘后载入进来」的变化才让现内容变得可信。
      if (after.text !== node.text && !recentlyExternal(node.file)) {
        node.witnessed = true;
      }
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
    // 只取「行上方」样式、有解析出显示行的 step。
    const above = steps.filter(
      ([, step, , line]) =>
        line !== undefined && line !== null && stepNotePosition(step) === "above"
    );

    // 按显示行分组:同一行多条标签渲染成 `⌖ A | ⌖ B`,每条 lens 各自可点、
    // 各编辑各的 tag。
    const byLine = new Map<number, CodeTourStepTuple[]>();
    for (const t of above) {
      const line = t[3]!;
      const group = byLine.get(line);
      if (group) group.push(t);
      else byLine.set(line, [t]);
    }

    const lenses: vscode.CodeLens[] = [];
    for (const [line, group] of byLine) {
      // createdAt 升序、id 兜底 → 稳定的 | 左右序。
      group.sort((a, b) => {
        const ca = a[1].createdAt ?? "";
        const cb = b[1].createdAt ?? "";
        if (ca !== cb) return ca < cb ? -1 : 1;
        return (a[1].id ?? "") < (b[1].id ?? "") ? -1 : 1;
      });
      const titles = lineLensTitles(
        group.map(([, step]) => (step.description || "").split(/\r?\n/)[0].trim())
      );
      group.forEach(([, step], i) => {
        lenses.push(
          new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
            title: titles[i],
            command: step.id ? "codeJumpTags.editNote" : "",
            arguments: step.id ? [step.id] : undefined
          })
        );
      });
    }
    return lenses;
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
