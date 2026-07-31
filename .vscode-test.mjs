import { defineConfig } from "@vscode/test-cli";

// E2E：在真实的 VS Code 扩展宿主里跑。vitest 那套只能覆盖纯函数层，
// inline note 的折叠/展开、失配判定、装饰绘制全部焊死在 vscode API 上，
// 只有这里能真的敲键、移光标、读回 buffer 与 sidecar。
export default defineConfig({
  label: "e2e",
  files: "test-e2e/**/*.test.js",
  workspaceFolder: "./test-e2e/fixture",
  launchArgs: ["--disable-extensions"],
  mocha: {
    ui: "bdd",
    timeout: 60000,
    slow: 5000
  }
});
