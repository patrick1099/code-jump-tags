import { describe, it, expect } from "vitest";
import {
  treeToTours,
  treeToAllTours,
  LOOSE_TOUR_ID,
  LOOSE_TITLE
} from "../../src/lodestar/adapter";
import { LodestarStore } from "../../src/lodestar/types";

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
  it("maps folders to tours and loose tags to a synthetic tour", () => {
    const tours = treeToTours(store, "ws");
    // loose tour first
    expect(tours[0].id).toBe("ws::" + LOOSE_TOUR_ID);
    expect(tours[0].title).toBe(LOOSE_TITLE);
    expect(tours[0].steps).toHaveLength(1);
    expect(tours[0].steps[0]).toMatchObject({ id: "t0", description: "loose one", file: "a.c", line: 3 });
    // folder tour
    expect(tours[1].id).toBe("ws::f1");
    expect(tours[1].title).toBe("通信");
    expect(tours[1].steps[0]).toMatchObject({ id: "t1", description: "上报入口\n更多", file: "b.c", line: 10, pattern: "case X:" });
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

  it("treeToAllTours flattens tags from EVERY nesting depth (decoration source)", () => {
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
    expect(allIds).toEqual(["t0", "t1", "t2"]);
  });
});
