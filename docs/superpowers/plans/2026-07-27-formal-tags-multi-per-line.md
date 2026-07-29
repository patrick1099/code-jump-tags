# 恢复「正式标签一行多签」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 撤回正式标签的「一行一签」限制,让一行可有多条独立正式标签;行上方每条显示为独立可点的 `⌖ 注释`(多条以 ` | ` 分隔),点哪条编辑哪条、不共享编辑框。

**Architecture:** 「一行一签」只在三处**写入侧守卫**里,渲染层(装饰/CodeLens)本就逐条标签生成。改动 = 拆掉三处守卫(`+` 合并、移到光标行占用拒绝、撤回移动占用拒绝)+ 把行上方多条 CodeLens 按 `createdAt` 稳定排序、加 ` | ` 分隔(逻辑抽成纯函数上 vitest)。不新建存储、不动 inline 折叠/展开。

**Tech Stack:** TypeScript、VS Code Extension API、MobX、vitest(`test/**/*.test.ts`)、webpack。

## Global Constraints

- **加性、不破坏 inline**:inline 随手 `//me:`(0.8.0)走 `findInlineTagByLocation`,只认 `inline===true`;本计划只动正式标签路径,inline 折叠/展开/共存一个字不改。
- **纯/胶水分层**:能不依赖 `vscode` 的(CodeLens 标题拼接)放进纯模块并 vitest 覆盖;`+`、守卫、CodeLens 组装是 vscode 胶水,无自动化单测,靠 F5 手动验收。
- **编译门 = `npm run build`**(webpack);`npx tsc --noEmit` 会报既有 `@types/vscode` 环境噪声,不作数,但不得新增类型错误。**单测门 = `npm run test:unit`**(现 163 全绿,加本计划新增须全绿)。
- **`createdAt` 决定 `|` 左右序**:同行标签按 `createdAt` 升序,并列以 `id` 兜底,保证渲染顺序稳定不跳。
- **提交信息**:中文 `feat(code-jump-tags): …` / `fix(code-jump-tags): …`;作者 footer 用现有 git 配置,勿另加 Co-Authored-By;每个任务只 `git add` 该任务改的文件,勿 `git add -A`(工作区可能有无关改动)。
- **行尾样式不可点是平台限制**(装饰不能带命令),本计划只做行上方多签点击编辑;行尾 inline 靠展开编辑、一行仍只一条——均记入 CHANGELOG 已知限制。

## 文件结构(先定边界)

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/player/lensTitles.ts` | **新增**。纯函数 `lineLensTitles(notes)` → 一行各标签的 CodeLens 标题(首条 `⌖ …`、后续 `\| ⌖ …`)。无 vscode。 | Create |
| `src/store/index.ts` | `CodeTourStep` 加 `createdAt?: string`(排序用,加性)。 | Modify |
| `src/lodestar/adapter.ts` | `tagToStep` 把 `tag.createdAt` 拷进 step。 | Modify |
| `src/player/decorator.ts` | `TagCodeLensProvider` 按行分组 + 按 `createdAt` 排序 + 用 `lineLensTitles` 生成多条可点 CodeLens。 | Modify |
| `src/recorder/commands.ts` | `+` 提交总是新建(删掉「命中已有标签就改去编辑」分支)。 | Modify |
| `src/lodestar/commands.ts` | `placeTagAtCursor` / `applyMove` 删掉占用拒绝守卫。 | Modify |
| `src/lodestar/tree.ts` | 更新 `findTagByLocation` 的注释(不再「保证一行一签」)。 | Modify |
| `CHANGELOG.md` / `docs/code-jump-tags/功能-代码对照.md` | 0.8.0 段补一行多签;对照文档同步。 | Modify |

---

## Task 1: 纯函数 `lineLensTitles`

CodeLens 标题拼接的纯逻辑,先 TDD 到齐,给 Task 3 消费。

**Files:**
- Create: `src/player/lensTitles.ts`
- Test: `test/player/lensTitles.test.ts`

**Interfaces:**
- Produces: `lineLensTitles(notes: string[]): string[]` —— 入参是**已排好序**的该行各标签注释首行;返回等长标题数组:index 0 → `⌖ ${note}`(空 → `⌖`),index>0 → `| ⌖ ${note}`(空 → `| ⌖`)。

- [ ] **Step 1: 写失败测试**

```ts
// test/player/lensTitles.test.ts
import { describe, it, expect } from "vitest";
import { lineLensTitles } from "../../src/player/lensTitles";

describe("lineLensTitles", () => {
  it("单条:只有 ⌖ 前缀", () => {
    expect(lineLensTitles(["A"])).toEqual(["⌖ A"]);
  });
  it("多条:第 2 条起加 | 前缀", () => {
    expect(lineLensTitles(["A", "B", "C"])).toEqual(["⌖ A", "| ⌖ B", "| ⌖ C"]);
  });
  it("空注释:退成 ⌖ / | ⌖", () => {
    expect(lineLensTitles(["", ""])).toEqual(["⌖", "| ⌖"]);
  });
  it("空数组:返回空", () => {
    expect(lineLensTitles([])).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/player/lensTitles.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 写最小实现**

```ts
// src/player/lensTitles.ts
// 纯文本:一行内多条「行上方」标签的 CodeLens 标题。首条 `⌖ …`,后续 `| ⌖ …`,
// 视觉上拼成 `⌖ A | ⌖ B`。每条 lens 仍各自可点(命令在 decorator 里挂)。No `vscode`.
export function lineLensTitles(notes: string[]): string[] {
  return notes.map((note, i) => {
    const label = note ? `⌖ ${note}` : "⌖";
    return i === 0 ? label : `| ${label}`;
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/player/lensTitles.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/player/lensTitles.ts test/player/lensTitles.test.ts
git commit -m "feat(code-jump-tags): lineLensTitles 纯函数 — 一行多签 CodeLens 标题拼接"
```

---

## Task 2: `+` 提交总是新建(拆一行一签主闸)

`src/recorder/commands.ts` 的 `addTag` 回复处理器:删掉「`findTagByLocation` 命中已有标签就改去编辑那条」的分支,`+` 提交一律新建。

**Files:**
- Modify: `src/recorder/commands.ts`(约 :410-428 的 `if (existing) { … }` 块 + 上方注释;可能连带 `findTagByLocation` 的 import)

**Interfaces:**
- Consumes: 无(纯删除分支)。行为变化由 F5 验收。

- [ ] **Step 1: 删掉合并分支**

在 `addTag` 回复处理器里,删掉这段(含其上方「One tag per line, ONE box per line…」注释),让代码直接落到其后的「构造新 `TagNode` → `getOrCreateInbox` → `addTag` → `saveStore` → `dismiss`」:

```ts
      // One tag per line, ONE box per line. If the line is already tagged, …
      const existing = findTagByLocation(getStore(), file, line);
      if (existing) {
        dismiss();
        const hasNote = existing.note && existing.note.trim().length > 0;
        if (!hasNote && reply.text && reply.text.trim().length > 0) {
          existing.note = reply.text;
          await saveStore();
        } else {
          const { openTagEditor } = await import("../lodestar/editThread");
          await openTagEditor(existing.id);
        }
        return;
      }
```

- [ ] **Step 2: 清理可能失效的 import**

检查 `findTagByLocation` 在 `src/recorder/commands.ts` 里是否仅此一处使用(`grep -n findTagByLocation src/recorder/commands.ts`)。若删除后不再被使用,从该文件顶部 import 列表移除 `findTagByLocation`,避免未用符号。

- [ ] **Step 3: 编译**

Run: `npm run build`
Expected: 两个 webpack 目标干净,无新增类型错误(尤其别留未用 import)。

- [ ] **Step 4: 手动验收(F5 起 Extension Development Host)**

- 在一条**无标签**的行按 `+` 输入「A」提交 → 生成标签 A。
- 在**同一行**再按 `+` 输入「B」提交 → **再生成一条独立标签 B**(不再被带去编辑 A)。sidecar `store.json` 出现两条锚定同一 (file,line) 的 tag。
- 记录行为(此时行上方渲染留待 Task 3;本步只验「确实新建了第二条」——可在树/「随手」外的文件夹里看到两条,或看 store.json)。

- [ ] **Step 5: 提交**

```bash
git add src/recorder/commands.ts
git commit -m "feat(code-jump-tags): + 提交总是新建标签(撤回一行一签主闸)"
```

---

## Task 3: 行上方多签渲染 `⌖ A | ⌖ B`,各自可点

`CodeTourStep` 加 `createdAt`(排序用),`tagToStep` 拷入,`TagCodeLensProvider` 按行分组 + 按 `createdAt` 排序 + 用 Task 1 的 `lineLensTitles` 逐条出可点 CodeLens。

**Files:**
- Modify: `src/store/index.ts`(`CodeTourStep` 加 `createdAt?: string`)
- Modify: `src/lodestar/adapter.ts`(`tagToStep` 拷 `createdAt`)
- Modify: `src/player/decorator.ts`(`TagCodeLensProvider.provideCodeLenses` 重写为分组+排序+多 lens;import `lineLensTitles` 与 `CodeTourStepTuple`)

**Interfaces:**
- Consumes: `lineLensTitles`(Task 1);`CodeTourStep.createdAt`(本任务新增);`CodeTourStepTuple`(`src/store/index.ts` 已导出)。

- [ ] **Step 1: `CodeTourStep` 加 `createdAt`**

在 `src/store/index.ts` 的 `CodeTourStep` 接口尾部(`notePosition` 后)加:

```ts
  createdAt?: string; // Code Jump Tags: tag 创建时间,同行多签按此稳定排序
```

- [ ] **Step 2: `tagToStep` 拷入 `createdAt`**

在 `src/lodestar/adapter.ts` 的 `tagToStep`(:7-19)里,与其它可选字段并列加一行:

```ts
  if (tag.createdAt) step.createdAt = tag.createdAt;
```

- [ ] **Step 3: 重写 `provideCodeLenses`**

把 `src/player/decorator.ts` 的 `TagCodeLensProvider.provideCodeLenses`(:346-370)改成按行分组、排序、逐条出 lens。顶部补 import:`import { lineLensTitles } from "./lensTitles";` 与在现有 `../store` 的 import 里加 `CodeTourStepTuple`(若尚未导入)。

```ts
  async provideCodeLenses(
    document: vscode.TextDocument
  ): Promise<vscode.CodeLens[]> {
    if (!store.showMarkers || DISABLED_SCHEMES.includes(document.uri.scheme)) {
      return [];
    }

    const steps = await getTourSteps(document);
    // 只取「行上方」样式、有解析出显示行的 step。
    const above = steps.filter(
      ([, step, , line]) =>
        line !== undefined && line !== null && stepNotePosition(step) === "above"
    );

    // 按显示行分组:同一行多条标签渲染成 `⌖ A | ⌖ B`,每条 lens 各自可点、
    // 各编辑各的 tag。
    const byLine = new Map<number, CodeTourStepTuple[]>();
    for (const t of above) {
      const line = t[3]!;
      const group = byLine.get(line);
      if (group) group.push(t);
      else byLine.set(line, [t]);
    }

    const lenses: vscode.CodeLens[] = [];
    for (const [line, group] of byLine) {
      // createdAt 升序、id 兜底 → 稳定的 | 左右序。
      group.sort((a, b) => {
        const ca = a[1].createdAt ?? "";
        const cb = b[1].createdAt ?? "";
        if (ca !== cb) return ca < cb ? -1 : 1;
        return (a[1].id ?? "") < (b[1].id ?? "") ? -1 : 1;
      });
      const titles = lineLensTitles(
        group.map(([, step]) => (step.description || "").split(/\r?\n/)[0].trim())
      );
      group.forEach(([, step], i) => {
        lenses.push(
          new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
            title: titles[i],
            command: step.id ? "codeJumpTags.editNote" : "",
            arguments: step.id ? [step.id] : undefined
          })
        );
      });
    }
    return lenses;
  }
```

- [ ] **Step 4: 编译 + 全量单测**

Run: `npm run build && npm run test:unit`
Expected: webpack 干净;单测全绿(含 Task 1 的 lensTitles)。

- [ ] **Step 5: 手动验收(F5)**

- 承 Task 2:同一行有 A、B 两条正式标签(行上方样式)→ 行上方显示 `⌖ A | ⌖ B`。
- 点 `⌖ A` → 打开 A 的编辑框;点 `⌖ B` → 打开 **B** 的编辑框(各自独立,不共享)。
- 改 A 的注释、增删同行第三条,渲染顺序稳定(按创建时间,不乱跳)。
- gutter 仍单个图标;悬停该行,弹框逐条列 A、B 注释,各带「✎ 编辑注释」。

- [ ] **Step 6: 提交**

```bash
git add src/store/index.ts src/lodestar/adapter.ts src/player/decorator.ts
git commit -m "feat(code-jump-tags): 行上方多签渲染 ⌖ A | ⌖ B(按 createdAt 稳定排序,各自可点)"
```

---

## Task 4: 放开另两处占用守卫 + 更新 findTagByLocation 注释

`placeTagAtCursor` 与 `applyMove` 删掉「目标行已被别的标签占用 → 拒绝」;`findTagByLocation` 注释更新。

**Files:**
- Modify: `src/lodestar/commands.ts`(`placeTagAtCursor` :317-328;`applyMove` 约 :430-460)
- Modify: `src/lodestar/tree.ts`(`findTagByLocation` 注释,:102-104)

**Interfaces:**
- Consumes: 无。行为变化由 F5 验收。

- [ ] **Step 1: `placeTagAtCursor` 删占用拒绝**

在 `src/lodestar/commands.ts` `placeTagAtCursor`(:317-328)里删掉这段(含 :317 的「守一行一签」注释),让它取到 `target` 后直接继续记录「移动前锚」→ `retargetTag`:

```ts
// 把 tagId 重锚到当前光标行;目标行已被「别的」标签占用 → 拒绝(守一行一签)。
…
  const existing = findTagByLocation(store, target.file, target.line);
  if (existing && existing.id !== tagId) {
    const label =
      (existing.note || "").split(/\r?\n/)[0].trim() || "(无注释)";
    window.showInformationMessage(`Code Jump Tags: 该行已有标签「${label}」`);
    return false;
  }
```

删后把函数头注释改为:`// 把 tagId 重锚到当前光标行(允许落在已有标签的行)。`

- [ ] **Step 2: `applyMove` 删占用拒绝**

阅读 `src/lodestar/commands.ts` 的 `applyMove`(约 :430-460;它是撤回/恢复移动共享的落子函数,内部用 `findTagByLocation` 判目标锚是否被占,占用则回滚/丢弃)。删掉其中「目标行被别的标签占用 → 拒绝/回滚」的分支,使撤回/恢复能把标签放回已被占用的原行;保留「标签已删 → 丢弃」这类与占用无关的分支。改动后确认 `applyMove` 的返回语义(ok / missing)对调用方 `undoMove`/`redoMove`/`undoTagMove` 仍自洽(不再产生 `occupied` 分支;若类型里有 `occupied` 字面量且此后不再出现,一并清理相关处理)。

- [ ] **Step 3: 更新 `findTagByLocation` 注释**

`src/lodestar/tree.ts` :102-104 的注释由「Used to keep one tag per line…」改为说明其现用途:按 (file,line) 取**首条**匹配标签的锚,供 `gotoLocation` 解析显示行(同行多签共享同一行,取首条即可)。函数体不动。

- [ ] **Step 4: 编译 + 全量单测**

Run: `npm run build && npm run test:unit`
Expected: webpack 干净;单测全绿。

- [ ] **Step 5: 手动验收(F5)**

- 在有标签的行放光标,对另一条标签用「移到光标行」→ 成功落在该行(不再提示「该行已有标签」),该行现有两条标签。
- 移动一条标签后「撤回移动」,若原行此时已被别的标签占用 → 仍能放回(不再被拒)。「恢复移动」同理。

- [ ] **Step 6: 提交**

```bash
git add src/lodestar/commands.ts src/lodestar/tree.ts
git commit -m "feat(code-jump-tags): 放开移到光标行/撤回移动的一行一签占用守卫"
```

---

## Task 5: CHANGELOG + 功能-代码对照

**Files:**
- Modify: `CHANGELOG.md`(现有 `## 0.8.0 - 2026-07-26` 段补一条)
- Modify: `docs/code-jump-tags/功能-代码对照.md`(§2 `+` 行为、§3 CodeLens 渲染、以及 0.8.0 段或新增小段说明一行多签)

- [ ] **Step 1: CHANGELOG 补条目**

在 `## 0.8.0` 段末尾(「相关设置」那条之前或之后合适处)补一条,中文、同段风格:

> - 正式标签恢复「一行多条」:同一行按 `+` 每次新建一条独立标签(不再改去编辑已有那条);行上方多条注释以 `⌖ A | ⌖ B` 并排、点哪条编辑哪条,互不共享编辑框;「移到光标行 / 撤回移动」也可落在已有标签的行。(编辑旧标签改用它自己行上方的小字 / 悬停「✎」/ 树重命名。行尾样式的静态小字受 VS Code 限制不可点;行尾 inline 随手仍一行一条。)

- [ ] **Step 2: 更新功能-代码对照**

在 `docs/code-jump-tags/功能-代码对照.md`:
- §2 命令表里 `codeJumpTags.addTag` 那行的「用户怎么说」/说明,更新为「`+` 每次新建一条(一行可多条)」。
- §3 视图表里 CodeLens 那行补「同行多条按 createdAt 排序、`⌖ A | ⌖ B` 各自可点,纯拼接 `src/player/lensTitles.ts`」。
- 追加一小段(可放 0.8.0 inline 段之后)记「0.8.x 正式标签一行多签」:一行一签仅存于三处写入守卫(`recorder/commands.ts` 的 `+` 合并、`commands.ts` 的 `placeTagAtCursor`/`applyMove` 占用拒绝),已撤回;渲染层一直逐条 per-step,无需大改。

- [ ] **Step 3: 全量测试 + 编译最终确认**

Run: `npm run test:unit && npm run build`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add CHANGELOG.md docs/code-jump-tags/功能-代码对照.md
git commit -m "docs(code-jump-tags): 一行多签 CHANGELOG(并进 0.8.0)+ 功能-代码对照"
```

---

## Self-Review(对照 spec 核对)

**Spec 覆盖:**
- `+` 总是新建 → Task 2 ✅
- 行上方多签 `⌖ A | ⌖ B` 各自可点 + 稳定排序 → Task 1(纯拼接)+ Task 3(分组/排序/组装 + `createdAt` 加字段)✅
- 放开 placeTagAtCursor + applyMove 占用守卫 → Task 4 ✅
- findTagByLocation 保留、更新注释 → Task 4 ✅
- 边界(行尾不可点、一行两条 inline 不支持、inline+formal 共存已做)→ Task 5 CHANGELOG 记录 ✅
- 并进 0.8.0 + 对照文档 → Task 5 ✅

**占位符扫描:** Task 1 给出完整测试+实现;Task 3 给出完整重写代码;Task 2/4 为「删除指定分支」并附要删的确切代码块与善后(import 清理、注释更新、返回语义自洽);glue 任务无自动化单测处均以 F5 验收清单显式标注——非占位符。

**类型一致性:** `lineLensTitles(notes: string[]): string[]`、`CodeTourStep.createdAt?: string`、`CodeTourStepTuple`(已有导出)在各任务引用一致;`tagToStep` 拷 `createdAt` 与 decorator 读 `step.createdAt` 对齐。

## 已知边界(写进 CHANGELOG,不在本计划解)
- 行尾静态小字(`notePosition:"end"` 的普通标签)不可点(VS Code 装饰不能带命令)。
- 行尾 inline 随手 `//me:` 一行仍只一条(buffer 往返最右 marker 死结);其编辑靠光标移回展开。
- 同行多条正式标签的 gutter 仍单图标、hover 合并逐条列出(既有渲染行为)。
