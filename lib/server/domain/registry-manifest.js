// L1 · domain —— registry-manifest.js（npm registry 上的**包清单**通道：packument 元数据）
//
// 缺口（2026-10-13 用户实测 `corrinehu/dsh-workbuddy-connect` 报「抓取超时」）：
// 「抓仓库清单」这一步的 4 条通道**全部指向 GitHub**（raw / api / gh CLI / jsDelivr CDN）——
// GitHub 一挂，整个探测就完；而**同一个包在 npm 上好好的**（该插件确实已发布：name
// `dsh-workbuddy-connect`、version 0.7.3）。registry 是另一条完全独立的网络路径
// （国内还有 npmmirror 镜像），把它接进探测链就能救回这一整类"GitHub 不通但 npm 通"的失败。
//
// 取的是 registry 的 **packument /latest 文档**：它本身就是这个包的 package.json 清单
// （name / version / private / dsh 标记 / repository …），无需下载 tarball 再解压 —— 一次 GET，
// 与"读仓库清单"的产物同构，因此可以直接进同一条竞速链。
//
// 顺序（按可达性）：npmmirror 镜像优先 → 官方 registry 兜底；各带上限（见 REGISTRY_TIMEOUT_MS）。
// **安全**：镜像与官方一视同仁 —— 拿回来的文本照样过上游的 JSON 解析 + name 字段校验，
// 回退通道不降低任何校验标准。
//
// 分层：本文件属 L1 · domain —— 不得出现 cordis ctx（test-architecture-guard 断言⑤）。

import { curlText } from '../infra/http.js'

/** 单条 registry 通道的请求上限。两条串行（镜像→官方）最坏 ≈2×8s，与既有 4 条通道并行，
 * 不额外拉长整体等待（外层还有 FETCH_BUDGET_MS 兜底）。 */
const REGISTRY_TIMEOUT_MS = 8000
const NPM_MIRROR = 'https://registry.npmmirror.com'
const NPM_OFFICIAL = 'https://registry.npmjs.org'

/** 只接受合法 npm 包名（外部索引/环境给的名字不得拿去拼 URL 路径）。
 * 与 market.js#npmNameHintForRepo 同一判据（那里也在拦外部数据）。 */
function isSafePackageName(name) {
  return /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u.test(String(name ?? ''))
}

/** scoped 包名的路径形式：`@scope/name` → `@scope%2Fname`（registry 也接受未编码的 `/`，
 * 但编码后对镜像更稳）。非 scoped 原样返回。 */
function registryPathOf(name) {
  const text = String(name ?? '')
  return text.startsWith('@') ? text.replace('/', '%2F') : text
}

/** 读一个包在某个 registry 上的清单**文本**（`<registry>/<name>/latest`）。
 * 返回 string = 读到了；返回 null = 这个 registry 上**确定没有**这个包（404）
 *   —— 或（0.5.47 加法）文档的 `repository` 字段**指向的不是调用方要的那个仓库**：
 *   本模块只负责"取回来"，"是不是本仓库的包"由 repo-package-match.js 判；
 *   但一旦调用方给了 `expectedRepo`，不匹配就必须当成"没读到"（**不猜名**：名字像不算命中）。
 * 抛异常 = 通道本身失败（网络/超时/5xx），由竞速记录成"这条通道为什么没成"。
 * deps.text 只为单测注入（生产走 curlText，绕开 node:https 的 TLS 指纹拦截）。 */
async function registryManifestText(name, registry = NPM_MIRROR, deps = {}) {
  if (!isSafePackageName(name)) throw new Error('包名不合法，拒绝请求 registry')
  const text = deps.text ?? curlText
  const url = `${String(registry).replace(/\/+$/u, '')}/${registryPathOf(name)}/latest`
  const timeout = Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : REGISTRY_TIMEOUT_MS
  try {
    const body = await text(url, timeout, { ipv4: true })
    const trimmed = typeof body === 'string' ? body.trim() : ''
    if (trimmed === '') throw new Error('registry 返回空响应')
    if (typeof deps.expectedRepo === 'string' && deps.expectedRepo !== '' && !repoFieldMatches(trimmed, deps.expectedRepo)) return null
    return trimmed
  } catch (error) {
    // 404 = 该源上没有这个包（确定性结论，交回上层按 not-found 处理，不再上升为通道失败）
    if (error instanceof Error && /HTTP 404|404/u.test(error.message)) return null
    throw error
  }
}

/** 文档的 `repository` 字段是否指向这个仓库（归一化比较：忽略大小写 / `.git` / `git+` / `#path`）。
 * 这里做**宽松**判定（只回答"像不像同一个仓库"），严格判定在 repo-package-match.js。
 * 拿不到 repository 字段 ⇒ 一律不匹配（没有证据就不认账）。 */
function repoFieldMatches(manifestText, repo) {
  let parsed = null
  try { parsed = JSON.parse(manifestText) } catch { return false }
  const raw = parsed?.repository ?? parsed?.latest?.repository ?? null
  const url = typeof raw === 'string' ? raw : (raw !== null && typeof raw === 'object' ? raw.url : null)
  const norm = (value) => String(value ?? '').trim().toLowerCase()
    .replace(/^git\+/u, '').replace(/\.git(?=$|[#?])/u, '').replace(/^\/+|\/+$/gu, '')
  const want = norm(repo)
  if (want === '' || typeof url !== 'string' || url === '') return false
  const text = norm(url)
  // 认 https://github.com/o/r、git://github.com/o/r、github:o/r、ssh://git@github.com/o/r 这些写法
  const tail = text.replace(/^[a-z+]+:\/\//u, '').replace(/^[^@/]*@/u, '').replace(/^[a-z]+:/u, '')
  const path = tail.replace(/^[^/]+\//u, '')
  return tail === want || path === want || tail.endsWith(`/${want}`) || text.includes(want)
}

/** 探测链的 registry 通道描述列表（顺序即优先级：npmmirror → 官方）。
 * `deps.text` 注入后两条通道共用（单测离线用）；生产不传。 */
function registryManifestChannels(name, deps = {}) {
  if (!isSafePackageName(name)) return []
  return [
    {
      id: 'npm-mirror',
      label: 'npm 镜像',
      run: () => registryManifestText(name, NPM_MIRROR, deps),
    },
    {
      id: 'npm-official',
      label: 'npm 官方源',
      run: () => registryManifestText(name, NPM_OFFICIAL, deps),
    },
  ]
}

export { REGISTRY_TIMEOUT_MS, NPM_MIRROR, NPM_OFFICIAL, isSafePackageName, registryPathOf, registryManifestText, registryManifestChannels, repoFieldMatches }
