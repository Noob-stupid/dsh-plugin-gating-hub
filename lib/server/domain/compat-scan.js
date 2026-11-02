// L1 · domain —— compat-scan.js（门控的「按需检查」：对当前补丁里的行跑一次适配判定；0.5.100 加法）
//
// ── 为什么需要（用户 2026-11-02 原话：「我们一般情况下都不预检吧」）──────────────────────────
// compat-pending 只在**框架升级前预扫**与**启动失败隔离**时写入。平时门控里一条记录都没有，
// 而"0 条"会被误读成"全部兼容" —— 这不是事实，只是**没人裁决过**。
// 这个模块给门控一个「现在查一下」的入口：对当前补丁里的行逐行跑判定，把结论如实记下来。
//
// ── 三条硬约束（一条都不许放宽）──────────────────────────────────────────────────────
//   ① **判据只有一份**：复用 `checkPluginFrameworkCompat`（框架升级预扫那条唯一链路里的判定函数，
//      含"源码里是否还引用已删除的 dsh-settings API"这条硬判据）。这里不新增任何兼容判据。
//   ② **只记录结论，绝不禁用任何行**：禁用是用户的动作（`/toggle`）。本模块不 import
//      `disableEntry`、不碰补丁文件 —— 扫描前后补丁必须逐字节不变。
//   ③ **只把判为不适配（fail）的行写进记录**：pass / unknown 只进统计。
//      为什么不能全写：`status:'pending'` 的记录会让 `/toggle` 对该行走"软禁"确认流程（409 +
//      风险确认），把通过的行也写进去等于凭空给用户加一道墙 —— 那是行为变更，不是记录。
//
// 读/写 compat-pending.json 的纪律在 domain/compat-pending-records.js（备份 → 原子写 → 读回核实 → 回滚）。
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolvePackageJson } from '../infra/paths.js'
import { SCANNER_VERSION } from './compat-verdict.js'
import { checkPluginFrameworkCompat, isFrameworkOwnedPackage } from './compat.js'

/** 记录里标注的来源（面板/日志靠它区分"这次是谁裁决的"）。 */
const SCAN_SOURCE = 'manual-scan'
/** 控制台自己永不参与扫描（它要是被判 fail，用户连面板都打不开）。 */
const SELF_ROW_ID = 'plugin-console'

/**
 * 对**当前 loader 行**逐行跑一次适配判定（纯读：不写盘、不禁用、不改补丁）。
 *
 * @param {object} p
 * @param {Array<object>} p.entries  loader 条目（`listEntries()` 的结果）
 * @param {string} p.profileDir      profile 目录（解析已装包用）
 * @param {string|null} p.frameworkVersion 当前框架版本（拿不到 => 全部 unknown，如实标注）
 * @param {object} [p.deps]          注入缝：`resolvePkg` / `readPkg`
 * @returns {{ ok: boolean, results: Array<object>, checked: number, pass: number, fail: number, unknown: number,
 *             skipped: Array<{rowId: string|null, reason: string}>, frameworkVersion: string|null, error: string|null }}
 */
function planCurrentScan({ entries, profileDir, frameworkVersion = null, deps = {} } = {}) {
  const resolvePkg = deps.resolvePkg ?? resolvePackageJson
  const readPkg = deps.readPkg ?? ((p) => JSON.parse(readFileSync(p, 'utf8')))
  const results = []
  const skipped = []
  const fwVer = typeof frameworkVersion === 'string' && frameworkVersion !== '' ? frameworkVersion : null
  for (const entry of Array.isArray(entries) ? entries : []) {
    const rowId = typeof entry?.rowId === 'string' ? entry.rowId : ''
    if (rowId === '') { skipped.push({ rowId: null, reason: 'no-row-id' }); continue }
    if (rowId === SELF_ROW_ID) { skipped.push({ rowId, reason: 'console-self' }); continue }
    const moduleName = typeof entry?.moduleName === 'string' ? entry.moduleName : ''
    let pkgPath = null
    try { pkgPath = moduleName === '' ? null : resolvePkg(moduleName, profileDir) } catch { pkgPath = null }
    if (pkgPath === null) { skipped.push({ rowId, reason: 'package-unreadable', moduleName }); continue }
    let pkg = null
    try { pkg = readPkg(pkgPath) } catch { pkg = null }
    if (pkg === null || typeof pkg !== 'object') { skipped.push({ rowId, reason: 'package-unreadable', moduleName }); continue }
    const pkgDir = dirname(pkgPath)
    let check = null
    if (fwVer === null) check = { decision: 'unknown', reason: '拿不到当前框架版本（无法判定，不是"兼容"）' }
    else {
      try { check = checkPluginFrameworkCompat(pkg, fwVer, pkgDir) } catch (error) { check = { decision: 'unknown', reason: '判定出错：' + String(error?.message ?? error) } }
    }
    const decision = check?.decision === 'pass' || check?.decision === 'fail' ? check.decision : 'unknown'
    results.push({
      rowId,
      moduleName: moduleName === '' ? null : moduleName,
      version: typeof pkg.version === 'string' ? pkg.version : null,
      decision,
      reason: check?.reason ?? null,
      frameworkOwned: isFrameworkOwnedPackage(pkgDir, profileDir),
      enabled: entry?.enabled === true,
    })
  }
  const count = (d) => results.filter((r) => r.decision === d).length
  return {
    ok: true,
    results,
    checked: results.length,
    pass: count('pass'),
    fail: count('fail'),
    unknown: count('unknown'),
    skipped,
    frameworkVersion: fwVer,
    error: fwVer === null ? '拿不到当前框架版本：本次所有行都只能判成"无法判定"' : null,
  }
}

/** 要写进 compat-pending 的记录（**只有 fail**；pass/unknown 只进统计，见模块头注释 ③）。 */
function recordsFromScan(scan, { at = Date.now() } = {}) {
  const list = Array.isArray(scan?.results) ? scan.results : []
  return list.filter((r) => r.decision === 'fail').map((r) => ({
    rowId: r.rowId,
    moduleName: r.moduleName,
    version: r.version,
    status: 'pending',
    check: 'fail',
    checkNote: r.reason,
    source: SCAN_SOURCE,
    scannedAt: at,
    frameworkVersion: scan?.frameworkVersion ?? null,
    // 判据戳：这次用的就是**当前**判据（SCANNER_VERSION），所以"读取代发"不会把它当过期结论重算
    scanVerdict: { version: SCANNER_VERSION, decision: 'fail', reason: r.reason, at, previous: null, rescinded: false, evidence: null },
  }))
}

export { SCAN_SOURCE, SELF_ROW_ID, planCurrentScan, recordsFromScan }
