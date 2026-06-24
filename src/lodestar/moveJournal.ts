// 会话级标签移动撤回栈(纯逻辑,不 import vscode)。一条记录一次显式移动:
// from=移动前锚, to=移动后锚。撤回把标签放回 from,恢复(redo)放回 to。
// 仅在内存、随插件生命周期,不持久化。

export type Anchor = {
  file: string;
  line: number; // 1-based
  text?: string;
  pattern?: string;
};

export type MoveEntry = {
  tagId: string;
  from: Anchor;
  to: Anchor;
};

export type MoveJournal = {
  undo: MoveEntry[]; // newest last
  redo: MoveEntry[]; // newest last
};

export const UNDO_CAP = 20; // 「最近几步」上限,溢出丢最旧

export function createJournal(): MoveJournal {
  return { undo: [], redo: [] };
}

// 记一次新移动:压 undo、截断到 UNDO_CAP、清空 redo(新动作作废重做历史)。
export function recordMove(j: MoveJournal, entry: MoveEntry): void {
  j.undo.push(entry);
  if (j.undo.length > UNDO_CAP) {
    j.undo.shift();
  }
  j.redo = [];
}

// 弹出 undo 栈顶(不自动压 redo;由命令层按 apply 结果决定去向)。
export function popUndo(j: MoveJournal): MoveEntry | undefined {
  return j.undo.pop();
}

// 弹出 redo 栈顶。
export function popRedo(j: MoveJournal): MoveEntry | undefined {
  return j.redo.pop();
}

// 从 undo 栈从后往前移除第一条 tagId 匹配的并返回(per-tag 撤回用)。
export function removeUndoForTag(
  j: MoveJournal,
  tagId: string
): MoveEntry | undefined {
  for (let i = j.undo.length - 1; i >= 0; i--) {
    if (j.undo[i].tagId === tagId) {
      return j.undo.splice(i, 1)[0];
    }
  }
  return undefined;
}

// 压回 undo 栈顶(撤回成功后把 redo 来的压回,或占用失败回滚)。带 CAP 截断。
export function pushUndo(j: MoveJournal, entry: MoveEntry): void {
  j.undo.push(entry);
  if (j.undo.length > UNDO_CAP) {
    j.undo.shift();
  }
}

// 压回 redo 栈顶。
export function pushRedo(j: MoveJournal, entry: MoveEntry): void {
  j.redo.push(entry);
}
