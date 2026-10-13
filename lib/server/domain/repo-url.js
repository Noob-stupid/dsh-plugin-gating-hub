// L1 · domain —— repo-url.js（仓库引用 ↔ 仓库 URL 的归一与解析；0.5.47 从 market.js 切出）
//
// 为什么单开一个叶子模块：`parseRepoFromUrl` **两个方向都要用** —— market.js 的 npm 包名搜索
// （packument 的 repository.url → 仓库标识）与 repo-package-match.js 的"按 repository 字段匹配仓库"。
// 后者被 market.js import，若它还回头 import market.js 就成环（ESM 环里 TDZ 会让其中一个拿到 undefined）。
// 放到叶子模块后两边都只向下依赖，方向单向、可静态断言。
//
// 分层：本文件属 L1 · domain —— 不得出现 cordis ctx（test-architecture-guard 断言⑤）。

/** 从 npm 的 repository 字段解析出 GitHub/Gitee 仓库标识（纯函数，单测覆盖）。
 * 支持 `https://github.com/o/r.git`、`git+https://…`、`git://…`、`ssh://git@github.com/o/r`、
 * `github:o/r` / `gitee:o/r` 简写、带 `#path` 的 monorepo 写法。 */
function parseRepoFromUrl(url) {
  const raw = String(url ?? '').trim()
  // npm 老式简写：`github:owner/repo` / `gitee:owner/repo`
  const shorthand = raw.match(/^(?:github|gitee):([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[#?].*)?$/u)
  if (shorthand !== null) return `${shorthand[1]}/${shorthand[2]}`
  const m = raw.match(/(?:github\.com|gitee\.com)[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[#?].*)?$/u)
  if (m === null) return null
  return `${m[1]}/${m[2]}`
}

export { parseRepoFromUrl }
