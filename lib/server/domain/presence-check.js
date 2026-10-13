// L1 · domain —— presence-check.js（"它其实已经装上了"的只读核实）
//
// 缺口（2026-10-13 用户实测 `corrinehu/dsh-workbuddy-connect`，报「抓取超时」）：
// 那个插件**当时其实已经装好了**（profile dependencies 里有 `^0.7.2`、`dsh.profile.bundles`
// 里有它、node_modules 下也有实体目录），可面板给的是一句网络失败 —— 用户以为没装上，
// 于是反复重装。**报"安装失败"之前必须先核实"是不是已经装上了"**。
//
// 判据（三处独立事实，全部只读，零网络）：
//   ① `<profile>/node_modules/<name>/package.json` 能解析且 name 完全相等 → 物在盘上（最硬的一条）
//   ② `<profile>/package.json` 的 dependencies / devDependencies 里有这个 name（装过并钉住的痕迹）
//   ③ `<profile>/package.json` 的 `dsh.profile.bundles` 里有这个 name（装配链已认它）
// 三者**分开如实汇报**：只有 ① 能说"已安装"；只有 ②③ 而没有 ①，说明"声明在、物不在"
// （正是 0.4.x 那类"装了没钉住 / 删了目录没删声明"的现场）—— 那种情况必须说清缺什么，
// 不能跟着报成功（与 manifest.js#fallbackNoteOf 的诚实口径一致）。
//
// 分层：本文件属 L1 · domain —— 不得出现 cordis ctx（test-architecture-guard 断言⑤）。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 读 profile 根 package.json（解析失败/不存在一律 null，绝不抛）。 */
function readProfilePkg(profileDir, deps = {}) {
  const exists = deps.exists ?? existsSync
  const read = deps.read ?? ((file) => readFileSync(file, 'utf8'))
  try {
    const file = join(String(profileDir ?? ''), 'package.json')
    if (!exists(file)) return null
    const parsed = JSON.parse(read(file))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 核实一个包是否已在某个 profile 里（三处事实分开返回）。`pkgName` 为空/非法 → installed=false。
 * 返回 `{ installed, packageName, version, sources, missing, message }`：
 *   · installed=true  → ① 命中（物在盘上），可直接对用户说"已安装 vX（无需重装）"
 *   · installed=false → `missing` 列出"有声明没实体"的那些痕迹，供上层拼诚实文案 */
function checkPluginPresence(profileDir, pkgName, deps = {}) {
  const name = typeof pkgName === 'string' ? pkgName.trim() : ''
  const out = { installed: false, packageName: name, version: null, sources: [], missing: [], message: '' }
  if (name === '') return out
  const exists = deps.exists ?? existsSync
  const read = deps.read ?? ((file) => readFileSync(file, 'utf8'))
  const nodeModulesDir = join(String(profileDir ?? ''), 'node_modules')
  // ① 物在盘上（最硬的一条）
  try {
    const manifest = join(nodeModulesDir, name, 'package.json')
    if (exists(manifest)) {
      let parsed = null
      try { parsed = JSON.parse(read(manifest)) } catch { parsed = null }
      if (parsed !== null && typeof parsed === 'object' && parsed.name === name) {
        out.installed = true
        out.version = typeof parsed.version === 'string' ? parsed.version : null
        out.sources.push('node_modules')
        out.message = `已安装 ${name}${out.version === null ? '' : ` v${out.version}`}（无需重装）`
        return out
      }
      // 目录在但清单读不出来/名字对不上：不算已安装，但值得如实说明（半成品目录）
      out.missing.push(`node_modules/${name}（清单读不出来或 name 不匹配）`)
    }
  } catch {}
  // ② / ③ 声明层痕迹（agent 面板与官方插件页看见的就是它们）
  const pkg = readProfilePkg(profileDir, deps)
  try {
    const depsObj = pkg?.dependencies
    const devDepsObj = pkg?.devDependencies
    if (depsObj !== null && typeof depsObj === 'object' && typeof depsObj[name] === 'string') out.sources.push('dependencies')
    if (devDepsObj !== null && typeof devDepsObj === 'object' && typeof devDepsObj[name] === 'string') out.sources.push('devDependencies')
    const bundles = pkg?.dsh?.profile?.bundles
    if (Array.isArray(bundles) && bundles.includes(name)) out.sources.push('dsh.profile.bundles')
  } catch {}
  if (out.sources.length > 0) {
    out.missing.push(`node_modules/${name}（物不在盘上）`)
    out.message = `声明里有 ${name}（${out.sources.join('、')}），但 ${out.missing.join('、')} —— 这是"装了没装完整"，需要重装一次`
  }
  return out
}

/** 从仓库名猜包名候选（`owner/dsh-foo` → `dsh-foo`）。
 * 只用于**兜底核实**（市场索引的 npmNameHint 才是首选口径）：用户点的是仓库，
 * 而插件包名多半就是仓库名去掉 owner（实测 `corrinehu/dsh-workbuddy-connect` → `dsh-workbuddy-connect`）。
 * 猜错无害：核实失败就照旧报网络错误，绝不会因为"猜中"而谎报已安装（名字必须完全相等）。 */
function packageNameCandidates(repo, extra = []) {
  const out = []
  const push = (value) => {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text !== '' && !out.includes(text)) out.push(text)
  }
  for (const value of extra) push(value)
  const full = String(repo ?? '').trim().replace(/\.git$/u, '')
  if (full.includes('/')) push(full.split('/').pop())
  return out
}

/** 在候选名里找**第一个**真的已装上的（物在盘上）。
 * 返回 checkPluginPresence 的结果或 null。多个候选只回报第一次命中 —— 不猜、不合并。 */
function firstInstalledPresence(profileDir, names, deps = {}) {
  for (const name of Array.isArray(names) ? names : [names]) {
    const res = checkPluginPresence(profileDir, name, deps)
    if (res.installed) return res
  }
  return null
}

/** 本地落地命中时给用户的"一键从本地安装"落点：目录 + 既有本地目录来源的规格。
 * 规格用 `link:` —— 与仓库既有约定一致（source-spec.js 判据 C / subdir-install.js：
 * `pnpm add link:<目录>` 就是本地目录的正常形态，依赖由 link 自足性补齐），不另发明协议。 */
function localInstallHint({ dir, packageName = null } = {}) {
  const text = typeof dir === 'string' ? dir.trim() : ''
  if (text === '') return null
  const spec = `link:${text.replace(/\\/gu, '/')}`
  return {
    dir: text,
    spec,
    packageName: typeof packageName === 'string' && packageName !== '' ? packageName : null,
    note: `已从「仓库落地」本地目录读到清单：${text} —— 可按本地目录安装（${spec}），无需等网络`,
  }
}

export { readProfilePkg, checkPluginPresence, packageNameCandidates, firstInstalledPresence, localInstallHint }
