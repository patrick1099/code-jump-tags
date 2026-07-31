// ⑤ 排除名单：名单内的文件完全不参与标签功能。
// 最要紧的是扩展自己的 .code-jump-tags/ —— store.json 里存着 note 文本，它若被当成
// 普通文件扫描，其中的 marker 会被折叠、反过来改写 store.json。
const assert = require("assert");
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const {
  settle,
  resetWorkspace,
  moveCursor,
  typeText,
  readStore,
  inlineTags,
  wsRoot
} = require("./helpers");

// 只数「这个文件上的」随手标签。扩展的 store 有内存缓存，删掉磁盘上的 store.json
// 并不能重置它，跨用例的标签会累积——数全局总数会被上一个用例的残留带偏。
function inlineTagsOf(rel) {
  return inlineTags(readStore()).filter(t => t.file === rel);
}

async function openAt(rel, content) {
  const abs = path.join(wsRoot(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  await settle(600);
  return editor;
}

// 在第 0 行行尾敲一条私记，然后把光标移走（正常文件此时会折叠）。
async function tryWriteNote(editor) {
  const len = editor.document.lineAt(0).text.length;
  await moveCursor(editor, 0, len);
  await typeText("  //me: 不该被折叠");
  await moveCursor(editor, 1, 0);
  // 新建文件的打开链路比 openSample 长（文件监听 -> recheck -> openTextDocument），
  // 默认 settle 不够收敛，断言会打在折叠完成之前。
  await settle(2000);
}

describe("排除名单", () => {
  beforeEach(async () => {
    await resetWorkspace();
  });

  for (const rel of [
    ".code-jump-tags/probe.js",
    "node_modules/lib/index.js",
    "dist/probe.js",
    "build/probe.js"
  ]) {
    it(`${rel} 里的 //me: 不被折叠、不产生标签`, async () => {
      const editor = await openAt(rel, "const a = 1;\nconst b = 2;\n");
      await tryWriteNote(editor);

      const line = editor.document.lineAt(0).text;
      assert.ok(
        line.includes("//me:"),
        `${rel}: marker 不该被折叠掉，实际行: ${JSON.stringify(line)}`
      );
      assert.strictEqual(
        inlineTagsOf(rel).length,
        0,
        `${rel}: 排除名单内的文件不该产生随手标签`
      );
    });
  }

  // 「排除没有误伤正常文件」的对照组不放在这里：inline-note / multiply-hunt 两个
  // 套件的 13 条用例全部在未排除的 sample.js 上跑折叠展开，它们就是对照组。在本文件
  // 里再造一个新文件做对照，只会引入跨用例的脏 buffer 污染而不增加任何覆盖。
});
