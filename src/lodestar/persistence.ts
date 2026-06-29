import { runInAction } from "mobx";
import { Uri, workspace } from "vscode";
import { STORE_DIRECTORY, STORE_FILE } from "../constants";
import { store as runtime } from "../store";
import { treeToAllTours, treeToTours } from "./adapter";
import { createEmptyStore, migrateLooseTags, newFolderId, parse, serialize } from "./tree";
import { backfillAnchorText, backfillOriginal } from "./relocate";
import { LodestarStore } from "./types";

let cache: LodestarStore = createEmptyStore();

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
  const bytes = new TextEncoder().encode(serialize(cache));
  await workspace.fs.writeFile(storeFileUri(), bytes);
  rebuildTours();
}
