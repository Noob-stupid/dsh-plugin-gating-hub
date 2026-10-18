// L1 · domain —— 更新候选净化（0.5.37 改错）
//
// 真机缺陷（2026-10-03 用户实测）：卡片上已装 `@deepseek-ai/dsh-time-context` **0.2.0-rc.2**，
// 主源 `registry.npmmirror.com` 的 `latest` 却是 **0.1.1-rc.1**（镜像陈旧，低于已装版本），
// 面板据此提示「发现新版本 0.2.0-rc.2 → 0.1.1-rc.1」并给出「更新」按钮 ⇒ 按下去是**降级**。
//
// 客户端已修（只在"严格更高"时提示）；这里再兜一道：**服务端绝不把"低于已装版本"的候选
// 当新版递出去**。语义与既有返回**字段名完全不变**（latest / next / beta 仍是这三个字段），
// 只是把这种候选清成 null —— 面板因此既不提示降级，也不会拿到错数据。
//
// 判据不做第二份实现：与客户端、路由共用 lib/server/infra/semver.js 的 pickNewerSemver
// （`// <<<update-pick:begin/end>>>` 标记块，两端逐字一致由架构守卫 ⑪ 钉死）。
// 本模块只收**已解开的** baseUrl / profileDir（domain 层不认识 cordis ctx，见架构守卫 ⑤）。
import { entryPkgMeta } from '../infra/paths.js'
import { pickNewerSemver } from '../infra/semver.js'

/** 已装版本（profile 里真实的 package.json，走既有缓存 60s）；读不到返回 null。 */
function installedVersionOf(packageName, baseUrl, profileDir) {
  try {
    const version = entryPkgMeta(packageName, baseUrl ?? 'file:///', profileDir ?? null)?.version
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}

/**
 * 把"严格低于已装版本"的候选清成 null（字段名不变，其余候选原样返回）。
 * 已装版本读不到（未安装的插件 / 解析失败）⇒ 不做任何过滤：既有行为一字不动。
 *
 * @param {{ latest?: string|null, next?: string|null, beta?: string|null }} candidates registry 的 dist-tag 候选
 * @param {string} packageName 包名
 * @param {string} baseUrl 解析起点（route 传 baseUrl / file:///）
 * @param {string|null} profileDir profile 根目录（route 传 profileDirOf）
 * @returns {{ latest: string|null, next: string|null, beta: string|null }}
 */
function dropStaleUpdateCandidates(candidates, packageName, baseUrl, profileDir) {
  const src = candidates !== null && typeof candidates === 'object' ? candidates : {}
  const installed = installedVersionOf(packageName, baseUrl, profileDir)
  if (installed === null) return { latest: src.latest ?? null, next: src.next ?? null, beta: src.beta ?? null }
  // pickNewerSemver(候选, [已装]) !== null ⇔ 已装版本**严格高于**该候选 ⇒ 该候选不是"新版"
  const keep = (value) => (typeof value === 'string' && pickNewerSemver(value, [installed]) !== null ? null : value)
  return { latest: keep(src.latest), next: keep(src.next), beta: keep(src.beta) }
}

/**
 * 从（已净化的）候选里挑"这次更新该去哪个版本"。
 *
 * ★ 0.5.52 加法（真机现场 2026-10-15）：面板对 `@deepseek-ai/*` 这类包**永远说"已是最新版本"**，
 *   于是「不适配 → 禁用 → 更新 → 启用」这条既定流程**走不完**。根因不在候选上（服务端一直把
 *   `latest/next/beta` 三个都返回了），而在**没有任何一处在用 next**：
 *     · 框架那张卡片有语义（`pickFrameworkTarget`：latest 优先，latest 不高于当前而 next 更新时取 next），
 *     · 插件那张卡片却只认 `latest`；而 npm 上 `@deepseek-ai/*` 的 `dist-tags.latest`
 *       是**远古版本**（本机实测 latest=0.1.6-alpha.1、next=0.2.1-rc.2），被
 *       `dropStaleUpdateCandidates` 按"低于已装"清成 null ⇒ 客户端看到 latest 为空 ⇒ 报"已是最新"。
 *   本函数把框架那套语义搬到插件侧，保持**同一口径**：latest 优先，否则 next，再否则 beta。
 *   安全性由调用顺序保证：只传**已净化**的候选进来（低于已装的已被清成 null），
 *   所以"取第一个非空"天然等于"取一个确实更高、且 latest 优先"的版本。
 *
 * @param {{ latest?: string|null, next?: string|null, beta?: string|null }} candidates
 * @returns {string|null} 目标版本；全空 ⇒ null（真的没有更高版本）
 */
/**
 * 版本比较（够用即止的 semver）：先比 major/minor/patch，再比 prerelease。
 * 预发布标识比正式版**低**（1.0.0-rc.1 < 1.0.0），与 semver 一致。
 */
function parseVersionParts(value) {
  const text = String(value).trim().replace(/^v/u, '')
  const [core, ...restPre] = text.split('-')
  const nums = core.split('.').map((x) => Number.parseInt(x, 10))
  const pre = restPre.length > 0 ? restPre.join('-').split('.') : []
  return { nums: [nums[0] || 0, nums[1] || 0, nums[2] || 0], pre }
}

function compareVersions(a, b) {
  const pa = parseVersionParts(a)
  const pb = parseVersionParts(b)
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i] ? 1 : -1
  }
  // 正式版 > 同号预发布
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0
  if (pa.pre.length === 0) return 1
  if (pb.pre.length === 0) return -1
  const len = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < len; i += 1) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = Number.parseInt(x, 10)
    const ny = Number.parseInt(y, 10)
    const xNum = !Number.isNaN(nx) && String(nx) === x
    const yNum = !Number.isNaN(ny) && String(ny) === y
    if (xNum && yNum) { if (nx !== ny) return nx > ny ? 1 : -1; continue }
    if (xNum && !yNum) return -1 // 数字标识 < 字母标识（semver）
    if (!xNum && yNum) return 1
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/**
 * 从 { latest, next, beta } 里选出**该更新的目标版本**。
 * ★ 0.5.74：按 semver 取最高，而不是按通道顺序取第一个非空 —— 官方包只往 next 发版，
 *   旧实现被远古 latest 挡住 ⇒ 永远显示"已是最新版"（真机实测见文件头）。
 *
 * @param {{latest?:string,next?:string,beta?:string}} candidates
 * @param {{installedVersion?:string|null}} [options] 给了就只考虑**比它高**的；全都更低时退回最高者
 */
function pickUpdateTarget(candidates, options = {}) {
  const src = candidates !== null && typeof candidates === 'object' ? candidates : {}
  const list = ['latest', 'next', 'beta']
    .map((key) => src[key])
    .filter((value) => typeof value === 'string' && value !== '')
  if (list.length === 0) return null
  const installed = typeof options?.installedVersion === 'string' && options.installedVersion !== ''
    ? options.installedVersion
    : null
  const highest = (pool) => pool.reduce((best, v) => (best === null || compareVersions(v, best) > 0 ? v : best), null)
  if (installed !== null) {
    const newer = list.filter((v) => compareVersions(v, installed) > 0)
    if (newer.length > 0) return highest(newer)
  }
  return highest(list)
}

export { compareVersions, dropStaleUpdateCandidates, installedVersionOf, pickUpdateTarget }
