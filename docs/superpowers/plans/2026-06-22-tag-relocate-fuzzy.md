# 标签行就近+模糊重定位 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让标签在行内小改动后稳定跟随原行，失配时就近模糊找回、绝不被远处重复副本（宏关掉的孪生函数）吸走，并让行内编辑实时刷新锚点。

**Architecture:** 在纯函数层 `src/lodestar/relocate.ts` 新增「空白归一化 Levenshtein 相似度 + 距离优先同心扩圈」的 `resolveLineFuzzy`，以原始行文字 `text` 为锚点。`text` 作为**加性**字段加到 `TagNode` / `CodeTourStep`，与既有正则 `pattern` 并存（`pattern` 继续服务 URL 深链与旧 step 层，不动）。重锚 `reanchorTag` 优先用 `text` 模糊解析、缺失时回退旧正则。RC3：`trackLineShifts` 去掉 delta=0 早退，行内编辑只刷新被改行上的锚点。

**Tech Stack:** TypeScript、vitest（`test/**/*.test.ts`，node 环境）、webpack 生产构建。纯函数层禁止 `import vscode`。

## Global Constraints

- 工作目录仅限 `C:\Users\dell\Desktop\plugin-research\codetour`，**不得**触碰 `C:\Users\dell\Desktop\需求`。
- 提交信息末尾追加：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- 不提交 `*.vsix`（已 gitignore）。
- `src/lodestar/relocate.ts`、`tree.ts`、`adapter.ts` 保持纯函数，**不得** `import vscode`。
- 单测命令 `npm run test:unit`（= `vitest run`）；构建 `npm run build`（= `webpack --mode production`），目标**零错误零警告**。
- `relocate.ts` 模块常量：`SIMILARITY_THRESHOLD = 0.9`、`SEARCH_RADII = [8, 40, Infinity]`、`MAX_CMP_LEN = 200`。
- **加性原则**：保留 `pattern`（正则）及其所有现有消费方（`gotoLocation`、`decorator.ts:66-67` 兜底、`vscode://` 深链、`recorder/watcher.ts`），现有 `relocate.test.ts` 全部保持绿。

---

### Task 1: 相似度原语（normalizeWs + similarity + 常量）

**Files:**
- Modify: `src/lodestar/relocate.ts`（文件头部新增常量与两个纯函数）
- Test: `test/lodestar/relocate.test.ts`（追加 describe 块）

**Interfaces:**
- Produces:
  - `export const SIMILARITY_THRESHOLD = 0.9;`
  - `export const SEARCH_RADII = [8, 40, Infinity];`
  - `export const MAX_CMP_LEN = 200;`
  - `export function normalizeWs(s: string): string`
  - `export function similarity(a: string, b: string): number` — 0~1，对截断到 `MAX_CMP_LEN` 的两串算 Levenshtein 归一化相似度；两串皆空返回 1。

- [ ] **Step 1: 写失败测试**

在 `test/lodestar/relocate.test.ts` 末尾追加（并在文件顶部 import 增补 `normalizeWs, similarity`）：

```ts
import { normalizeWs, similarity } from "../../src/lodestar/relocate";

describe("normalizeWs", () => {
  it("trims ends and collapses internal whitespace runs", () => {
    expect(normalizeWs("  if  (a >  b) {\t}  ")).toBe("if (a > b) {}");
  });
  it("maps blank/whitespace-only to empty string", () => {
    expect(normalizeWs("   \t ")).toBe("");
    expect(normalizeWs("")).toBe("");
  });
});

describe("similarity", () => {
  it("is 1 for identical strings and for two empties", () => {
    expect(similarity("foo()", "foo()")).toBe(1);
    expect(similarity("", "")).toBe(1);
  });
  it("tolerates a one-char insertion on a ~10-char line (>=0.9)", () => {
    // "if (a > b)" -> "if (a > b);" : 1 edit over length 11
    expect(similarity("if (a > b)", "if (a > b);")).toBeGreaterThanOrEqual(0.9);
  });
  it("is low for unrelated strings", () => {
    expect(similarity("alpha();", "return 0;")).toBeLessThan(0.5);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/lodestar/relocate.test.ts`
Expected: FAIL（`normalizeWs`/`similarity` 未导出）。

- [ ] **Step 3: 实现**

在 `src/lodestar/relocate.ts` 顶部（`import` 之后、`reanchorTag` 之前）插入：

```ts
export const SIMILARITY_THRESHOLD = 0.9;
export const SEARCH_RADII = [8, 40, Infinity];
export const MAX_CMP_LEN = 200;

// Collapse a line to its comparison form: trim ends, squeeze internal
// whitespace runs to a single space. Blank/whitespace-only -> "".
export function normalizeWs(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

// Normalized Levenshtein similarity in [0,1]. Inputs are compared as-is
// (callers pass normalizeWs'd strings). Each side is capped at MAX_CMP_LEN
// chars to bound the DP cost. Two empty strings count as identical (1).
export function similarity(a: string, b: string): number {
  const s = a.length > MAX_CMP_LEN ? a.slice(0, MAX_CMP_LEN) : a;
  const t = b.length > MAX_CMP_LEN ? b.slice(0, MAX_CMP_LEN) : b;
  const n = s.length;
  const m = t.length;
  if (n === 0 && m === 0) return 1;
  if (n === 0 || m === 0) return 0;
  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  const dist = prev[m];
  return 1 - dist / Math.max(n, m);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/lodestar/relocate.test.ts`
Expected: PASS（含原有用例）。

- [ ] **Step 5: 提交**

```bash
git add src/lodestar/relocate.ts test/lodestar/relocate.test.ts
git commit -m "feat(code-jump-tags): 相似度原语 normalizeWs+similarity+扩圈常量

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: 距离优先同心扩圈解析 `resolveLineFuzzy`

**Files:**
- Modify: `src/lodestar/relocate.ts`
- Test: `test/lodestar/relocate.test.ts`

**Interfaces:**
- Consumes: `SIMILARITY_THRESHOLD`, `SEARCH_RADII`, `normalizeWs`, `similarity`（Task 1）。
- Produces: `export function resolveLineFuzzy(text: string, centerLine: number, anchorText?: string): number` — 1-based。空 `anchorText` 直接返回 `centerLine`；中心行相似度 ≥ 阈值则信任中心；否则按 `SEARCH_RADII` 逐圈在 `[center±R]` 找 ≥ 阈值候选，取相似度最高、平手取最近；全无则返回 `centerLine`（不动）。

- [ ] **Step 1: 写失败测试**

追加（import 增补 `resolveLineFuzzy`）：

```ts
import { resolveLineFuzzy } from "../../src/lodestar/relocate";

describe("resolveLineFuzzy", () => {
  it("returns center when anchorText is empty", () => {
    const text = ["a", "b", "c"].join("\n");
    expect(resolveLineFuzzy(text, 2)).toBe(2);
  });

  it("keeps center when the center line still matches (exact)", () => {
    const text = ["void a(){", "  doThing();", "}"].join("\n");
    expect(resolveLineFuzzy(text, 2, "doThing();")).toBe(2);
  });

  it("keeps center when the center line drifted only a little (fuzzy >=0.9)", () => {
    const text = ["void a(){", "  doThing(x);", "}"].join("\n");
    // anchor is the old text "doThing();" — center now "doThing(x);"
    expect(resolveLineFuzzy(text, 2, "doThing();")).toBe(2);
  });

  it("prefers the NEAR fuzzy line over a FAR exact duplicate (macro twin)", () => {
    // line 2 (near, edited -> fuzzy ~0.9) vs line 40 (exact old text).
    const lines = Array.from({ length: 45 }, (_, i) => `pad${i}`);
    lines[1] = "  if (a > b) {;"; // 1-based line 2, near center, fuzzy
    lines[39] = "if (a > b) {";   // 1-based line 40, far, EXACT old text
    const text = lines.join("\n");
    expect(resolveLineFuzzy(text, 2, "if (a > b) {")).toBe(2);
  });

  it("relocates to the nearest matching line when center drifted out", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `x${i}`);
    lines[6] = "  uniqueAnchorToken();"; // 1-based line 7
    const text = lines.join("\n");
    // stored center stale at 4; nearest (only) match is line 7
    expect(resolveLineFuzzy(text, 4, "uniqueAnchorToken();")).toBe(7);
  });

  it("stays put when nothing in the whole file clears the threshold", () => {
    const text = ["aaa", "bbb", "ccc"].join("\n");
    expect(resolveLineFuzzy(text, 2, "zzzzzzzzzz")).toBe(2);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/lodestar/relocate.test.ts`
Expected: FAIL（`resolveLineFuzzy` 未导出）。

- [ ] **Step 3: 实现**

在 `src/lodestar/relocate.ts` 追加：

```ts
// Distance-first fuzzy line resolver (the recovery layer for changes we did
// NOT witness live — reopen after external/git edits). 1-based in/out.
// Trusts the center (incrementally-tracked) line whenever it still clears the
// similarity bar; otherwise searches outward in concentric rings, so a NEAR
// fuzzy match wins over a FAR exact duplicate (e.g. a #if-0 macro twin).
export function resolveLineFuzzy(
  text: string,
  centerLine: number,
  anchorText?: string
): number {
  if (!anchorText) return centerLine;
  const target = normalizeWs(anchorText);
  if (target.length === 0) return centerLine;

  const lines = text.split(/\r?\n/);
  const center0 = centerLine - 1;
  const simAt = (i: number): number => {
    const l = lines[i];
    return l === undefined ? -1 : similarity(normalizeWs(l), target);
  };

  // Fast path: incremental tracking already put us on a good line.
  if (center0 >= 0 && center0 < lines.length && simAt(center0) >= SIMILARITY_THRESHOLD) {
    return centerLine;
  }

  for (const R of SEARCH_RADII) {
    const lo = Math.max(0, center0 - R);
    const hi = Math.min(lines.length - 1, center0 + R);
    let best = -1;
    let bestSim = -1;
    let bestDist = Infinity;
    for (let i = lo; i <= hi; i++) {
      const s = simAt(i);
      if (s < SIMILARITY_THRESHOLD) continue;
      const d = Math.abs(i - center0);
      if (s > bestSim || (s === bestSim && d < bestDist)) {
        best = i;
        bestSim = s;
        bestDist = d;
      }
    }
    if (best >= 0) return best + 1;
    if (!isFinite(R)) break; // whole-file ring already scanned
  }
  return centerLine;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/lodestar/relocate.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/lodestar/relocate.ts test/lodestar/relocate.test.ts
git commit -m "feat(code-jump-tags): resolveLineFuzzy 距离优先同心扩圈解析

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: 锚点文字助手与旧数据回填（lineAnchorText / patternToText / backfillAnchorText）

**Files:**
- Modify: `src/lodestar/relocate.ts`
- Test: `test/lodestar/relocate.test.ts`

**Interfaces:**
- Consumes: `TagNode`、`FolderNode`、`TreeNode`、`LodestarStore`（`./types`）。
- Produces:
  - `export function lineAnchorText(lineText: string): string | undefined` — 返回 `trim()` 结果，空行返回 `undefined`。
  - `export function patternToText(pattern: string): string | undefined` — 反推 `linePattern` 的原文（剥前缀、反转义），反推不出返回 `undefined`。
  - `export function backfillAnchorText(store: LodestarStore): void` — 遍历全树，对有 `pattern` 无 `text` 的标签由 `pattern` 反推 `text`（in-place），`pattern` 原样保留。

- [ ] **Step 1: 写失败测试**

在 `test/lodestar/relocate.test.ts` 顶部 import 增补，并追加：

```ts
import {
  lineAnchorText,
  patternToText,
  backfillAnchorText,
  linePattern
} from "../../src/lodestar/relocate";
import { LodestarStore } from "../../src/lodestar/types";

describe("lineAnchorText", () => {
  it("returns the trimmed text, undefined for blank", () => {
    expect(lineAnchorText("   foo(a, b);  ")).toBe("foo(a, b);");
    expect(lineAnchorText("   \t")).toBeUndefined();
  });
});

describe("patternToText", () => {
  it("reverses linePattern: strips the prefix and unescapes specials", () => {
    const original = "if (a[0] > b) { c(); }";
    const pat = linePattern("    " + original)!;
    expect(patternToText(pat)).toBe(original);
  });
  it("returns undefined for a pattern without the known prefix", () => {
    expect(patternToText("something_else")).toBeUndefined();
  });
});

describe("backfillAnchorText", () => {
  it("derives text from pattern for tags missing text, keeps pattern", () => {
    const pat = linePattern("  unsigned char OverFlowEnable;")!;
    const store: LodestarStore = {
      version: 1,
      tree: [
        {
          type: "folder",
          id: "f1",
          title: "F",
          children: [
            { type: "tag", id: "t1", note: "n", file: "a.c", line: 3, pattern: pat, createdAt: "x" }
          ]
        }
      ]
    };
    backfillAnchorText(store);
    const tag = (store.tree[0] as any).children[0];
    expect(tag.text).toBe("unsigned char OverFlowEnable;");
    expect(tag.pattern).toBe(pat); // unchanged
  });
  it("leaves a tag that already has text untouched", () => {
    const store: LodestarStore = {
      version: 1,
      tree: [{ type: "tag", id: "t1", note: "n", file: "a.c", line: 1, text: "keep", pattern: "p", createdAt: "x" } as any]
    };
    backfillAnchorText(store);
    expect((store.tree[0] as any).text).toBe("keep");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/lodestar/relocate.test.ts`
Expected: FAIL（三个新函数未导出 / `tag.text` 不存在）。

> 注：`tag.text` 的类型在 Task 4 才加到 `TagNode`；本任务测试里对标签对象用 `as any` 规避类型报错（已在上面写好）。

- [ ] **Step 3: 实现**

在 `src/lodestar/relocate.ts`：顶部 import 增补类型，并追加三个函数。

import 改为（只引入实际用到的类型，避免未使用告警）：

```ts
import { LineEdit, shiftedLine } from "./tree";
import { LodestarStore, TreeNode } from "./types";
```

追加：

```ts
// The raw comparison anchor for a line: its trimmed text. undefined for a
// blank/whitespace-only line (no usable anchor). Counterpart of linePattern,
// but un-escaped — fed to the fuzzy resolver.
export function lineAnchorText(lineText: string): string | undefined {
  const t = lineText.trim();
  return t.length === 0 ? undefined : t;
}

const PATTERN_PREFIX = "^[^\\S\\n]*";

// Recover the raw line text from a linePattern() regex (strip the leading-
// whitespace prefix, then unescape the regex specials it escaped). Returns
// undefined if the string isn't one of our patterns.
export function patternToText(pattern: string): string | undefined {
  if (!pattern.startsWith(PATTERN_PREFIX)) return undefined;
  const body = pattern.slice(PATTERN_PREFIX.length);
  return body.replace(/\\([.*+?^${}()|[\]\\])/g, "$1");
}

// One-time, idempotent: give every tag a `text` anchor. Tags that predate the
// fuzzy model have only `pattern`; derive `text` from it so they get fuzzy
// recovery immediately. `pattern` is left untouched (URL/legacy still use it).
export function backfillAnchorText(store: LodestarStore): void {
  const walk = (nodes: TreeNode[]): void => {
    for (const node of nodes) {
      if (node.type === "folder") {
        walk(node.children);
      } else if (node.text === undefined && node.pattern) {
        const t = patternToText(node.pattern);
        if (t !== undefined) node.text = t;
      }
    }
  };
  walk(store.tree);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/lodestar/relocate.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/lodestar/relocate.ts test/lodestar/relocate.test.ts
git commit -m "feat(code-jump-tags): lineAnchorText/patternToText/backfillAnchorText 锚点文字与旧数据回填

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: 数据模型加性字段 `text`（TagNode / CodeTourStep / adapter）

**Files:**
- Modify: `src/lodestar/types.ts:9`（`TagNode` 加 `text?`）
- Modify: `src/store/index.ts:36`（`CodeTourStep` 加 `text?`）
- Modify: `src/lodestar/adapter.ts:7-17`（`tagToStep` 透传 `text`）
- Test: `test/lodestar/adapter.test.ts`（追加一例）

**Interfaces:**
- Produces: `TagNode.text?: string`、`CodeTourStep.text?: string`；`tagToStep` 在 `tag.text` 存在时设 `step.text`。
- Consumes: 无（纯类型 + 适配）。

- [ ] **Step 1: 写失败测试**

在 `test/lodestar/adapter.test.ts` 追加（沿用该文件已有 import 风格；若无 `TagNode` import 则补 `import { TagNode } from "../../src/lodestar/types";`，并 import `folderToTour`）：

```ts
import { folderToTour } from "../../src/lodestar/adapter";
import { FolderNode } from "../../src/lodestar/types";

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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/lodestar/adapter.test.ts`
Expected: FAIL（`step.text` 为 undefined / 类型不存在）。

- [ ] **Step 3: 实现**

`src/lodestar/types.ts`，在 `pattern?` 行后加：

```ts
  pattern?: string;    // line-content regex for drift recovery (URL/legacy)
  text?: string;       // raw trimmed line text — anchor for fuzzy recovery
```

`src/store/index.ts`，在 `pattern?: string;` 行后加：

```ts
  pattern?: string;
  text?: string; // Code Jump Tags: raw line text anchor for fuzzy recovery
```

`src/lodestar/adapter.ts`，`tagToStep` 内 `if (tag.pattern) ...` 行后加：

```ts
  if (tag.pattern) step.pattern = tag.pattern;
  if (tag.text) step.text = tag.text;
  if (tag.notePosition) step.notePosition = tag.notePosition;
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/lodestar/adapter.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/lodestar/types.ts src/store/index.ts src/lodestar/adapter.ts test/lodestar/adapter.test.ts
git commit -m "feat(code-jump-tags): TagNode/CodeTourStep 加性 text 锚点字段 + adapter 透传

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `reanchorTag` 升级为 text 优先、回退旧正则

**Files:**
- Modify: `src/lodestar/relocate.ts`（`TagAnchor` 与 `reanchorTag`）
- Test: `test/lodestar/relocate.test.ts`（改写既有 reanchorTag 块的输入/断言并补新例）

**Interfaces:**
- Consumes: `resolveLineFuzzy`、`resolveLine`、`lineAnchorText`、`linePattern`、`shiftedLine`。
- Produces:
  - `TagAnchor` 改为 `{ line: number; text?: string; pattern?: string }`。
  - `reanchorTag(text, anchor, edits): TagAnchor` —— 先 `shiftedLine` 得 center；解析行 = `anchor.text` 存在则 `resolveLineFuzzy(text, center+1, anchor.text)`，否则 `resolveLine(text, center+1, anchor.pattern)`；最后用解析行当前文字**同时刷新 `text` 和 `pattern`**（空行则各自 `undefined`，保底回退旧值）。返回 `{ line, text, pattern }`。

- [ ] **Step 1: 改测试为新接口（先让它失败）**

把 `test/lodestar/relocate.test.ts` 中 `describe("reanchorTag ...")` 整块替换为：

```ts
describe("reanchorTag (persisted live re-anchoring)", () => {
  const ins = (line: number, n: number): LineEdit => ({
    start: line,
    end: line,
    endChar: 0,
    delta: n
  });

  it("shifts the line down when lines are inserted above, refreshing both anchors", () => {
    const text = ["a", "b", "c", "d", "  doThing();", "f"].join("\n");
    const after = reanchorTag(text, { line: 2, text: "doThing();" }, [ins(0, 3)]);
    expect(after.line).toBe(5);
    expect(after.text).toBe("doThing();");
    expect(after.pattern).toBe(linePattern("  doThing();"));
  });

  it("recovers the true line by FUZZY content when the incremental shift is wrong", () => {
    const lines = Array.from({ length: 36 }, (_, i) => `line${i + 1}`);
    lines[34] = "  OverFlowEnable;"; // 1-based line 35
    const text = lines.join("\n");
    const after = reanchorTag(text, { line: 29, text: "OverFlowEnable;" }, [
      { start: 0, end: 33, endChar: 0, delta: 6 }
    ]);
    expect(after.line).toBe(35);
  });

  it("refreshes the text anchor to the line's new content", () => {
    const text = ["x", "  newName();", "y"].join("\n");
    const after = reanchorTag(text, { line: 2, text: "newName();" }, []);
    expect(after.line).toBe(2);
    expect(after.text).toBe("newName();");
  });

  it("falls back to legacy regex pattern when the tag has no text", () => {
    const lines = Array.from({ length: 36 }, (_, i) => `line${i + 1}`);
    lines[34] = "  OverFlowEnable;";
    const text = lines.join("\n");
    const pat = linePattern("  OverFlowEnable;");
    const after = reanchorTag(text, { line: 29, pattern: pat }, [
      { start: 0, end: 33, endChar: 0, delta: 6 }
    ]);
    expect(after.line).toBe(35);
    expect(after.text).toBe("OverFlowEnable;"); // refreshed from the resolved line
  });

  it("tracks by line number alone when the tag has neither text nor pattern", () => {
    const text = ["a", "b", "  x();", "d"].join("\n");
    const after = reanchorTag(text, { line: 1 }, [ins(0, 2)]);
    expect(after.line).toBe(3);
  });

  it("a mid-line split keeps the tag on the upper half and re-anchors to it", () => {
    // line 2 "if (a > b) { foo(); }" split after "{" -> upper "if (a > b) {"
    const text = ["void a(){", "if (a > b) {", "foo(); }", "}"].join("\n");
    // emulate the split edit: a newline inserted mid-line on line index 1
    const after = reanchorTag(
      text,
      { line: 2, text: "if (a > b) { foo(); }" },
      [{ start: 1, end: 1, endChar: 12, delta: 1 }]
    );
    expect(after.line).toBe(2);            // stays on the upper half
    expect(after.text).toBe("if (a > b) {"); // re-anchored to the upper half
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/lodestar/relocate.test.ts`
Expected: FAIL（旧 `reanchorTag` 用 `anchor.pattern` 做解析、返回 `{line,pattern}`，新断言对 `text` 不满足）。

- [ ] **Step 3: 实现**

在 `src/lodestar/relocate.ts`：确保 import 含 `lineAnchorText`（同文件内已定义，无需 import）。替换 `TagAnchor` 与 `reanchorTag`：

```ts
// A tag's position anchor: 1-based line plus optional recovery anchors.
// `text` (raw line text) drives fuzzy recovery; `pattern` (regex) is kept for
// the URL deep-link / legacy step layer and as a fallback for un-migrated tags.
export interface TagAnchor {
  line: number;
  text?: string;
  pattern?: string;
}

// Re-anchor a tag after a document change. (1) shift the stored line by the
// incremental edits, then (2) let content recovery override that guess: fuzzy
// on `text` when present, else the legacy regex on `pattern`. Finally refresh
// BOTH anchors from the resolved line's current text so neither goes stale.
export function reanchorTag(
  text: string,
  anchor: TagAnchor,
  edits: LineEdit[]
): TagAnchor {
  const shifted1 = shiftedLine(anchor.line - 1, edits) + 1;
  const resolved1 = anchor.text
    ? resolveLineFuzzy(text, shifted1, anchor.text)
    : resolveLine(text, shifted1, anchor.pattern);
  const line = Math.max(1, resolved1);

  const lines = text.split(/\r?\n/);
  const current = lines[line - 1];
  const newText =
    current !== undefined ? lineAnchorText(current) ?? anchor.text : anchor.text;
  const newPattern =
    current !== undefined ? linePattern(current) ?? anchor.pattern : anchor.pattern;

  return { line, text: newText, pattern: newPattern };
}
```

> 注：`resolveLine`、`linePattern` 保持原样不删（URL/legacy 仍用）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/lodestar/relocate.test.ts`
Expected: PASS（全部，含 `resolveLine`/`linePattern` 原有用例）。

- [ ] **Step 5: 提交**

```bash
git add src/lodestar/relocate.ts test/lodestar/relocate.test.ts
git commit -m "feat(code-jump-tags): reanchorTag 改 text 优先模糊解析、回退旧正则、双锚刷新

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: 接入消费方（解析助手 + editThread/decorator/recorder/persistence）

**Files:**
- Modify: `src/lodestar/relocate.ts`（新增 `resolveAnchoredLine` 助手）
- Modify: `src/lodestar/editThread.ts:106`
- Modify: `src/player/decorator.ts:65`、`decorator.ts:202-205`（reanchor 传/存 `text`）
- Modify: `src/recorder/commands.ts:394, 429-437`（建标签存 `text`）
- Modify: `src/lodestar/persistence.ts:6, 49`（load 后回填 `text`）
- Test: `test/lodestar/relocate.test.ts`（`resolveAnchoredLine` 单测）

**Interfaces:**
- Produces: `export function resolveAnchoredLine(text: string, line: number, anchorText?: string, pattern?: string): number` —— `anchorText` 存在走 `resolveLineFuzzy`，否则 `pattern` 存在走 `resolveLine`，否则返回 `line`。
- Consumes: `backfillAnchorText`（Task 3）、`lineAnchorText`（Task 3）、`reanchorTag` 新签名（Task 5）。

- [ ] **Step 1: 写失败测试（仅纯助手）**

追加：

```ts
import { resolveAnchoredLine } from "../../src/lodestar/relocate";

describe("resolveAnchoredLine", () => {
  const text = ["void a(){", "  doThing();", "}", "", "uniqueXYZ();"].join("\n");
  it("uses fuzzy text anchor when present", () => {
    expect(resolveAnchoredLine(text, 2, "uniqueXYZ();")).toBe(5);
  });
  it("falls back to regex pattern when no text", () => {
    expect(resolveAnchoredLine(text, 2, undefined, "uniqueXYZ\\(\\);")).toBe(5);
  });
  it("returns the line when neither anchor is given", () => {
    expect(resolveAnchoredLine(text, 3)).toBe(3);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/lodestar/relocate.test.ts`
Expected: FAIL（`resolveAnchoredLine` 未导出）。

- [ ] **Step 3a: 实现助手**

在 `src/lodestar/relocate.ts` 追加：

```ts
// Unified resolve for a tag/step: prefer the fuzzy text anchor, fall back to
// the legacy regex pattern, else trust the stored line. One choke point for
// every place that turns a stored line into a display line.
export function resolveAnchoredLine(
  text: string,
  line: number,
  anchorText?: string,
  pattern?: string
): number {
  if (anchorText) return resolveLineFuzzy(text, line, anchorText);
  if (pattern) return resolveLine(text, line, pattern);
  return line;
}
```

- [ ] **Step 3b: editThread.ts**

`src/lodestar/editThread.ts:16` 把 import 改为：

```ts
import { resolveAnchoredLine } from "./relocate";
```

`editThread.ts:106` 改为：

```ts
  const resolved = resolveAnchoredLine(doc.getText(), tag.line, tag.text, tag.pattern);
```

- [ ] **Step 3c: decorator.ts 解析路径**

`src/player/decorator.ts:10` 的 import 改为（`resolveLine` 改完 line 65 后在本文件不再被使用，去掉以免未使用告警；`decorator.ts:66-67` 用的是 `new RegExp(step.pattern)`，不依赖 `resolveLine`）：

```ts
import { reanchorTag, resolveAnchoredLine } from "../lodestar/relocate";
```

`decorator.ts:65` 改为（`step.text` 来自 adapter 透传）：

```ts
          line = resolveAnchoredLine(contents, step.line, step.text, step.pattern) - 1;
```

`decorator.ts:66-67` 的 `else if (step.pattern)` 正则兜底**保持不变**。

- [ ] **Step 3d: decorator.ts reanchor 传/存 text**

`decorator.ts:202-205` 改为：

```ts
    const after = reanchorTag(
      text,
      { line: node.line, text: node.text, pattern: node.pattern },
      edits
    );
    if (
      after.line !== node.line ||
      after.pattern !== node.pattern ||
      after.text !== node.text
    ) {
      node.line = after.line;
      node.pattern = after.pattern;
      node.text = after.text;
      changed++;
    }
```

- [ ] **Step 3e: recorder/commands.ts 建标签存 text**

`src/recorder/commands.ts:27` 区域的 import（`import { linePattern } from "../lodestar/relocate";`）改为：

```ts
import { linePattern, lineAnchorText } from "../lodestar/relocate";
```

`recorder/commands.ts:394` 后增补一行：

```ts
      const pattern = lineText ? linePattern(lineText) : undefined;
      const text = lineText ? lineAnchorText(lineText) : undefined;
```

`recorder/commands.ts:429-437` 的 `tag` 字面量在 `pattern,` 后加 `text,`：

```ts
        line,
        pattern,
        text,
        createdAt: new Date().toISOString()
```

- [ ] **Step 3f: persistence.ts 回填**

`src/lodestar/persistence.ts:6` import 增补 `backfillAnchorText`（来自 relocate，不是 tree）。在文件顶部 import 区加一行：

```ts
import { backfillAnchorText } from "./relocate";
```

`persistence.ts:49`（`migrateLooseTags(cache, newFolderId);` 之后）加：

```ts
  migrateLooseTags(cache, newFolderId);
  backfillAnchorText(cache);
```

- [ ] **Step 4: 跑单测 + 构建**

Run: `npx vitest run`
Expected: PASS（全部测试套件）。

Run: `npm run build`
Expected: webpack 成功，**零错误零警告**。

- [ ] **Step 5: 提交**

```bash
git add src/lodestar/relocate.ts src/lodestar/editThread.ts src/player/decorator.ts src/recorder/commands.ts src/lodestar/persistence.ts test/lodestar/relocate.test.ts
git commit -m "feat(code-jump-tags): 接入 text 锚点(editThread/decorator/recorder/persistence)+resolveAnchoredLine

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: RC3 —— 行内编辑(delta=0)刷新被改行锚点

**Files:**
- Modify: `src/player/decorator.ts:166-223`（`trackLineShifts` 去早退 + 行内刷新）
- Test: 无新单测（vscode 耦合）；靠 `npm run build` + 全量 vitest 绿 + 手动验证说明。

**Interfaces:**
- Consumes: `lineAnchorText`、`linePattern`（relocate）、`findNode`（tree）、`getStore`、`rebuildTours`、`debouncedSaveStore`、`updateDecorations`（decorator 现有依赖）。

- [ ] **Step 1: 改实现（去早退 + 行内刷新分支）**

`src/player/decorator.ts:10` import 增补 `lineAnchorText`、`linePattern`（仍不含 `resolveLine`）：

```ts
import {
  reanchorTag,
  resolveAnchoredLine,
  lineAnchorText,
  linePattern
} from "../lodestar/relocate";
```

`decorator.ts:180-182` 把：

```ts
  if (edits.every(edit => edit.delta === 0)) {
    return; // pure same-line text edit — no lines added/removed
  }
```

替换为（RC3：行内编辑不再早退，改为只刷新被改行上的标签锚点）：

```ts
  // RC3: a pure same-line edit (no lines added/removed) doesn't move any tag,
  // but it DOES change the edited line's text — refresh those tags' anchors so
  // they never go stale and prime a wrong fuzzy jump on the next structural
  // edit / reopen.
  if (edits.every(edit => edit.delta === 0)) {
    const editedLines0 = new Set<number>();
    for (const c of e.contentChanges) {
      for (let ln = c.range.start.line; ln <= c.range.end.line; ln++) {
        editedLines0.add(ln);
      }
    }
    const steps0 = await getTourSteps(e.document);
    const lines0 = e.document.getText().split(/\r?\n/);
    const cache0 = getStore();
    let touched = 0;
    for (const [, step] of steps0) {
      if (!step.id) continue;
      const found = findNode(cache0, step.id);
      if (!found || found.node.type !== "tag") continue;
      const node = found.node;
      if (!editedLines0.has(node.line - 1)) continue;
      const cur = lines0[node.line - 1];
      if (cur === undefined) continue;
      const t = lineAnchorText(cur);
      const p = linePattern(cur);
      if (t !== node.text || p !== node.pattern) {
        node.text = t;
        node.pattern = p;
        touched++;
      }
    }
    if (touched > 0) {
      rebuildTours();
      debouncedSaveStore();
    } else if (vscode.window.activeTextEditor?.document === e.document) {
      updateDecorations(vscode.window.activeTextEditor);
    }
    return;
  }
```

（`linePattern`、`lineAnchorText` 已在本任务开头那行 import 一并引入，无需重复。）

> 说明：原 `decorator.ts:216-222` 的 else 分支（“lines added/removed but no tag moved → 重绘去除 gutter 拖影”）仍保留在 delta≠0 路径末尾，不动。本次只改 delta=0 这一支。

- [ ] **Step 2: 构建 + 全量单测**

Run: `npm run build`
Expected: webpack 成功，零错误零警告。

Run: `npx vitest run`
Expected: PASS（全部）。

- [ ] **Step 3: 手动验证（打包安装后）**

```bash
npx @vscode/vsce package --no-dependencies
"/c/Users/dell/AppData/Local/Programs/Microsoft VS Code/bin/code.cmd" --install-extension "$(ls -t *.vsix | head -1)" --force
```

reload 后逐项确认（在一个含「被宏 `#if 0` 关掉的同名孪生函数」的 C 文件里）：
1. 在标签行中间插一个字符 / 删一个词间空格 —— 标签不跳、note 跟随。
2. 把整行逐字改写后再在上方插一行 —— 标签不跳到孪生副本。
3. 关闭文件 → 用外部编辑器在上方插 30 行 → 重开 —— 标签就近找回到正确行，不落到孪生副本。
4. 标签行中间敲回车拆成两行 —— 标签留在上半行。

- [ ] **Step 4: 提交**

```bash
git add src/player/decorator.ts
git commit -m "fix(code-jump-tags): RC3 行内编辑刷新被改行锚点(去 delta=0 早退)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 收尾（全部任务后）

- [ ] 在 `docs/code-jump-tags/功能-代码对照.md` 补「标签行重定位：就近+模糊」一节（指向 `relocate.ts` 的 `resolveLineFuzzy`/`similarity`/`reanchorTag` 与 `decorator.ts` 的 RC3 分支）。
- [ ] 走 `superpowers:requesting-code-review` 做整分支评审。
- [ ] 评审通过后按既有发布流程（bump version + CHANGELOG + tag push 触发 publish + 本地 `code --install-extension --force`）发版；本计划本身不含 version bump。

## 自检记录（spec 覆盖）

- RC1（模糊容忍）→ Task 1+2。RC2（就近、不被远副本吸走）→ Task 2。RC3（行内刷新）→ Task 7。
- 加性 `text`、保留 `pattern` → Task 4；旧数据回填 → Task 3+6f。
- 拆行策略（留上半行）→ Task 5 用例 + Task 7 手验。
- 阈值 0.9 / 窗口 8,40,∞ / 截断 200 → Task 1 常量。
- 两层分工（实时主力 / 模糊仅恢复）→ 由 Task 5（reanchor 中心快路径）+ Task 7（实时刷新）共同落实；正常编辑相似度恒高，模糊扩圈仅在重开未见变动时触发。
```
