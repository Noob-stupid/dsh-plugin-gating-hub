// L1 · domain —— auto-preflight.js（环境指纹变化 → 自动预检的**判定与记录层**；0.5.32 加法 D1）
//
// 为什么要有它（用户 2026-09-29 诉求，原话）：
//   「走**别的**更新通道（官方桌面端更新器 / 手动 pnpm / npx 缓存变化）改了框架后，我们**仍要自动守门**」。
// 现状（0.5.31）：`domain/compat-state.js` 的 `compareFingerprint` 已经能**发现**任何来源的框架变更
//   （`routes/compat.js` 每次状态查询现场算指纹并与基线比对），但发现之后**只上报一行文案**，
//   不会自动跑预检；而「启动失败隔离」（`domain/quarantine.js`）的输入是我们自己的升级脚本留下的
//   记录 —— 别人升级时**没有这份记录**，兜底因此不触发。本模块补上中间那一段：
//
//   指纹变化（changed=true）→ **自动跑一次只读预检** → 落成三样东西：
//     ① 兼容清单（受影响行 + 判据）  ② 隔离计划（建议禁用哪些行、为什么）  ③ 本次变更摘要（版本 from→to / 新增消失的包 / 指纹 reasons）
//
// 四条硬约束（全部可离线断言，见 tests/test-auto-preflight.mjs）：
//   · **只读**：不下载、不安装、不改补丁、不碰 loader —— 本模块连 ctx/ports 都不认识（只吃注入的窄接口）；
//   · **同一指纹只自动跑一次**：以指纹为 key 持久化「已扫过」标记；失败**如实记录原因**且**允许重试**；
//   · **绝不阻塞状态查询**：超时/异常一律降级成「未完成，可手动重跑」，状态查询该返回什么还返回什么；
//   · 纯函数为主：判定（shouldAutoRun）、超时包裹（withTimeout）、增量（summarizeDelta）、
//     记录合并（upsertRecord）都不做 IO，IO 只出现在 store 读写与 runAutoPreflight 的调用缝上。
//
// 分层：L1 domain —— 无 ctx、无 HTTP、不抛（异常在 runAutoPreflight 内被收成 state='failed'）。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from '../infra/paths.js'

/** 记录文件（与我们其余的常驻状态同住 `dshHome()/plugin-console/`，不碰用户 profile）。 */
const autoPreflightFile = () => join(dshHome(), 'plugin-console', 'auto-preflight.json')

/** 保留最近的扫描记录条数（防止指纹频繁抖动把状态文件撑大）。 */
const MAX_RECORDS = 12

/** 自动预检的默认超时（毫秒）。宁可降级成「未完成，可手动重跑」，也不让状态查询等它。 */
const DEFAULT_TIMEOUT_MS = 4000

const STATES = ['pending', 'done', 'failed', 'timeout']

/**
 * 指纹的**稳定 key**：只取参与变更判定的三个字段（`at` 每次都变，绝不能进 key）。
 * 归一化：字符串去空白 + 小写（win32 路径大小写不敏感；两个指纹「实际相同」时不许各跑一次）。
 */
function fingerprintKey(fp) {
  const norm = (value, lower = false) => {
    if (value === null || value === undefined) return ''
    const text = String(value).trim()
    return lower ? text.toLowerCase() : text
  }
  // 空包数按 '?' 归一：null 与 undefined 是同一件事（数不出来），别当成"变了"
  const entities = fp?.pnpmEntities === null || fp?.pnpmEntities === undefined ? '?' : String(fp.pnpmEntities)
  // 路径：反斜杠归一成正斜杠（Windows 的 `C:\x` 与 `C:/x` 是同一棵树）+ 小写（win32 不区分大小写）
  const root = norm(fp?.pnpmRoot, true).replace(/\\/gu, '/')
  return [norm(fp?.frameworkVersion), root, entities].join('|')
}

/** 两份指纹是否「实际相同」（同一 key）。 */
function sameFingerprint(a, b) {
  return fingerprintKey(a) === fingerprintKey(b)
}

function readStore(file = autoPreflightFile()) {
  try {
    const rec = JSON.parse(readFileSync(file, 'utf8'))
    if (rec === null || typeof rec !== 'object') return { schema: 1, records: [] }
    return { schema: 1, records: Array.isArray(rec.records) ? rec.records : [] }
  } catch {
    return { schema: 1, records: [] }
  }
}

/** 只增不删的合并：同 key 记录用新值覆盖，别的 key 原样保留；按 at 倒序裁剪到 MAX_RECORDS。 */
function upsertRecord(records, record, limit = MAX_RECORDS) {
  const list = Array.isArray(records) ? records.filter((r) => r !== null && typeof r === 'object') : []
  const key = typeof record?.key === 'string' ? record.key : fingerprintKey(record?.fingerprint)
  const next = list.filter((r) => (typeof r.key === 'string' ? r.key : fingerprintKey(r.fingerprint)) !== key)
  next.push({ ...record, key })
  next.sort((a, b) => (Number(b?.at ?? 0) - Number(a?.at ?? 0)))
  return next.slice(0, limit)
}

function writeStore(store, file = autoPreflightFile()) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ schema: 1, updatedAt: new Date().toISOString(), records: store.records }, null, 2)}\n`, 'utf8')
}

/** 从记录集里取某个指纹的那条记录（没有则 null）。 */
function findRecord(records, fp) {
  const key = fingerprintKey(fp)
  return (Array.isArray(records) ? records : []).find((r) => (typeof r?.key === 'string' ? r.key : fingerprintKey(r?.fingerprint)) === key) ?? null
}

/**
 * 自动预检的**执行判定**（纯函数）。三种「不跑」：
 *   · state='done'    → 同一指纹已经扫过（这就是"同指纹只自动跑一次"的闸门）；
 *   · state='pending' → 上一次还挂在超时边缘（没有结论），交给手动重跑，不叠加并发；
 *   · state='failed' / 'timeout' → **允许重试一次**（失败要能重试），但同一指纹最多自动重试 limit 次。
 * @returns {{ run: boolean, reason: string, attempt: number }}
 */
function shouldAutoRun(record, { retryLimit = 1 } = {}) {
  if (record === null || record === undefined) return { run: true, reason: 'first-seen', attempt: 1 }
  const state = typeof record.state === 'string' ? record.state : 'failed'
  const attempts = Number.isFinite(Number(record.attempts)) ? Number(record.attempts) : 0
  if (state === 'done') return { run: false, reason: 'already-scanned', attempt: attempts }
  if (state === 'pending') return { run: false, reason: 'in-flight', attempt: attempts }
  if (attempts >= retryLimit + 1) return { run: false, reason: 'retry-exhausted', attempt: attempts }
  return { run: true, reason: state === 'timeout' ? 'retry-after-timeout' : 'retry-after-failure', attempt: attempts + 1 }
}

/**
 * 超时包裹（纯函数，**不抛**）：到点就返回 `{ timedOut: true }`，绝不把异常甩给调用方。
 * 注意它**不会取消**底层 promise（JS 没有取消语义）—— 底层跑完后的写盘由 runAutoPreflight 收口，
 * 但那不影响状态查询：调用方拿到 timedOut 就立刻回响应。
 */
function withTimeout(promise, ms, onTimeout = null) {
  const limit = Number.isFinite(Number(ms)) && Number(ms) > 0 ? Number(ms) : DEFAULT_TIMEOUT_MS
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (typeof onTimeout === 'function') { try { onTimeout() } catch {} }
      resolve({ timedOut: true, value: null })
    }, limit)
    if (typeof timer?.unref === 'function') timer.unref()
  })
  const wrapped = Promise.resolve(promise).then(
    (value) => ({ timedOut: false, value }),
    (error) => ({ timedOut: false, value: null, error: error instanceof Error ? error.message : String(error) }),
  )
  return Promise.race([wrapped, timeout]).finally(() => { if (timer !== null) clearTimeout(timer) })
}

/**
 * 兼容清单：把补丁体检与源码扫描的结论收敛成**受影响行**（面板按行显示，一行一句）。
 * 只做汇总与排序，不新增判据（判据留在 patch-composition-audit / format-scan 两个模块里）。
 */
function affectedRows({ patchReport = null, scan = null, rows = [], limit = 40 } = {}) {
  const out = []
  const nameById = new Map((Array.isArray(rows) ? rows : []).map((r) => [r?.id, r?.name ?? null]))
  for (const item of (patchReport?.blockers ?? [])) {
    out.push({
      rowId: item.row ?? null, moduleName: item.name ?? nameById.get(item.row) ?? null, severity: 'blocker',
      code: item.code ?? 'patch-row', line: item.line ?? null, detail: item.detail ?? null,
      hint: item.hint ?? null, suggestions: item.suggestions ?? [],
    })
  }
  for (const item of (patchReport?.warnings ?? [])) {
    out.push({
      rowId: item.row ?? null, moduleName: item.name ?? nameById.get(item.row) ?? null, severity: 'warn',
      code: item.code ?? 'patch-row', line: item.line ?? null, detail: item.detail ?? null,
      hint: item.hint ?? null, suggestions: item.suggestions ?? [],
    })
  }
  for (const f of (scan?.findings ?? [])) {
    out.push({
      rowId: null, moduleName: f.moduleName ?? null, severity: f.severity ?? 'warn',
      code: f.rule ?? 'source-scan', line: f.line ?? null,
      detail: `${f.file ?? '?'}${f.line === null || f.line === undefined ? '' : `:${f.line}`}${f.before === undefined ? '' : ` → ${f.after ?? ''}`}`,
      hint: f.reason ?? f.note ?? null, suggestions: [],
    })
  }
  const rank = { blocker: 0, warn: 1 }
  out.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || String(a.rowId ?? '').localeCompare(String(b.rowId ?? '')))
  return out.slice(0, limit)
}

/**
 * 隔离计划：**建议**禁用哪些行 + 为什么（绝不自动写盘；真正落盘只走用户显式触发的
 * `POST /plugin-console/safe-boot {action:'disable-suspects'}` 或离线脚本）。
 * 只收「点名 + 可开关 + 非核心」的行：核心行禁掉只会让服务更起不来（正确动作是回滚框架）。
 */
function planSuspectRows(affected, { coreRowIds = new Set(), toggleableById = new Map(), limit = 20 } = {}) {
  const suspects = []
  const skipped = []
  for (const item of (Array.isArray(affected) ? affected : [])) {
    if (item.severity !== 'blocker' || typeof item.rowId !== 'string' || item.rowId === '') continue
    if (coreRowIds.has(item.rowId)) { skipped.push({ rowId: item.rowId, reason: 'core-row' }); continue }
    if (item.rowId === 'plugin-console') { skipped.push({ rowId: item.rowId, reason: 'self' }); continue }
    if (toggleableById.has(item.rowId) && toggleableById.get(item.rowId) === false) { skipped.push({ rowId: item.rowId, reason: 'not-toggleable' }); continue }
    if (suspects.some((s) => s.rowId === item.rowId)) continue
    if (suspects.length >= limit) break
    suspects.push({ rowId: item.rowId, moduleName: item.moduleName ?? null, reason: item.code, detail: item.detail ?? null, line: item.line ?? null })
  }
  return { suspects, skipped }
}

/** 本次变更摘要：框架版本 from→to + 新增/消失的包 + 指纹 reasons（面板一句话，详情放长文）。 */
function summarizeDelta({ current = null, previous = null, currentPackages = [], previousPackages = [] } = {}) {
  const from = previous?.frameworkVersion ?? null
  const to = current?.frameworkVersion ?? null
  const before = new Set((Array.isArray(previousPackages) ? previousPackages : []).filter((n) => typeof n === 'string' && n !== ''))
  const after = new Set((Array.isArray(currentPackages) ? currentPackages : []).filter((n) => typeof n === 'string' && n !== ''))
  const added = [...after].filter((n) => !before.has(n)).sort()
  const removed = [...before].filter((n) => !after.has(n)).sort()
  return {
    frameworkVersionFrom: from,
    frameworkVersionTo: to,
    versionChanged: from !== to,
    packagesAdded: added.slice(0, 50),
    packagesRemoved: removed.slice(0, 50),
    packagesAddedCount: added.length,
    packagesRemovedCount: removed.length,
    rootChanged: (previous?.pnpmRoot ?? null) !== (current?.pnpmRoot ?? null),
    entitiesChanged: (previous?.pnpmEntities ?? null) !== (current?.pnpmEntities ?? null),
    rationaleAvailable: before.size > 0 || after.size > 0,
  }
}

/** 面板/离线脚本共用的一句话短句（中英双语；面板只放这一句，长文进 detail）。 */
function autoPreflightNote(state, { blockers = 0, suspects = 0 } = {}) {
  const zh = {
    pending: '环境变了，正在自动预检…',
    done: blockers > 0 ? `环境变了：预检发现 ${blockers} 行受影响${suspects > 0 ? `，建议禁用 ${suspects} 行` : ''}` : '环境变了：自动预检未发现受影响行',
    failed: '环境变了，但自动预检失败（可手动重跑）',
    timeout: '环境变了，自动预检超时（可手动重跑）',
    idle: '环境未变化，无需自动预检',
  }
  const en = {
    pending: 'Environment changed — auto-preflight running…',
    done: blockers > 0 ? `Environment changed: ${blockers} affected row(s)${suspects > 0 ? `, ${suspects} suggested for disable` : ''}` : 'Environment changed: auto-preflight found no affected rows',
    failed: 'Environment changed, but auto-preflight failed (you can re-run it)',
    timeout: 'Environment changed; auto-preflight timed out (you can re-run it)',
    idle: 'No environment change — auto-preflight not needed',
  }
  const key = Object.prototype.hasOwnProperty.call(zh, state) ? state : 'idle'
  return { state: key, zh: zh[key], en: en[key] }
}

/**
 * 自动预检收口（**这条路径不阻塞任何调用方**：调用方不 await 它）。
 * 流程：判定是否该跑 → 写 state='pending' 占位（同指纹只跑一次的闸门立刻生效）→ 跑注入的扫描
 *       → 落 `{state:'done', preflight, affected, suspects, delta}`；失败/超时如实落 `failed`/`timeout` + reason。
 * 写盘失败也不抛（返回 `{ok:false, error}`），因为它的调用方是只读状态查询。
 *
 * ★ 并发纪律（2026-09-29 实测踩到）：**终态写入必须只落自己的那一条**。
 *   早先的写法是"读整份 store → push → 整份写回"，两个指纹的扫描同时收尾时会互相覆盖
 *   （谁后写谁赢，另一条的终态**永远停在 pending** —— 面板就永远显示"正在自动预检…"）。
 *   现在终态写盘只 upsert **当前 key 的那一条**，其余记录原样保留。
 */
async function runAutoPreflight({ current, previous, scan, timeoutMs = DEFAULT_TIMEOUT_MS, now = () => Date.now(), file = autoPreflightFile() } = {}) {
  const key = fingerprintKey(current)
  const startedAt = now()
  try {
    const store = readStore(file)
    const existing = findRecord(store.records, current)
    const verdict = shouldAutoRun(existing)
    if (!verdict.run) return { ok: true, ran: false, reason: verdict.reason, key, state: existing?.state ?? 'idle' }
    const pendingRecord = {
      ...(existing ?? {}), key, at: startedAt, startedAt, finishedAt: null, state: 'pending',
      attempts: verdict.attempt, reason: verdict.reason,
      fingerprint: current ?? null, previousFingerprint: previous ?? null,
    }
    writeStore({ records: upsertRecord(store.records, pendingRecord) }, file)
    let result = null
    const raced = await withTimeout(
      Promise.resolve().then(() => scan({ current, previous, key })),
      timeoutMs,
    )
    if (raced.timedOut) {
      result = { ok: false, state: 'timeout', reason: `自动预检超过 ${timeoutMs}ms 未完成（已降级为「未完成，可手动重跑」，未阻塞状态查询）` }
    } else if (raced.error !== undefined && raced.error !== null) {
      result = { ok: false, state: 'failed', reason: `自动预检抛错：${raced.error}` }
    } else {
      const value = raced.value ?? {}
      result = value.ok === false
        ? { ok: false, state: 'failed', reason: value.reason ?? '自动预检未产出结论' }
        : { ok: true, state: 'done', preflight: value }
    }
    const finishedAt = now()
    const record = {
      ...pendingRecord,
      finishedAt,
      state: result.state,
      error: result.ok ? null : result.reason,
      summary: result.ok ? (result.preflight?.summary ?? null) : null,
      affected: result.ok ? (result.preflight?.affected ?? []) : [],
      suspects: result.ok ? (result.preflight?.suspects ?? []) : [],
      evidence: result.ok ? (result.preflight?.evidence ?? null) : null,
      delta: result.ok ? (result.preflight?.delta ?? null) : null,
      skipped: result.ok ? (result.preflight?.skipped ?? []) : [],
    }
    // 终态写盘：只 upsert 自己这条（读最新一份 + 只替换同 key），不覆盖别的指纹已经写好的结论
    const after = readStore(file)
    writeStore({ records: upsertRecord(after.records, record) }, file)
    return { ok: result.ok, ran: true, key, state: result.state, record, error: result.ok ? null : result.reason, reason: verdict.reason }
  } catch (error) {
    return { ok: false, ran: false, key, state: 'failed', error: `自动预检记录写入失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 状态查询下发的视图（**加法字段**，不改 `/compat-status` 既有字段）：
 * 面板只需要一句短句 + 是否有结论 + 有几行受影响；长文（reasons/affected/delta）放在详情里。
 */
function autoPreflightView({ changed, current, records = null, file = autoPreflightFile() } = {}) {
  const list = Array.isArray(records) ? records : readStore(file).records
  // 指纹没变 → 不下发任何「上次的扫描结论」：那是上一个环境的结论，混在一起会让面板说假话。
  const record = changed === true ? findRecord(list, current) : null
  const state = record === null ? 'idle' : (STATES.includes(record.state) ? record.state : 'idle')
  const preflight = record === null ? null : {
    state: record.state ?? null,
    startedAt: record.startedAt ?? null,
    finishedAt: record.finishedAt ?? null,
    attempts: record.attempts ?? 0,
    error: record.error ?? null,
    summary: record.summary ?? null,
    affected: record.affected ?? [],
    suspects: record.suspects ?? [],
    skipped: record.skipped ?? [],
    evidence: record.evidence ?? null,
    delta: record.delta ?? null,
  }
  const blockers = (preflight?.affected ?? []).filter((a) => a.severity === 'blocker').length
  return {
    changed: changed === true,
    state,
    key: fingerprintKey(current),
    ranAt: record?.startedAt ?? null,
    scannedAt: record?.finishedAt ?? null,
    blockers,
    affectedCount: (preflight?.affected ?? []).length,
    suspects: (preflight?.suspects ?? []).map((s) => s.rowId),
    note: autoPreflightNote(state, { blockers, suspects: (preflight?.suspects ?? []).length }),
    error: record?.error ?? null,
    retryable: state === 'failed' || state === 'timeout',
    preflight,
  }
}

export {
  DEFAULT_TIMEOUT_MS,
  MAX_RECORDS,
  STATES,
  affectedRows,
  autoPreflightFile,
  autoPreflightNote,
  autoPreflightView,
  findRecord,
  fingerprintKey,
  planSuspectRows,
  readStore,
  runAutoPreflight,
  sameFingerprint,
  shouldAutoRun,
  summarizeDelta,
  upsertRecord,
  withTimeout,
  writeStore,
}
