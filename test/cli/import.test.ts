import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CliError,
  ImportEntry,
  clearFolder,
  importEntries,
  listTags,
  setFolderHiddenByPath
} from "../../src/cli/import";

// 每个测试都在独立 tmpdir 里造工作区根，直接调 importEntries（root 注入），
// 不依赖真实工作区。

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cjtag-test-"));
}

function writeFile(root: string, rel: string, content: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

function readStore(root: string): any {
  const raw = fs.readFileSync(
    path.join(root, ".code-jump-tags", "store.json"),
    "utf8"
  );
  return JSON.parse(raw);
}

function collectTagIds(node: any): string[] {
  if (node.type === "tag") return [node.id];
  return node.children.flatMap((c: any) => collectTagIds(c));
}

// "// 初始化时钟\nint main(void) {}\n" 的 GBK 字节（第 1 行含中文注释）。
const GBK_BYTES = Buffer.from([
  47, 47, 32, 179, 245, 202, 188, 187, 175, 202, 177, 214, 211, 10,
  105, 110, 116, 32, 109, 97, 105, 110, 40, 118, 111, 105, 100, 41, 32, 123, 125, 10
]);

describe("importEntries: folder 逐级创建", () => {
  it("按 / 分层逐级建文件夹, 同文件夹多条标签按顺序进 children", () => {
    const root = makeRoot();
    writeFile(root, "a.c", "l1\nl2\nl3\n");
    const res = importEntries(root, [
      { folder: "第1章 上电/1.1 时钟", file: "a.c", line: 1, note: "n1" },
      { folder: "第1章 上电/1.1 时钟", file: "a.c", line: 2, note: "n2" }
    ]);
    expect(res.added).toBe(2);
    expect(res.folders_created).toEqual(["第1章 上电", "第1章 上电/1.1 时钟"]);
    const store = readStore(root);
    expect(store.tree).toHaveLength(1);
    const ch1 = store.tree[0];
    expect(ch1.type).toBe("folder");
    expect(ch1.title).toBe("第1章 上电");
    const ch11 = ch1.children[0];
    expect(ch11.title).toBe("1.1 时钟");
    expect(ch11.children.map((t: any) => t.note)).toEqual(["n1", "n2"]);
  });
});

describe("importEntries: 同名 folder 复用", () => {
  it("已存在的同名层级被复用, 不重复创建, 不产生新的 created 路径", () => {
    const root = makeRoot();
    writeFile(root, "a.c", "l1\nl2\n");
    importEntries(root, [{ folder: "A/B", file: "a.c", line: 1, note: "x" }]);
    const res = importEntries(root, [{ folder: "A/B", file: "a.c", line: 2, note: "y" }]);
    expect(res.added).toBe(1);
    expect(res.folders_created).toEqual([]);
    const store = readStore(root);
    expect(store.tree).toHaveLength(1);
    expect(store.tree[0].title).toBe("A");
    expect(store.tree[0].children).toHaveLength(1);
    expect(store.tree[0].children[0].title).toBe("B");
    expect(store.tree[0].children[0].children).toHaveLength(2);
  });
});

describe("importEntries: 收件箱", () => {
  it("folder 省略时进「未分组」收件箱", () => {
    const root = makeRoot();
    writeFile(root, "a.c", "l1\n");
    const res = importEntries(root, [{ file: "a.c", line: 1, note: "x" }]);
    expect(res.folders_created).toEqual(["未分组"]);
    const store = readStore(root);
    expect(store.tree[0].title).toBe("未分组");
    expect(store.tree[0].inbox).toBe(true);
    expect(store.tree[0].children).toHaveLength(1);
  });

  it("folder 为 null / 空串也进同一个收件箱", () => {
    const root = makeRoot();
    writeFile(root, "a.c", "l1\nl2\n");
    importEntries(root, [
      { folder: null as any, file: "a.c", line: 1, note: "a" },
      { folder: "", file: "a.c", line: 2, note: "b" }
    ]);
    const store = readStore(root);
    expect(store.tree).toHaveLength(1);
    expect(store.tree[0].inbox).toBe(true);
    expect(store.tree[0].children).toHaveLength(2);
  });
});

describe("importEntries: 锚点从真实文件读出", () => {
  it("text / original / pattern 用第 line 行 trim 后的内容计算", () => {
    const root = makeRoot();
    writeFile(root, "a.c", "  int x = 1;\n  foo();\n");
    importEntries(root, [{ folder: "F", file: "a.c", line: 2, note: "call" }]);
    const store = readStore(root);
    const tag = store.tree[0].children[0];
    expect(tag.text).toBe("foo();");
    expect(tag.original).toBe("foo();");
    expect(tag.pattern).toBe("^[^\\S\\n]*foo\\(\\);");
    expect(tag.file).toBe("a.c");
    expect(tag.line).toBe(2);
    expect(tag.note).toBe("call");
    expect(typeof tag.id).toBe("string");
    expect(typeof tag.createdAt).toBe("string");
  });

  it("显式给 text 时直接用, 不再从文件行取", () => {
    const root = makeRoot();
    writeFile(root, "a.c", "a\nb\n");
    importEntries(root, [{ folder: "F", file: "a.c", line: 2, note: "x", text: "  b();  " }]);
    const store = readStore(root);
    const tag = store.tree[0].children[0];
    expect(tag.text).toBe("b();");
    expect(tag.pattern).toBe("^[^\\S\\n]*b\\(\\);");
  });
});

describe("importEntries: GBK 编码文件", () => {
  it("GB2312 中文行能正确解码出锚点", () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, "gbk.c"), GBK_BYTES);
    importEntries(root, [{ folder: "F", file: "gbk.c", line: 1, note: "中文注释" }]);
    const store = readStore(root);
    const tag = store.tree[0].children[0];
    expect(tag.text).toBe("// 初始化时钟");
    expect(tag.pattern).toBe("^[^\\S\\n]*// 初始化时钟");
  });
});

describe("importEntries: 整批校验", () => {
  it("line 越界被拒, 整批不写入(store 文件不产生)", () => {
    const root = makeRoot();
    writeFile(root, "a.c", "l1\nl2\nl3\n");
    let err: any;
    try {
      importEntries(root, [
        { folder: "F", file: "a.c", line: 1, note: "ok" },
        { folder: "F", file: "a.c", line: 99, note: "bad" }
      ]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe("E_VALIDATION");
    expect(err.details.index).toBe(1);
    expect(err.details.field).toBe("line");
    expect(
      fs.existsSync(path.join(root, ".code-jump-tags", "store.json"))
    ).toBe(false);
  });

  it("note 为空被拒", () => {
    const root = makeRoot();
    writeFile(root, "a.c", "l1\n");
    let err: any;
    try {
      importEntries(root, [{ folder: "F", file: "a.c", line: 1, note: "   " }]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe("E_VALIDATION");
    expect(err.details.field).toBe("note");
    expect(
      fs.existsSync(path.join(root, ".code-jump-tags", "store.json"))
    ).toBe(false);
  });
});

describe("importEntries: id 唯一性", () => {
  it("一批之内 id 不重复, 且不与 store 已有 id 撞", () => {
    const root = makeRoot();
    writeFile(root, "a.c", Array.from({ length: 200 }, (_, i) => `l${i}`).join("\n") + "\n");
    const entries: ImportEntry[] = Array.from({ length: 200 }, (_, i) => ({
      folder: "F",
      file: "a.c",
      line: i + 1,
      note: `n${i}`
    }));
    importEntries(root, entries);
    const first = readStore(root);
    const firstIds = collectTagIds(first.tree[0]);
    expect(firstIds).toHaveLength(200);
    expect(new Set(firstIds).size).toBe(200);

    const entries2: ImportEntry[] = Array.from({ length: 200 }, (_, i) => ({
      folder: "F",
      file: "a.c",
      line: i + 1,
      note: `m${i}`
    }));
    importEntries(root, entries2);
    const second = readStore(root);
    const allIds = collectTagIds(second.tree[0]);
    expect(allIds).toHaveLength(400);
    expect(new Set(allIds).size).toBe(400);
  });
});

describe("listTags / clearFolder", () => {
  it("listTags 输出精简树, --folder 只列该子树", () => {
    const root = makeRoot();
    writeFile(root, "a.c", "l1\nl2\n");
    importEntries(root, [
      { folder: "A/B", file: "a.c", line: 1, note: "x" },
      { folder: "A", file: "a.c", line: 2, note: "y" }
    ]);
    const whole = listTags(root);
    expect(whole.tree).toHaveLength(1);
    const folderA = whole.tree[0] as any;
    expect(folderA.type).toBe("folder");
    expect(folderA.path).toBe("A");
    expect(folderA.children).toHaveLength(2); // B 文件夹 + 一个直接标签

    const sub = listTags(root, "A/B");
    expect(sub.tree).toHaveLength(1);
    expect((sub.tree[0] as any).title).toBe("B");
    expect((sub.tree[0] as any).children[0].note).toBe("x");
    // path 是完整路径而不是把自己再拼一遍(曾经会输出 A/B/B)
    expect((sub.tree[0] as any).path).toBe("A/B");
  });

  it("clearFolder 移除文件夹及其全部标签, 并留在回收站里可恢复", () => {
    const root = makeRoot();
    writeFile(root, "a.c", "l1\nl2\n");
    importEntries(root, [
      { folder: "A/B", file: "a.c", line: 1, note: "x" },
      { folder: "A", file: "a.c", line: 2, note: "y" }
    ]);
    const res = clearFolder(root, "A/B");
    expect(res.removed_folder).toBe("A/B");
    expect(res.removed_tags).toBe(1);
    const store = readStore(root);
    expect(store.tree[0].children).toHaveLength(1);
    expect(store.tree[0].children[0].note).toBe("y");
    // 整章清掉是重写教程的常规动作, 删错了要能从侧边栏捞回来
    expect(store.trash).toHaveLength(1);
    expect(store.trash[0].node.title).toBe("B");
    expect(collectTagIds(store.trash[0].node)).toHaveLength(1);
  });
});

describe("setFolderHiddenByPath", () => {
  it("hide 写 hidden, show 删掉, list 带出 hidden", () => {
    const root = makeRoot();
    writeFile(root, "a.c", "l1\n");
    importEntries(root, [{ folder: "A/B", file: "a.c", line: 1, note: "x" }]);
    expect(setFolderHiddenByPath(root, "A/B", true)).toEqual({ folder: "A/B", hidden: true });
    expect(readStore(root).tree[0].children[0].hidden).toBe(true);
    expect((listTags(root).tree[0] as any).children[0].hidden).toBe(true);
    expect((listTags(root).tree[0] as any).hidden).toBeUndefined();
    setFolderHiddenByPath(root, "A/B", false);
    expect("hidden" in readStore(root).tree[0].children[0]).toBe(false);
  });

  it("文件夹不存在报 E_NOT_FOUND", () => {
    const root = makeRoot();
    writeFile(root, "a.c", "l1\n");
    importEntries(root, [{ folder: "A", file: "a.c", line: 1, note: "x" }]);
    expect(() => setFolderHiddenByPath(root, "A/Z", true)).toThrow(CliError);
  });
});
