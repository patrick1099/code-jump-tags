import { describe, it, expect } from "vitest";
import { treeToTours, LOOSE_TOUR_ID, LOOSE_TITLE } from "../../src/lodestar/adapter";
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
});
