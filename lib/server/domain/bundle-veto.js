// L1 · domain —— bundle 级否决（「被框架跳过的 bundle」）
//
// 真机现场（2026-10-15，用户原话：「为啥有的插件我本身是有的，但是没显示呢，比如 opviking 的 memory 插件」）：
//   `@openviking/dsh-memory-plugin` 装了、在 `dsh.profile.bundles` 里、自己的补丁也正常，
//   但面板上**一个字都没有**。原因在框架侧：`dsh-app-boot#loadProfileDirectory` 在**装载 bundle 时**
//   检查该 bundle 自身的 dsh peers，不满足就 `throw` ⇒ 整个 bundle 层进 `skippedBundles`，
//   它要插入的行因此**根本不存在**；而面板是 enumerate loader 行的，自然什么都不显示。
//
//   框架只把原因写进 `skippedBundles`（且不打印），控制台过去**完全不知道**这件事
//   （全仓 grep 只有一句提示文案提过 compatibility.json）—— 于是"插件静默消失"。
//   本模块把它变成可见：**复算同一判据，纯只读，绝不改动任何东西**。
//
// 判据与框架逐字对齐（`dsh-app-boot` 的 `evaluatePluginCompatibility` + `resolveBundleDir`）：
//   ① **解析顺序：安装锚点优先，profile 兜底**。框架注释写明"内置 bundle 永远来自运行中的 dsh 安装，
//      不用 profile 本地副本"——所以不能用"profile 优先"，否则会把内置 bundle 判成跳过（误报）。
//   ② 只看 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 这类 peer（复用 peer-veto 的 unsatisfiedPeers）。
//   ③ **豁免优先**：profile 的 `compatibility.json` 里 `"包@精确版本": ["DSH版本"...]` 命中当前框架版本
//      ⇒ 框架不跳过 ⇒ 我们也不许报"被跳过"。读不出/坏文件 ⇒ 视为无豁免（与框架同款降级）。
//   ④ 没有 `dsh.bundle` 声明的也算跳过（框架在同一个 try 里抛错），但**原因不同**，必须分开说。
//
// 分层：L1 domain —— 不认识 cordis ctx；收的是已解开的 profileDir / baseUrl（架构守卫 ⑤）。
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { unsatisfiedPeers } from './peer-veto.js'

/** profile 本地兼容豁免文件名（框架常量同名）。 */
const COMPATIBILITY_FILE = 'compatibility.json'

const readJsonSafe = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/**
 * 读 profile 的兼容豁免。形状与框架 `readProfileCompatibility` 一致：
 *   顶层是 map：`"@scope/pkg@1.2.3"` → `["0.2.1-rc.2", ...]`
 * 坏文件 / 坏记录一律**忽略**（绝不因为读不懂就不让 profile 用；与框架同款降级）。
 * @returns {Object<string, string[]>} 只含被接受的记录
 */
function readCompatExemptions(profileDir) {
  if (typeof profileDir !== 'string' || profileDir === '') return {}
  const value = readJsonSafe(join(profileDir, COMPATIBILITY_FILE))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [key, versions] of Object.entries(value)) {
    if (typeof key !== 'string' || key.lastIndexOf('@') <= 0) continue
    if (!Array.isArray(versions) || !versions.every((v) => typeof v === 'string' && v !== '')) continue
    out[key] = versions
  }
  return out
}

/** 安装锚点：运行中 dsh 安装的 package.json 绝对路径（框架 resolveBundleDir 的第一个锚点）。取不到返回 null。 */
function installAnchorFrom(baseUrl) {
  try {
    return createRequire(typeof baseUrl === 'string' && baseUrl !== '' ? baseUrl : 'file:///').resolve('@deepseek-ai/dsh/package.json')
  } catch {
    return null
  }
}

/** 从某个锚点按 Node 语义找包的 package.json；找不到返回 null。
 *  与框架的 `packageDirFromAnchor` 同义：从 anchor 所在目录向上找 `node_modules/<包名>/package.json`
 *  （bundle 可能装在上一层，例如安装锚点就在 `node_modules/@deepseek-ai/dsh/` 里）。 */
function packageJsonFromAnchor(anchor, packageName) {
  if (typeof anchor !== 'string' || anchor === '') return null
  const parts = String(packageName).split('/')
  let dir = dirname(anchor)
  for (let i = 0; i < 12; i += 1) {
    const candidate = join(dir, 'node_modules', ...parts, 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * 解析这个 bundle 的 package.json 路径：**安装锚点优先，profile 兜底**（与框架 resolveBundleDir 同序）。
 * @returns {string|null}
 */
function resolveBundlePackageJson(packageName, profileDir, baseUrl) {
  const anchors = []
  const install = installAnchorFrom(baseUrl)
  if (install !== null) anchors.push(install)
  if (typeof profileDir === 'string' && profileDir !== '') anchors.push(join(profileDir, 'package.json'))
  for (const anchor of anchors) {
    const hit = packageJsonFromAnchor(anchor, packageName)
    if (hit !== null) return hit
  }
  return null
}

/**
 * 复算：这个 bundle 会不会被框架**整层跳过**？返回 null = 不会（正常装载）。
 *
 * @param {object} p
 * @param {string} p.bundleName `dsh.profile.bundles` 里的包名
 * @param {string} p.profileDir profile 根目录
 * @param {string} [p.baseUrl] 解析安装锚点用（route 传 ctx.baseUrl）
 * @param {string} p.frameworkVersion 运行时框架版本
 * @param {Object<string,string[]>} [p.exemptions] 已读好的豁免（省得每个 bundle 重读一遍文件）
 * @returns {null | { packageName: string, version: string|null, path: string|null,
 *                    kind: 'missing'|'no-bundle'|'peers', reason: string, hint: string }}
 */
function bundleVetoFor({ bundleName, profileDir, baseUrl = '', frameworkVersion, exemptions = null } = {}) {
  if (typeof bundleName !== 'string' || bundleName === '') return null
  if (typeof frameworkVersion !== 'string' || frameworkVersion === '') return null
  const pkgPath = resolveBundlePackageJson(bundleName, profileDir, baseUrl)
  if (pkgPath === null) {
    return {
      packageName: bundleName,
      version: null,
      path: null,
      kind: 'missing',
      reason: `被框架跳过：bundle ${bundleName} 解析不到（既不在安装里，也不在 profile 里）`,
      hint: '出路：该 bundle 声明在 dsh.profile.bundles 里但包体不存在——重装它，或从 dsh.profile.bundles 里删掉这一行。',
    }
  }
  const manifest = readJsonSafe(pkgPath)
  if (manifest === null || typeof manifest !== 'object') {
    return {
      packageName: bundleName, version: null, path: pkgPath, kind: 'missing',
      reason: `被框架跳过：bundle ${bundleName} 的 package.json 读不出来`,
      hint: '出路：重装该 bundle（清单读不出来时框架只能跳过它）。',
    }
  }
  const version = typeof manifest.version === 'string' ? manifest.version : null
  // ④ 没有 dsh.bundle 声明：框架在同一个 try 里抛错 ⇒ 同样被跳过，但原因与 peer 无关（分开说）
  if (manifest.dsh?.bundle === undefined) {
    return {
      packageName: bundleName, version, path: pkgPath, kind: 'no-bundle',
      reason: `被框架跳过：bundle ${bundleName}@${version ?? '?'} 的 package.json 没有 dsh.bundle 声明`,
      hint: '出路：这不是一个 bundle 包——把它从 dsh.profile.bundles 里删掉，或换成声明了 dsh.bundle 的包。',
    }
  }
  // ② + ③ peers 与豁免
  const peers = unsatisfiedPeers(manifest, frameworkVersion)
  if (peers.length === 0) return null
  const table = exemptions === null ? readCompatExemptions(profileDir) : exemptions
  const key = `${manifest.name ?? bundleName}@${version ?? ''}`
  if (Array.isArray(table[key]) && table[key].includes(frameworkVersion)) return null // 已豁免 ⇒ 框架不跳过
  const first = `${peers[0].name}@${peers[0].range}`
  const what = peers.length === 1 ? first : `${first} 等 ${peers.length} 项`
  return {
    packageName: bundleName,
    version,
    path: pkgPath,
    kind: 'peers',
    reason: `被框架跳过：bundle 自身的 peer 不满足（需要 ${what}，当前 ${frameworkVersion}）`,
    hint: `出路：把该 bundle 更新到兼容当前框架的版本（首选）；或在 profile 的 ${COMPATIBILITY_FILE} 里授精确版本豁免（${key} → ["${frameworkVersion}"]）；不需要就把它从 dsh.profile.bundles 删掉。`,
    judged: { version, path: pkgPath, peers },
  }
}

/** 批量复算（豁免只读一次）。
 *
 * ★ 可靠性判定（真机试算后加的，必须有）：框架解析 bundle 是"**安装锚点优先**、profile 兜底"。
 *   如果**安装锚点解析不出来**（例如普通 Node 读不进 Electron 的 asar），我们的解析就退化成
 *   "只看 profile" —— 那会把**内置 bundle**（`@deepseek-ai/dsh-web-app` 这种明明在跑的）误报成"被跳过"。
 *   实测过一次：普通 Node 下把 5 个 bundle 报成跳过，其中 `dsh-web-app` 显然在正常工作。
 *   ⇒ 判据不可靠时**宁可不报**（返回空 + 说明），也绝不制造假警报。
 *   生产环境（Electron 宿主）里锚点是可解析的 —— 面板那句"当前 0.2.1-rc.2"正是同一套解析出来的。
 *
 * @returns {{ items: Array<object>, reliable: boolean, note: string|null }}
 */
function bundleVetoList({ bundleNames, profileDir, baseUrl = '', frameworkVersion } = {}) {
  const list = Array.isArray(bundleNames) ? bundleNames : []
  const empty = { items: [], reliable: true, note: null }
  if (list.length === 0) return empty
  if (typeof frameworkVersion !== 'string' || frameworkVersion === '') {
    return { items: [], reliable: false, note: '拿不到运行时框架版本，无法判定 bundle 是否被跳过' }
  }
  const installAnchor = installAnchorFrom(baseUrl)
  if (installAnchor === null) {
    // 与框架的解析顺序不一致 ⇒ 我们的结论不可信 ⇒ 什么都不报（见上面的真机试算）。
    return {
      items: [],
      reliable: false,
      note: '解析不到 dsh 安装位置（安装锚点），无法复现框架的 bundle 解析顺序——本项判定已跳过，以免误报',
    }
  }
  const exemptions = readCompatExemptions(profileDir)
  const items = []
  for (const name of list) {
    try {
      const hit = bundleVetoFor({ bundleName: name, profileDir, baseUrl, frameworkVersion, exemptions })
      if (hit !== null) items.push(hit)
    } catch {}
  }
  return { items, reliable: true, note: null }
}

export { COMPATIBILITY_FILE, readCompatExemptions, installAnchorFrom, resolveBundlePackageJson, bundleVetoFor, bundleVetoList }
