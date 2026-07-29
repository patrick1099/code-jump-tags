# inline `//me:` 私有注释 v1 —— 实现计划（目标版本 0.8.0）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在代码里敲可自定义的行尾 marker（如 `//me: 私记` / `//? 私记`），光标离开该行即折叠成 sidecar 里的悬浮标签（不落源码、不进 git），光标回来又展开成文本就地改。

**Architecture:** inline note 就是一条带 `inline:true` 的 `TagNode`，复用现有锚点引擎（`relocate.ts`）、装饰层（`decorator.ts` 的行尾 `notePosition:"end"` 渲染）、可疑态与 sidecar 存储。新增的只有：(1) 一个无 vscode 依赖的纯文本模块 `inlineNote.ts`（解析/剥离/展开 + marker 拼装）；(2) 一层薄胶水（`player/inlineNotes.ts`）把「光标进出行」翻译成折叠/展开的 buffer 编辑；(3) 树里对 inline note 的隐藏 + 提权/降格。**不新建平行存储、不新建锚点引擎。**

**Tech Stack:** TypeScript、VS Code Extension API、MobX（现有 runtime store）、vitest（纯逻辑单测，`test/**/*.test.ts`）。

## Global Constraints

- **私有注释文字绝不落进 git 能看见的地方**：折叠态文件 100% 干净；展开文字只在「光标正在这行」的几秒存在。安全靠时机（光标离开即折叠 + 打开文件扫残留兜底），**不碰 git 配置**。
- **加性、不破坏旧数据**：`TagNode` 只新增可选字段（`inline?`、`inlineMarker?`）；缺省行为与今天 100% 一致。gutter 建的正式标签行为一个字不变。
- **纯/胶水分层**：所有能不依赖 `vscode` 的逻辑放进纯模块并用 vitest 覆盖；`vscode` 只在胶水层出现。纯模块不得 `import "vscode"`。
- **身份锚永不含 marker**：写进 `original`/`text`/`pattern` 的锚文字，一律是剥掉 marker 后的干净代码。
- **一行一签**：marker 落在已有标签的行 → 归并进那条标签的 note，不新建第二签。
- **测试命令**：全量 `npm run test:unit`；单文件 `npx vitest run test/<path>.test.ts`。现有测试须全绿。
- **marker 语义**：一个「完整 marker」= 语言行注释符 + 用户配置的 token（token 自带标点）。纯层只吃「完整 marker 列表」，拼装是胶水层的活。
- **提交信息结尾**（本仓库约定，见既有 commit）：中文 `type(code-jump-tags): …`；作者 footer 用现有配置即可。

## 文件结构（先定边界）

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/lodestar/inlineNote.ts` | **新增**。纯文本：`findMarker` / `parseInlineNote` / `stripInlineNote` / `toInlineText` / `fullMarkers`。无 vscode。 | Create |
| `src/lodestar/types.ts` | `TagNode` 加 `inline?`、`inlineMarker?`。 | Modify |
| `src/lodestar/tree.ts` | 加 `setInline(store,id,boolean)`（提权/降格纯函数）。 | Modify |
| `src/lodestar/adapter.ts` | `treeToTours` 排除 inline（树里隐藏）；`treeToAllTours` 保留（照常装饰）；加 `inlineTour`（可选「💬 随手」汇总组）。 | Modify |
| `src/player/inlineNotes.ts` | **新增**。胶水：读语言行注释符 + 配置 token → 完整 marker；折叠/展开的 buffer 编辑；`onDidChangeTextEditorSelection` 驱动；扫残留；`rescanInlineNotes` / 提权 / 降格命令实现。 | Create |
| `src/player/index.ts`（或 `extension.ts` 激活处） | 注册 `registerInlineNotes()`。 | Modify |
| `package.json` | 配置项 `inlineNote.enabled` / `inlineNote.markers` / `inlineNote.showSummaryGroup`；命令 + 右键菜单。 | Modify |
| `CHANGELOG.md` / `package.json` version / `docs/.../对照` | 0.8.0 发行日志与版本号。 | Modify |

---

## Task 1: 纯文本核心 —— `inlineNote.ts`

无 vscode 依赖的解析/剥离/展开 + marker 拼装。这是全特性的地基，先 TDD 到齐。

**Files:**
- Create: `src/lodestar/inlineNote.ts`
- Test: `test/lodestar/inlineNote.test.ts`

**Interfaces:**
- Produces:
  - `fullMarkers(lineComment: string, tokens: string[]): string[]` — `["me:","?"]` + `"//"` → `["//me:","//?"]`（跳过空 token；去重）。
  - `findMarker(lineText: string, markers: string[]): { start: number; marker: string } | null` — 所有 marker 里**最靠右**的那次出现；`start` 是 0-based 完整-marker 起始列。并列同 start 取更长的。
  - `parseInlineNote(lineText: string, markers: string[]): { code: string; note: string; marker: string } | null` — 命中则 `code` = 保留缩进、去掉「marker 及其后」再 trimEnd 的行；`note` = marker 之后 trim；`marker` = 命中的完整 marker。无命中返回 `null`。
  - `stripInlineNote(lineText: string, markers: string[]): string` — 无命中原样返回；命中返回上面的 `code`。
  - `toInlineText(code: string, note: string, marker: string): string` — `` `${code}  ${marker} ${note}` ``（两空格分隔代码与 marker）。

- [ ] **Step 1: 写失败测试**

```ts
// test/lodestar/inlineNote.test.ts
import { describe, it, expect } from "vitest";
import {
  fullMarkers,
  findMarker,
  parseInlineNote,
  stripInlineNote,
  toInlineText
} from "../../src/lodestar/inlineNote";

const M = ["//me:", "//?"]; // 完整 markers（已拼好行注释符）

describe("fullMarkers", () => {
  it("拼行注释符，跳过空 token，去重", () => {
    expect(fullMarkers("//", ["me:", "?"])).toEqual(["//me:", "//?"]);
    expect(fullMarkers("#", ["me:", "", "me:"])).toEqual(["#me:"]);
  });
});

describe("findMarker", () => {
  it("取最靠右的一处", () => {
    const hit = findMarker("a(); // real //me: 私记", M);
    expect(hit).toEqual({ start: "a(); // real ".length, marker: "//me:" });
  });
  it("无 marker 返回 null", () => {
    expect(findMarker("int x = 1;", M)).toBeNull();
  });
  it("并列同起点取更长 marker", () => {
    // 人为构造：两个 marker 同一起点
    const hit = findMarker("x //ab", ["//a", "//ab"]);
    expect(hit).toEqual({ start: 2, marker: "//ab" });
  });
});

describe("parseInlineNote", () => {
  it("行尾 marker：拆出保留缩进的 code 与 trim 的 note", () => {
    expect(parseInlineNote("    int x = f();  //me: 会溢出", M)).toEqual({
      code: "    int x = f();",
      note: "会溢出",
      marker: "//me:"
    });
  });
  it("行内已有真注释：只认最后一段 marker，真注释留在 code 里", () => {
    expect(parseInlineNote("a(); // real //? 私记", M)).toEqual({
      code: "a(); // real",
      note: "私记",
      marker: "//?"
    });
  });
  it("空 note", () => {
    expect(parseInlineNote("x = 1; //me:", M)).toEqual({
      code: "x = 1;",
      note: "",
      marker: "//me:"
    });
  });
  it("无 marker 返回 null", () => {
    expect(parseInlineNote("plain code", M)).toBeNull();
  });
});

describe("stripInlineNote", () => {
  it("剥掉 marker 段，保留缩进；无 marker 原样", () => {
    expect(stripInlineNote("    int x = f();  //me: 会溢出", M)).toBe("    int x = f();");
    expect(stripInlineNote("    int x = f();", M)).toBe("    int x = f();");
  });
});

describe("toInlineText + 往返幂等", () => {
  it("展开格式", () => {
    expect(toInlineText("int x = f();", "会溢出", "//me:")).toBe("int x = f();  //me: 会溢出");
  });
  it("parse(toInlineText(...)) 还原 code/note/marker（对每个 m）", () => {
    for (const m of M) {
      const code = "  foo(bar);";
      const note = "私记内容";
      const round = parseInlineNote(toInlineText(code, note, m), M);
      expect(round).toEqual({ code, note, marker: m });
      expect(stripInlineNote(toInlineText(code, note, m), M)).toBe(code);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/lodestar/inlineNote.test.ts`
Expected: FAIL（模块不存在 / 函数未定义）。

- [ ] **Step 3: 写最小实现**

```ts
// src/lodestar/inlineNote.ts
// 纯文本：inline note 的解析/剥离/展开与 marker 拼装。No `vscode` import.

// 拼「完整 marker」= 行注释符 + token。跳过空 token，按首次出现去重。
export function fullMarkers(lineComment: string, tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    if (!t) continue;
    const full = lineComment + t;
    if (!out.includes(full)) out.push(full);
  }
  return out;
}

// 所有 marker 里最靠右的那次出现。并列同起点取更长的（避免 "//a" 抢了 "//ab"）。
export function findMarker(
  lineText: string,
  markers: string[]
): { start: number; marker: string } | null {
  let best: { start: number; marker: string } | null = null;
  for (const marker of markers) {
    if (!marker) continue;
    const idx = lineText.lastIndexOf(marker);
    if (idx < 0) continue;
    if (
      best === null ||
      idx > best.start ||
      (idx === best.start && marker.length > best.marker.length)
    ) {
      best = { start: idx, marker };
    }
  }
  return best;
}

export function parseInlineNote(
  lineText: string,
  markers: string[]
): { code: string; note: string; marker: string } | null {
  const hit = findMarker(lineText, markers);
  if (!hit) return null;
  const code = lineText.slice(0, hit.start).replace(/\s+$/, "");
  const note = lineText.slice(hit.start + hit.marker.length).trim();
  return { code, note, marker: hit.marker };
}

export function stripInlineNote(lineText: string, markers: string[]): string {
  const parsed = parseInlineNote(lineText, markers);
  return parsed ? parsed.code : lineText;
}

export function toInlineText(code: string, note: string, marker: string): string {
  return `${code}  ${marker} ${note}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/lodestar/inlineNote.test.ts`
Expected: PASS（全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/lodestar/inlineNote.ts test/lodestar/inlineNote.test.ts
git commit -m "feat(code-jump-tags): inline note 纯文本核心 parse/strip/toInlineText + 多 marker"
```

---

## Task 2: `TagNode` 加 `inline?` / `inlineMarker?` 字段

纯类型改动，加性。单独一小步，好让后续任务引用。

**Files:**
- Modify: `src/lodestar/types.ts:3-15`

**Interfaces:**
- Produces: `TagNode.inline?: boolean`、`TagNode.inlineMarker?: string`。

- [ ] **Step 1: 改类型**

在 `TagNode` 接口尾部（`notePosition` 后）加两行：

```ts
  notePosition?: "above" | "end"; // per-tag note placement; unset => "above"
  inline?: boolean;      // true = 一条 inline note：默认不进主树，光标进入展开成文本
  inlineMarker?: string; // 该 inline note 折叠时命中的完整 marker（如 "//me:"），仅回展用
```

- [ ] **Step 2: 确认类型编译通过**

Run: `npx tsc --noEmit -p tsconfig.json`（若仓库有此脚本；否则 `npm run compile` 或 `npx tsc --noEmit`）
Expected: 无新增类型错误。

- [ ] **Step 3: 跑现有测试确认无回归**

Run: `npm run test:unit`
Expected: PASS（加性字段不影响任何现有断言）。

- [ ] **Step 4: 提交**

```bash
git add src/lodestar/types.ts
git commit -m "feat(code-jump-tags): TagNode 加 inline / inlineMarker 可选字段（加性）"
```

---

## Task 3: 树里隐藏 inline note（`adapter.ts`）

inline note 照常被装饰（走 `treeToAllTours` → `store.allTours` → decorator 的行尾 `end` 渲染），但**不进主树**（`treeToTours` → `store.tours` → 树 provider）。靠给 `folderToTour` 加一个「是否含 inline」开关实现，两个入口分别传值。

**Files:**
- Modify: `src/lodestar/adapter.ts:21-64`
- Test: `test/lodestar/adapter.test.ts`（追加用例）

**Interfaces:**
- Consumes: `TagNode.inline`（Task 2）。
- Produces: `folderToTour(folder, workspaceId, opts?: { includeInline?: boolean })`（缺省 `includeInline: true`，保持既有调用者语义不变）；`treeToTours` 内部以 `includeInline:false` 建树。

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 test/lodestar/adapter.test.ts
import { treeToTours, treeToAllTours, folderToTour } from "../../src/lodestar/adapter";

describe("inline note 树可见性", () => {
  const s = {
    version: 1 as const,
    tree: [
      {
        type: "folder" as const, id: "f1", title: "组", children: [
          { type: "tag" as const, id: "normal", note: "正式", file: "a.c", line: 1, createdAt: "x" },
          { type: "tag" as const, id: "inl", note: "随手", file: "a.c", line: 2, inline: true, notePosition: "end" as const, createdAt: "x" }
        ]
      }
    ]
  };

  it("treeToTours 隐藏 inline（树里只剩正式标签）", () => {
    const tours = treeToTours(s, "ws");
    expect(tours[0].steps.map(st => st.id)).toEqual(["normal"]);
  });

  it("treeToAllTours 保留 inline（装饰源含随手）", () => {
    const tours = treeToAllTours(s, "ws");
    const ids = tours.flatMap(t => t.steps.map(st => st.id));
    expect(ids).toContain("inl");
  });

  it("folderToTour 默认含 inline（不破坏既有调用者）", () => {
    expect(folderToTour(s.tree[0], "ws").steps.map(st => st.id)).toEqual(["normal", "inl"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/lodestar/adapter.test.ts`
Expected: FAIL（`treeToTours` 目前含 inl；`folderToTour` 无 opts）。

- [ ] **Step 3: 改实现**

```ts
// src/lodestar/adapter.ts —— 替换 folderToTour 与 treeToTours
export function folderToTour(
  folder: FolderNode,
  workspaceId: string,
  opts: { includeInline?: boolean } = {}
): CodeTour {
  const includeInline = opts.includeInline !== false; // 默认含
  return {
    id: `${workspaceId}::${folder.id}`,
    title: folder.title,
    steps: folder.children
      .filter((c): c is TagNode => c.type === "tag")
      .filter(t => includeInline || !t.inline)
      .map(tagToStep)
  };
}

export function treeToTours(store: LodestarStore, workspaceId: string): CodeTour[] {
  const folders = store.tree.filter((n): n is FolderNode => n.type === "folder");
  return folders.map(f => folderToTour(f, workspaceId, { includeInline: false }));
}
```

`treeToAllTours` 内部对每个 folder 调 `folderToTour(node, workspaceId)`（默认含 inline）——**不改**。同理 `src/player/tree/index.ts` 里 `subfolderNodesOf` 与 `getParent` 调 `folderToTour(child, wsId)` 渲染子文件夹树：也要隐藏 inline，改成 `folderToTour(child, wsId, { includeInline: false })`。

- [ ] **Step 4: 同步子文件夹树入口**

Modify: `src/player/tree/index.ts:221` 与 `:242` 两处 `folderToTour(...)` 加 `{ includeInline: false }`。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/lodestar/adapter.test.ts && npm run test:unit`
Expected: PASS（新用例 + 全量回归）。

- [ ] **Step 6: 提交**

```bash
git add src/lodestar/adapter.ts src/player/tree/index.ts test/lodestar/adapter.test.ts
git commit -m "feat(code-jump-tags): inline note 从主树隐藏（装饰仍照常）"
```

---

## Task 4: 提权/降格纯函数 `setInline`（`tree.ts`）

翻 `inline` 标志位。提权额外清 `inlineMarker`（它回到正式标签，不再需要回展 marker）。

**Files:**
- Modify: `src/lodestar/tree.ts`（`retargetTag` 之后追加）
- Test: `test/lodestar/tree.test.ts`（追加用例）

**Interfaces:**
- Produces: `setInline(store: LodestarStore, id: string, inline: boolean): boolean` — 找到 tag 则置 `inline`（`false` 时 `delete node.inline` 保持数据干净并清 `inlineMarker`），返回是否命中一个 tag。

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 test/lodestar/tree.test.ts（沿用该文件已有的 import 风格）
import { setInline } from "../../src/lodestar/tree";

describe("setInline 提权/降格", () => {
  function makeStore() {
    return {
      version: 1 as const,
      tree: [
        { type: "folder" as const, id: "f", title: "组", children: [
          { type: "tag" as const, id: "t", note: "n", file: "a", line: 1, inline: true, inlineMarker: "//me:", createdAt: "x" }
        ] }
      ]
    };
  }
  it("提权：清 inline 与 inlineMarker", () => {
    const s = makeStore();
    expect(setInline(s, "t", false)).toBe(true);
    const tag: any = (s.tree[0] as any).children[0];
    expect(tag.inline).toBeUndefined();
    expect(tag.inlineMarker).toBeUndefined();
  });
  it("降格：置 inline=true", () => {
    const s = makeStore();
    (s.tree[0] as any).children[0].inline = undefined;
    expect(setInline(s, "t", true)).toBe(true);
    expect((s.tree[0] as any).children[0].inline).toBe(true);
  });
  it("未知 id / 文件夹返回 false", () => {
    const s = makeStore();
    expect(setInline(s, "nope", true)).toBe(false);
    expect(setInline(s, "f", true)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/lodestar/tree.test.ts`
Expected: FAIL（`setInline` 未定义）。

- [ ] **Step 3: 写实现**

```ts
// src/lodestar/tree.ts —— 追加在 retargetTag 之后
// 翻转一条 tag 的 inline 标志（提权=false / 降格=true）。降格进随手、提权成正式标签。
// 返回是否命中一个 tag（未知 id / 文件夹返回 false）。
export function setInline(
  store: LodestarStore,
  id: string,
  inline: boolean
): boolean {
  const found = findNode(store, id);
  if (!found || found.node.type !== "tag") return false;
  if (inline) {
    found.node.inline = true;
  } else {
    delete found.node.inline;
    delete found.node.inlineMarker;
  }
  return true;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/lodestar/tree.test.ts && npm run test:unit`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/lodestar/tree.ts test/lodestar/tree.test.ts
git commit -m "feat(code-jump-tags): setInline 提权/降格纯函数"
```

---

## Task 5: 折叠/展开胶水层 —— `player/inlineNotes.ts`

核心运行时。把「光标进出行」翻译成折叠（创建/归并 inline tag + 剥净 buffer + 存盘）与展开（注入文本）。这是唯一较难、且**无自动化单测**（依赖真实 `vscode` 编辑器与 undo 栈）的任务——纯逻辑已在 Task 1 覆盖，这里靠**手动验收清单**把关，并把「undo 交织行为」列为显式验收项。

**Files:**
- Create: `src/player/inlineNotes.ts`
- Modify: 激活入口注册（见 Task 7 收尾；本任务先导出 `registerInlineNotes` 并在 `src/player/index.ts` 的现有 `register*` 序列里挂上）。

**Interfaces:**
- Consumes: `parseInlineNote` / `stripInlineNote` / `toInlineText` / `fullMarkers`（Task 1）；`getStore` / `saveStore`（`lodestar/persistence`）；`findTagByLocation` / `addTag` / `getOrCreateInbox` / `newFolderId`（`tree`）；`lineAnchorText` / `linePattern`（`relocate`）；`updateDecorations`（`player/decorator`）。
- Produces: `registerInlineNotes(): void`；内部 `collapseLine(editor, line0)`、`expandLine(editor, line0)`、`markersForDocument(doc): string[]`、`lineCommentFor(languageId): string`、`rescanDocument(editor)`。

**实现要点（写进文件内注释，逐条落地）：**

1. **完整 marker 来源**：`markersForDocument(doc)` = `fullMarkers(lineCommentFor(doc.languageId), config.markers)`。`config.markers` 读 `codeJumpTags.inlineNote.markers`（默认 `["me:"]`）；`config.enabled` 关则整层短路。`lineCommentFor` 先查一张小映射表（`js/ts/c/cpp/java/go/rust/... => "//"`，`python/shell/yaml/... => "#"`，`lua/sql => "--"`），查不到退回 `"//"`。（VS Code 无同步公开 API 直接取 `comments.lineComment`；小表足够，且可后续扩展。）

2. **折叠 `collapseLine(editor, line0)`**（光标离开一条含 marker 的行时触发）：
   - `const parsed = parseInlineNote(lineText, markers); if (!parsed) return;`
   - 若 `parsed.note` 为空且该行原本没有 tag → 视为用户删空了 note，仅剥净 buffer、不建 tag。
   - 锚：`const anchor = lineAnchorText(parsed.code); const pattern = linePattern(parsed.code);`
   - upsert：`const existing = findTagByLocation(store, file, line1);`
     - 有 → 更新 `existing.note = parsed.note; existing.inline ??= true; existing.inlineMarker = parsed.marker;`（遵一行一签；若命中的是正式标签则**不**强制置 inline，只更 note——但 v1 主场景是它自己建的 inline tag）。
     - 无 → 建 `TagNode`（照抄 `recorder/commands.ts:430-439` 的构造：`id`/`note`/`file`/`line`/`pattern`/`text`/`original`/`createdAt`）外加 `inline:true, notePosition:"end", inlineMarker:parsed.marker`，`addTag(store, tag, getOrCreateInbox(store,newFolderId).id)`。
   - 剥净 buffer：`await editor.edit(b => b.replace(fullLineRange, parsed.code), { undoStopBefore:false, undoStopAfter:false });` 再 `await saveStore();`
   - `file` = 工作区相对路径，取法与 `recorder/commands.ts` 建 tag 时一致。

3. **展开 `expandLine(editor, line0)`**（光标进入一条有 inline tag、且当前行**不含 marker** 的行时触发）：
   - 找该行 inline tag（`findTagByLocation`，判 `inline===true`）；无则 return。
   - `const marker = tag.inlineMarker ?? markersForDocument(doc)[0]; const text = toInlineText(lineText, tag.note, marker);`
   - `await editor.edit(b => b.replace(fullLineRange, text), { undoStopBefore:false, undoStopAfter:false });` **只改 buffer，不动 sidecar。**

4. **触发器 `onDidChangeTextEditorSelection`**：维护 per-editor 的「当前展开行」`expandedLine: number | null`。
   - 事件里取新光标行 `cur0`。
   - 若 `expandedLine !== null && expandedLine !== cur0` → `collapseLine(editor, expandedLine)`；`expandedLine = null`。
   - 若 `cur0` 那行有 inline tag 且不含 marker → `expandLine(editor, cur0)`；`expandedLine = cur0`。
   - 若 `cur0` 那行**含 marker 但没 tag**（用户刚敲的）→ 不立即折叠（人还在打字）；等光标离开时由上一条分支折叠。为此：也把「含 marker 的行」记成 `expandedLine`，离开即折叠。

5. **re-entrancy 防抖**：`collapseLine`/`expandLine` 里的 `editor.edit` 会触发 `onDidChangeTextDocument`（`decorator.ts` 的 `trackLineShifts`）与可能的 selection 事件。用一个模块级 `busy` 布尔在进入 edit 前置位、`finally` 复位，事件回调开头 `if (busy) return;`，避免自触发递归。

6. **undo 交织（显式验收项，非自动化测试）**：`undoStopBefore/After:false` 让折叠/展开的编辑并入相邻用户编辑、减少突兀。已知残留：光标停展开行时按 Ctrl+Z 可能撤出一次折叠让 marker 文本短暂复活——**可接受**（外观毛刺，非数据/隐私问题），靠 Task 6 的扫残留兜底堵泄漏。验收时须实测并记录行为。

- [ ] **Step 1: 建文件与 `markersForDocument`/`lineCommentFor`**（含小语言表），导出 `registerInlineNotes` 空壳。
- [ ] **Step 2: 实现 `collapseLine`**（upsert + 剥净 + 存盘）。
- [ ] **Step 3: 实现 `expandLine`**（注入文本）。
- [ ] **Step 4: 接 `onDidChangeTextEditorSelection` + `busy` 防抖，串起进出行逻辑。**
- [ ] **Step 5: 在 `src/player/index.ts` 现有注册序列挂上 `registerInlineNotes()`。**
- [ ] **Step 6: 编译**

Run: `npm run compile`（或 `npx tsc --noEmit`）
Expected: 无类型错误。

- [ ] **Step 7: 手动验收（F5 起 Extension Development Host）**，逐条实测记录：
  - 敲 `int x=f();  //me: 会溢出`，光标移到别行 → 该行变干净 `int x=f();`，行尾出现 💬「会溢出」，`.code-jump-tags/store.json` 多一条 `inline:true` tag。
  - 光标回到该行 → 行尾恢复 `//me: 会溢出` 可改；改成「一定溢出」再离开 → sidecar note 更新、buffer 复干净。
  - 配 `markers=["me:","?"]`：`//? 私记` 折叠展开正常，且回展仍是 `//?` 不变成 `//me:`。
  - Python 文件里 `#me: 私记` 生效。
  - 一行一签：在已打正式标签的行敲 `//me:` 离开 → 并入其 note，不新建。
  - **undo 交织**：折叠后按 Ctrl+Z 数次，记录行为（marker 是否短暂复活、最终是否留干净）。写进验收记录。
  - 保存磁盘检查：折叠态 `git diff` 看不到 `//me:`。

- [ ] **Step 8: 提交**

```bash
git add src/player/inlineNotes.ts src/player/index.ts
git commit -m "feat(code-jump-tags): inline note 折叠/展开胶水（光标进出行驱动）"
```

---

## Task 6: 扫残留兜底 + `rescanInlineNotes` 命令

堵「光标停在展开行时被 autosave/提交」的漏：打开/切换编辑器时，把文件里任何遗留的 marker 行折叠一遍。

**Files:**
- Modify: `src/player/inlineNotes.ts`（加 `rescanDocument` + 注册命令 + `onDidChangeActiveTextEditor`）
- Modify: `package.json`（命令 `codeJumpTags.rescanInlineNotes`，Task 7 统一登记也可）

**Interfaces:**
- Consumes: `collapseLine`、`markersForDocument`、`findMarker`（Task 1/5）。
- Produces: `rescanDocument(editor): Promise<void>` — 遍历 doc 每一行，`findMarker(lineText, markers)` 命中就 `collapseLine`（跳过光标当前行，避免把人正在敲的行吞掉）。

- [ ] **Step 1: 实现 `rescanDocument`**：从后往前遍历行（折叠只改本行、不删行，前后向都安全，但从后往前对将来扩展更稳），命中 marker 且非光标行则 `collapseLine`。
- [ ] **Step 2: 挂 `onDidChangeActiveTextEditor`**：编辑器变为 active（含启动时已开的）→ `rescanDocument`。复用 `busy` 防抖。
- [ ] **Step 3: 注册命令 `codeJumpTags.rescanInlineNotes`**：对当前 active editor 跑 `rescanDocument`（给关了自动折叠触发点的人手动兜底）。
- [ ] **Step 4: 编译**

Run: `npm run compile`
Expected: 无类型错误。

- [ ] **Step 5: 手动验收**：
  - 在展开行手动 Ctrl+S 让 `//me:` 落盘 → 切走再切回该文件 → marker 被自动折叠、buffer 复干净。
  - 命令面板跑「扫残留」→ 当前文件所有遗留 marker 折叠。

- [ ] **Step 6: 提交**

```bash
git add src/player/inlineNotes.ts package.json
git commit -m "feat(code-jump-tags): 打开/切换文件扫残留兜底 + rescanInlineNotes 命令"
```

---

## Task 7: 提权/降格命令、可选「💬 随手」汇总组、package.json 贡献点

把 Task 4 的 `setInline` 接到右键命令；加可选的只读汇总组（仿 `suspectTour`）；统一登记 `package.json` 的配置/命令/菜单。

**Files:**
- Modify: `src/lodestar/adapter.ts`（加 `inlineTour`）
- Modify: `src/player/tree/index.ts`（`getChildren` 顶部按设置注入 `inlineTour`）
- Modify: `src/player/inlineNotes.ts`（注册 `promoteInlineNote` / `demoteToInlineNote` 命令）
- Modify: `package.json`（`contributes.configuration` + `commands` + `menus`）
- Test: `test/lodestar/adapter.test.ts`（`inlineTour` 用例）

**Interfaces:**
- Consumes: `setInline`（Task 4）、`saveStore`。
- Produces: `inlineTour(store, workspaceId): CodeTour`（synthetic id `__inline__`，标题 `💬 随手 (N)`，steps = 全树 `inline===true` 的 tag，仿 `suspectTour`）。

- [ ] **Step 1: 写 `inlineTour` 失败测试**（仿 adapter.test 里 suspectTour 的写法：断言标题计数与 steps id 集合 = 所有 inline tag）。
- [ ] **Step 2: 跑确认失败** → `npx vitest run test/lodestar/adapter.test.ts`。
- [ ] **Step 3: 实现 `inlineTour`**（复制 `suspectTour` 结构，改 `SUSPECT_TOUR_ID`→`INLINE_TOUR_ID="__inline__"`、过滤条件为 `node.inline === true`、标题 `💬 随手 (${n})`）。
- [ ] **Step 4: 跑确认通过。**
- [ ] **Step 5: 树顶注入**：`src/player/tree/index.ts:getChildren` 里，在 suspect 组注入处旁边，读 `codeJumpTags.inlineNote.showSummaryGroup`（默认 `true`）；为 true 且存在 inline tag 时 `tours.unshift(new CodeTourNode(inlineTour(...), extensionPath))`。同 `handleDrag` 里对 `__inline__` 与 `__suspect__` 一样判为「合成分组不可拖」。
- [ ] **Step 6: 注册命令**（`src/player/inlineNotes.ts`）：
  - `codeJumpTags.promoteInlineNote`（参数 tagId）→ `setInline(store,id,false)` +（可选）移入 inbox → `saveStore()`。
  - `codeJumpTags.demoteToInlineNote`（参数 tagId）→ `setInline(store,id,true)` + 该 tag `notePosition="end"` → `saveStore()`。
- [ ] **Step 7: package.json 贡献点**：
  - `contributes.configuration` 加：
    - `codeJumpTags.inlineNote.enabled`（boolean，默认 `true`）
    - `codeJumpTags.inlineNote.markers`（array of string，默认 `["me:"]`，description 说明「跟在行注释符后的 token，自带标点，如 `me:`、`?`」）
    - `codeJumpTags.inlineNote.showSummaryGroup`（boolean，默认 `true`）
  - `contributes.commands` 加三个命令（`rescanInlineNotes`/`promoteInlineNote`/`demoteToInlineNote`，中文 title）。
  - `contributes.menus.view/item/context`：正式标签行右键出「降格为随手」，inline note（`__inline__` 组下）右键出「提权为标签」——用 `when` 上下文区分（可复用现有 step 节点的 when 模式；无法精确区分则先都挂上，命令内部按 `inline` 判空跑）。
- [ ] **Step 8: 编译 + 全量测试**

Run: `npm run compile && npm run test:unit`
Expected: PASS。

- [ ] **Step 9: 手动验收**：随手组显示计数；右键提权→进 inbox、可复制链接；右键正式标签降格→移出主树、仍带行尾 💬。

- [ ] **Step 10: 提交**

```bash
git add src/lodestar/adapter.ts src/player/tree/index.ts src/player/inlineNotes.ts package.json test/lodestar/adapter.test.ts
git commit -m "feat(code-jump-tags): 提权/降格命令 + 可选「随手」汇总组 + 贡献点"
```

---

## Task 8: 0.8.0 版本号 + CHANGELOG + 功能-代码对照

**Files:**
- Modify: `package.json`（`"version": "0.8.0"`）
- Modify: `CHANGELOG.md`（顶部加 `## 0.8.0` 段）
- Create/Modify: `docs/superpowers/specs/` 下的「功能-代码对照」补记（沿用既有 0.7.x 对照文档风格）

- [ ] **Step 1: 版本号 → 0.8.0**（`package.json`）。
- [ ] **Step 2: CHANGELOG 顶部加段**，中文，覆盖：新增行尾 inline 私有注释（敲自定义 marker → 光标离开折叠成不进 git 的悬浮标签 → 回来展开可改）、marker 可自定义多种并存、跨语言行注释符、树里隐藏 + 「随手」汇总组 + 提权/降格、扫残留兜底与已知取舍（展开态被保存的短暂落盘、undo 交织为外观毛刺、字符串字面量里的 marker 会误认）。
- [ ] **Step 3: 全量测试 + 编译最终确认**

Run: `npm run test:unit && npm run compile`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add package.json CHANGELOG.md docs/
git commit -m "feat(code-jump-tags): 0.8.0 版本号 + CHANGELOG + inline note 功能-代码对照"
```

---

## Self-Review（对照 spec 核对）

**Spec 覆盖：**
- 数据模型 `inline?`/`inlineMarker?` → Task 2 ✅
- 三形态一套存储（inline note = 带标志位的 TagNode）→ Task 2/5 ✅
- 生命周期状态机（折叠/展开/扫残留/正式标签不展开）→ Task 5（折叠、展开、正式标签不注入）+ Task 6（扫残留）✅
- 锚剥离 `stripInlineNote` + 只认最后一段 + 一行一签 → Task 1（纯）+ Task 5（upsert 归并）✅
- marker 可自定义多种并存 + 跨语言 → Task 1（`fullMarkers`/多 marker `findMarker`）+ Task 5（`markersForDocument`/`lineCommentFor`）✅
- 回展保真 `inlineMarker` → Task 1（`toInlineText`）+ Task 2（字段）+ Task 5（存/用）✅
- 复用 relocate/suspect，不新引擎 → Task 5 直接调 `lineAnchorText`/`linePattern` + 复用 decorator 的 `end` 渲染与既有可疑态 ✅
- 树隐藏 + 「💬 随手」组 + 提权/降格 → Task 3 + Task 4 + Task 7 ✅
- 命令 `promoteInlineNote`/`demoteToInlineNote`/`rescanInlineNotes` + 配置项 → Task 6/7 ✅
- 已知取舍（展开态落盘、undo 交织为验收项、字符串误伤、无行号漂移）→ Task 5 要点6 + Task 6 兜底 + Task 8 CHANGELOG 记录 ✅

**占位符扫描：** 纯任务（1/3/4）均给出完整可运行代码与断言；胶水任务（5/6/7）无法自动化单测，改为「实现要点逐条 + 手动验收清单」并显式标注——这是该层的诚实边界，非占位符。

**类型一致性：** `folderToTour(folder, workspaceId, opts?)`、`setInline(store,id,boolean)`、`fullMarkers/findMarker/parseInlineNote/stripInlineNote/toInlineText`、`inlineTour(store,workspaceId)` 在各任务引用处签名一致；`inline?`/`inlineMarker?` 字段名全程统一。

## 已知边界（写进 CHANGELOG，不在 v1 解）
- 独占一行的 marker 折叠成空行、锚为空（弱跟随）——v1 主场景是行尾；标准行为记录即可。
- 字符串字面量里的 marker（`"http://me: x"`）会被误认——v1 接受「宁可多认、可手动降格/删」。
- undo 交织可能让折叠短暂回吐 marker 文本——外观毛刺，扫残留兜底堵泄漏。
- 语言行注释符走内置小表 + 退回 `//`——冷门语言可后续加表项。
