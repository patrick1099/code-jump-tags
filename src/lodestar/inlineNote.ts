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
