# 0.7.0 original/current 匹配 — Plan 3/3：树侧呈现 +「待处理」分组 + 发版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **依赖 Plan 1 + Plan 2** 已落地。开工前确认 `npx vitest run` 全绿、`npm run build` 0 error，且可疑态在编辑器内已工作（灰?gutter + hover 按钮）。

**Goal:** 把可疑态搬到标签树里（? 角标 + 灰图标 + 右键动作），并加一个置顶的「待处理」虚拟汇总分组，最后一次性发布 0.7.0。

**Architecture:** 树侧全部读 Plan 2 的运行时可疑注册表（`allSuspects`/`getSuspect`）；「待处理」是只读过滤视图（合成一个 CodeTour，标签仍住原文件夹）。可疑注册表变化时主动刷新树。发版走既有 tag-push CI，发版前 HOLD 等用户手动验证。

**Tech Stack:** TypeScript、vitest、VS Code 扩展 API、webpack、GitHub Actions（publish.yml）。

## Global Constraints

- 只在 `C:\Users\dell\Desktop\plugin-research\codetour` 工作；不碰 `C:\Users\dell\Desktop\需求`。
- 每个 commit 末尾追加：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- 不提交 vsix；`src/lodestar/` 纯模块禁 `import vscode`；在 `main` 上工作。
- 设计依据：`docs/superpowers/specs/2026-06-29-original-current-matching-design.md`。
- 铁律不变：树侧任何自动路径不写 `original`；写 original 只在用户点「采纳新位置」→ retargetTag。
- **发版是「一次性、不可逆」**：tag push 触发市场发布。**发版前必须 HOLD，等用户明确说发布**（已发版本视为 burned）。
- vitest：`npx vitest run [file]`；构建：`npm run build`。提交前缀 `feat/refactor/test/docs(code-jump-tags):`。

---

## File Structure

- `src/lodestar/commands.ts`（改）— `promoteToOriginal`/`recoverToOriginal` 改为接受 node-或-id，promote 默认候选行取自注册表。
- `src/player/tree/nodes.ts`（改）— 可疑标签 ? 角标 + 灰图标 + `.suspect` contextValue。
- `src/lodestar/adapter.ts`（改，纯）— `SUSPECT_TOUR_ID` + `suspectTour`。
- `src/player/tree/index.ts`（改）—「待处理」分组、拖拽 guard、`refreshTagsTree` 导出。
- `src/player/recheck.ts`（改）— 注册表变化时 `refreshTagsTree()`。
- `package.json`（改）— view/item/context 菜单 + 版本号 0.7.0。
- `CHANGELOG.md`（改）— 0.7.0 条目。
- `docs/code-jump-tags/功能-代码对照.md`（改）。
- 测试：`test/lodestar/adapter.test.ts`（追加）。

---

## Task 1: 动作命令兼容树节点调用

**Files:**
- Modify: `src/lodestar/commands.ts`（`promoteToOriginal`/`recoverToOriginal`）

**Interfaces:**
- Consumes: `getSuspect`（suspect.ts）。
- Produces: `promoteToOriginal(arg: string | any, line?: number)`、`recoverToOriginal(arg: string | any)` —— `arg` 可为 tagId 字符串（hover 命令链接）或树节点（右键，含 `tagLink.id`/`tagId`）。promote 的 `line` 缺省时取 `getSuspect(id)?.line`（软可疑候选），再缺省用光标行。

- [ ] **Step 1: 加 import**

`src/lodestar/commands.ts` 顶部从 suspect 引入：`import { getSuspect } from "./suspect";`

- [ ] **Step 2: 归一化首参**

在 commands.ts 加一个小工具（放在 0.7.0 区块开头，`lineAnchorsAt` 之前）：

```ts
function tagIdOf(arg: string | any): string | undefined {
  if (typeof arg === "string") return arg;
  return arg?.tagLink?.id ?? arg?.tagId;
}
```

把 `promoteToOriginal` 签名/开头改为：

```ts
export async function promoteToOriginal(arg: string | any, line?: number) {
  const tagId = tagIdOf(arg);
  if (!tagId) {
    window.showInformationMessage("Code Jump Tags: 找不到该标签");
    return;
  }
  const store = getStore();
  const found = findNode(store, tagId);
  if (!found || found.node.type !== "tag") {
    window.showInformationMessage("Code Jump Tags: 找不到该标签");
    return;
  }
  const file = found.node.file;
  const candidate = line ?? getSuspect(tagId)?.line;
  const targetLine =
    candidate ?? (window.activeTextEditor?.selection.active.line ?? found.node.line - 1) + 1;
  const anchors = await lineAnchorsAt(file, targetLine);
  if (!anchors) return;
  retargetTag(store, tagId, file, targetLine, anchors.text, anchors.pattern);
  await saveStore();
  const { recheckFile } = await import("../player/recheck");
  await recheckFile(file);
  await gotoLocation(file, targetLine, anchors.pattern);
  window.setStatusBarMessage("Code Jump Tags: 已采纳为新身份", 2000);
}
```

把 `recoverToOriginal` 开头改为：

```ts
export async function recoverToOriginal(arg: string | any) {
  const tagId = tagIdOf(arg);
  if (!tagId) {
    window.showInformationMessage("Code Jump Tags: 找不到该标签");
    return;
  }
  const store = getStore();
  const found = findNode(store, tagId);
  // ...（其余函数体保持 Plan 2 原样，仅把 `tagId` 来源换成上面归一化的值）
```

- [ ] **Step 3: 构建通过**

Run: `npm run build`
Expected: 0 error。

- [ ] **Step 4: Commit**

```bash
git add src/lodestar/commands.ts
git commit -m "refactor(code-jump-tags): 可疑动作命令兼容树节点/命令链接两种调用

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: 树节点可疑 ? 角标 + 灰图标 + contextValue

**Files:**
- Modify: `src/player/tree/nodes.ts`

**Interfaces:**
- Consumes: `getSuspect`（suspect.ts）。
- Produces: 可疑标签节点 `description` 显示「⚠ 失配[·有候选]」、`iconPath` 变灰 `question`、`contextValue` 含 `.suspect`（供菜单 `viewItem =~ /suspect/`）。

- [ ] **Step 1: 加 import**

`src/player/tree/nodes.ts` 顶部加：`import { getSuspect } from "../../lodestar/suspect";`（`ThemeColor`/`ThemeIcon` 已 import）。

- [ ] **Step 2: 在 CodeTourStepNode 末尾加可疑呈现**

在 `const contextValues = ["codeJumpTags.tag"];` 这行**之前**插入：

```ts
    const suspect = step.id ? getSuspect(step.id) : undefined;
    if (suspect) {
      this.description = suspect.status === "current" ? "⚠ 失配·有候选" : "⚠ 失配";
      this.iconPath = new ThemeIcon(
        "question",
        // @ts-ignore
        new ThemeColor("disabledForeground")
      );
    }
```

在 `const contextValues = ["codeJumpTags.tag"];` 之后插入：

```ts
    if (suspect) {
      contextValues.push("suspect");
    }
```

- [ ] **Step 3: 构建通过**

Run: `npm run build`
Expected: 0 error。

- [ ] **Step 4: Commit**

```bash
git add src/player/tree/nodes.ts
git commit -m "feat(code-jump-tags): 树里可疑标签 ?角标+灰图标+suspect contextValue

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: adapter 合成「待处理」tour（纯）

**Files:**
- Modify: `src/lodestar/adapter.ts`
- Test: `test/lodestar/adapter.test.ts`

**Interfaces:**
- Produces: `export const SUSPECT_TOUR_ID = "__suspect__";`、`suspectTour(store: LodestarStore, workspaceId: string, suspectIds: string[]): CodeTour` —— 按树序收集 id ∈ suspectIds 的标签，合成只读分组 tour，title `⚠ 待处理 (n)`。

- [ ] **Step 1: 写失败测试**

`test/lodestar/adapter.test.ts` 顶部 import 加 `suspectTour, SUSPECT_TOUR_ID`，追加：

```ts
describe("suspectTour", () => {
  const store: any = {
    version: 1,
    tree: [{ type: "folder", id: "f", title: "x", children: [
      { type: "tag", id: "t1", note: "n1", file: "a.ts", line: 1 },
      { type: "tag", id: "t2", note: "n2", file: "b.ts", line: 2 },
      { type: "tag", id: "t3", note: "n3", file: "c.ts", line: 3 }
    ] }]
  };
  it("collects only suspect tags, in tree order, with a counted title", () => {
    const tour = suspectTour(store, "ws", ["t3", "t1"]);
    expect(tour.id).toBe(`ws::${SUSPECT_TOUR_ID}`);
    expect(tour.title).toBe("⚠ 待处理 (2)");
    expect(tour.steps.map(s => s.id)).toEqual(["t1", "t3"]);
  });
  it("empty when no suspects", () => {
    expect(suspectTour(store, "ws", []).steps).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试看它失败**

Run: `npx vitest run test/lodestar/adapter.test.ts`
Expected: FAIL — `suspectTour is not a function`。

- [ ] **Step 3: 实现**

`src/lodestar/adapter.ts` 末尾新增：

```ts
export const SUSPECT_TOUR_ID = "__suspect__";

// Read-only "待处理" filter view: a synthetic tour gathering the suspect tags
// (by id, in tree order). Tags still live in their real folders; this only
// mirrors them for one-shot triage.
export function suspectTour(
  store: LodestarStore,
  workspaceId: string,
  suspectIds: string[]
): CodeTour {
  const want = new Set(suspectIds);
  const tags: TagNode[] = [];
  const walk = (nodes: (FolderNode | TagNode)[]): void => {
    for (const node of nodes) {
      if (node.type === "tag") {
        if (want.has(node.id)) tags.push(node);
      } else {
        walk(node.children as (FolderNode | TagNode)[]);
      }
    }
  };
  walk(store.tree as (FolderNode | TagNode)[]);
  return {
    id: `${workspaceId}::${SUSPECT_TOUR_ID}`,
    title: `⚠ 待处理 (${tags.length})`,
    steps: tags.map(tagToStep)
  };
}
```

- [ ] **Step 4: 跑测试看它通过**

Run: `npx vitest run test/lodestar/adapter.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lodestar/adapter.ts test/lodestar/adapter.test.ts
git commit -m "feat(code-jump-tags): adapter 合成「待处理」只读分组 tour(纯)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: 树provider —「待处理」分组 + 拖拽 guard + 刷新钩子

**Files:**
- Modify: `src/player/tree/index.ts`
- Modify: `src/player/recheck.ts`

**Interfaces:**
- Consumes: `allSuspects`（suspect.ts）、`suspectTour`/`SUSPECT_TOUR_ID`（adapter.ts）。
- Produces: `export function refreshTagsTree(): void`（tree/index.ts）。

- [ ] **Step 1: getChildren 根级置顶「待处理」分组**

`src/player/tree/index.ts` 的 `getChildren`，在根分支（`if (!element) { ... }`）里，构造好 `const tours = store.tours.map(...)` 与现有 activeTour unshift 之后、`return tours;` 之前，插入：

```ts
        const { allSuspects } = await import("../../lodestar/suspect");
        const suspectIds = allSuspects().map(s => s.id);
        if (suspectIds.length > 0) {
          const { getStore, getWorkspaceId } = await import(
            "../../lodestar/persistence"
          );
          const { suspectTour } = await import("../../lodestar/adapter");
          tours.unshift(
            new CodeTourNode(
              suspectTour(getStore(), getWorkspaceId(), suspectIds),
              this.extensionPath
            )
          );
        }
```

注意：根分支开头 `if (!store.hasTours && !store.activeTour) return undefined;` 保持不变（无标签时本就没有可疑项）。

- [ ] **Step 2: 拖拽 guard —「待处理」分组节点不可拖**

在 `handleDrag` 的 `.map(s => {...})` 里，处理 `CodeTourNode` 分支改为先判合成分组：

```ts
        if (s instanceof CodeTourNode) {
          const folderId = s.tour.id.split("::").pop();
          if (folderId === "__suspect__") return undefined; // 合成分组不可拖
          return folderId || undefined;
        }
```

（`subfolderNodesOf` / `getParent` 对 `__suspect__` 会因 `findNode` 落空而自然返回 `[]`/`null`，无需额外改。）

- [ ] **Step 3: 导出 refreshTagsTree**

在 `CodeTourTreeProvider` 类里加一个公有方法（放在 `getTreeItem` 旁）：

```ts
  public refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }
```

在文件底部、`registerTreeProvider` 外层加模块级引用与导出：

```ts
let s_provider: CodeTourTreeProvider | undefined;
export function refreshTagsTree(): void {
  s_provider?.refresh();
}
```

在 `registerTreeProvider` 里 `const treeDataProvider = new CodeTourTreeProvider(extensionPath);` 之后加：`s_provider = treeDataProvider;`

- [ ] **Step 4: recheck 变化时刷新树**

`src/player/recheck.ts` 的 `recheckFile`，把变更分支改为同时刷新树：

```ts
  const changed = setFileSuspects(file, infos);
  if (changed) {
    const { refreshTagsTree } = await import("./tree");
    refreshTagsTree();
    if (window.activeTextEditor) updateDecorations(window.activeTextEditor);
  }
```

- [ ] **Step 5: 构建 + 全量测试**

Run: `npm run build && npx vitest run`
Expected: 构建 0 error/warning；测试全绿。

- [ ] **Step 6: Commit**

```bash
git add src/player/tree/index.ts src/player/recheck.ts
git commit -m "feat(code-jump-tags): 树置顶「待处理」汇总分组 + 注册表变更刷新树

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: 树右键动作菜单

**Files:**
- Modify: `package.json`（`menus.view/item/context`）

- [ ] **Step 1: 加菜单项**

在 `package.json` 的 `menus."view/item/context"` 数组里追加（紧跟现有 tag 菜单组之后）：

```json
        ,
        {
          "command": "codeJumpTags.promoteToOriginal",
          "when": "viewItem =~ /suspect/",
          "group": "suspect@1"
        },
        {
          "command": "codeJumpTags.recoverToOriginal",
          "when": "viewItem =~ /suspect/",
          "group": "suspect@2"
        }
```

- [ ] **Step 2: 校验 JSON + 构建**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('ok')" && npm run build`
Expected: `ok` + 0 error。

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat(code-jump-tags): 树右键 采纳新位置/找回原行(仅可疑标签)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: 版本号 + CHANGELOG + 知识沉淀 + 装机自验

**Files:**
- Modify: `package.json`（version）、`CHANGELOG.md`、`docs/code-jump-tags/功能-代码对照.md`

- [ ] **Step 1: 版本号 0.7.0**

`package.json` 顶部 `"version": "0.6.1"` 改为 `"version": "0.7.0"`。

- [ ] **Step 2: CHANGELOG 0.7.0 条目**

在 `CHANGELOG.md` 顶部插入（白话、面向用户）：

```markdown
## 0.7.0 - 2026-06-29
- 标签现在分「身份」和「位置」两本账:身份(original)只有你亲手确认才会变,机器自动追踪只动位置。重命名变量、整行剪切粘贴,标签都跟得住;关掉窗口后被 git pull / 外部工具改了,重开时也按身份把标签找回真行。
- 当一行内容变得和标签身份差太多、机器认不出了,标签会进入「可疑」态:编辑器 gutter 变灰带「?」,鼠标悬停显示「原身份 vs 现内容」两行对照,并给两个一键动作——
  - 「采纳新位置」:把现在这行认作新身份(对应你改了名);
  - 「找回原行」:丢掉跑偏的位置,按原身份找回真行(对应误改/污染)。
- 标签树里可疑标签带「?」角标,顶部多一个「待处理」分组,把所有可疑标签汇总到一处,便于一次清理(修完自动移出)。也能在树里右键这两个动作。
- 可疑检查只在「落定点」按文件做、不打扰你打字:默认在切回窗口 / 打开切换编辑器 / 文件被外部改动时检查;可在设置里增减(保存时、空闲后),也能用命令「重新校验当前文件的标签」手动来一发。
```

- [ ] **Step 3: 更新功能-代码对照**

增「0.7.0 树侧 + 发版（Plan 3）」一节：`suspectTour`/`SUSPECT_TOUR_ID`(adapter)、树「待处理」分组 + 拖拽 guard + `refreshTagsTree`、nodes.ts ? 角标、view/item/context 菜单、版本 0.7.0。

- [ ] **Step 4: 构建 + 全量测试 + 装机自验**

Run:
```bash
npm run build && npx vitest run
npx vsce package
"/c/Users/dell/AppData/Local/Programs/Microsoft VS Code/bin/code.cmd" --install-extension code-jump-tags-*.vsix --force
```
Reload Window 后端到端验证整套 0.7.0：建标签→改名→重开找回；制造可疑→灰?+hover/树角标/待处理分组→采纳新位置 & 找回原行均生效;切换触发点设置生效;手动校验命令生效。

- [ ] **Step 5: Commit**

```bash
git add package.json CHANGELOG.md docs/code-jump-tags/功能-代码对照.md
git commit -m "feat(code-jump-tags): 0.7.0 版本号 + CHANGELOG + 功能-代码对照

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: 发布 0.7.0（HOLD — 等用户明确放行）

**Files:** 无（git/CI 操作）

> **这一步默认 HOLD。** 已发版本不可逆(burned)。先让用户在本机用装好的 vsix 充分手动验证,**用户明确说「发布」后**再执行以下步骤。

- [ ] **Step 1: 发版前自检**

Run:
```bash
git status -s            # 工作区干净
git branch --show-current # main
grep '"version"' package.json  # 0.7.0
git tag | grep v0.7.0 || echo "no v0.7.0 tag yet"   # 尚无该 tag
npx vitest run && npm run build   # 全绿、0 error
```
Expected: 干净 / main / 0.7.0 / 无 v0.7.0 / 测试构建通过。

- [ ] **Step 2: 推 main**

```bash
git push origin main
```

- [ ] **Step 3: 打 tag 触发市场发布**

```bash
git tag v0.7.0
git push origin v0.7.0
```

- [ ] **Step 4: 看 CI**

```bash
gh run list --workflow=publish.yml -L 3
gh run watch <run-id> --exit-status
```
Expected: `completed / success`(Node 20 弃用注解是非致命警告,可忽略;若要清除,后续把 actions/checkout、actions/setup-node 升 v5)。

- [ ] **Step 5: 回报用户**

告知 0.7.0 已上架、CI run id 与结论。

---

## Self-Review

**Spec coverage（本期 = 树 ? 角标 +「待处理」分组 + 树右键动作 + 发版）：**
- 树 ? 角标 + 灰图标：Task 2 ✓
- 「待处理」只读汇总分组(标签仍住原文件夹、修完自动移出)：Task 3 `suspectTour` + Task 4 provider(读 `allSuspects`，注册表清空即从分组消失) ✓
- 树右键 采纳新位置/找回原行(仅可疑)：Task 1(命令兼容树节点) + Task 5(菜单) ✓
- 注册表变化刷新树：Task 4 `refreshTagsTree` ✓
- 合成分组不可拖：Task 4 Step 2 guard ✓
- 版本/CHANGELOG/发版(HOLD)：Task 6/7 ✓
- 铁律：树侧无自动写 original;「采纳」经 retargetTag、「找回」经 healTagToLine(不写 original) ✓

**Placeholder scan:** 无 TBD/TODO;代码步骤均给完整代码与命令。Task 7 的 `<run-id>` 是 gh 输出占位,已给取值命令。

**Type consistency:** `suspectTour(store, workspaceId, suspectIds)`/`SUSPECT_TOUR_ID` 在 adapter 定义、tree provider 调用一致;`refreshTagsTree` 在 tree/index 定义、recheck 调用一致;`promoteToOriginal`/`recoverToOriginal` 接受 node-或-id 与 Plan 2 hover 的 `[id,line]`/`[id]` 调用、树菜单的 node 调用都兼容;`.suspect` contextValue(nodes.ts) 与菜单 `viewItem =~ /suspect/`(package.json) 一致。

**跨 Plan 一致性:** 本计划消费 Plan 2 的 `getSuspect`/`allSuspects`/`setFileSuspects`/`recheckFile`、Plan 1 的 `retargetTag`(写 original)/`findAnchorLine`,签名一致。

---

## Execution Handoff

Plan 3 全部完成且用户手动验证通过后,执行 Task 7 发布 0.7.0。至此 0.7.0(original/current 双版本匹配)三个 plan 闭环。
