import { describe, it, expect } from "vitest";
import {
  createJournal,
  recordMove,
  popUndo,
  popRedo,
  removeUndoForTag,
  pushUndo,
  pushRedo,
  UNDO_CAP,
  MoveEntry
} from "../../src/lodestar/moveJournal";

function entry(tagId: string, fromLine = 1, toLine = 2): MoveEntry {
  return {
    tagId,
    from: { file: "a.c", line: fromLine },
    to: { file: "a.c", line: toLine }
  };
}

describe("moveJournal", () => {
  it("recordMove pushes onto undo and clears redo", () => {
    const j = createJournal();
    j.redo.push(entry("old"));
    recordMove(j, entry("1"));
    expect(j.undo.map(e => e.tagId)).toEqual(["1"]);
    expect(j.redo).toEqual([]);
  });

  it("recordMove caps undo at UNDO_CAP, dropping the oldest", () => {
    const j = createJournal();
    for (let i = 0; i < UNDO_CAP + 3; i++) {
      recordMove(j, entry(String(i)));
    }
    expect(j.undo.length).toBe(UNDO_CAP);
    expect(j.undo[0].tagId).toBe("3");
    expect(j.undo[j.undo.length - 1].tagId).toBe(String(UNDO_CAP + 2));
  });

  it("popUndo returns the newest and removes it without touching redo", () => {
    const j = createJournal();
    recordMove(j, entry("1"));
    recordMove(j, entry("2"));
    const e = popUndo(j);
    expect(e!.tagId).toBe("2");
    expect(j.undo.map(x => x.tagId)).toEqual(["1"]);
    expect(j.redo).toEqual([]);
  });

  it("popUndo on an empty undo stack returns undefined", () => {
    expect(popUndo(createJournal())).toBeUndefined();
  });

  it("popRedo returns the newest redo entry", () => {
    const j = createJournal();
    pushRedo(j, entry("9"));
    expect(popRedo(j)!.tagId).toBe("9");
    expect(j.redo).toEqual([]);
  });

  it("removeUndoForTag pulls the newest matching entry from the middle, keeping order", () => {
    const j = createJournal();
    recordMove(j, entry("a"));
    recordMove(j, entry("b"));
    recordMove(j, entry("a"));
    recordMove(j, entry("c"));
    const e = removeUndoForTag(j, "a");
    expect(e!.tagId).toBe("a");
    expect(j.undo.map(x => x.tagId)).toEqual(["a", "b", "c"]);
  });

  it("removeUndoForTag returns undefined when nothing matches", () => {
    const j = createJournal();
    recordMove(j, entry("a"));
    expect(removeUndoForTag(j, "zzz")).toBeUndefined();
    expect(j.undo.map(x => x.tagId)).toEqual(["a"]);
  });

  it("pop + push round-trip moves an entry undo->redo->undo cleanly", () => {
    const j = createJournal();
    recordMove(j, entry("1"));
    const e = popUndo(j)!;
    pushRedo(j, e);
    expect(j.undo).toEqual([]);
    expect(j.redo.map(x => x.tagId)).toEqual(["1"]);
    const e2 = popRedo(j)!;
    pushUndo(j, e2);
    expect(j.redo).toEqual([]);
    expect(j.undo.map(x => x.tagId)).toEqual(["1"]);
  });

  it("pushUndo caps at UNDO_CAP", () => {
    const j = createJournal();
    for (let i = 0; i < UNDO_CAP; i++) {
      recordMove(j, entry(String(i)));
    }
    pushUndo(j, entry("extra"));
    expect(j.undo.length).toBe(UNDO_CAP);
    expect(j.undo[j.undo.length - 1].tagId).toBe("extra");
  });
});
