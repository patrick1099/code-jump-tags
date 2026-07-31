// Suspect-state engine — PURE (no vscode). A tag is "suspect" when, at a recheck
// point, its immutable `original` no longer matches near its line. Soft suspect:
// `current` still matches (we have a candidate). Hard suspect: neither matches.
// Suspect state is runtime-only (never persisted) — a Map filled per file by the
// recheck triggers.
import { matchAnchor } from "./relocate";

export interface FileTag {
  id: string;
  file: string;
  line: number;
  original?: string;
  current?: string;
  witnessed?: boolean; // 现内容是我们在编辑器里亲眼看着变成这样的
}

export interface SuspectInfo {
  id: string;
  file: string;
  status: "current" | "lost"; // current = soft (has candidate), lost = hard
  line: number;               // candidate line (soft) / fallback line (hard)
  original?: string;
  current?: string;
}

export function classifyFileTags(tags: FileTag[], fileText: string): SuspectInfo[] {
  const out: SuspectInfo[] = [];
  for (const t of tags) {
    const m = matchAnchor(fileText, t.line, t.original, t.current);
    if (m.status === "original") continue; // healthy
    // 软可疑(current 命中) + 这次分歧是我们亲眼看着发生的 => 不是失配，是用户自己改的。
    // 失配只该留给「没看见的改动」：文件被别的编辑器改、git 拉取、VS Code 没开着时被动过。
    // 硬可疑(lost)不在此列 —— 连现内容都对不上，说明这行确实在我们看不见的地方变了。
    if (m.status === "current" && t.witnessed) continue;
    out.push({
      id: t.id,
      file: t.file,
      status: m.status,
      line: m.line,
      original: t.original,
      current: t.current
    });
  }
  return out;
}

const registry = new Map<string, SuspectInfo>();

// Replace all suspect entries for one file. Returns true if the registry changed
// (so callers can skip a repaint when nothing moved).
export function setFileSuspects(file: string, infos: SuspectInfo[]): boolean {
  let changed = false;
  for (const [id, info] of registry) {
    if (info.file === file && !infos.some(i => i.id === id)) {
      registry.delete(id);
      changed = true;
    }
  }
  for (const info of infos) {
    const prev = registry.get(info.id);
    if (!prev || prev.status !== info.status || prev.line !== info.line) {
      registry.set(info.id, info);
      changed = true;
    }
  }
  return changed;
}

// Drop suspect entries for the given ids (e.g. tags just deleted from the
// store). Returns true if any entry was actually removed, so the caller can
// decide whether to refresh the tree.
export function removeSuspects(ids: string[]): boolean {
  let changed = false;
  for (const id of ids) {
    if (registry.delete(id)) changed = true;
  }
  return changed;
}

export function getSuspect(id: string): SuspectInfo | undefined {
  return registry.get(id);
}

export function allSuspects(): SuspectInfo[] {
  return [...registry.values()];
}

export function clearSuspects(): void {
  registry.clear();
}
