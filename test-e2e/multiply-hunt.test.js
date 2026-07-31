// 增殖猎场：简单的「进出该行」复现不出增殖，所以在这里逐个试真实使用中会走到的
// 其它路径。每条都断言同一件事——目标行的 marker 数不得 > 1，随手标签不得复制。
// 哪条红了，哪条就是触发路径。（真凶是 I：展开态下连按退格。）
const assert = require("assert");
const vscode = require("vscode");
const path = require("path");
const {
  settle,
  resetWorkspace,
  openSample,
  lineText,
  moveCursor,
  typeText,
  countMarkers,
  inlineTagsOf,
  wsRoot
} = require("./helpers");

const TARGET = 1;
const NOTE = "这里会溢出";
const AWAY = 5;
const FILE = "sample.js";

async function writeNote(editor) {
  await moveCursor(editor, TARGET, lineText(editor, TARGET).length);
  await typeText(`  //me: ${NOTE}`);
  await moveCursor(editor, AWAY, 0);
}

// 统一的收尾体检：行里最多一个 marker，sidecar 里最多一条随手标签。
function assertNoMultiply(editor, label) {
  const text = lineText(editor, TARGET);
  const n = countMarkers(text);
  const tags = inlineTagsOf(FILE);
  assert.ok(
    n <= 1,
    `[${label}] 该行出现了 ${n} 个 marker: ${JSON.stringify(text)}`
  );
  assert.ok(
    tags.length <= 1,
    `[${label}] sidecar 里出现了 ${tags.length} 条随手标签: ` +
      JSON.stringify(tags.map(t => t.note))
  );
}

describe("增殖猎场", () => {
  beforeEach(async () => {
    await resetWorkspace();
  });

  it("A. 展开态下保存文件", async () => {
    const editor = await openSample();
    await writeNote(editor);
    await moveCursor(editor, TARGET, 0); // 展开
    await editor.document.save();
    await settle(800);
    await moveCursor(editor, AWAY, 0);
    await moveCursor(editor, TARGET, 0);
    assertNoMultiply(editor, "展开态保存");
  });

  it("B. 展开态下切走再切回（走 rescanDocument）", async () => {
    const editor = await openSample();
    await writeNote(editor);
    await moveCursor(editor, TARGET, 0); // 展开，光标停在这

    const other = vscode.Uri.file(path.join(wsRoot(), "other.js"));
    await vscode.workspace.fs.writeFile(other, Buffer.from("const x = 1;\n"));
    const od = await vscode.workspace.openTextDocument(other);
    await vscode.window.showTextDocument(od, { preview: false });
    await settle(900);

    await vscode.window.showTextDocument(editor.document, { preview: false });
    await settle(1200);
    assertNoMultiply(editor, "切走切回");
  });

  it("C. 折叠后撤销（Ctrl+Z）", async () => {
    const editor = await openSample();
    await writeNote(editor);
    await vscode.commands.executeCommand("undo");
    await settle(800);
    await moveCursor(editor, TARGET, 0);
    await moveCursor(editor, AWAY, 0);
    await moveCursor(editor, TARGET, 0);
    assertNoMultiply(editor, "撤销后往返");
  });

  it("D. 展开态下改私记文字，再折叠展开", async () => {
    const editor = await openSample();
    await writeNote(editor);
    await moveCursor(editor, TARGET, 0); // 展开
    await moveCursor(editor, TARGET, lineText(editor, TARGET).length);
    await typeText("补充");
    await moveCursor(editor, AWAY, 0);
    await moveCursor(editor, TARGET, 0);
    assertNoMultiply(editor, "改私记文字");
  });

  it("E. 手动跑「扫残留」命令（展开态）", async () => {
    const editor = await openSample();
    await writeNote(editor);
    await moveCursor(editor, TARGET, 0); // 展开
    await vscode.commands.executeCommand("codeJumpTags.rescanInlineNotes");
    await settle(900);
    await moveCursor(editor, AWAY, 0);
    await moveCursor(editor, TARGET, 0);
    assertNoMultiply(editor, "扫残留");
  });

  it("F. 关掉文件再重开（展开态残留落盘）", async () => {
    const editor = await openSample();
    await writeNote(editor);
    await moveCursor(editor, TARGET, 0); // 展开
    await editor.document.save();
    await settle(600);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await settle(800);
    const again = await openSample();
    await moveCursor(again, AWAY, 0);
    await moveCursor(again, TARGET, 0);
    assertNoMultiply(again, "关掉重开");
  });

  it("G. 同一行两条随手私记抢位", async () => {
    const editor = await openSample();
    await writeNote(editor);
    await moveCursor(editor, TARGET, lineText(editor, TARGET).length);
    await typeText(`  //me: 第二条`);
    await moveCursor(editor, AWAY, 0);
    await moveCursor(editor, TARGET, 0);
    assertNoMultiply(editor, "同行两条");
  });

  // ★ 用户给的真实复现：点回有随手标签的那一行，一直按退格。
  // 退格把 //me: 啃成 //me 的那一刻 marker 认不出来了，selection 处理器就当这是
  // 「有标签但没展开的行」，当场原地重注一份私记拼在残骸后面 —— 再退格再啃坏，再注
  // 一份，越删越长。修法见 inlineNotes.handleCursor 的 `prev === cur0` 早退。
  it("I. ★ 展开态下连按退格，不得重复生成", async () => {
    const editor = await openSample();
    await writeNote(editor);
    await moveCursor(editor, TARGET, 0); // 点回该行 -> 展开
    const expanded = lineText(editor, TARGET);
    assert.ok(
      expanded.includes("//me:"),
      "前置条件：该行应处于展开态，实际: " + JSON.stringify(expanded)
    );

    // 光标挪到行尾，一路退格吃穿 note + marker。
    //
    // 判据用「行长度必须严格递减」而不是数 marker：退格把冒号吃掉后，残骸是 `//me`
    // 而不是 `//me:`，按完整 marker 去数会把 `... //me  //me: 私记` 数成 1 个而假绿。
    // 退格就是删字符，扩展在这一刻往行里加任何东西都是错的。
    await moveCursor(editor, TARGET, lineText(editor, TARGET).length);
    let prevLen = lineText(editor, TARGET).length;
    for (let i = 0; i < 24; i++) {
      await vscode.commands.executeCommand("deleteLeft");
      await settle(150);
      const now = lineText(editor, TARGET);
      assert.ok(
        now.length < prevLen,
        `第 ${i + 1} 次退格后行反而变长了（${prevLen} -> ${now.length}），` +
          `说明有内容被重新注入: ${JSON.stringify(now)}`
      );
      assert.ok(
        now.split("//me").length - 1 <= 1,
        `第 ${i + 1} 次退格后该行出现了多份 marker 残骸: ${JSON.stringify(now)}`
      );
      prevLen = now.length;
    }
    await settle(1200);
    assertNoMultiply(editor, "连按退格");
  });

  it("H. 光标在行内左右移动（不离开该行）", async () => {
    const editor = await openSample();
    await writeNote(editor);
    for (let i = 0; i < 5; i++) {
      await moveCursor(editor, TARGET, 0);
      await moveCursor(editor, TARGET, 4);
      await moveCursor(editor, TARGET, 10);
    }
    assertNoMultiply(editor, "行内左右移");
  });
});
