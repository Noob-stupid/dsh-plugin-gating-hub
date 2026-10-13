// L1 · domain —— repo-package-match.js（**按 `repository` 字段把仓库引用匹配到 npm 包**；0.5.47 加法）
//
// 缺口（与 0.5.46 同源的真机现场）：用户按**仓库引用**（`corrinehu/dsh-workbuddy-connect`）安装时，
// 「抓仓库清单」这一步四条通道全指向 GitHub，GitHub 一挂整条路就断；而同一个包在 npm 上好好的。
// 要把 registry 接进回退链，先得回答"这个仓库**对应哪个 npm 包**"。
//
// 判据（用户红线）：**不靠猜名** —— 名字只是候选，命中的唯一凭据是 registry 文档里
// `repository` 字段**逐字符指向这个仓库**（归一化后相等：忽略大小写、忽略 `.git` 后缀，
// 认 `git+https://` / `git://` / `github:o/r` / `#path` 这些写法，见 market.js#parseRepoFromUrl）。
// 名字猜错无害（匹配不上就当作"没这条通道"）；名字猜对也**不会**因为"名字像"就认账。
//
// 数据结构（registry `<name>/latest` 文档 = 该版本的 package.json）：
//   `{ name, version, repository: "https://github.com/o/r" | { url } | "github:o/r", … }`
// 取 `repository` 时两处都看：`latest.repository` 与顶层 `repository`（历史包两种都出现过）。
//
// 分层：本文件属 L1 · domain —— 不得出现 cordis ctx（test-architecture-guard 断言⑤）。

import { parseRepoFromUrl } from './repo-url.js'
import { isSafePackageName, registryManifestText, NPM_MIRROR, NPM_OFFICIAL } from './registry-manifest.js'

/** 仓库引用归一化：去空白、去 `git+`、去 `.git` 后缀、去首尾斜杠、统一小写。 */
function normalizeRepoRef(repo) {
  return String(repo ?? '')
    .trim()
    .replace(/^git\+/u, '')
    .replace(/\.git$/u, '')
    .replace(/^\/+|\/+$/gu, '')
    .toLowerCase()
}

/** 从 registry 文档里取 `repository` 的仓库标识（认字符串 / `{ url }` / 老式简写）。
 * 取不到 → null（**不猜**：没有 `repository` 字段的包不参与按仓库匹配）。 */
function repositoryRefOf(manifest) {
  if (manifest === null || typeof manifest !== 'object') return null
  const raw = manifest.repository ?? manifest.latest?.repository ?? null
  const url = typeof raw === 'string' ? raw : (raw !== null && typeof raw === 'object' ? raw.url : null)
  const parsed = parseRepoFromUrl(url)
  return parsed === null ? null : normalizeRepoRef(parsed)
}

/** 这份 registry 文档指向哪个仓库（解析不出 ⇒ null）。 */
function manifestRepoRef(manifestText) {
  let parsed = null
  try { parsed = JSON.parse(String(manifestText)) } catch { return null }
  return repositoryRefOf(parsed)
}

/** 候选包名：显式给的首选（市场索引 npmName / 调用方）在前，其次**仓库名本身**去 owner。
 * 只保留合法 npm 包名（外部数据不拿去拼 URL）。**不生成 scoped 变体**：那是猜名，本模块口径是不猜。 */
function candidatePackageNames(repo, extra = []) {
  const out = []
  const push = (value) => {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text !== '' && isSafePackageName(text) && !out.includes(text)) out.push(text)
  }
  for (const value of Array.isArray(extra) ? extra : [extra]) push(value)
  const full = String(repo ?? '').trim().replace(/\.git$/u, '')
  if (full.includes('/')) push(full.split('/').filter((p) => p !== '').pop())
  return out
}

/** registry 源的候选（顺序即优先级：npmmirror 镜像优先 → 官方兜底）。 */
function registrySources(deps = {}) {
  const given = Array.isArray(deps.registries) ? deps.registries.filter((r) => r !== null && typeof r?.url === 'string' && r.url !== '') : []
  if (given.length > 0) return given
  return [
    { id: 'npm-mirror', label: 'npm 镜像', url: NPM_MIRROR },
    { id: 'npm-official', label: 'npm 官方源', url: NPM_OFFICIAL },
  ]
}

/** 按仓库引用在 registry 上找包：返回 `{ hit, packageName, text, registry, channel, label, notes }`。
 *   · hit=true  ⇒ `repository` 字段逐字符指向本仓库（证据来自 registry 文档本身，不是名字像）
 *   · hit=false ⇒ notes 里逐条写明"哪个候选在哪个源上：没有这个包 / 不是这个仓库 / 通道失败"
 * 每个源上逐个候选试（候选很少，且每步都有上限）；deps.text/registries/timeoutMs 只为单测注入。 */
async function resolvePackageByRepo(repo, { packageNames = [], deps = {} } = {}) {
  const notes = []
  const want = normalizeRepoRef(repo)
  if (want === '') return { hit: false, packageName: null, text: null, registry: null, channel: null, label: null, notes: ['仓库引用为空，未查 registry'] }
  const names = candidatePackageNames(repo, packageNames)
  if (names.length === 0) return { hit: false, packageName: null, text: null, registry: null, channel: null, label: null, notes: ['没有可用作候选的合法 npm 包名（不猜名，跳过 registry 通道）'] }
  for (const source of registrySources(deps)) {
    for (const name of names) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const text = await registryManifestText(name, source.url, deps)
        if (text === null) {
          notes.push(`${name} @ ${source.label}：registry 上没有这个包（404）`)
          continue
        }
        const ref = manifestRepoRef(text)
        if (ref === null) {
          notes.push(`${name} @ ${source.label}：文档里没有可解析的 repository 字段，无法证明它就是这个仓库`)
          continue
        }
        if (ref !== want) {
          notes.push(`${name} @ ${source.label}：仓库字段指向 ${ref}，不是 ${want}`)
          continue
        }
        return { hit: true, packageName: name, text, registry: source.url, channel: source.id, label: source.label, notes }
      } catch (error) {
        notes.push(`${name} @ ${source.label}：通道失败（${error instanceof Error ? error.message : String(error)}）`)
      }
    }
  }
  return { hit: false, packageName: null, text: null, registry: null, channel: null, label: null, notes }
}

/** 把"按仓库匹配"接上既有 registry 探测链：返回**带 repository 校验**的通道（顺序同 registrySources）。
 * 未命中 ⇒ null（"这个候选不是本仓库的包"，与 404 同一出口；**不冒充**"这个包不存在"）；
 * 命中 ⇒ 该包在 registry 上的清单文本（与"读仓库里的 package.json"同构，直接进同一条竞速链）。
 * 回退不降低校验标准：镜像与官方一视同仁，都过 `repository` 字段这一关。 */
function repoMatchedRegistryChannels(repo, { packageNames = [], deps = {} } = {}) {
  const want = normalizeRepoRef(repo)
  const names = candidatePackageNames(repo, packageNames)
  if (want === '' || names.length === 0) return []
  return registrySources(deps).map((source) => ({
    id: source.id,
    label: `${source.label}（按 repository 字段核对）`,
    run: async () => {
      for (const name of names) {
        // eslint-disable-next-line no-await-in-loop
        const text = await registryManifestText(name, source.url, deps)
        if (text === null) continue
        if (manifestRepoRef(text) === want) return text
      }
      return null
    },
  }))
}

export {
  normalizeRepoRef, repositoryRefOf, manifestRepoRef, candidatePackageNames,
  registrySources, resolvePackageByRepo, repoMatchedRegistryChannels,
}
