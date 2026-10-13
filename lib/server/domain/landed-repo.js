// L1 · domain —— 已落地仓库复用（批次 C-⑩ 2026-09-27 加法；0.5.48 从 repoland.js 抽出）
//
// 为什么单开一个模块：repoland.js 贴着 tests/test-architecture-guard.mjs 的 **单文件 ≤ 600 行**硬顶，
// 而"判断某个仓库本机是否已经落地、能不能直接复用"是自洽的一块只读逻辑（0.5.48 改错时新增了判据，
// 抽出来是**搬移 + 那一条判据**，导出名与行为在 repoland.js 侧保持不变）。
//
// 为什么要有这条复用：用户在「仓库落地」里已经把仓库拉到本地（reposDir，默认 ~/.dsh/repos），
// 安装/套装装配时再去网上拉一遍纯属浪费 —— 本机直连不通时甚至是"白等一场空"。
//
// ★ 2026-10-13（0.5.48）改错：判据从"**仓库根**必须有 package.json"改为
//   「根有清单 **或** 目标子目录有清单」。
//   为什么原来那条对**子目录插件结构性失效**：像 DeepSeek-Bot 这类仓库，根目录**故意**没有
//   package.json（真正的插件在 `<repo>/<subdir>/`）。旧判据要求根有清单 ⇒ 这类仓库**永远 hit:false**
//   ⇒ 明明本地已经落地，还是去网上重拉一遍 —— 恰好把"已落地优先 ⇒ 零网络"这条特性，
//   对它最该服务的场景（用户特地为子目录插件落的仓库）废掉了。
//   `subdir` 由调用方按本次安装目标传入（形如 `web-search` 或 `packages/web-search`）；
//   不传 ⇒ 只认根清单 ⇒ **行为与旧版逐项相同**（不改变既有调用点的语义、不制造新的命中面）。

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 已落地仓库复用（纯判断，只读）。返回 `{ hit, path, subdir? }`；deps 只为单测注入。 */
function findLandedRepoImpl(repo, deps = {}) {
  const exists = deps.exists ?? existsSync
  const list = deps.listLanded
  const full = String(repo ?? '').trim().replace(/\.git$/u, '')
  if (full === '' || !full.includes('/')) return { hit: false, path: null }
  const subdir = typeof deps.subdir === 'string' && deps.subdir.trim() !== ''
    ? deps.subdir.trim().replace(/^[./\\]+/u, '').replace(/\\/gu, '/')
    : null
  let landed = []
  try { landed = list() ?? [] } catch { landed = [] }
  const match = landed.find((r) => String(r.repo).toLowerCase() === full.toLowerCase())
  if (match === undefined) return { hit: false, path: null }
  try {
    if (exists(join(match.path, 'package.json'))) return { hit: true, path: match.path }
    // 根没有清单：只有调用方明确给了子目录时才继续看子目录（否则不扩大命中面）
    if (subdir !== null && exists(join(match.path, ...subdir.split('/'), 'package.json'))) {
      return { hit: true, path: match.path, subdir }
    }
    return { hit: false, path: match.path }
  } catch {
    return { hit: false, path: match.path }
  }
}

export { findLandedRepoImpl }
