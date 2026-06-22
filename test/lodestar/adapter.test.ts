import { describe, it, expect } from "vitest";
import {
  treeToTours,
  treeToAllTours,
  LOOSE_TOUR_ID,
  LOOSE_TITLE,
  folderToTour
} from "../../src/lodestar/adapter";
import { LodestarStore, FolderNode } from "../../src/lodestar/types";
import { createEmptyStore } from "../../src/lodestar/tree";

const store: LodestarStore = {
  version: 1,
  tree: [
    { type: "tag", id: "t0", note: "loose one", file: "a.c", line: 3, createdAt: "x" },
    {
      type: "folder", id: "f1", title: "通信",
      children: [
        { type: "tag", id: "t1", note: "上报入口\n更多", file: "b.c", line: 10, pattern: "case X:", createdAt: "x" }
      ]
    }
  ]
};

describe("treeToTours", () => {
  it("maps only top-level folders to tours; root-level loose tags are ignored", () => {
    const tours = treeToTours(store, "ws");
    // only the folder tour — no synthetic loose group
    expect(tours).toHaveLength(1);
    expect(tours[0].id).toBe("ws::f1");
    expect(tours[0].title).toBe("通信");
    expect(tours[0].steps[0]).toMatchObject({ id: "t1", description: "上报入口\n更多", file: "b.c", line: 10, pattern: "case X:" });
    // LOOSE_TOUR_ID / LOOSE_TITLE constants still exported but no longer used for synthesis
    expect(tours.some(t => t.id.endsWith(LOOSE_TOUR_ID))).toBe(false);
    expect(tours.some(t => t.title === LOOSE_TITLE)).toBe(false);
  });

  it("omits the loose tour when there are no loose tags", () => {
    const onlyFolder: LodestarStore = { version: 1, tree: [store.tree[1]] };
    const tours = treeToTours(onlyFolder, "ws");
    expect(tours.map(t => t.title)).toEqual(["通信"]);
  });

  it("treeToTours keeps a nested sub-folder OUT of the top-level list", () => {
    const nested: LodestarStore = {
      version: 1,
      tree: [
        {
          type: "folder", id: "f1", title: "外层",
          children: [
            { type: "tag", id: "t1", note: "外层标签", file: "a.c", line: 1, createdAt: "x" },
            {
              type: "folder", id: "f2", title: "内层",
              children: [
                { type: "tag", id: "t2", note: "内层标签", file: "b.c", line: 2, createdAt: "x" }
              ]
            }
          ]
        }
      ]
    };
    const tours = treeToTours(nested, "ws");
    // only the top-level folder is a tour; the sub-folder is not
    expect(tours.map(t => t.id)).toEqual(["ws::f1"]);
    // and the top-level tour shows only its DIRECT tag (not the nested one)
    expect(tours[0].steps.map(s => s.id)).toEqual(["t1"]);
  });

  it("treeToAllTours flattens tags from EVERY folder depth (decoration source); root-level loose tags excluded", () => {
    const nested: LodestarStore = {
      version: 1,
      tree: [
        { type: "tag", id: "t0", note: "根松散", file: "a.c", line: 1, createdAt: "x" },
        {
          type: "folder", id: "f1", title: "外层",
          children: [
            { type: "tag", id: "t1", note: "外层标签", file: "a.c", line: 2, createdAt: "x" },
            {
              type: "folder", id: "f2", title: "内层",
              children: [
                { type: "tag", id: "t2", note: "内层标签", file: "b.c", line: 3, createdAt: "x" }
              ]
            }
          ]
        }
      ]
    };
    const allIds = treeToAllTours(nested, "ws")
      .flatMap(t => t.steps.map(s => s.id))
      .sort();
    // t0 is a root-level loose tag — no longer surfaced by treeToAllTours
    expect(allIds).toEqual(["t1", "t2"]);
  });
});

describe("tagToStep text passthrough", () => {
  it("copies tag.text onto the derived step", () => {
    const folder: FolderNode = {
      type: "folder",
      id: "f1",
      title: "F",
      children: [
        { type: "tag", id: "t1", note: "n", file: "a.c", line: 2, text: "foo();", createdAt: "x" }
      ]
    };
    const tour = folderToTour(folder, "ws");
    expect(tour.steps[0].text).toBe("foo();");
  });
});

describe("no synthetic loose group", () => {
  it("treeToTours ignores root-level loose tags (emits only folder tours)", () => {
    const s = createEmptyStore();
    s.tree.push({ type: "tag", id: "t1", note: "n", file: "a.c", line: 1, createdAt: "t" });
    s.tree.push({ type: "folder", id: "f1", title: "通信", children: [] });
    const tours = treeToTours(s, "ws");
    expect(tours).toHaveLength(1);
    expect(tours[0].id).toBe("ws::f1");
    expect(tours.some(t => t.id.endsWith("__loose__"))).toBe(false);
    expect(tours.some(t => t.title === "(未分组)")).toBe(false);
  });

  it("treeToAllTours emits no loose group", () => {
    const s = createEmptyStore();
    s.tree.push({ type: "tag", id: "t1", note: "n", file: "a.c", line: 1, createdAt: "t" });
    const all = treeToAllTours(s, "ws");
    expect(all.some(t => t.id.endsWith("__loose__"))).toBe(false);
  });
});
