// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { reaction } from "mobx";
import {
  commands,
  Comment,
  CommentAuthorInformation,
  CommentController,
  CommentMode,
  comments,
  CommentThread,
  CommentThreadCollapsibleState,
  ExtensionContext,
  MarkdownString,
  Range,
  Selection,
  TextDocument,
  TextEditorRevealType,
  Uri,
  window,
  workspace
} from "vscode";
import {
  NOTE_INPUT_PLACEHOLDER,
  NOTE_INPUT_PROMPT,
  SMALL_ICON_URL
} from "../constants";
import { store } from "../store";
import { initializeStorage } from "../store/storage";
import {
  getActiveStepMarker,
  getFileUri,
  getRelativePath,
  getStepFileUri,
  getTourTitle
} from "../utils";
import { isExcluded } from "../lodestar/exclude";
import { registerCodeStatusModule } from "./codeStatus";
import { registerPlayerCommands } from "./commands";
import { excludePatterns, registerInlineNotes } from "./inlineNotes";
import { registerDecorators } from "./decorator";
import { registerFileSystemProvider } from "./fileSystem";
import { registerTextDocumentContentProvider } from "./fileSystem/documentProvider";
import { registerStatusBar } from "./status";
import { registerTreeProvider } from "./tree";

const CONTROLLER_ID = "codeJumpTags";
const CONTROLLER_LABEL = "Code Jump Tags";

let id = 0;

const SHELL_SCRIPT_PATTERN = /^>>\s+(?<script>.*)$/gm;

const COMMAND_PATTERN =
  /(?<commandPrefix>\(command:[\w+\.]+\?)(?<params>\[[^\]\)]+\])/gm;

const TOUR_REFERENCE_PATTERN =
  /(?:\[(?<linkTitle>[^\]]+)\])?\[(?=\s*[^\]\s])(?<tourTitle>[^\]#]+)?(?:#(?<stepNumber>\d+))?\](?!\()/gm;
const FILE_REFERENCE_PATTERN = /(\!)?(\[[^\]]+\]\()(\.[^\)]+)(?=\))/gm;
const CODE_FENCE_PATTERN = /```[^\n]+\n(.+)\n```/gms;

export function generatePreviewContent(content: string) {
  return content
    .replace(SHELL_SCRIPT_PATTERN, (_, script) => {
      const args = encodeURIComponent(JSON.stringify([script]));
      const s = `> [${script}](command:codeJumpTags.sendTextToTerminal?${args} "Run \\"${script.replace(
        /"/g,
        "'"
      )}\\" in a terminal")`;
      return s;
    })
    .replace(COMMAND_PATTERN, (_, commandPrefix, params) => {
      const args = encodeURIComponent(JSON.stringify(JSON.parse(params)));
      return `${commandPrefix}${args}`;
    })
    .replace(FILE_REFERENCE_PATTERN, (_, isImage, prefix, filePath) => {
      const workspaceUri = workspace.getWorkspaceFolder(
        Uri.parse(store.activeTour!.tour.id)
      )!.uri;
      const fileUri = Uri.joinPath(workspaceUri, filePath);

      if (isImage) {
        return `!${prefix}${fileUri.toString()}`;
      } else {
        const args = encodeURIComponent(JSON.stringify([fileUri]));
        return `${prefix}command:vscode.open?${args} "Open ${filePath}"`;
      }
    })
    .replace(TOUR_REFERENCE_PATTERN, (_, linkTitle, tourTitle, stepNumber) => {
      if (!tourTitle) {
        const title = linkTitle || `#${stepNumber}`;
        return `[${title}](command:codeJumpTags.navigateToStep?${stepNumber} "Navigate to step #${stepNumber}")`;
      }

      const tours = store.activeTour?.tours || store.tours;
      const tour = tours.find(tour => getTourTitle(tour) === tourTitle);
      if (tour) {
        const args: [string, number?] = [tour.title];

        if (stepNumber) {
          args.push(Number(stepNumber));
        }
        const argsContent = encodeURIComponent(JSON.stringify(args));
        const title = linkTitle || tour.title;
        return `[${title}](command:codeJumpTags.startTourByTitle?${argsContent} "Start \\"${tour.title}\\" tour")`;
      }

      return _;
    })
    .replace(CODE_FENCE_PATTERN, (_, codeBlock) => {
      const params = encodeURIComponent(JSON.stringify([codeBlock]));
      return `${_}
↪ [Insert Code](command:codeJumpTags.insertCodeSnippet?${params} "Insert Code")`;
    });
}

export class CodeTourComment implements Comment {
  public id: string = (++id).toString();
  public contextValue: string = "";
  public author: CommentAuthorInformation = {
    name: CONTROLLER_LABEL,
    iconPath: Uri.parse(SMALL_ICON_URL)
  };
  public body: MarkdownString;

  constructor(
    content: string,
    public label: string = "",
    public parent: CommentThread,
    public mode: CommentMode
  ) {
    const body =
      mode === CommentMode.Preview ? generatePreviewContent(content) : content;

    this.body = new MarkdownString(body);
    this.body.isTrusted = true;
  }
}

let controller: CommentController | null;

export async function focusPlayer() {
  const currentThread = store.activeTour!.thread!;
  showDocument(currentThread.uri, currentThread.range);
}

// Commenting-range provider for the gutter "+". While editing
// (store.isRecording) EVERY line gets the "+", including lines that already
// carry a tag.
//
// 这里以前是按「未打标签的行」拼范围的，已有标签的行被主动挖掉 —— 那就是「一行只能
// 建一条标签」的物理成因：建完第一条，这行的 "+" 就消失了；而 getTourSteps 连随手
// 私记也算在内，所以在行尾写一条随手注释同样会把该行的 "+" 干掉。0.8.x 的「一行多签」
// 只落在了数据层和渲染层（hover 合并、CodeLens `⌖ A | ⌖ B`），创建入口一直没跟上。
//
// addTag（recorder/commands.ts）本来就是无条件新建一条标签，从不去改已有的那条，
// 所以放开范围不会有「误编辑」的风险 —— 在已有标签的行上点 "+"，就是再加一条。
// 编辑旧标签仍走它自己行上方的 CodeLens / 悬停里的 ✎。
function makeCommentingRangeProvider() {
  return {
    provideCommentingRanges: async (document: TextDocument) => {
      if (!store.isRecording) {
        return null;
      }
      if (document.uri.scheme === "file") {
        const folders = workspace.workspaceFolders;
        if (folders && folders.length > 0) {
          const rel = getRelativePath(folders[0].uri.path, document.uri.path);
          if (isExcluded(rel, excludePatterns())) return null;
        }
      }
      if (document.lineCount === 0) return [];
      return [new Range(0, 0, document.lineCount - 1, 0)];
    }
  };
}

// Best-effort cache-bust for the gutter "+". The commenting API has no
// "ranges changed" event and caches ranges per open document, so a freshly
// tagged line keeps its "+" until reopen. Disposing+recreating the controller
// (the same path that makes the "+" appear) asks VS Code to re-query. Done only
// while editing — that's the only time the "+" shows, and the ambient edit tour
// has zero steps so the controller holds no live thread to lose. If VS Code
// still ignores the re-query, addTag keeps the lingering "+" harmless.
// Create the player's comment controller with the shared input-box text, so the
// "+" (create) box reads the same as the note (edit) box — not VS Code's default
// "开始讨论" — and wire up the gutter "+" range provider.
function createPlayerController(): CommentController {
  const c = comments.createCommentController(CONTROLLER_ID, CONTROLLER_LABEL);
  c.options = {
    prompt: NOTE_INPUT_PROMPT,
    placeHolder: NOTE_INPUT_PLACEHOLDER
  };
  c.commentingRangeProvider = makeCommentingRangeProvider();
  return c;
}

export function refreshCommentingRanges() {
  if (!controller || !store.isRecording) {
    return;
  }
  controller.dispose();
  controller = createPlayerController();
}

export async function startPlayer() {
  if (controller) {
    controller.dispose();
  }

  // TODO: Correctly limit the commenting ranges
  // to files within the workspace root
  controller = createPlayerController();
}

export async function stopPlayer() {
  if (store.activeTour?.thread) {
    store.activeTour!.thread.dispose();
    store.activeTour!.thread = null;
  }

  if (controller) {
    controller.dispose();
    controller = null;
  }
}

const VIEW_COMMANDS = new Map([
  ["comments", "workbench.panel.comments"],
  ["console", "workbench.panel.console"],
  ["debug", "workbench.view.debug"],
  ["debug:breakpoints", "workbench.debug.action.focusBreakpointsView"],
  ["debug:callstack", "workbench.debug.action.focusCallStackView"],
  ["debug:variables", "workbench.debug.action.focusVariablesView"],
  ["debug:watch", "workbench.debug.action.focusWatchView"],
  ["explorer", "workbench.view.explorer"],
  ["extensions", "workbench.view.extensions"],
  ["extensions:disabled", "extensions.disabledExtensionList.focus"],
  ["extensions:enabled", "extensions.enabledExtensionList.focus"],
  ["output", "workbench.panel.output"],
  ["problems", "workbench.panel.markers"],
  ["scm", "workbench.view.scm"],
  ["search", "workbench.view.search"],
  ["terminal", "terminal.focus"]
]);

async function renderCurrentStep() {
  // 顺读气泡默认折叠;用户手动展开/折叠后,VS Code 会把状态回写到旧 thread 上,
  // 翻页时沿用它,免得每一步都要重新点开。新开一次顺读时 thread 为 null,回到折叠。
  const previousState = store.activeTour!.thread?.collapsibleState;
  if (store.activeTour!.thread) {
    store.activeTour!.thread.dispose();
  }

  const currentTour = store.activeTour!.tour;
  const currentStep = store.activeTour!.step;

  const step = currentTour!.steps[currentStep];
  if (!step) {
    return;
  }

  const workspaceRoot = store.activeTour?.workspaceRoot;
  const uri = await getStepFileUri(step, workspaceRoot, currentTour.ref);

  let line = step.line
    ? step.line - 1
    : step.selection
    ? step.selection.end.line - 1
    : undefined;

  if (step.file && line === undefined) {
    const stepPattern = step.pattern || getActiveStepMarker();
    if (stepPattern) {
      const document = await workspace.openTextDocument(uri);
      const match = document.getText().match(new RegExp(stepPattern, "m"));
      if (match) {
        line = document.positionAt(match.index!).line;
      }
    }
  }

  if (line === undefined) {
    // The step doesn't have a discoverable line number and so
    // stick the step at the end of the file. Unfortunately, there
    // isn't a way to say EOF, so 2000 is a temporary hack.
    line = 2000;
  }

  const range = new Range(line!, 0, line!, 0);
  let label = `Step #${currentStep + 1} of ${currentTour!.steps.length}`;

  if (currentTour.title) {
    const title = getTourTitle(currentTour);
    label += ` (${title})`;
  }

  store.activeTour!.thread = controller!.createCommentThread(uri, range, []);

  const mode =
    store.isRecording && store.isEditing
      ? CommentMode.Editing
      : CommentMode.Preview;
  const content = step.description;

  // 上一步/下一步/结束不再拼进正文,改由 comments/commentThread/title 菜单挂在
  // 气泡标题栏(折叠按钮旁),按下面的 contextValue 决定显示哪几个。
  const hasPreviousStep = currentStep > 0;
  const hasNextStep = currentStep < currentTour.steps.length - 1;

  const comment = new CodeTourComment(
    content,
    label,
    store.activeTour!.thread!,
    mode
  );

  // @ts-ignore
  store.activeTour!.thread.canReply = false;
  store.activeTour!.thread.comments = [comment];

  const contextValues = [];
  if (hasPreviousStep) {
    contextValues.push("hasPrevious");
  }

  if (hasNextStep) {
    contextValues.push("hasNext");
  }

  store.activeTour!.thread.contextValue = contextValues.join(".");
  store.activeTour!.thread.collapsibleState = store.isRecording
    ? CommentThreadCollapsibleState.Expanded
    : previousState ?? CommentThreadCollapsibleState.Collapsed;

  let selection;
  if (step.selection) {
    // Adjust the 1-based positions
    // to the 0-based positions that
    // VS Code's editor uses.
    selection = new Selection(
      step.selection.start.line - 1,
      step.selection.start.character - 1,
      step.selection.end.line - 1,
      step.selection.end.character - 1
    );
  } else {
    selection = new Selection(range.start, range.end);
  }

  await showDocument(uri, range, selection);

  if (step.directory) {
    const directoryUri = getFileUri(step.directory, workspaceRoot);
    commands.executeCommand("revealInExplorer", directoryUri);
  } else if (step.view) {
    const commandName = VIEW_COMMANDS.has(step.view)
      ? VIEW_COMMANDS.get(step.view)!
      : `${step.view}.focus`;

    try {
      await commands.executeCommand(commandName);
    } catch {
      window.showErrorMessage(
        `The current tour step is attempting to focus a view which isn't available: ${step.view}. Please check the tour and try again.`
      );
    }
  }

  if (step.commands) {
    for (const command of step.commands) {
      let name = command,
      args: any[] = [];

      if (command.includes("?")) {
        const parts = command.split("?");
        name = parts[0];
        args = JSON.parse(parts[1]);
      }

      try {
        console.log("Executing command", name, JSON.stringify(args));
        await commands.executeCommand(name, ...args);
      } catch (e) {
        window.showErrorMessage(`An error has occurred: ${e}`);
      }
    }
  }
}

async function showDocument(uri: Uri, range: Range, selection?: Selection) {
  const document =
    window.visibleTextEditors.find(
      editor => editor.document.uri.toString() === uri.toString()
    ) || (await window.showTextDocument(uri, { preserveFocus: true }));

  // TODO: Figure out how to force focus when navigating
  // to documents which are already open.

  if (selection) {
    document.selection = selection;
  }

  document.revealRange(range, TextEditorRevealType.InCenter);
}

export function registerPlayerModule(context: ExtensionContext) {
  registerPlayerCommands();
  registerTreeProvider(context.extensionPath);
  registerFileSystemProvider();
  registerTextDocumentContentProvider();
  registerStatusBar();
  registerDecorators();
  registerCodeStatusModule();
  registerInlineNotes();

  initializeStorage(context);

  // When a tag is added/removed, try to refresh the gutter "+" ranges so a newly
  // tagged line drops its "+" without waiting for the file to be reopened.
  reaction(
    () => store.tours.map(tour => tour.steps.length).join(","),
    () => refreshCommentingRanges()
  );

  // Watch for changes to the active tour property,
  // and automatically re-render the current step in response.
  reaction(
    () => [
      store.activeTour
        ? [
            store.activeTour.step,
            store.activeTour.tour.title,
            store.activeTour.tour.steps.map(step => [
              step.title,
              step.description,
              step.line,
              step.directory,
              step.view
            ])
          ]
        : null
    ],
    () => {
      if (store.activeTour) {
        renderCurrentStep();
      }
    }
  );
}
