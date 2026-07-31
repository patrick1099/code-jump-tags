// 「这个文件刚刚被我们看不见的人改过」——文件监听器与 trackLineShifts 之间的一小块
// 共享状态。运行时的，不持久化。
//
// 为什么需要它：判断「这次 buffer 变化是不是用户在编辑器里自己敲的」不能靠
// `document.isDirty` —— VS Code 触发 onDidChangeTextDocument 时还没把脏标志翻上来，
// 实测用户编辑也读到 false。可靠的信号在另一头：外部写盘会先让文件监听器响一次，
// 紧接着 VS Code 才重新载入 buffer 并触发文档变更事件。于是规则变成：
//
//   缺省认为「buffer 变化 = 我们亲眼看见的」；但若该文件刚刚有一次**不是我们保存**
//   引起的磁盘变更，就在一个短窗口内拒绝把它算作看见 —— 那次变更之后紧跟着的 buffer
//   变化，正是那份外部内容被载入进来。
const externalAt = new Map<string, number>();

// 窗口要覆盖「磁盘变更 -> VS Code 重新载入 buffer -> 触发文档变更事件」这一段。
export const DISTRUST_WINDOW_MS = 2000;

export function markExternalChange(file: string): void {
  externalAt.set(file, Date.now());
}

export function recentlyExternal(file: string): boolean {
  const t = externalAt.get(file);
  return t !== undefined && Date.now() - t < DISTRUST_WINDOW_MS;
}
