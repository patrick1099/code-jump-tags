import { describe, it, expect } from "vitest";
import {
  globToRegExp,
  isExcluded,
  DEFAULT_EXCLUDE
} from "../../src/lodestar/exclude";

describe("globToRegExp", () => {
  it("`**/` 允许零层目录", () => {
    const re = globToRegExp("**/.git/**");
    expect(re.test(".git/config")).toBe(true);
    expect(re.test("sub/.git/config")).toBe(true);
    expect(re.test("a/b/.git/x/y")).toBe(true);
  });
  it("结尾 `/**` 连目录本身一起命中", () => {
    expect(globToRegExp("**/dist/**").test("dist")).toBe(true);
    expect(globToRegExp("**/dist/**").test("dist/a.js")).toBe(true);
  });
  it("单 `*` 不跨目录分隔符", () => {
    const re = globToRegExp("src/*.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/sub/a.ts")).toBe(false);
  });
  it("正则元字符按字面量处理", () => {
    expect(globToRegExp("a+b/**").test("a+b/x")).toBe(true);
    expect(globToRegExp("a+b/**").test("aab/x")).toBe(false);
  });
});

describe("isExcluded", () => {
  it("空名单一律不排除", () => {
    expect(isExcluded(".code-jump-tags/store.json", [])).toBe(false);
  });
  it("反斜杠路径（Windows）同样命中", () => {
    expect(isExcluded(".code-jump-tags\\store.json", DEFAULT_EXCLUDE)).toBe(true);
    expect(isExcluded("src\\player\\index.ts", DEFAULT_EXCLUDE)).toBe(false);
  });
  it("剥掉 ./ 与前导 / 前缀", () => {
    expect(isExcluded("./node_modules/x/y.js", DEFAULT_EXCLUDE)).toBe(true);
    expect(isExcluded("/node_modules/x/y.js", DEFAULT_EXCLUDE)).toBe(true);
  });
  it("默认名单覆盖 sidecar 自身与常见配置/构建目录", () => {
    for (const p of [
      ".code-jump-tags/store.json",
      ".git/COMMIT_EDITMSG",
      ".vscode/settings.json",
      "node_modules/foo/index.js",
      "out/extension.js",
      "dist/extension-node.js",
      "build/x.o"
    ]) {
      expect(isExcluded(p, DEFAULT_EXCLUDE), p).toBe(true);
    }
  });
  it("正常源码不被误伤", () => {
    for (const p of [
      "src/player/index.ts",
      "README.md",
      "test/lodestar/tree.test.ts",
      "docs/distributed-notes.md", // 含 "dist" 但不是 dist/ 目录
      "app/outbound/handler.c" // 含 "out" 但不是 out/ 目录
    ]) {
      expect(isExcluded(p, DEFAULT_EXCLUDE), p).toBe(false);
    }
  });
  it("坏模式被忽略而不是让整层失效", () => {
    expect(isExcluded("src/a.ts", ["["])).toBe(false);
  });
});
