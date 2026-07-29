# 待办 / Roadmap

> 维护约定:做完的划掉或移到「已完成」。带设计稿的条目附链接。

## 接下来要干的

### 1. 失配「实时采纳」——我盯着改的默认最新
- **状态:** 设计定稿,**暂缓实现**(用户 2026-07-27 parked)。
- **要做什么:** 把失配语义从「内容和打标签那刻不同」改成「趁我没盯着时内容被动了」。会话内我亲手改锚定行 → 静默采纳为最新;只有会话外的改动才报失配:① 关掉 VS Code 后外部改、② `git pull`/`checkout`/`merge`、③ VS Code 开着但被别的编辑器改。
- **难点:** 用户开了自动保存,不能靠「磁盘动没动」区分自己打字和外来写入 → 需「落盘来源记账」(记下哪次写盘是自己的 autosave)+ 重载守卫 + git 扩展信号。用户明确**不接受**漏掉「开着 VS Code 被外部编辑器改」这种,所以记账不能省。
- **隐私铁律:** 实时采纳只对正式标签;inline `//me:` 绝不被 `onDidChangeTextDocument` 采纳(防私记泄漏)。
- **设计稿:** `docs/superpowers/specs/2026-07-27-suspect-live-adopt-design.md`
- **实现前:** 先补一轮 brainstorm 定死设计稿里的开放题(相似度地板要不要、配置开关、原子替换写入的监听覆盖),再单独成 SDD 计划。

### 2. hover 支持一行多签
- **状态:** 未做(用户 2026-07-27 让先放着)。
- **要做什么:** 同一行多条正式标签,悬停只弹一条。根因:`decorator.ts:174-177` 每条标签各 push 一个同 range 的 gutter 装饰、各带 hoverMessage,VS Code 对同装饰类型的重叠 range 只显示一个。
- **修法:** 像 `provideCodeLenses` 那样把 gutter 装饰**按行分组**,合成一条包含该行全部标签注释 + 各自 `[✎ 编辑注释]`(各 keyed 到自己的 `step.id`)的 hoverMessage,一行一条装饰。约在 `updateDecorations`(`decorator.ts` ~127-177)一处集中改。
- **归属:** 「一行多签(2026-07-27)」功能的收尾项;设计稿见 `docs/superpowers/specs/2026-07-27-formal-tags-multi-per-line-design.md`(渲染部分)。

### 3. F5 手动验收(合并后补验)
> 本仓库合并到 main 时,以下项**未经 F5 实测**(用户暂不验)。真正用起来前建议在 Extension Development Host 走一遍。
- **0.8.0 inline 随手 `//me:`:** 折叠/展开、扫残留、树「💬 随手」组 + 提权/降格、undo 交织;**隐私红线**(折叠态存盘后源文件/git diff 不含私记、sidecar 锚字段剥净)。
- **一行多签:** 行上方多签 `⌖ A | ⌖ B` 各自可点已 F5 通过 ✅;其余(移到光标行/撤回·恢复落在已有标签行、删一留一、正式多签+行尾 inline 共存)未逐项验。

## 已完成
- **0.8.0 行尾私有注释(inline `//me:`)** —— 8 任务 SDD,评审 MERGE-READY。见 `docs/superpowers/plans/2026-07-26-inline-me-notes-v1.md`。
- **正式标签一行多签(撤回一行一签)** —— 5 任务 SDD,评审 MERGE-READY,行上方多签 F5 通过。见 `docs/superpowers/plans/2026-07-27-formal-tags-multi-per-line.md`。
