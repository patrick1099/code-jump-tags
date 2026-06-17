// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { reaction } from "mobx";
import {
  DataTransfer,
  DataTransferItem,
  Disposable,
  Event,
  EventEmitter,
  MarkdownString,
  TreeDataProvider,
  TreeDragAndDropController,
  TreeItem,
  window
} from "vscode";
import { AMBIENT_TOUR_ID, EXTENSION_NAME } from "../../constants";
import { generatePreviewContent } from "..";
import { store } from "../../store";
import { CodeTourNode, CodeTourStepNode } from "./nodes";

const LODESTAR_MIME = "application/vnd.code.tree.codeJumpTags";

class CodeTourTreeProvider
  implements
    TreeDataProvider<TreeItem>,
    TreeDragAndDropController<TreeItem>,
    Disposable {
  private _disposables: Disposable[] = [];

  dropMimeTypes = [LODESTAR_MIME];
  dragMimeTypes = [LODESTAR_MIME];

  async handleDrag(
    source: TreeItem[],
    data: DataTransfer
  ): Promise<void> {
    const ids = source
      .map(s => (s instanceof CodeTourStepNode ? s.step?.id : undefined))
      .filter(Boolean);
    data.set(LODESTAR_MIME, new DataTransferItem(ids));
  }

  async handleDrop(
    target: TreeItem | undefined,
    data: DataTransfer
  ): Promise<void> {
    const item = data.get(LODESTAR_MIME);
    if (!item) return;
    const ids: string[] = item.value;
    const { getStore, saveStore } = await import("../../lodestar/persistence");
    const { moveNode, findNode } = await import("../../lodestar/tree");
    const store = getStore();

    let toParentId: string | null = null;
    let index = Number.MAX_SAFE_INTEGER;
    if (target instanceof CodeTourNode) {
      const folderId = target.tour.id.split("::").pop()!;
      toParentId = folderId === "__loose__" ? null : folderId;
    } else if (target instanceof CodeTourStepNode && target.step?.id) {
      const found = findNode(store, target.step.id);
      if (found) {
        toParentId = found.parent ? found.parent.id : null;
        index = found.index;
      }
    }
    for (const id of ids) moveNode(store, id, toParentId, index);
    await saveStore();
  }

  private _onDidChangeTreeData = new EventEmitter<TreeItem | undefined>();
  public readonly onDidChangeTreeData: Event<TreeItem | undefined> = this
    ._onDidChangeTreeData.event;

  constructor(private extensionPath: string) {
    reaction(
      () => [
        store.tours,
        store.hasTours,
        store.isRecording,
        store.progress.map(([id, completedSteps]) => [
          id,
          completedSteps.map(step => step)
        ]),
        store.activeTour
          ? [
              store.activeTour.tour.title,
              store.activeTour.tour.description,
              store.activeTour.tour.steps.map(step => [
                step.title,
                step.markerTitle,
                step.description
              ])
            ]
          : null
      ],
      () => {
        this._onDidChangeTreeData.fire(undefined);
      }
    );
  }

  getTreeItem = (node: TreeItem) => node;

  async getChildren(element?: TreeItem): Promise<TreeItem[] | undefined> {
    if (!element) {
      if (!store.hasTours && !store.activeTour) {
        return undefined;
      } else {
        const tours = store.tours.map(
          tour => new CodeTourNode(tour, this.extensionPath)
        );

        if (
          store.activeTour &&
          store.activeTour.tour.id !== AMBIENT_TOUR_ID &&
          !store.tours.find(tour => tour.id === store.activeTour?.tour.id)
        ) {
          tours.unshift(
            new CodeTourNode(store.activeTour.tour, this.extensionPath)
          );
        }

        return tours;
      }
    } else if (element instanceof CodeTourNode) {
      // Code Jump Tags: a folder expands to its nested sub-folders first, then
      // its own direct tags as step nodes. Sub-folders come from the raw tree;
      // each is wrapped in a CodeTourNode whose derived tour holds that folder's
      // direct tags (so it expands the same way, to any depth).
      const subfolderNodes = await this.subfolderNodesOf(element);

      let stepNodes: TreeItem[];
      if (element.tour.steps.length === 0) {
        if (subfolderNodes.length > 0) {
          // Folder holds only sub-folders — no "No steps recorded" placeholder.
          stepNodes = [];
        } else if (
          store.isRecording &&
          store.activeTour?.tour.id == element.tour.id
        ) {
          const item = new TreeItem("Add tour step...");
          item.command = {
            command: "codeJumpTags.addContentStep",
            title: "Add tour step..."
          };
          stepNodes = [item];
        } else {
          stepNodes = [new TreeItem("No steps recorded")];
        }
      } else {
        stepNodes = element.tour.steps.map(
          (_, index) => new CodeTourStepNode(element.tour, index)
        );
      }

      return [...subfolderNodes, ...stepNodes];
    }
  }

  // Build CodeTourNodes for the direct sub-folders of the folder behind `node`.
  // Returns [] for the synthetic "(未分组)" group or any leaf folder. Uses
  // dynamic imports to avoid a load-time cycle with the lodestar layer.
  private async subfolderNodesOf(node: CodeTourNode): Promise<TreeItem[]> {
    const folderId = node.tour.id.split("::").pop();
    if (!folderId || folderId === "__loose__") return [];
    const { getStore, getWorkspaceId } = await import(
      "../../lodestar/persistence"
    );
    const { findNode } = await import("../../lodestar/tree");
    const { folderToTour } = await import("../../lodestar/adapter");
    const found = findNode(getStore(), folderId);
    if (!found || found.node.type !== "folder") return [];
    const wsId = getWorkspaceId();
    return found.node.children
      .filter((c): c is typeof c & { type: "folder" } => c.type === "folder")
      .map(
        child => new CodeTourNode(folderToTour(child, wsId), this.extensionPath)
      );
  }

  async getParent(element: TreeItem): Promise<TreeItem | null> {
    if (element instanceof CodeTourStepNode) {
      return new CodeTourNode(element.tour, this.extensionPath);
    }
    // A sub-folder's parent is the folder that contains it (null at the root),
    // so reveal can expand the chain for nested tags.
    if (element instanceof CodeTourNode) {
      const folderId = element.tour.id.split("::").pop();
      if (folderId && folderId !== "__loose__") {
        const { getStore, getWorkspaceId } = await import(
          "../../lodestar/persistence"
        );
        const { findNode } = await import("../../lodestar/tree");
        const { folderToTour } = await import("../../lodestar/adapter");
        const found = findNode(getStore(), folderId);
        if (found && found.parent) {
          return new CodeTourNode(
            folderToTour(found.parent, getWorkspaceId()),
            this.extensionPath
          );
        }
      }
    }
    return null;
  }

  // This is called whenever a tree item is hovered over, and we're
  // using it to generate preview tooltips for tour steps on-demand.
  async resolveTreeItem(element: TreeItem): Promise<TreeItem> {
    if (element instanceof CodeTourStepNode) {
      const content = generatePreviewContent(
        element.tour.steps[element.stepNumber].description
      );

      const tooltip = new MarkdownString(content);
      tooltip.isTrusted = true;

      // @ts-ignore
      element.tooltip = tooltip;
    }

    return element;
  }

  dispose() {
    this._disposables.forEach(disposable => disposable.dispose());
  }
}

export function registerTreeProvider(extensionPath: string) {
  const treeDataProvider = new CodeTourTreeProvider(extensionPath);
  const treeView = window.createTreeView(`${EXTENSION_NAME}.tags`, {
    showCollapseAll: true,
    treeDataProvider,
    canSelectMany: true,
    dragAndDropController: treeDataProvider
  });

  let isRevealPending = false;
  treeView.onDidChangeVisibility(e => {
    if (e.visible && isRevealPending) {
      isRevealPending = false;
      revealCurrentStepNode();
    }
  });

  function revealCurrentStepNode() {
    setTimeout(() => {
      treeView.reveal(
        new CodeTourStepNode(store.activeTour!.tour, store.activeTour!.step)
      );
    }, 300);
  }

  reaction(
    () => [
      store.activeTour
        ? [
            store.activeTour.tour.title,
            store.activeTour.tour.steps.map(step => [step.title]),
            store.activeTour.step
          ]
        : null
    ],
    () => {
      if (store.activeTour && store.activeTour.step >= 0) {
        if (
          !treeView.visible ||
          store.activeTour.tour.steps[store.activeTour.step].view
        ) {
          isRevealPending = true;
          return;
        }

        revealCurrentStepNode();
      } else {
        // TODO: Once VS Code supports it, we want
        // to de-select the step node once the tour ends.
        treeView.message = undefined;
      }
    }
  );
}
