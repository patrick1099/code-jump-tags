// 排除名单 —— PURE（不 import vscode）。
//
// 扩展此前对文件**完全没有排除机制**：只判了 uri.scheme === "file"，于是
// `.code-jump-tags/`（自己的 sidecar）、`.vscode/`、`node_modules/`、构建产物
// 一律参与 inline note 扫描与折叠。最糟的一条是 sidecar 自身：store.json 里存着
// note 文本，它被当成普通文件扫描时，其中的 marker 会被折叠、反过来改写 store.json。
//
// 这里只做 glob → RegExp 的纯转换，读配置与接线在各调用点。

// 支持的语法（minimatch 的常用子集，足够覆盖目录排除）：
//   `**/`  跨任意层目录，且允许**零层**（`**/.git/**` 命中 `.git/config`）
//   `/**`  结尾时匹配该目录下任意深度，且允许目录本身
//   `*`    单层内任意字符（不跨 `/`）
//   `?`    单层内单个字符
export function globToRegExp(pattern: string): RegExp {
  const p = pattern.replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        if (p[i + 2] === "/") {
          re += "(?:.*/)?"; // `**/` 可匹配零层目录
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "/") {
      // 结尾的 `/**`：目录本身也算命中
      if (p[i + 1] === "*" && p[i + 2] === "*" && i + 3 === p.length) {
        re += "(?:/.*)?";
        i += 2;
      } else {
        re += "/";
      }
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$");
}

// 工作区相对路径是否命中任一排除模式。路径分隔符统一成 `/`，并剥掉可能的 `./`
// 前缀与前导 `/`，好让 `**/x/**` 这类模式在 Windows 上同样命中。
export function isExcluded(relPath: string, patterns: string[]): boolean {
  if (!patterns || patterns.length === 0) return false;
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  return patterns.some(p => {
    try {
      return globToRegExp(p).test(norm);
    } catch {
      return false; // 用户写坏了模式，忽略它而不是整层失效
    }
  });
}

// package.json 里 `codeJumpTags.exclude` 的默认值必须与此保持一致。
export const DEFAULT_EXCLUDE = [
  "**/.code-jump-tags/**",
  "**/.git/**",
  "**/.vscode/**",
  "**/node_modules/**",
  "**/out/**",
  "**/dist/**",
  "**/build/**"
];
