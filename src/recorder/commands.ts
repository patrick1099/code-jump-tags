// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { action, comparer, runInAction } from "mobx";
import * as path from "path";
import * as vscode from "vscode";
import { workspace } from "vscode";
import { EXTENSION_NAME, FS_SCHEME_CONTENT } from "../constants";
import { api, RefType } from "../git";
import { CodeTourComment } from "../player";
import { CodeTourNode, CodeTourStepNode } from "../player/tree/nodes";
import { CodeTour, store } from "../store";
import {
  EDITING_KEY,
  endCurrentCodeTour,
  exportTour,
  onDidEndTour,
  startCodeTour
} from "../store/actions";
import { getActiveWorkspacePath, getRelativePath } from "../utils";
import { getStore, saveStore } from "../lodestar/persistence";
import {
  addTag,
  findTagByLocation,
  getOrCreateInbox,
  newFolderId
} from "../lodestar/tree";
import { linePattern, lineAnchorText } from "../lodestar/relocate";
import { TagNode } from "../lodestar/types";

export async function saveTour(tour: CodeTour) {
  const uri = vscode.Uri.parse(tour.id);
  const newTour = {
    $schema: "https://aka.ms/codetour-schema",
    ...tour
  };

  // @ts-ignore
  delete newTour.id;
  newTour.steps.forEach(step => {
    delete step.markerTitle;
  });

  const tourContent = JSON.stringify(newTour, null, 2);

  const bytes = new TextEncoder().encode(tourContent);
  await vscode.workspace.fs.writeFile(uri, bytes);
}

export function registerRecorderCommands() {
  function getTourFileUri(workspaceRoot: vscode.Uri, title: string) {
    const file = title
      .toLocaleLowerCase()
      .replace(/\s/g, "-")
      .replace(/[^\w\d\-_]/g, "");

    const prefix = workspaceRoot.path.endsWith("/")
      ? workspaceRoot.path
      : `${workspaceRoot.path}/`;

    const customTourDirectory = vscode.workspace
      .getConfiguration(EXTENSION_NAME)
      .get("customTourDirectory", null);
    const tourDirectory = customTourDirectory || ".tours";

    return workspaceRoot.with({
      path: `${prefix}${tourDirectory}/${file}.tour`
    });
  }

  async function checkIfTourExists(workspaceRoot: vscode.Uri, title: string) {
    const uri = getTourFileUri(workspaceRoot, title);

    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return stat.type === vscode.FileType.File;
    } catch {
      return false;
    }
  }

  async function writeTourFile(
    workspaceRoot: vscode.Uri,
    title: string | vscode.Uri,
    ref?: string
  ): Promise<CodeTour> {
    const uri =
      typeof title === "string" ? getTourFileUri(workspaceRoot, title) : title;

    const tourTitle =
      typeof title === "string"
        ? title
        : path.basename(title.path).replace(".tour", "");

    const tour = {
      $schema: "https://aka.ms/codetour-schema",
      title: tourTitle,
      steps: []
    };

    if (ref && ref !== "HEAD") {
      (tour as any).ref = ref;
    }

    const tourContent = JSON.stringify(tour, null, 2);
    const bytes = new TextEncoder().encode(tourContent);
    await vscode.workspace.fs.writeFile(uri, bytes);

    (tour as any).id = decodeURIComponent(uri.toString());

    // @ts-ignore
    return tour as CodeTour;
  }

  interface WorkspaceQuickPickItem extends vscode.QuickPickItem {
    uri: vscode.Uri;
  }

  const REENTER_TITLE_RESPONSE = "Re-enter title";
  async function recordTourInternal(
    tourTitle: string | vscode.Uri,
    workspaceRoot?: vscode.Uri
  ) {
    if (!workspaceRoot) {
      workspaceRoot = workspace.workspaceFolders![0].uri;

      if (workspace.workspaceFolders!.length > 1) {
        const items: WorkspaceQuickPickItem[] = workspace.workspaceFolders!.map(
          ({ name, uri }) => ({
            label: name,
            uri: uri
          })
        );

        const response = await vscode.window.showQuickPick(items, {
          placeHolder: "Select the workspace to save the tour to"
        });

        if (!response) {
          return;
        }

        workspaceRoot = response.uri;
      }
    }

    if (typeof tourTitle === "string") {
      const tourExists = await checkIfTourExists(workspaceRoot, tourTitle);

      if (tourExists) {
        const response = await vscode.window.showErrorMessage(
          `This workspace already includes a tour with the title "${tourTitle}."`,
          REENTER_TITLE_RESPONSE,
          "Overwrite existing tour"
        );

        if (response === REENTER_TITLE_RESPONSE) {
          return vscode.commands.executeCommand(
            `${EXTENSION_NAME}.recordTour`,
            workspaceRoot,
            tourTitle
          );
        } else if (!response) {
          // If the end-user closes the error
          // dialog, then cancel the recording.
          return;
        }
      }
    }

    let ref;

    const mode = vscode.workspace
      .getConfiguration("codeJumpTags")
      .get("recordMode", "lineNumber");

    if (mode === "lineNumber") {
      ref = await promptForTourRef(workspaceRoot);
    }

    const tour = await writeTourFile(workspaceRoot, tourTitle, ref);

    startCodeTour(tour, 0, workspaceRoot, true);

    vscode.window.showInformationMessage(
      "CodeTour recording started! Begin creating steps by opening a file, clicking the + button to the left of a line of code, and then adding the appropriate comments."
    );
  }

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.recordTour`,
    async (workspaceRoot?: vscode.Uri, placeHolderTitle?: string) => {
      const inputBox = vscode.window.createInputBox();
      inputBox.title =
        "Specify the title of the tour, or save it to a specific location";
      inputBox.placeholder = placeHolderTitle;
      inputBox.buttons = [
        {
          iconPath: new vscode.ThemeIcon("save-as"),
          tooltip: "Save tour as..."
        }
      ];

      inputBox.onDidAccept(async () => {
        inputBox.hide();

        if (!inputBox.value) {
          return;
        }

        recordTourInternal(inputBox.value, workspaceRoot);
      });

      inputBox.onDidTriggerButton(async button => {
        inputBox.hide();

        const uri = await vscode.window.showSaveDialog({
          filters: {
            Tours: ["tour"]
          },
          saveLabel: "Save Tour"
        });

        if (!uri) {
          return;
        }

        const disposeEndTourHandler = onDidEndTour(async tour => {
          if (tour.id === decodeURIComponent(uri.toString())) {
            disposeEndTourHandler.dispose();

            if (
              await vscode.window.showInformationMessage(
                "Would you like to export this tour?",
                "Export Tour"
              )
            ) {
              const content = await exportTour(tour);
              vscode.workspace.fs.writeFile(uri, Buffer.from(content));
            }
          }
        });

        recordTourInternal(uri, workspaceRoot);
      });

      inputBox.show();
    }
  );

  function getStepSelection() {
    const activeEditor = vscode.window.activeTextEditor;
    if (
      activeEditor &&
      activeEditor.selection &&
      !activeEditor.selection.isEmpty
    ) {
      const { start, end } = activeEditor.selection;

      // Convert the selection from 0-based
      // to 1-based to make it easier to
      // edit the JSON tour file by hand.
      const selection = {
        start: {
          line: start.line + 1,
          character: start.character + 1
        },
        end: {
          line: end.line + 1,
          character: end.character + 1
        }
      };

      const previousStep =
        store.activeTour!.tour.steps[store.activeTour!.step - 1];

      // Check whether the end-user forgot to "reset"
      // the selection from the previous step, and if so,
      // ignore it from this step since it's not likely useful.
      if (
        !previousStep ||
        !previousStep.selection ||
        !comparer.structural(previousStep.selection, selection)
      ) {
        return selection;
      }
    }
  }

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.addContentStep`,
    action(async (node?: CodeTourStepNode) => {
      const value = store.activeTour?.step === -1 ? "Introduction" : "";
      const title = await vscode.window.showInputBox({
        prompt: "Specify the title of the step",
        value
      });

      if (!title) {
        return;
      }

      let stepNumber;
      if (node) {
        stepNumber = node.stepNumber + 1;
        store.activeTour!.step = stepNumber;
      } else {
        stepNumber = ++store.activeTour!.step;
      }

      const tour = store.activeTour!.tour;

      tour.steps.splice(stepNumber, 0, {
        title,
        description: ""
      });

      if (!store.isEditing) {
        store.isEditing = true;
        vscode.commands.executeCommand("setContext", EDITING_KEY, false);
      }

      saveTour(tour);
    })
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.addDirectoryStep`,
    action(async (uri: vscode.Uri) => {
      const stepNumber = ++store.activeTour!.step;
      const tour = store.activeTour!.tour;

      const workspaceRoot = getActiveWorkspacePath();
      const directory = getRelativePath(workspaceRoot, uri.path);

      tour.steps.splice(stepNumber, 0, {
        directory,
        description: ""
      });

      if (!store.isEditing) {
        store.isEditing = true;
        vscode.commands.executeCommand("setContext", EDITING_KEY, false);
      }

      saveTour(tour);
    })
  );

  vscode.commands.registerTextEditorCommand(
    `${EXTENSION_NAME}.addSelectionStep`,
    action(async (editor: vscode.TextEditor) => {
      const stepNumber = ++store.activeTour!.step;
      const tour = store.activeTour!.tour;

      const workspaceRoot = getActiveWorkspacePath();
      const file = getRelativePath(workspaceRoot, editor.document.uri.path);

      tour.steps.splice(stepNumber, 0, {
        file,
        selection: getStepSelection(),
        description: ""
      });

      if (!store.isEditing) {
        store.isEditing = true;
        vscode.commands.executeCommand("setContext", EDITING_KEY, false);
      }

      saveTour(tour);
    })
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.addTag`,
    async (reply: vscode.CommentReply) => {
      const thread = reply.thread;
      const workspaceRoot = workspace.workspaceFolders![0].uri;
      const file = getRelativePath(workspaceRoot.path, thread.uri.path);
      const lineIndex = thread.range.start.line;
      const line = lineIndex + 1;

      // Read the anchor line's text from the document the thread actually lives
      // on. Relying on activeTextEditor is unsafe: it may point at a different
      // (shorter) document, in which case lineAt() throws and the whole submit
      // rejects — which is what made adding a tag only work "sometimes".
      let lineText: string | undefined;
      const threadEditor = vscode.window.visibleTextEditors.find(
        e => e.document.uri.toString() === thread.uri.toString()
      );
      if (threadEditor && lineIndex < threadEditor.document.lineCount) {
        lineText = threadEditor.document.lineAt(lineIndex).text.trim();
      }
      const pattern = lineText ? linePattern(lineText) : undefined;
      const text = lineText ? lineAnchorText(lineText) : undefined;

      // Dismiss the native editing bubble on the NEXT tick. Disposing the thread
      // synchronously inside its own reply handler wedges VS Code's comment
      // widget (the submit spinner never clears, i.e. it "hangs"). Resolving the
      // command first, then tearing the thread down, avoids that race.
      const dismiss = () =>
        setTimeout(() => {
          try {
            thread.dispose();
          } catch {
            /* thread already gone */
          }
        }, 0);

      // One tag per line, ONE box per line. If the line is already tagged,
      // clicking "+" routes to the same edit box as clicking the note. The edit
      // box shows the current note in its header and replaces it with what you
      // type, so we discard the "+" box text and just open it. The one exception
      // is a tag with no note yet: there's nothing to preserve, so adopt whatever
      // was just typed as its first note without opening the editor.
      const existing = findTagByLocation(getStore(), file, line);
      if (existing) {
        dismiss();
        const hasNote = existing.note && existing.note.trim().length > 0;
        if (!hasNote && reply.text && reply.text.trim().length > 0) {
          existing.note = reply.text;
          await saveStore();
        } else {
          const { openTagEditor } = await import("../lodestar/editThread");
          await openTagEditor(existing.id);
        }
        return;
      }

      const tag: TagNode = {
        type: "tag",
        id: `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        note: reply.text,
        file,
        line,
        pattern,
        text,
        original: text,
        createdAt: new Date().toISOString()
      };
      const inbox = getOrCreateInbox(getStore(), newFolderId);
      addTag(getStore(), tag, inbox.id); // new tags land in the inbox folder
      await saveStore();
      dismiss();
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.editTour`,
    async (node: CodeTourNode | vscode.CommentThread) => {
      store.isRecording = true;
      store.isEditing = true;
      await vscode.commands.executeCommand(
        "setContext",
        "codeJumpTags:recording",
        true
      );
      await vscode.commands.executeCommand("setContext", EDITING_KEY, true);

      if (node instanceof CodeTourNode) {
        startCodeTour(node.tour);
      } else if (store.activeTour) {
        // We need to re-start the tour so that the associated
        // comment controller is put into edit mode
        startCodeTour(
          store.activeTour!.tour,
          store.activeTour!.step,
          store.activeTour.workspaceRoot
        );
      }
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.editTourAtStep`,
    async (node: CodeTourStepNode) => {
      startCodeTour(node.tour, node.stepNumber, undefined, true);
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.previewTour`,
    async (node: CodeTourNode | vscode.CommentThread) => {
      store.isEditing = false;
      vscode.commands.executeCommand("setContext", EDITING_KEY, false);
      await vscode.commands.executeCommand(
        "setContext",
        "codeJumpTags:recording",
        false
      );

      if (node instanceof CodeTourNode) {
        startCodeTour(node.tour);
      } else if (store.activeTour) {
        // We need to re-start the tour so that the associated
        // comment controller is put into edit mode
        startCodeTour(
          store.activeTour!.tour,
          store.activeTour!.step,
          store.activeTour.workspaceRoot
        );
      }
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.makeTourPrimary`,
    async (node: CodeTourNode) => {
      const primaryTour = node.tour;
      primaryTour.isPrimary = true;
      saveTour(primaryTour);

      store.tours
        .filter(tour => tour.id !== primaryTour.id && tour.isPrimary)
        .forEach(tour => {
          delete tour.isPrimary;
          saveTour(tour);
        });
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.unmakeTourPrimary`,
    async (node: CodeTourNode) => {
      const primaryTour = node.tour;
      delete primaryTour.isPrimary;
      saveTour(primaryTour);
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.saveTag`,
    async (comment: CodeTourComment) => {
      if (!comment.parent) {
        return;
      }

      runInAction(() => {
        const content =
          comment.body instanceof vscode.MarkdownString
            ? comment.body.value
            : comment.body;

        const tourStep = store.activeTour!.tour!.steps[store.activeTour!.step];
        tourStep.description = content;

        const selection = getStepSelection();
        if (selection) {
          tourStep.selection = selection;
        }
      });

      store.isEditing = false;
      vscode.commands.executeCommand("setContext", EDITING_KEY, false);
      await saveTour(store.activeTour!.tour);
    }
  );

  async function updateTourProperty(tour: CodeTour, property: string) {
    const propertyValue = await vscode.window.showInputBox({
      prompt: `Enter the ${property} for this tour`,
      // @ts-ignore
      value: tour[property]
    });

    if (!propertyValue) {
      return;
    }

    // @ts-ignore
    tour[property] = propertyValue;
    await saveTour(tour);

    return propertyValue;
  }

  async function moveStep(
    movement: number,
    node: CodeTourStepNode | CodeTourComment
  ) {
    let tour: CodeTour, stepNumber: number;

    // Code Jump Tags: a tree tag node carries a Lodestar tag id; reorder it within
    // its parent in the store instead of mutating the derived tour cache.
    if ((node as any)?.step?.id) {
      const { getStore, saveStore } = await import("../lodestar/persistence");
      const { findNode, moveNode } = await import("../lodestar/tree");
      const store = getStore();
      const id = (node as CodeTourStepNode).step!.id!;
      const found = findNode(store, id);
      if (!found) return;
      const parentId = found.parent ? found.parent.id : null;
      const newIndex = found.index + movement;
      if (newIndex < 0 || newIndex >= found.siblings.length) return; // at edge, no-op
      moveNode(store, id, parentId, newIndex);
      await saveStore();
      return;
    }

    if (node instanceof CodeTourComment) {
      tour = store.activeTour!.tour;
      stepNumber = store.activeTour!.step;
    } else {
      tour = node.tour;
      stepNumber = node.stepNumber;
    }

    runInAction(async () => {
      const step = tour.steps[stepNumber];
      tour.steps.splice(stepNumber, 1);
      tour.steps.splice(stepNumber + movement, 0, step);

      // If the user is moving the currently active step, then move
      // the tour play along with it as well.
      if (
        store.activeTour &&
        tour.id === store.activeTour.tour.id &&
        stepNumber === store.activeTour.step
      ) {
        store.activeTour.step += movement;
      }

      await saveTour(tour);
    });
  }

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.moveTagBack`,
    moveStep.bind(null, -1)
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.moveTagForward`,
    moveStep.bind(null, 1)
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.changeTourDescription`,
    (node: CodeTourNode) => updateTourProperty(node.tour, "description")
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.changeTourTitle`,
    async (node: CodeTourNode) => {
      const oldTitle = node.tour.title;
      const newTitle = await updateTourProperty(node.tour, "title");

      // If the user updated the tour's title, then we need to check
      // whether there are other tours that reference this tour, and
      // if so, we want to update the tour reference to match the new title.
      if (newTitle) {
        store.tours
          .filter(tour => tour.nextTour === oldTitle)
          .forEach(tour => {
            tour.nextTour = newTitle;
            saveTour(tour);
          });
      }
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.changeTourStepTitle`,
    async (node: CodeTourStepNode) => {
      const step = node.tour.steps[node.stepNumber];
      const response = await vscode.window.showInputBox({
        prompt: `Enter the title for this tour step`,
        value: step.title || ""
      });

      if (typeof response === "undefined") {
        return;
      } else if (response) {
        step.title = response;
      } else {
        delete step.title;
      }

      saveTour(node.tour);
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.changeTourStepIcon`,
    async (node: CodeTourStepNode) => {
      const step = node.tour.steps[node.stepNumber];
      const response = await vscode.window.showInputBox({
        prompt: `Enter the icon for this tour step`,
        value: step.icon || ""
      });

      if (typeof response === "undefined") {
        return;
      } else if (response) {
        step.icon = response;
      } else {
        delete step.icon;
      }

      saveTour(node.tour);
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.changeTourStepLine`,
    async (comment: CodeTourComment) => {
      const step = store.activeTour!.tour.steps[store.activeTour!.step];
      const response = await vscode.window.showInputBox({
        prompt: `Enter the new line # for this tour step (Leave blank to use the selection/document end)`,
        value: step.line?.toString() || ""
      });

      if (response) {
        step.line = Number(response);
      } else {
        delete step.line;
      }

      saveTour(store.activeTour!.tour);
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.changeTourRef`,
    async (node: CodeTourNode) => {
      const workspaceRoot =
        store.activeTour &&
        store.activeTour.tour.id === node.tour.id &&
        store.activeTour.workspaceRoot
          ? store.activeTour.workspaceRoot
          : workspace.getWorkspaceFolder(vscode.Uri.parse(node.tour.id))?.uri;

      if (!workspaceRoot) {
        return vscode.window.showErrorMessage(
          "You can't change the git ref of an embedded tour file."
        );
      }

      const ref = await promptForTourRef(workspaceRoot);
      if (ref) {
        if (ref === "HEAD") {
          delete node.tour.ref;
        } else {
          node.tour.ref = ref;
        }
      }

      saveTour(node.tour);
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.deleteTour`,
    async (node: CodeTourNode, additionalNodes: CodeTourNode[]) => {
      const messageSuffix = additionalNodes
        ? `${additionalNodes.length} selected tours`
        : `"${node.tour.title}" tour`;

      const buttonSuffix = additionalNodes
        ? `${additionalNodes.length} Tours`
        : "Tour";

      if (
        await vscode.window.showInformationMessage(
          `Are you sure your want to delete the ${messageSuffix}?`,
          `Delete ${buttonSuffix}`
        )
      ) {
        const tourIds = (additionalNodes || [node]).map(node => node.tour.id);

        if (store.activeTour && tourIds.includes(store.activeTour.tour.id)) {
          await endCurrentCodeTour();
        }

        tourIds.forEach(tourId => {
          const uri = vscode.Uri.parse(tourId);
          vscode.workspace.fs.delete(uri);
        });
      }
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.deleteTag`,
    async (
      node: CodeTourStepNode | CodeTourComment,
      additionalNodes: CodeTourStepNode[]
    ) => {
      let tour: CodeTour, steps: number[];
      let messageSuffix = "selected step";
      let buttonSuffix = "Step";

      // Code Jump Tags: a tree tag node carries a Lodestar tag id; route those to
      // the store (with confirm + recycle bin) instead of mutating the cache.
      if ((node as any)?.step?.id) {
        const { getStore } = await import("../lodestar/persistence");
        const { pruneCovered } = await import("../lodestar/selection");
        const { batchDeleteByIds } = await import("../lodestar/commands");
        const store = getStore();

        const idOf = (n: any): string | undefined =>
          n?.step?.id ?? (n?.tour?.id ? n.tour.id.split("::").pop() : undefined);

        const selected =
          additionalNodes && additionalNodes.length > 0 ? additionalNodes : [node];
        const ids = pruneCovered(
          store,
          selected.map(idOf).filter((x): x is string => !!x)
        );
        if (ids.length === 0) return;
        await batchDeleteByIds(store, ids);
        return;
      }

      if (node instanceof CodeTourStepNode) {
        tour = node.tour;

        if (additionalNodes) {
          buttonSuffix = `${additionalNodes.length} Steps`;
          messageSuffix = `${additionalNodes.length} selected steps`;

          steps = additionalNodes.map(n => n.stepNumber);
        } else {
          steps = [node.stepNumber];
        }
      } else {
        tour = store.activeTour!.tour;
        steps = [store.activeTour!.step];

        node.parent.dispose();
      }

      if (
        await vscode.window.showInformationMessage(
          `Are you sure your want to delete the ${messageSuffix}?`,
          `Delete ${buttonSuffix}`
        )
      ) {
        steps.forEach(step => tour.steps.splice(step, 1));

        if (store.activeTour && store.activeTour.tour.id === tour.id) {
          const previousSteps = steps.filter(
            step => step <= store.activeTour!.step
          );
          if (
            previousSteps.length > 0 &&
            (store.activeTour!.step > 0 || tour.steps.length === 0)
          ) {
            store.activeTour!.step -= previousSteps.length;
          }

          if (steps.includes(store.activeTour.step)) {
            // The only reason that a CodeTour content editor would be
            // open is because it was associated with the current step.
            // So detect if there are any, and if so, hide them.
            vscode.window.visibleTextEditors.forEach(editor => {
              if (editor.document.uri.scheme === FS_SCHEME_CONTENT) {
                editor.hide();
              }
            });
          }
        }

        saveTour(tour);
      }
    }
  );

  interface GitRefQuickPickItem extends vscode.QuickPickItem {
    ref?: string;
  }

  async function promptForTourRef(
    workspaceRoot: vscode.Uri
  ): Promise<string | undefined> {
    // If for some reason the Git extension isn't available,
    // then we won't be able to ask the user to select a git ref.
    if (!api || !api.getRepository) {
      return;
    }

    const repository = api.getRepository(workspaceRoot);

    // The opened project isn't a git repository, and
    // so there's no commit/tag/branch to associate the tour with.
    if (!repository) {
      return;
    }

    const currentBranch = repository.state.HEAD!.name;
    let items: GitRefQuickPickItem[] = [
      {
        label: "$(circle-slash) None",
        description:
          "Allow the tour to apply to all versions of this repository",
        ref: "HEAD",
        alwaysShow: true
      },
      {
        label: `$(git-branch) Current branch (${currentBranch})`,
        description: "Allow the tour to apply to all versions of this branch",
        ref: currentBranch,
        alwaysShow: true
      },
      {
        label: "$(git-commit) Current commit",
        description: "Keep the tour associated with a specific commit",
        ref: repository.state.HEAD ? repository.state.HEAD.commit! : "",
        alwaysShow: true
      }
    ];

    const tags = repository.state.refs
      .filter(ref => ref.type === RefType.Tag)
      .map(ref => ref.name!)
      .sort()
      .map(ref => ({
        label: `$(tag) ${ref}`,
        description: "Keep the tour associated with a specific tag",
        ref
      }));

    if (tags) {
      items.push(...tags);
    }

    const response = await vscode.window.showQuickPick<GitRefQuickPickItem>(
      items,
      {
        placeHolder: "Select the Git ref to associate the tour with:"
      }
    );

    if (response) {
      return response.ref;
    }
  }
}
