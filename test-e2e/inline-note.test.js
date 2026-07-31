const assert = require("assert");
const vscode = require("vscode");
const {
  settle,
  resetWorkspace,
  openSample,
  lineText,
  moveCursor,
  typeText,
  countMarkers,
  inlineTagsOf
} = require("./helpers");

// 被打私记的那一行（0-based）：`  const total = compute(1, 2);`
const TARGET = 1;
const CLEAN = "  const total = compute(1, 2);";
const NOTE = "这里会溢出";
const FILE = "sample.js";

// 在 TARGET 行尾敲出一条随手私记，并折叠掉（光标移走）。
async function writeNote(editor) {
  await moveCursor(editor, TARGET, lineText(editor, TARGET).length);
  await typeText(`  //me: ${NOTE}`);
  await moveCursor(editor, 5, 0); // 移走 -> 折叠
}

describe("inline note —— 折叠/展开往返", () => {
  beforeEach(async () => {
    await resetWorkspace();
  });

  it("敲一条私记，移走后行被剥净且落进 sidecar", async () => {
    const editor = await openSample();
    await writeNote(editor);

    assert.strictEqual(
      lineText(editor, TARGET),
      CLEAN,
      "折叠后行内不该还留着 marker 文本"
    );
    const tags = inlineTagsOf(FILE);
    assert.strictEqual(tags.length, 1, "应恰好落下一条随手标签");
    assert.strictEqual(tags[0].note, NOTE);
    assert.ok(
      !tags[0].original.includes("//me:"),
      "身份锚绝不能含 marker，实际: " + tags[0].original
    );
  });

  // ⑥ 增殖：核心回归。反复进出该行，marker 永远只能有一个。
  it("反复进出该行，//me: 不增殖", async () => {
    const editor = await openSample();
    await writeNote(editor);

    for (let i = 0; i < 6; i++) {
      await moveCursor(editor, TARGET, 0); // 进 -> 展开
      const expanded = lineText(editor, TARGET);
      assert.strictEqual(
        countMarkers(expanded),
        1,
        `第 ${i + 1} 轮展开后 marker 数应为 1，实际行: ${JSON.stringify(expanded)}`
      );

      await moveCursor(editor, 5, 0); // 出 -> 折叠
      const collapsed = lineText(editor, TARGET);
      assert.strictEqual(
        countMarkers(collapsed),
        0,
        `第 ${i + 1} 轮折叠后不该残留 marker，实际行: ${JSON.stringify(collapsed)}`
      );
      assert.strictEqual(
        collapsed,
        CLEAN,
        `第 ${i + 1} 轮折叠后行内容应回到干净代码`
      );
    }

    assert.strictEqual(
      inlineTagsOf(FILE).length,
      1,
      "往返多轮后 sidecar 里仍应只有一条随手标签，不该复制出多条"
    );
  });

  // ⑥ 删不掉：删掉行内那段文字后，它不能复活。
  it("删掉行内的 //me: 私记后，标签消失且不复活", async () => {
    const editor = await openSample();
    await writeNote(editor);

    // 回到该行让它展开，然后把 marker 起始处到行尾整段删掉
    await moveCursor(editor, TARGET, 0);
    const expanded = lineText(editor, TARGET);
    const at = expanded.indexOf("//me:");
    assert.ok(at > 0, "展开态应能找到 marker，实际行: " + JSON.stringify(expanded));

    await editor.edit(b =>
      b.delete(
        new vscode.Range(
          new vscode.Position(TARGET, at),
          new vscode.Position(TARGET, expanded.length)
        )
      )
    );
    await settle(400);

    await moveCursor(editor, 5, 0); // 移走 -> 应触发删除
    assert.strictEqual(
      inlineTagsOf(FILE).length,
      0,
      "删掉行内文字后，这条随手标签应被删除"
    );

    // 再进出两轮，不能复活
    for (let i = 0; i < 2; i++) {
      await moveCursor(editor, TARGET, 0);
      assert.strictEqual(
        countMarkers(lineText(editor, TARGET)),
        0,
        `第 ${i + 1} 轮回到该行时，私记不该被注回来`
      );
      await moveCursor(editor, 5, 0);
    }
    assert.strictEqual(inlineTagsOf(FILE).length, 0, "标签不该复活");
  });

  // 竞态：快速连续移光标（不等每一步 settle），触发器不串行时会重入。
  it("快速连续移动光标，不产生重复 marker 或重复标签", async () => {
    const editor = await openSample();
    await writeNote(editor);

    for (let i = 0; i < 8; i++) {
      const line = i % 2 === 0 ? TARGET : 5;
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      // 故意不 settle：让事件挤在一起
    }
    await settle(1500);

    const text = lineText(editor, TARGET);
    assert.ok(
      countMarkers(text) <= 1,
      "快速移动后该行不该出现多个 marker，实际行: " + JSON.stringify(text)
    );
    assert.strictEqual(
      inlineTagsOf(FILE).length,
      1,
      "快速移动后不该复制出多条随手标签"
    );
  });
});
