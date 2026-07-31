// 「失配只该在没看见的改动上出现」——用户在编辑器里自己改一行再保存，不该被判失配。
// 失配留给：文件被别的编辑器改、git 拉取、VS Code 没开着时被动过。
const assert = require("assert");
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const {
  settle,
  resetWorkspace,
  openSample,
  lineText,
  moveCursor,
  typeText,
  readStore,
  allTags,
  wsRoot
} = require("./helpers");

const TARGET = 1;
const FILE = "sample.js";

// 按注释文字定位「本用例建的那条」。扩展的 store 有内存缓存，删掉磁盘上的 store.json
// 重置不了它，所以不能按数量断言——上一个用例的标签还在。
function tagByNote(note) {
  return allTags(readStore()).find(t => t.note === note && !t.inline);
}

// 直接改 sidecar 不管用（内存缓存），走扩展自己的 addTag 命令：它接一个 CommentReply，
// 只用到 thread.uri / thread.range / text 三样。
// 用 editor.edit 而不是逐字符 `type` 命令：这里要验的是「文档在编辑器里被改脏」这个
// 判据，用哪种编辑方式都一样，而 editor.edit 是可 await 的，去掉了打字时序的抖动。
async function appendToLine(editor, line0, text) {
  const end = editor.document.lineAt(line0).text.length;
  await editor.edit(b => b.insert(new vscode.Position(line0, end), text));
  await settle(1000);
}

async function addFormalTag(doc, line0, note) {
  await vscode.commands.executeCommand("codeJumpTags.addTag", {
    thread: {
      uri: doc.uri,
      range: new vscode.Range(line0, 0, line0, 0),
      dispose() {}
    },
    text: note
  });
  // 这里要等过「外部写盘不信任窗口」：resetWorkspace 是用 fs.writeFileSync 重写
  // sample.js 的，那本身就是一次外部改动（扩展正确地识别了它）。窗口没过去之前
  // 做的编辑不会被记成 witnessed —— 这是产品的正确行为，测试得让开。
  await settle(2400);
}

describe("失配只认「没看见的改动」", () => {
  beforeEach(async () => {
    await resetWorkspace();
  });

  it("在编辑器里改这一行再保存，标签被记为 witnessed（不判失配）", async () => {
    const NOTE = "witnessed-用例-A";
    const editor = await openSample();
    await addFormalTag(editor.document, TARGET, NOTE);
    assert.ok(tagByNote(NOTE), "前置条件：应建出这条正式标签");

    // 在这一行行尾追加内容，改到远超相似度阈值，再保存
    await appendToLine(editor, TARGET," // 大幅改写这一行的内容让它认不出原身份");
    await editor.document.save();
    await settle(1500);

    // 切走再切回，触发 recheckOn.open
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await settle(500);
    const again = await openSample();
    await settle(1200);

    const tag = tagByNote(NOTE);
    assert.ok(tag, "标签应还在");
    assert.strictEqual(
      tag.witnessed,
      true,
      "亲眼看见的改动应被标记为 witnessed，实际标签: " + JSON.stringify(tag)
    );
    assert.ok(
      lineText(again, TARGET).includes("大幅改写"),
      "前置条件：改动应已落盘"
    );
  });

  it("外部改动作废这份信任（模拟别的编辑器 / git 写盘）", async () => {
    const NOTE = "witnessed-用例-B";
    const editor = await openSample();
    await addFormalTag(editor.document, TARGET, NOTE);

    await appendToLine(editor, TARGET," // 我自己改的");
    await editor.document.save();
    await settle(1500);
    assert.strictEqual(
      tagByNote(NOTE).witnessed,
      true,
      "前置条件：自己的改动应已 witnessed"
    );

    // 关掉编辑器，然后在 VS Code 之外直接改盘上的文件
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await settle(800);
    const abs = path.join(wsRoot(), FILE);
    const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
    lines[TARGET] = "  const grandTotal = computeEverything(9, 9, 9);";
    // 走 VS Code 自己的 fs API 写盘：它必定会触发 createFileSystemWatcher，
    // 而 node 的 writeFileSync 在扩展宿主里有时不会被 VS Code 的监听器捕获。
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(abs),
      Buffer.from(lines.join("\n"), "utf8")
    );
    await settle(4000); // 等文件监听器

    const tag = tagByNote(NOTE);
    assert.notStrictEqual(
      tag.witnessed,
      true,
      "外部改动后信任应被作废，实际标签: " + JSON.stringify(tag)
    );
  });
});
