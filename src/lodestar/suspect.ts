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

export function getSuspect(id: string): SuspectInfo | undefined {
  return registry.get(id);
}

export function allSuspects(): SuspectInfo[] {
  return [...registry.values()];
}

export function clearSuspects(): void {
  registry.clear();
}
