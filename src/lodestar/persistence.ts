import { runInAction } from "mobx";
import { ExtensionContext, RelativePattern, Uri, workspace } from "vscode";
import { STORE_DIRECTORY, STORE_FILE } from "../constants";
import { store as runtime } from "../store";
import { treeToAllTours, treeToTours } from "./adapter";
import { createEmptyStore, migrateLooseTags, newFolderId, parse, serialize } from "./tree";
import { backfillAnchorText, backfillOriginal } from "./relocate";
import { LodestarStore } from "./types";

let cache: LodestarStore = createEmptyStore();
// 最近一次 saveStore 写出去的内容。store.json watcher 靠它做自触发守卫:外部
// (命令行工具)改写内容与它不同才重载;saveStore 自己写的那份原样读回来直接跳过。
let lastSavedContents: string | undefined;

function workspaceRootUri(): Uri {
  return workspace.workspaceFolders![0].uri;
}

function storeFileUri(): Uri {
  return Uri.joinPath(workspaceRootUri(), STORE_DIRECTORY, STORE_FILE);
}

export function getStore(): LodestarStore {
  return cache;
}

export function getWorkspaceId(): string {
  return workspaceRootUri().toString();
}

// Old storage folder, from when the extension was named "Lodestar". Read once
// and migrated into the new location so existing tags aren't lost on rename.
const LEGACY_STORE_DIRECTORY = ".lodestar";

export async function loadStore(): Promise<void> {
  try {
    const bytes = await workspace.fs.readFile(storeFileUri());
    cache = parse(new TextDecoder().decode(bytes));
  } catch {
    try {
      const legacy = Uri.joinPath(
        workspaceRootUri(),
        LEGACY_STORE_DIRECTORY,
        STORE_FILE
      );
      const bytes = await workspace.fs.readFile(legacy);
      cache = parse(new TextDecoder().decode(bytes));
      await saveStore(); // copy into the new .code-jump-tags/ location
    } catch {
      cache = createEmptyStore();
    }
  }
  migrateLooseTags(cache, newFolderId);
  backfillAnchorText(cache);
  backfillOriginal(cache);
  rebuildTours();
}

export function rebuildTours(): void {
  runInAction(() => {
    const wsId = getWorkspaceId();
    runtime.tours = treeToTours(cache, wsId);
    // All tags across every nesting depth — the decoration/CodeLens source.
    runtime.allTours = treeToAllTours(cache, wsId);
  });
}

// Persist the current cache, then refresh the derived runtime tours.
export async function saveStore(): Promise<void> {
  const dir = Uri.joinPath(workspaceRootUri(), STORE_DIRECTORY);
  try {
    await workspace.fs.createDirectory(dir);
  } catch {
    /* already exists */
  }
  const contents = serialize(cache);
  lastSavedContents = contents;
  const bytes = new TextEncoder().encode(contents);
  await workspace.fs.writeFile(storeFileUri(), bytes);
  rebuildTours();
}

// 监听 <工作区根>/.code-jump-tags/store.json 的 create/change,让命令行工具在外部
// 写完标签后不用重启窗口即可刷新。回调先读文件,内容和 saveStore 刚写出去的那份
// 相同就是自触发,直接跳过不重载(否则写一次抖一轮);不同才 loadStore(),它末尾
// 自带 rebuildTours,树和装饰层自动刷新。
export function registerStoreWatcher(context: ExtensionContext): void {
  const pattern = new RelativePattern(
    workspaceRootUri(),
    `${STORE_DIRECTORY}/${STORE_FILE}`
  );
  const watcher = workspace.createFileSystemWatcher(pattern);
  const reload = async () => {
    try {
      const bytes = await workspace.fs.readFile(storeFileUri());
      const contents = new TextDecoder().decode(bytes);
      if (contents === lastSavedContents) return;
      await loadStore();
    } catch {
      // 文件可能被瞬时占用/删除,忽略本轮,下个事件会再来
    }
  };
  watcher.onDidCreate(reload);
  watcher.onDidChange(reload);
  context.subscriptions.push(watcher);
}
