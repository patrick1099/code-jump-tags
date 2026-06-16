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
  return step;
}

function folderToTour(folder: FolderNode, workspaceId: string): CodeTour {
  return {
    id: `${workspaceId}::${folder.id}`,
    title: folder.title,
    steps: folder.children
      .filter((c): c is TagNode => c.type === "tag")
      .map(tagToStep)
  };
}

// One-way: build the derived CodeTour[] cache from the on-disk tree.
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
