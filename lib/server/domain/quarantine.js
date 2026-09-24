// L1 · domain —— quarantine.js（启动失败隔离：记录读取 / 合并进兼容清单 / 对账 / 隔离计划）
// 分层 Step 8c-1 从 domain/compat.js 拆出（该文件当时 627 行、超守卫 600 行上限），只搬移未改逻辑。

import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readCompatPending, rowIdModuleMap, writeCompatPending } from './compat.js'
import { CORE_PATCH_ROW_IDS } from './patch.js'
import { dshHome } from '../infra/paths.js'

/** 把升级脚本留下的「启动失败隔离」记录并入适配门清单（只处理一次：处理后改名 .applied）。
 *  作用：服务被隔离救回来之后，用户能在面板上看到「谁被自动关了、为什么」，并可逐个解锁。 */
/** 读取升级脚本写下的隔离记录（含 BOM 兼容）。
 *  ★ 2026-09-11 事故根因：升级脚本用 PowerShell `Set-Content -Encoding UTF8` 写这个文件，
 *  PS5.1 会**带 UTF-8 BOM**；而合并逻辑先"复制 + 删除"再判断 JSON.parse 结果 → BOM 让 parse
 *  必失败 → 记录被销毁、却从未并进适配门清单 → 界面上那 20 行只剩一个**没有解释的【停用】**。
 *  这里统一剥 BOM 再解析；解析失败返回 null（调用方会保留文件、留错误日志，绝不销毁证据）。 */
function readQuarantineRecord() {
  const file = join(dshHome(), 'plugin-console', 'fw-quarantine.json')
  if (!existsSync(file)) return null
  let raw = ''
  try { raw = readFileSync(file, 'utf8') } catch { return null }
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
  try {
    const rec = JSON.parse(raw)
    return rec !== null && typeof rec === 'object' ? rec : null
  } catch { return null }
}

/** 合并隔离记录失败时留痕（v0.3.44）：静默 catch 让 2026-09-11 那次 20 行隔离记录凭空消失，
 *  界面只剩一个没有解释的【停用】，而且事后完全查不到原因。错误落到 fw-merge-error.log。 */
function logQuarantineMergeError(error) {
  try {
    const file = join(dshHome(), 'plugin-console', 'fw-merge-error.log')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${new Date().toISOString()} ${error?.stack ?? String(error)}\n`, { flag: 'a' })
  } catch {}
}

/** 把某行的待适配记录标记为「已适配」（保留历史判定痕迹：check / checkNote / riskyApprovedAt）。
 *  语义（用户定案 2026-09-11）：**启用即视为已适配**，但要留下"曾被判定/隔离"的痕迹供事后查。 */
function markPendingAdopted(pending, rowId, by, meta) {
  const rec = (pending?.pending ?? []).find((p) => p.rowId === rowId)
  if (rec === undefined) return false
  rec.status = 'adopted'
  rec.adoptedAt = Date.now()
  rec.adoptedBy = by
  if (meta !== null && meta !== undefined) {
    if (typeof meta.moduleName === 'string' && meta.moduleName !== '') rec.moduleName = meta.moduleName
    if (typeof meta.version === 'string' && meta.version !== '') rec.version = meta.version
  }
  return true
}

/**
 * 启动失败日志分析器（纯函数，导出供测试）：
 * 从服务/预设的启动失败日志里提取「谁把服务搞挂了」——用于**启动失败隔离**（升级后服务拉不起来时，
 * 先禁用/隔离肇事者并重试，而不是整包回滚）。三类信号：
 *   ① 预设挂载失败：`preset "router-spec" failed to mount` 或路径 `.agent-presets/<name>/agent.cordis.yml`
 *   ② loader 条目应用失败：`failed to apply loader entry <rowId> (<moduleName>)`
 *   ③ 模块解析失败：`Cannot find module '<moduleName>'`
 * 返回 { presets:[name], modules:[{rowId,moduleName}], lines:[命中行] }
 */
function analyzeBootFailure(logText) {
  const text = String(logText ?? '')
  const presets = new Set()
  const modules = new Map() // moduleName -> rowId|null
  const hits = []
  const pushHit = (line) => { if (hits.length < 40 && !hits.includes(line.trim())) hits.push(line.trim().slice(0, 300)) }

  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') continue
    let matched = false
    for (const m of line.matchAll(/preset\s+"([^"]+)"\s+failed to mount/gu)) { presets.add(m[1]); matched = true }
    for (const m of line.matchAll(/\.agent-presets[\\/]([^\\/\s"']+)[\\/]agent\.cordis\.ya?ml/gu)) { presets.add(m[1]); matched = true }
    for (const m of line.matchAll(/failed to apply loader entry\s+(\S+)\s+\(([^)]+)\)/gu)) { modules.set(m[2], m[1]); matched = true }
    for (const m of line.matchAll(/Cannot find module '([^']+)'/gu)) {
      if (!modules.has(m[1])) modules.set(m[1], null)
      matched = true
    }
    if (matched) pushHit(line)
  }
  return {
    presets: [...presets],
    modules: [...modules].map(([moduleName, rowId]) => ({ moduleName, rowId })),
    lines: hits,
  }
}

/** 启动失败隔离决策器（纯函数，导出供测试）。
 * 输入：启动失败日志 + 当前可开关行清单（[{rowId,moduleName,toggleable}]）。
 * 输出一份**可直接执行的隔离方案**（PowerShell 侧只负责照做，不掺判断逻辑）：
 *   presets  要隔离的预设文件（改名 .broken-<ts>，避免预设挂载失败拖垮整个服务）
 *   rows     要写入 disabled:true 的行（已剔除核心行/受保护行/控制台自身）
 *   safeMode 无明确肇事者时是否建议安全模式（禁用全部第三方行，先让服务起来）
 *   coreHits 命中的行属于核心/受保护（禁它没用，正确动作是回滚框架）
 * 设计依据：loader 单行 import 失败 = 整个服务启动崩溃；静态扫描抓不到全部不兼容，
 * 所以必须有一条「起不来 → 定位肇事者 → 隔离 → 重试」的运行时兜底。 */
function planQuarantine({ logText, candidates, presetRoot = null, exists = existsSync }) {
  const analysis = analyzeBootFailure(logText)
  const byModule = new Map()
  const byRow = new Map()
  for (const c of candidates ?? []) {
    if (typeof c?.rowId !== 'string' || c.rowId === '') continue
    if (typeof c.moduleName === 'string' && c.moduleName !== '') byModule.set(c.moduleName, c)
    byRow.set(c.rowId, c)
  }
  const rows = []
  const coreHits = []
  const unknown = []
  for (const m of analysis.modules) {
    const hit = (m.rowId !== null && byRow.get(m.rowId)) || byModule.get(m.moduleName) || null
    if (hit === null) { unknown.push(m.moduleName); continue }
    const isCore = CORE_PATCH_ROW_IDS.has(hit.rowId) || hit.rowId === 'plugin-console'
    if (isCore || hit.toggleable === false) { coreHits.push({ rowId: hit.rowId, moduleName: hit.moduleName }); continue }
    if (!rows.includes(hit.rowId)) rows.push(hit.rowId)
  }
  const root = presetRoot ?? join(dshHome(), '.agent-presets')
  const presets = []
  for (const name of analysis.presets) {
    const file = join(root, name, 'agent.cordis.yml')
    presets.push({ name, file, exists: exists(file) })
  }
  return {
    presets,
    rows,
    unknown,
    coreHits,
    safeMode: presets.length === 0 && rows.length === 0,
    lines: analysis.lines,
  }
}

/** 把升级脚本留下的「启动失败隔离」记录并入适配门清单。
 *  顺序很关键（v0.3.44）：**先写清单并校验成功，再归档移除记录**。反过来的话，
 *  任何解析/写入意外都会"记录没了、清单也没进"，用户只看到一个没有理由的【停用】。
 *  导出仅供测试直接驱动（避免测试为了跑它而 apply 整个插件）。 */
function mergeQuarantineRecord(ports) {
  const file = join(dshHome(), 'plugin-console', 'fw-quarantine.json')
  if (!existsSync(file)) return null
  const rec = readQuarantineRecord()
  if (rec === null) {
    logQuarantineMergeError(new Error('隔离记录无法解析（已按 BOM 兼容处理仍失败），保留文件待下次启动重试'))
    return null
  }
  const rows = (Array.isArray(rec.rows) ? rec.rows : []).filter((rowId) => typeof rowId === 'string' && rowId !== '')
  const pending = readCompatPending() ?? { frameworkVersion: null, upgradeFrom: null, pending: [] }
  if (!Array.isArray(pending.pending)) pending.pending = []
  const lines = Array.isArray(rec.lines) ? rec.lines : []
  // 隔离记录里只有 rowId（脚本写的），但清单里其它地方都按 moduleName 认身份：
  // 「全家桶一键启用已适配」按 moduleName 前缀匹配、`检测到已适配 vX` 也要 moduleName 才能算。
  // 所以这里按当前 loader 反查补上（v0.3.45：补不上就会永远匹配不到 —— 用户实测「点了说没有待适配行」）。
  const info = ports === undefined || ports === null ? new Map() : rowIdModuleMap(ports)
  for (const rowId of rows) {
    const meta = info.get(rowId) ?? null
    const record = {
      rowId,
      moduleName: meta?.moduleName ?? null,
      version: meta?.version ?? null,
      status: 'pending',
      check: 'unknown',
      checkNote: `启动失败隔离（${rec.mode ?? 'targeted'}）：${lines[0] ?? '启动日志命中，服务曾被它拖垮'}`,
      forcedAt: Date.now(),
      source: 'boot-quarantine',
    }
    const at = pending.pending.findIndex((p) => p.rowId === rowId)
    if (at >= 0) pending.pending[at] = { ...pending.pending[at], ...record }
    else pending.pending.push(record)
    // 该行现在就是启用的（比如用户在隔离之后已经手动启用过）→ 直接记成已适配，别留一个假 pending
    if (meta?.enabled === true) markPendingAdopted(pending, rowId, 'row-enabled', meta)
  }
  // 预设隔离单独记录（它不是插件行，没有「启用」语义；解锁 = 把 .broken 文件改回来）
  if (Array.isArray(rec.presets) && rec.presets.length > 0) {
    pending.presetsQuarantined = rec.presets.map((name) => ({ name, at: rec.at ?? null, note: 'agent.cordis.yml 已改名 .broken（启动失败隔离），确认修好后改回文件名即可恢复' }))
  }
  pending.quarantineAt = rec.at ?? null
  pending.quarantineLines = lines.slice(0, 5)
  writeCompatPending(pending)
  // 写后校验：清单里必须真的能看到这些行，才允许销毁原始记录
  const back = readCompatPending()
  const missing = rows.filter((rowId) => !(back?.pending ?? []).some((p) => p.rowId === rowId))
  if (back === null || missing.length > 0) {
    logQuarantineMergeError(new Error(`隔离记录写入清单后校验失败（缺失 ${missing.length}/${rows.length} 行），保留记录待下次启动重试`))
    return rec
  }
  try {
    copyFileSync(file, `${file}.applied-${Date.now()}`)
    rmSync(file, { force: true })
  } catch {}
  return rec
}

/** 启动时让清单与现实对账（v0.3.45）：
 *   ① 老记录缺 moduleName → 按当前 loader 补上（否则「全家桶一键启用已适配」永远匹配不到）；
 *   ② 记录还是 pending、但这一行**当前已经启用**（用户手动启用过 / 补丁被清过）→ 转 adopted。
 *  不这么做就会出现用户实测的那种矛盾：**已启用的行，重启后仍挂着【待适配】**。
 *  返回 { backfilled, adopted } 供日志/测试核对；无变化则不写盘。 */
function reconcileCompatPending(ports) {
  const pending = readCompatPending()
  if (pending === null || !Array.isArray(pending.pending)) return { backfilled: 0, adopted: 0 }
  const info = rowIdModuleMap(ports)
  let backfilled = 0
  let adopted = 0
  for (const rec of pending.pending) {
    if ((rec.status ?? 'pending') !== 'pending') continue
    const meta = info.get(rec.rowId) ?? null
    if (meta !== null) {
      if ((rec.moduleName === null || rec.moduleName === undefined || rec.moduleName === '') && typeof meta.moduleName === 'string' && meta.moduleName !== '') {
        rec.moduleName = meta.moduleName
        if (meta.version !== null && meta.version !== undefined) rec.version = meta.version
        backfilled += 1
      }
      if (meta.enabled === true) {
        if (markPendingAdopted(pending, rec.rowId, 'row-enabled', meta)) adopted += 1
      }
    }
  }
  if (backfilled > 0 || adopted > 0) {
    pending.updatedAt = new Date().toISOString()
    writeCompatPending(pending)
  }
  return { backfilled, adopted }
}

export { readQuarantineRecord, logQuarantineMergeError, markPendingAdopted, mergeQuarantineRecord, reconcileCompatPending, analyzeBootFailure, planQuarantine }
