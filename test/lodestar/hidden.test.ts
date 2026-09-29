import { describe, it, expect } from "vitest";
import { folderToTour, treeToAllTours, treeToTours } from "../../src/lodestar/adapter";
import { isFolderHiddenDeep, setFolderHidden } from "../../src/lodestar/tree";
import { LodestarStore } from "../../src/lodestar/types";

function makeStore(): LodestarStore {
  return {
    version: 1,
    tree: [
      {
        type: "folder", id: "root", title: "链路",
        children: [
          { type: "tag", id: "t1", note: "a", file: "a.c", line: 1, createdAt: "x" },
          {
            type: "folder", id: "s1", title: "场景1",
            children: [
              { type: "tag", id: "t2", note: "b", file: "a.c", line: 2, createdAt: "x" },
              { type: "folder", id: "s1a", title: "细节", children: [] }
            ]
          }
        ]
      },
      { type: "folder", id: "other", title: "别的", children: [] }
    ]
  };
}

describe("按文件夹隐藏标记", () => {
  it("setFolderHidden 只改该文件夹自己的标志, 取消时删掉字段", () => {
    const store = makeStore();
    expect(setFolderHidden(store, "s1", true)).toBe(true);
    expect((store.tree[0] as any).children[1].hidden).toBe(true);
    expect((store.tree[0] as any).hidden).toBeUndefined();
    expect(setFolderHidden(store, "s1", false)).toBe(true);
    expect("hidden" in (store.tree[0] as any).children[1]).toBe(false);
  });

  it("setFolderHidden 对标签 / 不存在的 id 返回 false", () => {
    const store = makeStore();
    expect(setFolderHidden(store, "t1", true)).toBe(false);
    expect(setFolderHidden(store, "nope", true)).toBe(false);
  });

  it("隐藏沿树向下继承, 不影响兄弟文件夹", () => {
    const store = makeStore();
    setFolderHidden(store, "root", true);
    const byId = new Map(treeToAllTours(store, "ws").map(t => [t.id, t]));
    expect(byId.get("ws::root")).toMatchObject({ hidden: true, markersHidden: true });
    expect(byId.get("ws::s1")!.hidden).toBeUndefined();
    expect(byId.get("ws::s1")!.markersHidden).toBe(true);
    expect(byId.get("ws::s1a")!.markersHidden).toBe(true);
    expect(byId.get("ws::other")!.markersHidden).toBeUndefined();
    expect(isFolderHiddenDeep(store, "s1a")).toBe(true);
    expect(isFolderHiddenDeep(store, "other")).toBe(false);
  });

  it("只隐藏子文件夹时, 上级照常显示", () => {
    const store = makeStore();
    setFolderHidden(store, "s1", true);
    const byId = new Map(treeToAllTours(store, "ws").map(t => [t.id, t]));
    expect(byId.get("ws::root")!.markersHidden).toBeUndefined();
    expect(byId.get("ws::s1")!.markersHidden).toBe(true);
    expect(byId.get("ws::s1a")!.markersHidden).toBe(true);
    expect(treeToTours(store, "ws")[0].markersHidden).toBeUndefined();
  });

  it("隐藏文件夹的标签照样进派生 tour(行号跟随要用)", () => {
    const store = makeStore();
    setFolderHidden(store, "root", true);
    const all = treeToAllTours(store, "ws").flatMap(t => t.steps.map(s => s.id));
    expect(all).toEqual(["t1", "t2"]);
  });

  it("folderToTour 的 parentHidden 让子文件夹显示为随上级隐藏", () => {
    const store = makeStore();
    const s1 = (store.tree[0] as any).children[1];
    const tour = folderToTour(s1, "ws", { parentHidden: true });
    expect(tour.hidden).toBeUndefined();
    expect(tour.markersHidden).toBe(true);
  });
});
