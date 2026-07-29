// 纯文本:一行内多条「行上方」标签的 CodeLens 标题。首条 `⌖ …`,后续 `| ⌖ …`,
// 视觉上拼成 `⌖ A | ⌖ B`。每条 lens 仍各自可点(命令在 decorator 里挂)。No `vscode`.
export function lineLensTitles(notes: string[]): string[] {
  return notes.map((note, i) => {
    const label = note ? `⌖ ${note}` : "⌖";
    return i === 0 ? label : `| ${label}`;
  });
}
