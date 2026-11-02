// L1 · domain —— framework-stale-restore.js（「改名残留」能不能恢复的**判据**；0.5.99 改错）
//
// ── 真机现场（2026-11-02，用户实测）────────────────────────────────────────────────
// 框架包里出现大量「**真名目录存在，但是空壳**（没有 package.json），真正内容被改名成了
// `<name>.stale-<ver>-<ts>`」：
//     真名 cordis\                        → 空（无 package.json）
//     cordis.stale-4.0.4-1793185607671\   → 有内容（package.json + lib）
//   该目录下总计 564 项，其中 276 个是 .stale-*。后果：`@deepseek-ai/cordis` 解析失败
//   （`ERR_MODULE_NOT_FOUND`），插件的 `import` 直接起不来；把 178 个空壳从 .stale-* 恢复后成功。
//
// ── 旧判据的缺陷（本次修的正是它）──────────────────────────────────────────────────
// 旧实现是「真名**缺失**（exists=false）才恢复；真名已存在就跳过」。真机现场恰恰是
// 「真名存在但是空壳」⇒ 被跳过 ⇒ 坏状态一直留着，框架一直起不来。
//
// ── 新判据（三条，全部可离线断言）──────────────────────────────────────────────────
//   ① **可用**的定义是「这个目录里有 package.json」；目录存在但没有 package.json = **空壳 = 不可用**，
//      在判据里与"缺失"同等对待（都算"真名此刻不可用"）。
//   ② 恢复前必须校验候选的 `package.json.name` 与真名一致（`<scope>/<real>`）——
//      不一致一律不动，记 `failed`（防张冠李戴：把别的包改成这个名字）。
//   ③ 三类结果分开报告：`restore`（可恢复）/ `noCandidate`（真缺内容且没有可用的 .stale-*）/
//      `failed`（候选名字不符、候选本身不可用等）—— 调用方要能原样写进升级日志。
//
// 本模块只做**判据与计划**（读目录 + 读 package.json，纯读、零写盘）；改名/读回核实/回滚在
// domain/framework-cleanup.js#restoreStaleBackups（动作层），两处调用方共用同一条路。
import { readdirSync, readFileSync, lstatSync } from 'node:fs'
import { basename, join } from 'node:path'

/** 空壳挪开后用的后缀（**挪开不删**，保留可回溯）。 */
const EMPTY_SUFFIX = '.empty-'
/** 改名残留的后缀（`<real>.stale-<ver>-<ts>`）。 */
const STALE_MARK = '.stale-'

function errText(error) {
  return String(error?.message ?? error)
}

/** 从目录名拆出真名（`cordis.stale-4.0.4-123` → `cordis`）；不是残留就返回 null。 */
function staleRealNameOf(name) {
  if (typeof name !== 'string') return null
  const at = name.indexOf(STALE_MARK)
  if (at <= 0) return null
  return name.slice(0, at)
}

/** 真名对应的**包名**（scope 目录下是 `@scope/real`；不是 scope 目录就用真名本身）。 */
function expectedPackageName(scopeDir, real) {
  const scope = basename(String(scopeDir ?? ''))
  return scope.startsWith('@') ? `${scope}/${real}` : real
}

/** 空壳挪开后的名字：`<real>.empty-<stamp>`。 */
function emptyShellName(real, stamp) {
  return `${real}${EMPTY_SUFFIX}${stamp}`
}

/** 读 `<dir>/package.json`：`{ ok, name, version, error }`（读不到/解析不了都如实带原因）。 */
function packageJsonOf(dir, { readText = (p) => readFileSync(p, 'utf8') } = {}) {
  try {
    const raw = JSON.parse(readText(join(dir, 'package.json')))
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, name: null, version: null, error: 'package.json 不是对象' }
    return { ok: true, name: typeof raw.name === 'string' ? raw.name : null, version: typeof raw.version === 'string' ? raw.version : null, error: null }
  } catch (error) {
    return { ok: false, name: null, version: null, error: errText(error) }
  }
}

/** 名字里那个"被占用"的东西（空壳 / 链接 / 文件 / 真实目录）：lstat 能立住就算被占着。 */
function isOccupied(dir, { lstat = lstatSync } = {}) {
  try { lstat(dir); return true } catch { return false }
}

/**
 * **可用**的判据（用户 2026-11-02 定案）：目录里有**能读出来的 package.json**。
 * 注意它不看包名 —— 「是不是这个包」由 `packageJsonOf().name` 与真名比对，两件事分开判。
 */
function isUsablePackageDir(dir, deps = {}) {
  const lstat = deps.lstat ?? lstatSync
  let stat = null
  try { stat = lstat(dir) } catch { return false }
  try { if (stat?.isDirectory?.() === false && stat?.isSymbolicLink?.() !== true) return false } catch {}
  return packageJsonOf(dir, deps).ok === true
}

/** 候选排序用的时间戳（`<real>.stale-<ver>-<ts>` 里尾巴那串数字；没有就是 0）。 */
function candidateStamp(name) {
  const m = String(name ?? '').match(/-(\d{6,})$/u)
  return m === null ? 0 : Number(m[1])
}

/**
 * 挑要恢复的那份候选：包名必须与真名一致（防张冠李戴），多份时取**时间戳最新**的那份。
 * 返回 `{ picked, mismatch, unusable }` —— `mismatch` 是"有 package.json 但名字不对"的候选，
 * 它们不是可以恢复的对象，但**必须**在报告里点名（否则用户不知道为什么没恢复）。
 */
function pickRestoreCandidate({ scopeDir, real, candidates, deps = {} } = {}) {
  const expected = expectedPackageName(scopeDir, real)
  const usable = []
  const mismatch = []
  const unusable = []
  for (const name of Array.isArray(candidates) ? candidates : []) {
    const info = packageJsonOf(join(scopeDir, name), deps)
    if (info.ok !== true) { unusable.push({ name, error: info.error }); continue }
    if (info.name !== expected) { mismatch.push({ name, nameInPkg: info.name, expected }); continue }
    usable.push({ name, version: info.version, stamp: candidateStamp(name) })
  }
  usable.sort((a, b) => (b.stamp - a.stamp) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
  return { picked: usable.length > 0 ? usable[0] : null, usableCount: usable.length, mismatch, unusable }
}

/**
 * 计划一次「改名残留修复」（**纯读，零写盘**）。返回每个真名一项：
 *   `{ real, action: 'restore'|'skip'|'noCandidate'|'failed', staleName, reason, detail,
 *      realOccupied, realUsable, candidates, mismatch, unusable }`
 *
 * 分类规则（顺序即优先级）：
 *   ① 真名**可用** ⇒ `skip`（reason `real-name-exists`）—— 健康树上一个字节都不动（幂等）；
 *   ② 真名不可用（缺失 **或空壳**）+ 有可用候选 ⇒ `restore`；
 *   ③ 真名不可用 + 候选里**有名字不符的** ⇒ `failed`（reason `name-mismatch`，一个都不动）；
 *   ④ 真名不可用 + 候选都不可用（没 package.json）或压根没有候选 ⇒ `noCandidate`。
 */
function planStaleRestore({ scopeDir, deps = {} } = {}) {
  const empty = { ok: false, items: [], problem: null }
  if (typeof scopeDir !== 'string' || scopeDir === '') return { ...empty, problem: '没有给 scopeDir' }
  let entries = []
  try { entries = deps.readdir ? deps.readdir(scopeDir) : readdirSync(scopeDir, { withFileTypes: true }) } catch (error) {
    const missing = error?.code === 'ENOENT'
    return { ...empty, ok: missing, problem: missing ? null : '列不出目录：' + errText(error) }
  }
  const byReal = new Map()
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry?.name
    const isDir = typeof entry === 'string' ? true : entry?.isDirectory?.() === true
    if (typeof name !== 'string' || !isDir) continue
    const real = staleRealNameOf(name)
    if (real === null || real === '') continue
    if (!byReal.has(real)) byReal.set(real, [])
    byReal.get(real).push(name)
  }
  // 真名一侧也要扫：**空壳本身没有 .stale-* 兄弟**时（真缺内容）同样要报 `noCandidate`，
  // 否则升级日志里那批"真名在、内容没了"的行一个字都不会出现（真机就是这样被漏掉的）。
  const realNames = new Set()
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry?.name
    const isDir = typeof entry === 'string' ? true : entry?.isDirectory?.() === true
    if (typeof name !== 'string' || !isDir) continue
    if (name.includes(STALE_MARK) || name.includes(EMPTY_SUFFIX)) continue // 残留/挪开的空壳不是真名
    realNames.add(name)
  }
  for (const real of realNames) if (!byReal.has(real)) byReal.set(real, [])
  const items = []
  for (const real of [...byReal.keys()].sort()) {
    const candidates = byReal.get(real).slice().sort()
    const target = join(scopeDir, real)
    const realOccupied = isOccupied(target, deps)
    const realUsable = realOccupied && isUsablePackageDir(target, deps)
    const base = { real, staleName: null, realOccupied, realUsable, candidates }
    if (realUsable) {
      // 健康行：有候选也只是"旁边留着一份旧残留"，不动（幂等：健康树上零动作、零报告项）
      if (candidates.length === 0) continue
      items.push({ ...base, action: 'skip', reason: 'real-name-exists', detail: `真名目录里已有 package.json —— 不动旁边那份 ${candidates[0]}` })
      continue
    }
    const pick = pickRestoreCandidate({ scopeDir, real, candidates, deps })
    if (pick.picked !== null) {
      items.push({
        ...base,
        action: 'restore',
        staleName: pick.picked.name,
        reason: realOccupied ? 'real-name-unusable' : 'real-name-missing',
        detail: realOccupied
          ? `真名目录存在但没有可读的 package.json（空壳）—— 用 ${pick.picked.name} 恢复，空壳挪成 ${EMPTY_SUFFIX}<ts>`
          : `真名缺失 —— 用 ${pick.picked.name} 恢复`,
        mismatch: pick.mismatch,
        unusable: pick.unusable,
      })
      continue
    }
    if (pick.mismatch.length > 0) {
      items.push({
        ...base,
        action: 'failed',
        reason: 'name-mismatch',
        detail: `候选的 package.json.name 与真名不符（应为 ${expectedPackageName(scopeDir, real)}）：${pick.mismatch.map((m) => `${m.name}=${String(m.nameInPkg)}`).join('、')} —— 一个都不动`,
        mismatch: pick.mismatch,
        unusable: pick.unusable,
      })
      continue
    }
    items.push({
      ...base,
      action: 'noCandidate',
      reason: 'no-usable-stale',
      detail: pick.unusable.length > 0
        ? `真名不可用，且 ${pick.unusable.length} 份 .stale-* 都没有可读的 package.json（不可作为候选）`
        : '真名不可用，且没有任何 .stale-* 候选（框架真缺内容，需要重装）',
      mismatch: pick.mismatch,
      unusable: pick.unusable,
    })
  }
  return { ok: true, items, problem: null }
}

export {
  EMPTY_SUFFIX,
  STALE_MARK,
  candidateStamp,
  emptyShellName,
  expectedPackageName,
  isOccupied,
  isUsablePackageDir,
  packageJsonOf,
  pickRestoreCandidate,
  planStaleRestore,
  staleRealNameOf,
}
