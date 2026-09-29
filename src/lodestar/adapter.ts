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
  if (tag.text) step.text = tag.text;
  if (tag.original) step.original = tag.original;
  if (tag.notePosition) step.notePosition = tag.notePosition;
  if (tag.createdAt) step.createdAt = tag.createdAt;
  // 随手私记的标记要一路传到装饰层：它只画行尾小字，不画 gutter 的 ⌖，也不画失配的 ?。
  if (tag.inline) step.inline = true;
  return step;
}

export function folderToTour(
  folder: FolderNode,
  workspaceId: string,
  opts: { includeInline?: boolean; parentHidden?: boolean } = {}
): CodeTour {
  const includeInline = opts.includeInline !== false; // 默认含
  const tour: CodeTour = {
    id: `${workspaceId}::${folder.id}`,
    title: folder.title,
    steps: folder.children
      .filter((c): c is TagNode => c.type === "tag")
      .filter(t => includeInline || !t.inline)
      .map(tagToStep)
  };
  if (folder.hidden) tour.hidden = true;
  if (folder.hidden || opts.parentHidden) tour.markersHidden = true;
  return tour;
}

// 深度优先顺读:把文件夹整棵子树(含所有层级子文件夹)的正式标签收进一条 tour,
// 按树的自然顺序(同一层 children 数组的先后)。inline 随手私记被跳过 —— 顺读只
// 关心要逐步讲解的正式标签。id/title 沿用 folderToTour 的格式,方便树上任意一层
// 文件夹直接播放。
export function folderToDeepTour(
  folder: FolderNode,
  workspaceId: string
): CodeTour {
  const steps: CodeTourStep[] = [];
  const walk = (node: FolderNode): void => {
    for (const child of node.children) {
      if (child.type === "tag") {
        if (child.inline !== true) steps.push(tagToStep(child));
      } else {
        walk(child);
      }
    }
  };
  walk(folder);
  return {
    id: `${workspaceId}::${folder.id}`,
    title: folder.title,
    steps
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
  return folders.map(f => folderToTour(f, workspaceId, { includeInline: false }));
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

  // 隐藏沿树向下继承:上级隐藏了,子文件夹自己没标也算隐藏。
  function walk(nodes: (FolderNode | TagNode)[], parentHidden: boolean): void {
    for (const node of nodes) {
      if (node.type === "folder") {
        tours.push(folderToTour(node, workspaceId, { parentHidden }));
        walk(
          node.children as (FolderNode | TagNode)[],
          parentHidden || node.hidden === true
        );
      }
    }
  }
  walk(store.tree as (FolderNode | TagNode)[], false);

  return tours;
}

export const SUSPECT_TOUR_ID = "__suspect__";

// Read-only "待处理" filter view: a synthetic tour gathering the suspect tags
// (by id, in tree order). Tags still live in their real folders; this only
// mirrors them for one-shot triage.
// 随手私记不进这里：它们是行尾的一次性便条，不是要 triage 的正式标签。放进来会让
// 侧边栏在任何一次失配抖动时被随手私记灌满 —— 用户明确要求随手绝不出现在侧边栏。
export function suspectTour(
  store: LodestarStore,
  workspaceId: string,
  suspectIds: string[]
): CodeTour {
  const want = new Set(suspectIds);
  const tags: TagNode[] = [];
  const walk = (nodes: (FolderNode | TagNode)[]): void => {
    for (const node of nodes) {
      if (node.type === "tag") {
        if (want.has(node.id) && node.inline !== true) tags.push(node);
      } else {
        walk(node.children as (FolderNode | TagNode)[]);
      }
    }
  };
  walk(store.tree as (FolderNode | TagNode)[]);
  return {
    id: `${workspaceId}::${SUSPECT_TOUR_ID}`,
    title: `⚠ 待处理 (${tags.length})`,
    steps: tags.map(tagToStep)
  };
}

export const INLINE_TOUR_ID = "__inline__";

// Read-only "随手" summary view: a synthetic tour gathering every inline tag
// (node.inline === true) found anywhere in the tree, in tree order. Tags still
// live wherever they were created (inbox or otherwise); this only mirrors them
// for one-shot triage/promotion.
export function inlineTour(store: LodestarStore, workspaceId: string): CodeTour {
  const tags: TagNode[] = [];
  const walk = (nodes: (FolderNode | TagNode)[]): void => {
    for (const node of nodes) {
      if (node.type === "tag") {
        if (node.inline === true) tags.push(node);
      } else {
        walk(node.children as (FolderNode | TagNode)[]);
      }
    }
  };
  walk(store.tree as (FolderNode | TagNode)[]);
  return {
    id: `${workspaceId}::${INLINE_TOUR_ID}`,
    title: `💬 随手 (${tags.length})`,
    steps: tags.map(tagToStep)
  };
}
