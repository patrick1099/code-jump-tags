const vscode = require("vscode");
const path = require("path");
const fs = require("fs");

const FIXTURE_SOURCE = `function alpha() {
  const total = compute(1, 2);
  return total;
}

function beta() {
  const total = compute(3, 4);
  return total;
}

function gamma() {
  let acc = 0;
  for (const n of [1, 2, 3]) {
    acc += n;
  }
  return acc;
}
`;

function wsRoot() {
  return vscode.workspace.workspaceFolders[0].uri.fsPath;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 扩展的写入是 debounce + fire-and-forget 的，断言前必须让事件循环把它们跑完。
// 800ms 覆盖 decorator 的 800ms debouncedSaveStore。
const settle = (ms = 900) => sleep(ms);

// 把 fixture 恢复成初版，并清掉 sidecar —— 每个用例都从同一状态出发，
// 否则上一个用例遗留的标签会让下一个用例的「新建 vs 归并」走不同分支。
async function resetWorkspace() {
  // 先关编辑器再写盘：否则打开着的脏 buffer 会盖回磁盘内容，用例之间互相污染。
  await vscode.commands.executeCommand(
    "workbench.action.revertAndCloseActiveEditor"
  );
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await settle(300);

  fs.writeFileSync(path.join(wsRoot(), "sample.js"), FIXTURE_SOURCE, "utf8");
  // 用例自己造出来的临时目录/文件一并清掉
  for (const rel of [
    ".code-jump-tags",
    "node_modules",
    "dist",
    "build",
    "src",
    "other.js"
  ]) {
    try {
      fs.rmSync(path.join(wsRoot(), rel), { recursive: true, force: true });
    } catch {
      // VS Code 可能正占着某个目录的句柄（EPERM）。清不掉不该让用例挂掉——
      // 每个用例写的都是自己的路径，残留不会互相污染。
    }
  }
  await settle(300);
}

async function openSample() {
  const uri = vscode.Uri.file(path.join(wsRoot(), "sample.js"));
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  await settle(600);
  return editor;
}

function lineText(editor, line0) {
  return editor.document.lineAt(line0).text;
}

// 移光标。程序化赋值 editor.selection 同样会触发
// onDidChangeTextEditorSelection —— 这正是被测的那个触发器。
async function moveCursor(editor, line0, char = 0) {
  const pos = new vscode.Position(line0, char);
  editor.selection = new vscode.Selection(pos, pos);
  await settle();
}

// 走 VS Code 的 `type` 命令而不是 editor.edit：这是真实键入走的那条路，
// 逐字符触发 onDidChangeTextDocument + selection 变化。
async function typeText(text) {
  for (const ch of text) {
    await vscode.commands.executeCommand("type", { text: ch });
  }
  await settle(400);
}

function countMarkers(s, marker = "//me:") {
  return s.split(marker).length - 1;
}

// 直接读 sidecar：扩展没有对外暴露 store 的 API，而磁盘上的这份就是唯一真源。
function readStore() {
  const f = path.join(wsRoot(), ".code-jump-tags", "store.json");
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

// 展平树，取出所有 tag 节点。
function allTags(store) {
  if (!store) return [];
  const out = [];
  const walk = nodes => {
    for (const n of nodes || []) {
      if (n.type === "tag") out.push(n);
      else if (n.type === "folder") walk(n.children);
    }
  };
  walk(store.tree);
  return out;
}

const inlineTags = store => allTags(store).filter(t => t.inline === true);

// 只数「这个文件上的」随手标签。扩展的 store 有内存缓存，删掉磁盘上的 store.json
// 并不能重置它，跨用例的标签会累积——数全局总数会被别的用例残留带偏（且随用例执行
// 顺序变化而时红时绿）。
const inlineTagsOf = rel => inlineTags(readStore()).filter(t => t.file === rel);

module.exports = {
  sleep,
  settle,
  resetWorkspace,
  openSample,
  lineText,
  moveCursor,
  typeText,
  countMarkers,
  readStore,
  allTags,
  inlineTags,
  inlineTagsOf,
  wsRoot
};
