import { describe, it, expect } from "vitest";
import { lineLensTitles } from "../../src/player/lensTitles";

describe("lineLensTitles", () => {
  it("单条:只有 ⌖ 前缀", () => {
    expect(lineLensTitles(["A"])).toEqual(["⌖ A"]);
  });
  it("多条:第 2 条起加 | 前缀", () => {
    expect(lineLensTitles(["A", "B", "C"])).toEqual(["⌖ A", "| ⌖ B", "| ⌖ C"]);
  });
  it("空注释:退成 ⌖ / | ⌖", () => {
    expect(lineLensTitles(["", ""])).toEqual(["⌖", "| ⌖"]);
  });
  it("空数组:返回空", () => {
    expect(lineLensTitles([])).toEqual([]);
  });
});
