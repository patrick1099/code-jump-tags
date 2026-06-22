import type { CodeTour, CodeTourStep } from "../store";
import { FolderNode, LodestarStore, TagNode } from "./types";

export const LOOSE_TOUR_ID = "__loose__";
export const LOOSE_TITLE = "(未分组)";

function tagToStep(tag: TagNode): CodeTourStep {
  const step: CodeTourStep = {
    id: tag.id,
    description: tag.note,
    file: tag.file,
    line: tag.line
  };
  if (tag.pattern) step.pattern = tag.pattern;
  if (tag.notePosition) step.notePosition = tag.notePosition;
  return step;
}

export function folderToTour(folder: FolderNode, workspaceId: string): CodeTour {
  return {
    id: `${workspaceId}::${folder.id}`,
    title: folder.title,
    steps: folder.children
      .filter((c): c is TagNode => c.type === "tag")
      .map(tagToStep)
  };
}

// One-way: build the derived CodeTour[] cache from the on-disk tree. Only the
// TOP-LEVEL folders become tours here. Root-level loose tags are ignored —
// migration wraps them into a real inbox folder. This feeds the tree roots and
// the tour pickers, which must not surface a nested sub-folder as a top-level
// playable tour. Sub-folders are rendered by the tree provider's recursive
// getChildren, and their tags are decorated via treeToAllTours below.
export function treeToTours(store: LodestarStore, workspaceId: string): CodeTour[] {
  const folders = store.tree.filter((n): n is FolderNode => n.type === "folder");
  return folders.map(f => folderToTour(f, workspaceId));
}

// Every folder at ANY depth becomes its own tour (holding that folder's direct
// tags). Root-level loose tags are ignored — the inbox folder holds them after
// migration. The union of folder tours covers every tag reachable from a folder,
// so editor decorations / CodeLenses mark tags inside sub-folders too. Used only
// as the decoration source — never as tree roots or pickable tours.
export function treeToAllTours(
  store: LodestarStore,
  workspaceId: string
): CodeTour[] {
  const tours: CodeTour[] = [];

  function walk(nodes: (FolderNode | TagNode)[]): void {
    for (const node of nodes) {
      if (node.type === "folder") {
        tours.push(folderToTour(node, workspaceId));
        walk(node.children as (FolderNode | TagNode)[]);
      }
    }
  }
  walk(store.tree as (FolderNode | TagNode)[]);

  return tours;
}
