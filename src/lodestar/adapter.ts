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
// TOP-LEVEL folders become tours here (plus the loose "(未分组)" group). This
// feeds the tree roots and the tour pickers, which must not surface a nested
// sub-folder as a top-level playable tour. Sub-folders are rendered by the tree
// provider's recursive getChildren, and their tags are decorated via
// treeToAllTours below.
export function treeToTours(store: LodestarStore, workspaceId: string): CodeTour[] {
  const looseTags = store.tree.filter((n): n is TagNode => n.type === "tag");
  const folders = store.tree.filter((n): n is FolderNode => n.type === "folder");

  const tours: CodeTour[] = [];
  if (looseTags.length > 0) {
    tours.push({
      id: `${workspaceId}::${LOOSE_TOUR_ID}`,
      title: LOOSE_TITLE,
      steps: looseTags.map(tagToStep)
    });
  }
  tours.push(...folders.map(f => folderToTour(f, workspaceId)));
  return tours;
}

// Every folder at ANY depth becomes its own tour (holding that folder's direct
// tags), plus the loose top-level "(未分组)" group. The union covers every tag
// in the tree regardless of nesting, so editor decorations / CodeLenses mark
// tags inside sub-folders too. Used only as the decoration source — never as
// tree roots or pickable tours.
export function treeToAllTours(
  store: LodestarStore,
  workspaceId: string
): CodeTour[] {
  const tours: CodeTour[] = [];

  const looseTags = store.tree.filter((n): n is TagNode => n.type === "tag");
  if (looseTags.length > 0) {
    tours.push({
      id: `${workspaceId}::${LOOSE_TOUR_ID}`,
      title: LOOSE_TITLE,
      steps: looseTags.map(tagToStep)
    });
  }

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
