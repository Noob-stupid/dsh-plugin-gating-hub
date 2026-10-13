// L1 · domain —— landed-source.js（本地优先：从「仓库落地」目录读清单）
//
// 缺口（2026-10-13 用户实测 `corrinehu/dsh-workbuddy-connect` 报「抓取超时」）：
// 「抓仓库清单」这一步**只有网络通道**——本机 4 条通道全挂（或全慢）就直接失败，
// 而用户其实早把仓库用「仓库落地」克隆到本地了（默认 ~/.dsh/repos/<owner>/<name>，见 repoland.js）。
// 网络是**最不可靠**的一环，本地文件却是零成本、零超时、零失败率的 —— 它必须排在竞速之前。
//
// 为什么单开一个模块：market.js 的探测链要加"本地优先"，而 repoland.js 已经 import 了一堆
// 网络/进程模块（archive-source / exec / sources）。让 market.js 去 import repoland.js 会把
// "读一个本地文件"变成拉进整个克隆链路；这里只依赖 node 内置模块 + 调用方给的落地目录根。
//
// 分层：本文件属 L1 · domain —— 不得出现 cordis ctx（test-architecture-guard 断言⑤）。

import { existsSync, readFileSync } from 'node:fs'
import { join as joinPathDefault } from 'node:path'

/** `owner/name` 归一化：去空白、去 `.git` 后缀、统一小写（Windows 路径与 git 地址都不区分大小写）。 */
function normalizeRepo(repo) {
  return String(repo ?? '').trim().replace(/\.git$/u, '').toLowerCase()
}

/** 把一个仓库名折成落地目录候选路径 `[<root>/<owner>/<name>, <root>/<name>]`。
 * 为什么两种：listLandedRepos 只认 `owner/name` 两级，但用户手工 `git clone` 到落地目录下
 * 平铺一层也是常见做法 —— 两种都试，成本只是一个 existsSync。 */
function landedRepoCandidates(root, repo, deps = {}) {
  const join = deps.join ?? joinPathDefault
  const full = normalizeRepo(repo)
  if (full === '' || !full.includes('/')) return []
  const [owner, ...rest] = full.split('/')
  const name = rest.join('/')
  const base = String(root ?? '').trim()
  if (base === '' || name === '') return []
  return [join(base, owner, name), join(base, name)]
}

/** 从磁盘读一份 `package.json` **文本**（本地优先的**唯一落点**）。
 * 返回文本而不是解析后的对象：与网络通道同一口径 —— "读到了"与"是不是合法清单"是两件事，
 * 判定权统一留给上游（fetchRepoPackageEx），**本地来源不得降低校验标准**。
 * 任何失败（路径不存在 / 读不到 / 空文件）一律返回 null，绝不抛。 */
function localManifestText(dir, deps = {}) {
  const dirText = String(dir ?? '').trim()
  if (dirText === '') return null
  const join = deps.join ?? joinPathDefault
  const exists = deps.exists ?? existsSync
  const read = deps.read ?? ((file) => readFileSync(file, 'utf8'))
  try {
    const file = join(dirText, 'package.json')
    if (!exists(file)) return null
    const text = read(file)
    return typeof text === 'string' && text.trim() !== '' ? text : null
  } catch {
    return null
  }
}

/** 探测链用的本地通道实现（生产默认值；单测注入 deps 即可完全离线）。
 * `roots` 是「仓库落地」目录候选根：由调用方给（install-job 传 getReposDir()），
 * 这样本模块不必 import repoland —— 只读探测不拉起克隆链路。
 * 命中顺序即候选顺序（`owner/name` 优先，其次平铺一层）。 */
function landedManifestText(repo, roots, deps = {}) {
  const dir = landedRepoDir(repo, roots, deps)
  return dir === null ? null : localManifestText(dir, deps)
}

/** 命中「仓库落地」时的**本地目录**（0.5.47 加法）：用户要能"一键从本地安装"，
 * 而安装需要的是**目录**（`file:<dir>` 规格），不只是清单文本。
 * 与 landedManifestText 同一套候选顺序与同一份 deps 注入缝；没命中 ⇒ null。 */
function landedRepoDir(repo, roots, deps = {}) {
  const list = (Array.isArray(roots) ? roots : [roots]).map((r) => String(r ?? '').trim()).filter((r) => r !== '')
  if (list.length === 0) return null
  for (const root of list) {
    for (const dir of landedRepoCandidates(root, repo, deps)) {
      if (localManifestText(dir, deps) !== null) return dir
    }
  }
  return null
}

export { normalizeRepo, landedRepoCandidates, localManifestText, landedManifestText, landedRepoDir }
