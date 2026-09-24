// 由 Step 1 搬运工具从 lib/index.js 原样切出（只移动、未改逻辑）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md §三 L0 · infra


/** 最小 semver：解析（含 prerelease/build）。 */

/** 单段范围匹配（^ ~ >= <= > < = 精确；返回 true = 满足）。 */

/** 范围匹配：支持多个段以逗号/空白分隔（AND）与 `||`（OR）。 */

/**
 * 宽松声明匹配（仅用于插件「显式声明兼容范围」）：prerelease 版本按同线发布版判定——
 * 作者声明 `>=0.1.2` 即代表支持 0.1.2 线，框架运行在 0.1.2-rc.1 应判定兼容。
 */

/** 解析 DSH 框架版本号为可比较对象；正式版（无预发布段）视为 rc.∞。 */

/** 判断 candidate 是否比 current 更新（候选与当前必须是合法版本号，否则视为不可比）。 */

function parseSemverText(v) {
  const m = String(v ?? '').trim().replace(/^v/u, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null }
}
function compareSemverText(a, b) {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.pre === null && b.pre === null) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  const pa = a.pre.split('.')
  const pb = b.pre.split('.')
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const xa = pa[i]
    const xb = pb[i]
    if (xa === undefined) return -1
    if (xb === undefined) return 1
    const na = /^\d+$/u.test(xa)
    const nb = /^\d+$/u.test(xb)
    if (na && nb) { const d = Number(xa) - Number(xb); if (d !== 0) return d; continue }
    if (na) return -1
    if (nb) return 1
    const d = xa < xb ? -1 : xa > xb ? 1 : 0
    if (d !== 0) return d
  }
  return 0
}
function semverCompareOne(v, raw) {
  const rText = String(raw).trim()
  const m = rText.match(/^(\^|~|>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/u)
  if (!m) return true
  const op = m[1] ?? ''
  const base = { major: Number(m[2]), minor: m[3] === undefined ? 0 : Number(m[3]), patch: m[4] === undefined ? 0 : Number(m[4]), pre: m[5] ?? null }
  const hasMinor = m[3] !== undefined
  const hasPatch = m[4] !== undefined
  // npm 语义：prerelease 版本只与同 [major,minor,patch] 且范围带 prerelease 的声明匹配
  const preAllowed = v.pre === null || (v.major === base.major && v.minor === base.minor && v.patch === base.patch && base.pre !== null)
  switch (op) {
    case '':
    case '=':
      return preAllowed && compareSemverText(v, base) === 0
    case '<':
      return preAllowed && compareSemverText(v, base) < 0
    case '<=':
      return preAllowed && compareSemverText(v, base) <= 0
    case '>':
      return preAllowed && compareSemverText(v, base) > 0
    case '>=':
      return preAllowed && compareSemverText(v, base) >= 0
    case '~': {
      if (!preAllowed) return false
      if (!hasMinor) return v.major === base.major
      if (!hasPatch) return v.major === base.major && v.minor === base.minor
      return compareSemverText(v, base) >= 0 && !(v.major === base.major && v.minor > base.minor) && v.major === base.major
    }
    case '^': {
      if (!preAllowed) return false
      const upper = base.major === 0
        ? (base.minor === 0 ? { major: 0, minor: 0, patch: base.patch + 1, pre: null } : { major: 0, minor: base.minor + 1, patch: 0, pre: null })
        : { major: base.major + 1, minor: 0, patch: 0, pre: null }
      return compareSemverText(v, base) >= 0 && compareSemverText(v, upper) < 0
    }
    default:
      return true
  }
}
function semverRangeMatch(versionText, rangeText) {
  const v = parseSemverText(versionText)
  if (!v) return false
  const alternatives = String(rangeText ?? '').split(/\s*\|\|\s*/u).filter(Boolean)
  if (alternatives.length === 0) return false
  return alternatives.some((alt) => {
    const parts = alt.split(/\s*[,\s]\s*/u).filter(Boolean)
    return parts.length > 0 && parts.every((part) => semverCompareOne(v, part))
  })
}
function semverRangeMatchLoose(versionText, rangeText) {
  if (semverRangeMatch(versionText, rangeText)) return true
  const v = parseSemverText(versionText)
  if (v === null || v.pre === null) return false
  return semverRangeMatch(`${v.major}.${v.minor}.${v.patch}`, rangeText)
}
function parseFrameworkVersion(value) {
  const m = String(value ?? '').match(/^(\d+)\.(\d+)\.(\d+)(?:-(?:[a-z]+\.)?(\d+))?$/iu)
  if (!m) return -1
  const [, maj, min, pat, rc] = m
  return {
    maj: Number.parseInt(maj, 10),
    min: Number.parseInt(min, 10),
    pat: Number.parseInt(pat, 10),
    rc: rc === undefined ? Number.POSITIVE_INFINITY : Number.parseInt(rc, 10),
  }
}
function isFrameworkVersionNewer(candidate, current) {
  const a = parseFrameworkVersion(candidate)
  const b = parseFrameworkVersion(current)
  if (a === -1 || b === -1) return false
  if (a.maj !== b.maj) return a.maj > b.maj
  if (a.min !== b.min) return a.min > b.min
  if (a.pat !== b.pat) return a.pat > b.pat
  return a.rc > b.rc
}
/**
 * 框架升级候选列表（2026-09-23 用户要求：「有的版本都加上，测试版也可以有列表」）。
 *
 * 为什么需要它：升级面板原先只有**一个**目标（`latest` 优先、否则 `next`），用户看到
 * 「可升级到 0.1.5-rc.3（latest 0.1.5-rc.3 · next 0.1.7-rc.1）」却**没法自己选**——
 * 想上 0.1.7-rc.1 或某个 alpha 只能手敲 pnpm 命令。
 *
 * 规则（安全边界，都在这里钉死）：
 *   · 只收 **严格比 current 新** 的版本（用 `compareSemverText`，保留完整 prerelease 语义：
 *     0.1.5-rc.3 < 0.1.6-alpha.1 < 0.1.7-alpha.1 < 0.1.7-rc.1 < 0.1.7 正式版）；
 *     等于或低于当前的**一律不进列表**——降级另有「回滚到上一版」那条路，不从这里走。
 *   · 注册表顺序（按发布时间）不可信，这里按语义版本**降序**排（最新在最前）；
 *   · `latest` / `next` / `beta` / `alpha` 等 dist-tag 命中的版本带 `channel` 标注，
 *     供前端打「稳定版 / 预发布」标签；`latest` 同时作为 `tagDefault`（默认选中项，保持原行为）。
 *
 * @param {object|null|undefined} meta registry 元数据（{ 'dist-tags', versions }）
 * @param {string|null} current 当前已装框架版本
 * @returns {{ versions: Array<{version: string, channel: string|null, isLatest: boolean}>, tagDefault: string|null }}
 */
function frameworkUpgradeCandidates(meta, current) {
  const tags = meta !== null && typeof meta === 'object' && meta['dist-tags'] !== null && typeof meta['dist-tags'] === 'object'
    ? meta['dist-tags']
    : {}
  const cur = parseSemverText(current)
  const all = meta !== null && typeof meta === 'object' && meta.versions !== null && typeof meta.versions === 'object'
    ? Object.keys(meta.versions)
    : []
  const newer = []
  for (const v of all) {
    const parsed = parseSemverText(v)
    if (parsed === null) continue
    if (cur !== null && compareSemverText(parsed, cur) <= 0) continue
    newer.push(v)
  }
  newer.sort((a, b) => compareSemverText(parseSemverText(b), parseSemverText(a)))
  const tagDefault = typeof tags.latest === 'string' && newer.includes(tags.latest) ? tags.latest : null
  const versions = newer.map((v) => {
    const channel = Object.keys(tags).find((name) => tags[name] === v) ?? null
    return { version: v, channel, isLatest: channel === 'latest' }
  })
  return { versions, tagDefault }
}

export { parseSemverText, compareSemverText, semverCompareOne, semverRangeMatch, semverRangeMatchLoose, parseFrameworkVersion, isFrameworkVersionNewer, frameworkUpgradeCandidates }