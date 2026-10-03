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

export { dropStaleUpdateCandidates, installedVersionOf }
