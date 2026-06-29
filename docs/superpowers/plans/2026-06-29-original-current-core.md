# 0.7.0 original/current 匹配 — Plan 1/3：身份核心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给标签加上对机器只读的身份锚 `original`，并把冷恢复（重开/pull 后定位）改成「先 original 后 current」二重匹配，为后续可疑态 UX 打地基。

**Architecture:** 纯逻辑优先（`src/lodestar/` 下零 `vscode` 依赖的模块，vitest 覆盖），再接薄薄的胶水层（decorator / editThread / goto 三处显示与跳转路由）。本期不做任何可疑态 UI、不做触发点设置、不发版——这些在 Plan 2/3。

**Tech Stack:** TypeScript、vitest（纯逻辑单测）、VS Code 扩展 API、webpack（`npm run build`）。

## Global Constraints

- 只在 `C:\Users\dell\Desktop\plugin-research\codetour` 工作；不碰 `C:\Users\dell\Desktop\需求`。
- 每个 commit 末尾追加：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- 不提交 vsix（`*.vsix` 已 gitignore）。
- `src/lodestar/` 下的纯模块（types/tree/relocate/moveJournal/selection/adapter）**禁止 `import vscode`**。
- 仓库直接在 `main` 上工作（个人 fork）。
- 设计依据：`docs/superpowers/specs/2026-06-29-original-current-matching-design.md`。
- 单阈值 `SIMILARITY_THRESHOLD = 0.9`（已存在于 `relocate.ts:4`），本期不新增阈值常量。
- `line` 为 1-based。`original`/`text`(current) 均存 trim 后的行文字。
- **铁律：本期任何代码路径都不得自动写 `original`；只有「建标签」和「用户显式 retargetTag」写它。**
- 本期 **不** 改 `package.json` 版本号、**不** 改 CHANGELOG、**不** 发版（0.7.0 三个 plan 全部落地后一次性发）。
- 提交信息用仓库惯例前缀 `feat(code-jump-tags): …` / `test(code-jump-tags): …` / `refactor(code-jump-tags): …`。
- vitest 运行：单文件 `npx vitest run test/lodestar/<file>.test.ts`；全量 `npx vitest run`。构建：`npm run build`。

---

## File Structure

- `src/lodestar/types.ts` — `TagNode` 增 `original?: string`（数据模型，纯）。
- `src/lodestar/relocate.ts` — 新增 `findAnchorLine`（严格定位，未命中返回 0）、`matchAnchor`（二重匹配）、`resolveTagLine`（显示/跳转单一咽喉）、`backfillOriginal`（幂等回填）。纯。
- `src/lodestar/tree.ts` — `retargetTag` 改为同时写 `original`。纯。
- `src/lodestar/adapter.ts` — `tagToStep` 把 `original` 带进 `CodeTourStep`。纯。
- `src/store/index.ts`（或定义 `CodeTourStep` 的文件）— `CodeTourStep` 增 `original?: string`（类型声明）。
- `src/lodestar/persistence.ts` — `loadStore` 调 `backfillOriginal`。胶水。
- `src/recorder/commands.ts` — 建标签时 `original: text`。胶水。
- `src/player/decorator.ts` — 显示行改走 `resolveTagLine`（original 优先）。胶水。
- `src/lodestar/editThread.ts` — 编辑气泡定位改走 `resolveTagLine`。胶水。
- `src/lodestar/commands.ts` — `gotoLocation` 跳转改走 `resolveTagLine`（按 file+line 反查 tag 取 original/current）。胶水。
- 测试：`test/lodestar/relocate.test.ts`（追加）、`test/lodestar/tree.test.ts`（追加）。

---

## Task 1: 数据模型 — TagNode 与 CodeTourStep 增 `original`

**Files:**
- Modify: `src/lodestar/types.ts:3-14`
- Modify: `src/lodestar/adapter.ts:7-18`
- Modify: `CodeTourStep` 定义处（见 Step 3 定位）

**Interfaces:**
- Produces: `TagNode.original?: string`（建标签/人显式 retarget 那刻的行文字 trim；对机器只读，匹配/恢复的裁判）。`CodeTourStep.original?: string`。

- [ ] **Step 1: 给 TagNode 加字段**

在 `src/lodestar/types.ts` 的 `TagNode` 接口里，`text?` 那行下方加：

```ts
  text?: string;       // raw trimmed line text — current anchor (live, may be poisoned)
  original?: string;   // identity anchor: trimmed line text at创建/人显式重设. 机器只读, 匹配裁判
```

（保留 `text?` 原注释里的语义说明，把它的角色明确为 current。）

- [ ] **Step 2: adapter 把 original 带进 step**

在 `src/lodestar/adapter.ts` 的 `tagToStep`，`if (tag.text) step.text = tag.text;` 那行下方加：

```ts
  if (tag.original) step.original = tag.original;
```

- [ ] **Step 3: CodeTourStep 类型加字段**

定位声明：`npx tsc --noEmit` 前先找到 `CodeTourStep` 接口。运行：

Run: `grep -rn "interface CodeTourStep" src/`
Expected: 命中一个文件（很可能 `src/store/index.ts`）。

在该接口里，与 `text?` / `pattern?` 同级处加一行：

```ts
  original?: string;
```

- [ ] **Step 4: 类型编译通过**

Run: `npx tsc --noEmit`
Expected: 无新增错误（与改动前的基线一致）。

- [ ] **Step 5: Commit**

```bash
git add src/lodestar/types.ts src/lodestar/adapter.ts src/store
git commit -m "feat(code-jump-tags): TagNode/CodeTourStep 增 original 身份锚字段

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `findAnchorLine` — 严格定位（未命中返回 0）

**Files:**
- Modify: `src/lodestar/relocate.ts`（在 `resolveLineFuzzy` 函数下方新增）
- Test: `test/lodestar/relocate.test.ts`（追加）

**Interfaces:**
- Consumes: 现有 `normalizeWs`、`similarity`、`SIMILARITY_THRESHOLD`、`SEARCH_RADII`（同文件）。
- Produces: `findAnchorLine(text: string, centerLine: number, anchorText?: string): number` —— 距离优先同心圈找 `anchorText`，命中返回 1-based 行号；**未命中返回 0**（不像 `resolveLineFuzzy` 盲回退到 centerLine）。

- [ ] **Step 1: 写失败测试**

在 `test/lodestar/relocate.test.ts` 末尾追加（确认顶部已 `import { ... } from "../../src/lodestar/relocate";`，把 `findAnchorLine` 加进 import）：

```ts
describe("findAnchorLine", () => {
  const text = ["alpha", "beta", "gamma", "delta"].join("\n");

  it("returns the center line when it matches", () => {
    expect(findAnchorLine(text, 2, "beta")).toBe(2);
  });

  it("finds a moved line by distance-first ring search", () => {
    expect(findAnchorLine(text, 1, "delta")).toBe(4);
  });

  it("returns 0 when nothing clears the bar (no blind fallback)", () => {
    expect(findAnchorLine(text, 2, "nonexistent-zzz")).toBe(0);
  });

  it("returns 0 for empty/blank anchor", () => {
    expect(findAnchorLine(text, 2, "")).toBe(0);
    expect(findAnchorLine(text, 2, undefined)).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试看它失败**

Run: `npx vitest run test/lodestar/relocate.test.ts`
Expected: FAIL — `findAnchorLine is not a function` / 未导出。

- [ ] **Step 3: 实现**

在 `src/lodestar/relocate.ts` 的 `resolveLineFuzzy` 函数结束（`}` 后）下方新增：

```ts
// Strict distance-first resolver: like resolveLineFuzzy but returns 0 (not the
// center line) when NO line clears the similarity bar, so callers can tell a
// real match from a miss. 1-based; 0 = miss.
export function findAnchorLine(
  text: string,
  centerLine: number,
  anchorText?: string
): number {
  if (!anchorText) return 0;
  const target = normalizeWs(anchorText);
  if (target.length === 0) return 0;

  const lines = text.split(/\r?\n/);
  const center0 = centerLine - 1;
  const simAt = (i: number): number => {
    const l = lines[i];
    return l === undefined ? -1 : similarity(normalizeWs(l), target);
  };

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
    if (!isFinite(R)) break;
  }
  return 0;
}
```

- [ ] **Step 4: 跑测试看它通过**

Run: `npx vitest run test/lodestar/relocate.test.ts`
Expected: PASS（含原有用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/lodestar/relocate.ts test/lodestar/relocate.test.ts
git commit -m "feat(code-jump-tags): findAnchorLine 严格定位(未命中返0)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `matchAnchor` — 二重匹配（先 original 后 current）

**Files:**
- Modify: `src/lodestar/relocate.ts`（`findAnchorLine` 下方新增）
- Test: `test/lodestar/relocate.test.ts`

**Interfaces:**
- Consumes: `findAnchorLine`。
- Produces:
  ```ts
  export type AnchorMatch =
    | { status: "original"; line: number }  // original 命中 → 自愈/跳转
    | { status: "current"; line: number }   // original 失败, current 命中 → 软可疑候选
    | { status: "lost"; line: number };     // 两者皆失 → 硬可疑; line = 回退(中心行)
  export function matchAnchor(text: string, centerLine: number, original?: string, current?: string): AnchorMatch;
  ```

- [ ] **Step 1: 写失败测试**

把 `matchAnchor`、`AnchorMatch` 加进该测试文件的 import，并追加：

```ts
describe("matchAnchor (二重匹配)", () => {
  it("matches original first and reports original", () => {
    const text = ["int foo(a)", "int bar(b)"].join("\n");
    expect(matchAnchor(text, 1, "int foo(a)", "int foo(a)")).toEqual({
      status: "original",
      line: 1
    });
  });

  it("falls to current when original is gone (renamed line)", () => {
    // original 描述老名字(已不在), current 描述改名后的行(在第2行)
    const text = ["x", "int computeCrc16(buf)"].join("\n");
    const m = matchAnchor(text, 1, "int computeCrc(buf)", "int computeCrc16(buf)");
    expect(m).toEqual({ status: "current", line: 2 });
  });

  it("reports lost when neither matches, line = center fallback", () => {
    const text = ["totally", "different"].join("\n");
    expect(matchAnchor(text, 2, "old-aaa", "new-bbb")).toEqual({
      status: "lost",
      line: 2
    });
  });
});
```

- [ ] **Step 2: 跑测试看它失败**

Run: `npx vitest run test/lodestar/relocate.test.ts`
Expected: FAIL — `matchAnchor is not a function`。

- [ ] **Step 3: 实现**

在 `findAnchorLine` 下方新增：

```ts
// Cold-recovery double match: try the immutable judge `original` first, then the
// live cache `current`. Both via findAnchorLine (distance-first ring around
// centerLine). 1-based. status tells the caller whether to heal silently
// (original), offer a soft-suspect candidate (current), or give up (lost).
export type AnchorMatch =
  | { status: "original"; line: number }
  | { status: "current"; line: number }
  | { status: "lost"; line: number };

export function matchAnchor(
  text: string,
  centerLine: number,
  original?: string,
  current?: string
): AnchorMatch {
  const o = findAnchorLine(text, centerLine, original);
  if (o > 0) return { status: "original", line: o };
  const c = findAnchorLine(text, centerLine, current);
  if (c > 0) return { status: "current", line: c };
  return { status: "lost", line: centerLine };
}
```

- [ ] **Step 4: 跑测试看它通过**

Run: `npx vitest run test/lodestar/relocate.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lodestar/relocate.ts test/lodestar/relocate.test.ts
git commit -m "feat(code-jump-tags): matchAnchor 先original后current二重匹配

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `resolveTagLine` — 显示/跳转单一咽喉

**Files:**
- Modify: `src/lodestar/relocate.ts`（`matchAnchor` 下方新增）
- Test: `test/lodestar/relocate.test.ts`

**Interfaces:**
- Consumes: `matchAnchor`、现有 `resolveLine`（pattern 兜底）。
- Produces: `resolveTagLine(text: string, line: number, original?: string, current?: string, pattern?: string): number` —— 显示/跳转都用它，1-based 进出。先二重匹配；都失则 pattern 兜底；再失则原样返回 line。

- [ ] **Step 1: 写失败测试**

把 `resolveTagLine` 加进 import，追加：

```ts
describe("resolveTagLine", () => {
  it("prefers original-matched line", () => {
    const text = ["a", "needle()", "b"].join("\n");
    expect(resolveTagLine(text, 1, "needle()", "needle()")).toBe(2);
  });

  it("uses current when original fails", () => {
    const text = ["a", "renamed()", "b"].join("\n");
    expect(resolveTagLine(text, 1, "oldname()", "renamed()")).toBe(2);
  });

  it("falls back to pattern when both anchors miss", () => {
    const text = ["a", "  target;", "b"].join("\n");
    // 故意 original/current 都对不上, 只有 pattern 命中
    const pattern = "^[^\\S\\n]*target;";
    expect(resolveTagLine(text, 1, "zzz", "yyy", pattern)).toBe(2);
  });

  it("returns stored line when everything misses", () => {
    const text = ["a", "b", "c"].join("\n");
    expect(resolveTagLine(text, 2, "zzz", "yyy")).toBe(2);
  });
});
```

- [ ] **Step 2: 跑测试看它失败**

Run: `npx vitest run test/lodestar/relocate.test.ts`
Expected: FAIL — `resolveTagLine is not a function`。

- [ ] **Step 3: 实现**

在 `matchAnchor` 下方新增：

```ts
// The single choke point that turns a stored tag line into a display/jump line.
// Original-first double match, then the legacy regex pattern, else the stored
// line. Marker and jump MUST both call this so they always agree.
export function resolveTagLine(
  text: string,
  line: number,
  original?: string,
  current?: string,
  pattern?: string
): number {
  const m = matchAnchor(text, line, original, current);
  if (m.status !== "lost") return m.line;
  if (pattern) return resolveLine(text, line, pattern);
  return line;
}
```

- [ ] **Step 4: 跑测试看它通过**

Run: `npx vitest run test/lodestar/relocate.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lodestar/relocate.ts test/lodestar/relocate.test.ts
git commit -m "feat(code-jump-tags): resolveTagLine 显示/跳转单一咽喉(original优先)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `backfillOriginal` — 幂等回填旧数据

**Files:**
- Modify: `src/lodestar/relocate.ts`（`backfillAnchorText` 下方新增）
- Test: `test/lodestar/relocate.test.ts`

**Interfaces:**
- Consumes: 现有 `patternToText`、`LodestarStore`/`TreeNode`（已 import）。
- Produces: `backfillOriginal(store: LodestarStore): void` —— 给每个 `original === undefined` 的标签补 `original = text ?? patternToText(pattern)`；已有则不动；幂等。

- [ ] **Step 1: 写失败测试**

在测试文件顶部确认有 `import { backfillOriginal } from "../../src/lodestar/relocate";`（加上），并 `import type { LodestarStore } from "../../src/lodestar/types";`，追加：

```ts
describe("backfillOriginal", () => {
  function store(tag: any): LodestarStore {
    return { version: 1, tree: [{ type: "folder", id: "f", title: "x", children: [tag] }] } as any;
  }

  it("fills original from text when missing", () => {
    const s = store({ type: "tag", id: "t", note: "", file: "a", line: 1, text: "foo()" });
    backfillOriginal(s);
    expect((s.tree[0] as any).children[0].original).toBe("foo()");
  });

  it("fills original from pattern when no text", () => {
    const s = store({ type: "tag", id: "t", note: "", file: "a", line: 1, pattern: "^[^\\S\\n]*bar;" });
    backfillOriginal(s);
    expect((s.tree[0] as any).children[0].original).toBe("bar;");
  });

  it("leaves an existing original untouched (idempotent)", () => {
    const s = store({ type: "tag", id: "t", note: "", file: "a", line: 1, text: "new", original: "frozen" });
    backfillOriginal(s);
    backfillOriginal(s);
    expect((s.tree[0] as any).children[0].original).toBe("frozen");
  });
});
```

- [ ] **Step 2: 跑测试看它失败**

Run: `npx vitest run test/lodestar/relocate.test.ts`
Expected: FAIL — `backfillOriginal is not a function`。

- [ ] **Step 3: 实现**

在 `src/lodestar/relocate.ts` 的 `backfillAnchorText` 函数下方新增：

```ts
// One-time, idempotent: give every tag a frozen `original` identity anchor.
// Missing original is seeded from current `text` (or patternToText(pattern)),
// then never auto-changed again (only retargetTag / tag creation write it).
export function backfillOriginal(store: LodestarStore): void {
  const walk = (nodes: TreeNode[]): void => {
    for (const node of nodes) {
      if (node.type === "folder") {
        walk(node.children);
      } else if (node.original === undefined) {
        const seed =
          node.text ?? (node.pattern ? patternToText(node.pattern) : undefined);
        if (seed !== undefined) node.original = seed;
      }
    }
  };
  walk(store.tree);
}
```

- [ ] **Step 4: 跑测试看它通过**

Run: `npx vitest run test/lodestar/relocate.test.ts`
Expected: PASS。

- [ ] **Step 5: 接进 loadStore**

在 `src/lodestar/persistence.ts`：
- 第 7 行 import 改为：`import { backfillAnchorText, backfillOriginal } from "./relocate";`
- 第 51 行 `backfillAnchorText(cache);` 下方加一行：`backfillOriginal(cache);`

- [ ] **Step 6: 构建通过**

Run: `npm run build`
Expected: webpack 成功，0 error。

- [ ] **Step 7: Commit**

```bash
git add src/lodestar/relocate.ts src/lodestar/persistence.ts test/lodestar/relocate.test.ts
git commit -m "feat(code-jump-tags): backfillOriginal 幂等回填 + 接入 loadStore

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `retargetTag` 写 original（人显式重设身份）

**Files:**
- Modify: `src/lodestar/tree.ts:131-148`
- Test: `test/lodestar/tree.test.ts`

**Interfaces:**
- Consumes: `retargetTag(store, id, file, line, anchorText?, anchorPattern?)`（签名不变）。
- Produces: 调用成功后 `node.original === anchorText`（与 `node.text` 同值）。这是「用户确认 → 升 original」的唯一底层写点；撤回/恢复/移到光标行/粘贴到此行/采纳新位置都经它。

- [ ] **Step 1: 写失败测试**

在 `test/lodestar/tree.test.ts` 追加（确认 `retargetTag` 已在 import 列表）：

```ts
describe("retargetTag writes original", () => {
  it("sets original to the new anchor text on a successful retarget", () => {
    const store: any = {
      version: 1,
      tree: [{ type: "folder", id: "f", title: "x", children: [
        { type: "tag", id: "t", note: "", file: "a.ts", line: 1, text: "old", original: "old" }
      ] }]
    };
    const ok = retargetTag(store, "t", "b.ts", 9, "newline()", "^[^\\S\\n]*newline\\(\\)");
    expect(ok).toBe(true);
    const tag = store.tree[0].children[0];
    expect(tag.text).toBe("newline()");
    expect(tag.original).toBe("newline()");
    expect(tag.file).toBe("b.ts");
    expect(tag.line).toBe(9);
  });
});
```

- [ ] **Step 2: 跑测试看它失败**

Run: `npx vitest run test/lodestar/tree.test.ts`
Expected: FAIL — `tag.original` 仍是 `"old"`（retargetTag 还没写 original）。

- [ ] **Step 3: 实现**

在 `src/lodestar/tree.ts` 的 `retargetTag`，`found.node.text = anchorText;` 那行下方加：

```ts
  found.node.text = anchorText;
  found.node.original = anchorText; // 人显式动作 = 重设身份, 同时写裁判
  found.node.pattern = anchorPattern;
```

并更新该函数上方注释，补一句：`Also writes `original` (this is the human-explicit re-identify channel).`

- [ ] **Step 4: 跑测试看它通过**

Run: `npx vitest run test/lodestar/tree.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lodestar/tree.ts test/lodestar/tree.test.ts
git commit -m "feat(code-jump-tags): retargetTag 同时写 original(人显式重设身份)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: 建标签时写 original

**Files:**
- Modify: `src/recorder/commands.ts:430-439`

**Interfaces:**
- Consumes: 该处已有的局部变量 `text`（= `lineAnchorText(lineText)`）。
- Produces: 新建 `TagNode` 带 `original: text`。

- [ ] **Step 1: 改建标签对象**

在 `src/recorder/commands.ts` 的 `const tag: TagNode = { ... }`（约 430-439 行），把 `text,` 那行下方加一行：

```ts
        text,
        original: text,
        createdAt: new Date().toISOString()
```

- [ ] **Step 2: 构建通过**

Run: `npm run build`
Expected: webpack 成功，0 error。

- [ ] **Step 3: Commit**

```bash
git add src/recorder/commands.ts
git commit -m "feat(code-jump-tags): 建标签时写入 original 身份锚

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: 冷恢复路由切到 `resolveTagLine`（original 优先）

三处「把存储行解析成显示/跳转行」改走新咽喉，使标记与跳转一致地用 original 优先。

**Files:**
- Modify: `src/player/decorator.ts:10-15`（import）、`:70`（调用）
- Modify: `src/lodestar/editThread.ts:16`（import）、`:106`（调用）
- Modify: `src/lodestar/commands.ts:27`（import）、`gotoLocation` `:85-100`

**Interfaces:**
- Consumes: `resolveTagLine(text, line, original?, current?, pattern?)`、`findTagByLocation`（commands.ts 已 import）、`getStore`（commands.ts 已 import）。

- [ ] **Step 1: decorator 改用 resolveTagLine**

`src/player/decorator.ts`：
- import 块（10-15 行）把 `resolveAnchoredLine,` 换成 `resolveTagLine,`。
- 第 70 行：
  ```ts
  line = resolveTagLine(contents, step.line, step.original, step.text, step.pattern) - 1;
  ```

- [ ] **Step 2: editThread 改用 resolveTagLine**

`src/lodestar/editThread.ts`：
- 第 16 行：`import { resolveTagLine } from "./relocate";`
- 第 106 行：
  ```ts
  const resolved = resolveTagLine(doc.getText(), tag.line, tag.original, tag.text, tag.pattern);
  ```

- [ ] **Step 3: gotoLocation 改用 resolveTagLine（按 file+line 反查 tag 取 original/current）**

`src/lodestar/commands.ts`：
- 第 27 行 import 改为：`import { resolveTagLine, linePattern, lineAnchorText } from "./relocate";`
  （删掉 `resolveLine`——确认 `resolveLine` 在本文件已无其它用处：`grep -n "resolveLine" src/lodestar/commands.ts`，若仅此一处则删，否则保留并并列 import。）
- `gotoLocation` 函数体（85-100 行）把
  ```ts
  const text = doc.getText();
  const resolved = resolveLine(text, line, pattern);
  ```
  改为
  ```ts
  const text = doc.getText();
  const tag = findTagByLocation(getStore(), file, line);
  const resolved = resolveTagLine(text, line, tag?.original, tag?.text, pattern);
  ```

- [ ] **Step 4: 构建通过**

Run: `npm run build`
Expected: webpack 成功，0 error、0 warning。

- [ ] **Step 5: 全量单测通过**

Run: `npx vitest run`
Expected: 全绿（原有 + 本期新增）。

- [ ] **Step 6: Commit**

```bash
git add src/player/decorator.ts src/lodestar/editThread.ts src/lodestar/commands.ts
git commit -m "refactor(code-jump-tags): 冷恢复显示/跳转统一走 resolveTagLine(original优先)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: 装机自验 + 知识沉淀

**Files:**
- Modify: `docs/code-jump-tags/功能-代码对照.md`

- [ ] **Step 1: 打包并装本机**

Run:
```bash
npx vsce package
"/c/Users/dell/AppData/Local/Programs/Microsoft VS Code/bin/code.cmd" --install-extension code-jump-tags-*.vsix --force
```
Expected: 打包出 vsix（不提交），安装成功。提示用户 `Developer: Reload Window` 后做一次手动验证：建标签 → 关文件 → 外部把该行变量改名 → 重开，标签应靠 original 找回真行。

- [ ] **Step 2: 更新功能-代码对照**

在 `docs/code-jump-tags/功能-代码对照.md` 增一节「0.7.0 身份核心（Plan 1）」，记录：
- `original`(裁判, 机器只读) vs `text`(current) vs `line` 三权分立；
- 冷恢复二重匹配 `matchAnchor`/`resolveTagLine`（relocate.ts）；
- 写 original 的唯二入口：建标签（recorder/commands.ts）、`retargetTag`（tree.ts）；
- `backfillOriginal` 回填（relocate.ts + persistence.ts）。

- [ ] **Step 3: Commit**

```bash
git add docs/code-jump-tags/功能-代码对照.md
git commit -m "docs(code-jump-tags): 0.7.0 身份核心(Plan1) 功能-代码对照

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage（本期范围 = 设计稿的「数据模型」+「冷恢复二重匹配」+「铁律：机器永不写 original」+「回填」）：**
- 数据模型 `original`/`text`(current)：Task 1 ✓
- 冷恢复二重匹配（先 original 后 current）：Task 2/3/4（findAnchorLine→matchAnchor→resolveTagLine）+ Task 8 路由 ✓
- 单阈值 0.9：复用 `SIMILARITY_THRESHOLD`，未新增常量 ✓
- 回填 original：Task 5 ✓
- 写 original 唯二入口（建标签 + retargetTag）：Task 6/7 ✓
- 铁律「机器永不写 original」：live 路径（decorator trackLineShifts / reanchorTag）只动 line/text/pattern，`original` 是新字段、不被触碰——本期不引入任何自动写 original 的代码路径 ✓
- **本期不覆盖（留 Plan 2/3）**：可疑态 UI（灰/?/hover 按钮/树角标/待处理分组）、触发点设置、手动校验命令、采纳新位置/找回原行命令、版本号/CHANGELOG/发版。`matchAnchor` 的 `status`（original/current/lost = 命中/软可疑/硬可疑）已为 Plan 2 备好，本期仅消费 `line`。

**Placeholder scan:** 无 TBD/TODO；每个代码步骤给了完整代码与可运行命令。

**Type consistency:** `findAnchorLine`/`matchAnchor`/`AnchorMatch`/`resolveTagLine`/`backfillOriginal` 跨 Task 命名一致；`resolveTagLine(text, line, original, current, pattern)` 参数顺序在 Task 4 定义、Task 8 三处调用一致；`TagNode.original` / `CodeTourStep.original` 命名一致。

---

## Execution Handoff（落在 Plan 1 全部任务之后）

Plan 1 完成后，Plan 2（可疑态 UX：灰/? + hover 双行+按钮 + 树角标 + 待处理汇总分组 + 采纳新位置/找回原行命令）与 Plan 3（可配置触发点 + 手动校验命令 + 版本号/CHANGELOG/发版）各自单独写 plan。三者全部落地后，再按发布流程一次性发 0.7.0（发版前 HOLD 等用户手动验证）。
