// L1 · domain —— safe-boot.js（**安全启动材料**：last-known-good 快照 + 恢复判定；0.5.32 加法 D2/D3）
//
// 为什么要有它（用户 2026-09-29 诉求，原话）：
//   「走别的更新通道改了框架后…**能挽救"改完打不开"**的局面」。
// 现状（0.5.31）：兜底（启动失败隔离）的输入是我们**自己的升级脚本**留下的记录 —— 官方桌面端更新器 /
//   手动 pnpm / npx 缓存变化导致的"打不开"，既没有那份记录，也没有可回退的"上一次好状态"。
// 本模块补上这块材料：
//   · D2：每次确认服务正常（状态查询成功 + 指纹未变）就把**逐字节补丁 + 框架版本 + 环境指纹 +
//         此刻启用/禁用的行清单 + 时间戳**写一份快照，落在 `dshHome()/plugin-console/safe-boot/snapshots/`
//         （**不是** profile 目录 —— 绝不污染用户 profile）；写入**原子**（临时文件 + rename）并记 sha256。
//   · D3：恢复入口的**判定与落盘原语**（路由与离线脚本共用同一套）：`restoreLastGood`（改前再备份 +
//         读回核实 + 逐字节比对）/ `disableSuspects`（**只**给点名行追加 `disabled: true`，不删任何行）。
//
// 保留策略：最近 AUTO_KEEP 份 + **永不删**「用户标记为良好」的那份；标记的那份另记 lastGoodId，
//   即便被手动清理，恢复也会如实报"找不到"而不是默默换一份。
//
// 分层：L1 domain —— 无 ctx、无 HTTP；IO 全部走注入的默认实现（测试可整段替换为内存实现）。

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { CORE_PATCH_ROW_IDS } from './patch.js'
import { parsePatchRows } from './patch-composition-audit.js'
import { validatePatchYaml } from './patch-yaml-check.js'
import { dshHome } from '../infra/paths.js'

/** 快照根（我们自己的目录，位于 `dshHome()/plugin-console/` 下，与用户 profile 无关）。
 *  ★ 默认值必须在**调用时**求值（不能写成模块级常量）：离线脚本 `scripts/safe-boot.mjs --home <dir>`
 *    是在导入之后才设置 DSH_HOME 的，模块级常量会把默认 home 提前钉死在导入那一刻（真机实测踩到）。 */
const safeBootDir = (home = undefined) => join(home ?? dshHome(), 'plugin-console', 'safe-boot')
const snapshotsDir = (home = undefined) => join(safeBootDir(home), 'snapshots')
const safeBootStateFile = (home = undefined) => join(safeBootDir(home), 'state.json')

/** 默认保留：最近 3 份自动快照（用户手动标记为良好的那份永不删）。 */
const AUTO_KEEP = 3

/** 快照类别：auto = 每次确认正常时自动落；good = 用户显式标记为"良好"（永不删）。 */
const SNAPSHOT_KINDS = ['auto', 'good']

const sha256 = (text) => createHash('sha256').update(typeof text === 'string' ? Buffer.from(text, 'utf8') : text).digest('hex')

/** 文件名里安全的时间戳（冒号/点在 Windows 上是非法字符）。 */
function stampOf(ms) {
  return new Date(ms).toISOString().replace(/[:.]/gu, '-')
}

/**
 * 指纹等价判定（只看参与变更判定的三要素，忽略 `at`；win32 路径大小写不敏感 → 小写归一）。
 * 与 `domain/auto-preflight.js#fingerprintKey` 同源判据，但这里保持独立实现，
 * 避免「快照等价」被自动预检的节流语义牵着走（两者的失败模式不同）。
 */
function sameEnv(a, b) {
  const norm = (v, lower = false) => {
    if (v === null || v === undefined) return ''
    const t = String(v).trim()
    return lower ? t.toLowerCase() : t
  }
  const ent = (v) => (v === null || v === undefined ? '?' : String(v))
  return norm(a?.frameworkVersion) === norm(b?.frameworkVersion)
    && norm(a?.pnpmRoot, true) === norm(b?.pnpmRoot, true)
    && ent(a?.pnpmEntities) === ent(b?.pnpmEntities)
}

/**
 * 保留策略（纯函数）：最近 `keep` 份 **auto** 快照 + 全部 `good` 快照；其余进 `removed`。
 * @param {Array<{id:string,at:number,kind?:string}>} snapshots
 * @returns {{ keep: string[], removed: string[] }}
 */
function applyRetention(snapshots, keep = AUTO_KEEP) {
  const list = (Array.isArray(snapshots) ? snapshots : []).filter((s) => s !== null && typeof s === 'object' && typeof s.id === 'string')
  const newestFirst = [...list].sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0))
  const auto = newestFirst.filter((s) => s.kind !== 'good')
  const good = newestFirst.filter((s) => s.kind === 'good')
  const keptAuto = auto.slice(0, Math.max(0, Number(keep) || 0))
  const keepIds = new Set([...keptAuto, ...good].map((s) => s.id))
  return {
    keep: newestFirst.filter((s) => keepIds.has(s.id)).map((s) => s.id),
    removed: newestFirst.filter((s) => !keepIds.has(s.id)).map((s) => s.id),
  }
}

/** 从快照列表里挑「用于恢复」的那一份：用户标记的 good 优先，其次最新。 */
function pickSnapshot(snapshots, { id = null } = {}) {
  const list = (Array.isArray(snapshots) ? snapshots : []).filter((s) => s !== null && typeof s === 'object' && typeof s.id === 'string')
  if (typeof id === 'string' && id !== '') return list.find((s) => s.id === id) ?? null
  const good = list.filter((s) => s.kind === 'good').sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0))
  if (good.length > 0) return good[0]
  const sorted = [...list].sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0))
  return sorted[0] ?? null
}

/** 快照的对外摘要（**不含** patchText —— 列表接口不该把几十 KB 补丁塞给面板）。 */
function snapshotView(rec) {
  if (rec === null || rec === undefined) return null
  return {
    id: rec.id ?? null,
    kind: rec.kind ?? 'auto',
    at: rec.at ?? null,
    createdAt: rec.createdAt ?? null,
    frameworkVersion: rec.frameworkVersion ?? null,
    fingerprint: rec.fingerprint ?? null,
    patchSha256: rec.patchSha256 ?? null,
    patchBytes: typeof rec.patchText === 'string' ? Buffer.byteLength(rec.patchText, 'utf8') : (rec.patchBytes ?? null),
    patchPath: rec.patchPath ?? null,
    rowCount: rec.rows?.all?.length ?? 0,
    enabledCount: rec.rows?.enabled?.length ?? 0,
    disabledCount: rec.rows?.disabled?.length ?? 0,
    enabled: rec.rows?.enabled ?? [],
    disabled: rec.rows?.disabled ?? [],
    reasons: rec.reasons ?? [],
    note: rec.note ?? null,
    restoreCommand: rec.restoreCommand ?? null,
  }
}

/** 读 patches 的启用/禁用行清单（补丁层视角：谁被 `disabled: true` 明确关掉）。 */
function patchRowState(text) {
  const lines = String(text ?? '').replace(/\r\n/gu, '\n').split('\n')
  const disabled = []
  const forced = []
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^- id:\s*(\S+)\s*$/u)
    if (m === null) continue
    const next = lines[i + 1] ?? ''
    if (/^\s+disabled:\s*true\s*$/u.test(next)) disabled.push(m[1])
    else if (/^\s+disabled:\s*false\s*$/u.test(next)) forced.push(m[1])
  }
  const ins = []
  for (const row of parsePatchRows(text)) if (typeof row.id === 'string' && row.id !== '') ins.push(row.id)
  return { disabled, forced, all: ins }
}

/** 某行此刻是否已被 `disabled: true` 明确关掉（幂等判据）。 */
function isRowDisabled(text, rowId) {
  return new RegExp(`^- id: ${escapeRe(rowId)}\\r?\\n\\s+disabled: true\\s*$`, 'mu').test(String(text ?? '').replace(/\r\n/gu, '\n'))
}

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * `disable-suspects` 的纯判定：**只**给点名行追加 `disabled: true`，一行都不删。
 * 不写的六种情形（如实回报，绝不静默）：核心行 / 控制台自身 / 补丁里没有这一行 / 本来就是禁用的 /
 * **框架自带行（`@deepseek-ai/*`，D5 安全栏）** / **受保护模块行（D5 安全栏）**。
 *
 * ⚠ 后两条是 D5 的关键（用户 2026-09-29 明确要求「必须带上 0.5.30 已立的安全栏」）：
 *   自动禁用的**触发源**从"我们升级"扩到了"指纹变化 / 启动失败记录"，所以写盘路径必须自带这两道闸门
 *   —— 不能指望调用方每次都记得传对名单。手动点名（D3 路由 / 离线脚本）也一并受保护：
 *   点错了最多是"没生效 + 原因可读"，而不是把框架自己的行关掉。
 */
function planDisableRows(text, rowIds, { coreRowIds = CORE_PATCH_ROW_IDS, moduleNameOf = null, isProtected = null, isFrameworkOwned = null } = {}) {
  const source = String(text ?? '')
  const rows = parsePatchRows(source)
  const known = new Map(rows.map((r) => [r.id, r]))
  const add = []
  const skipped = []
  for (const raw of (Array.isArray(rowIds) ? rowIds : [])) {
    const rowId = typeof raw === 'string' ? raw.trim() : ''
    if (rowId === '') continue
    if (coreRowIds.has(rowId)) { skipped.push({ rowId, reason: 'core-row' }); continue }
    if (rowId === 'plugin-console') { skipped.push({ rowId, reason: 'self' }); continue }
    if (!known.has(rowId)) { skipped.push({ rowId, reason: 'not-in-patch' }); continue }
    const moduleName = (typeof moduleNameOf === 'function' ? moduleNameOf(rowId) : null) ?? known.get(rowId)?.name ?? null
    if (typeof isFrameworkOwned === 'function' && moduleName !== null && isFrameworkOwned(moduleName) === true) {
      skipped.push({ rowId, reason: 'framework-owned' }); continue
    }
    if (typeof isProtected === 'function' && moduleName !== null && isProtected(moduleName) === true) {
      skipped.push({ rowId, reason: 'protected-module' }); continue
    }
    if (add.some((a) => a.rowId === rowId)) continue
    if (isRowDisabled(source, rowId)) { skipped.push({ rowId, reason: 'already-disabled' }); continue }
    add.push({ rowId, line: known.get(rowId)?.line ?? null, moduleName })
  }
  if (add.length === 0) return { add, skipped, next: source, changed: false }
  const base = source.replace(/\s+$/u, '')
  const blocks = add.map((a) => `- id: ${a.rowId}\n  disabled: true\n`).join('')
  return { add, skipped, next: `${base}\n${blocks}`, changed: true }
}

/**
 * 恢复的**计划**（纯函数）：给定快照文本与当前文本，算出「要不要写、写什么、影响面」。
 * 恢复不做任何"智能合并"：目标就是快照的**逐字节**内容（严格 YAML 校验只当闸门，不做改写）。
 */
function planRestore({ snapshotText = null, currentText = '', snapshot = null } = {}) {
  if (typeof snapshotText !== 'string') return { ok: false, code: 'snapshot-missing', error: '找不到可用快照（没有快照，或指定 id 不存在）' }
  const expected = snapshot?.patchSha256 ?? null
  const actual = sha256(snapshotText)
  if (expected !== null && expected !== actual) {
    return { ok: false, code: 'snapshot-corrupt', error: `快照内容与它记录的 sha256 不一致（记录 ${String(expected).slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）—— 拒绝用被改坏的快照恢复`, sha256: actual }
  }
  const check = validatePatchYaml(snapshotText)
  if (check.ok !== true) {
    return { ok: false, code: 'snapshot-invalid-yaml', error: `快照不是合法补丁结构（拒绝写入）：${check.problems.slice(0, 3).join('；')}`, problems: check.problems }
  }
  if (snapshotText === currentText) {
    return { ok: true, code: 'already-identical', changed: false, text: snapshotText, sha256: actual, problems: [] }
  }
  return { ok: true, code: 'restore', changed: true, text: snapshotText, sha256: actual, problems: [] }
}

/**
 * 写一份快照（**原子**：同目录临时文件 + rename；fsync 后 rename）。
 * 相同环境**且**补丁逐字节未变时**零写盘**（节流：面板每次刷新都会调状态查询）。
 * @returns {{ ok: boolean, written: boolean, reason?: string, snapshot?: object, error?: string }}
 */
function writeSnapshot({
  patchPath, patchText = null, fingerprint = null, frameworkVersion = null, reasons = [],
  kind = 'auto', note = null, force = false, home = undefined, keep = AUTO_KEEP, now = () => Date.now(),
  pluginVersion = null, restoreCommand = 'node scripts/safe-boot.mjs --restore-last-good',
  readFile = (p) => readFileSync(p, 'utf8'), writeFile = (p, d) => writeFileSync(p, d, 'utf8'),
  rename = (a, b) => renameSync(a, b), mkdir = (d) => mkdirSync(d, { recursive: true }),
  readDir = (d) => readdirSync(d), remove = (p) => rmSync(p, { force: true }), exists = existsSync,
} = {}) {
  try {
    if (typeof patchPath !== 'string' || patchPath === '') return { ok: false, written: false, error: '没有补丁路径，无法保存安全启动材料' }
    const text = typeof patchText === 'string' ? patchText : (exists(patchPath) ? readFile(patchPath) : '')
    const bytes = Buffer.byteLength(text, 'utf8')
    const hash = sha256(text)
    const dir = snapshotsDir(home)
    mkdir(dir)
    const records = readSnapshotDir({ home, readDir, readFile })
    if (force !== true) {
      const latest = pickSnapshot(records)
      if (latest !== null && sameEnv(latest.fingerprint, fingerprint) && latest.patchSha256 === hash && latest.patchBytes === bytes) {
        return { ok: true, written: false, reason: 'unchanged', snapshot: snapshotView(latest) }
      }
    }
    const at = now()
    // 同一毫秒内可能连写多份（例如"恢复后再立刻快照"）：文件名必须**唯一**，
    // 否则第二份会静默覆盖第一份 —— 保留策略看起来生效、实际少了一份（真机会话里踩过同类坑）。
    const uniqueId = (base) => {
      const taken = new Set(records.map((r) => r.id))
      if (!taken.has(base) && !exists(join(dir, `${base}.json`))) return base
      for (let n = 2; n < 1000; n += 1) {
        const candidate = `${base}-${n}`
        if (!taken.has(candidate) && !exists(join(dir, `${candidate}.json`))) return candidate
      }
      return base
    }
    const id = uniqueId(`snap-${stampOf(at)}`)
    const check = validatePatchYaml(text)
    const record = {
      schema: 1,
      id,
      kind: SNAPSHOT_KINDS.includes(kind) ? kind : 'auto',
      at,
      createdAt: new Date(at).toISOString(),
      frameworkVersion: frameworkVersion ?? fingerprint?.frameworkVersion ?? null,
      fingerprint: fingerprint ?? null,
      reasons: Array.isArray(reasons) ? reasons : [],
      patchPath,
      patchSha256: hash,
      patchBytes: bytes,
      rows: (() => { const st = patchRowState(text); return { all: st.all, disabled: st.disabled, forced: st.forced, enabled: st.all.filter((id2) => !st.disabled.includes(id2)) } })(),
      yamlCheck: { ok: check.ok, problems: check.problems.slice(0, 5) },
      note: typeof note === 'string' ? note : null,
      restoreCommand,
      pluginVersion,
      patchText: text,
    }
    const file = join(dir, `${id}.json`)
    const tmp = join(dir, `.${id}.tmp`)
    writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`)
    rename(tmp, file)
    // 读回核实：文件真的在、且能解析出同一份内容（否则如实报失败，别假装存好了）
    let verified = null
    try { verified = JSON.parse(readFile(file)) } catch (error) { verified = null }
    if (verified === null || verified.patchSha256 !== hash) {
      return { ok: false, written: false, error: `快照写盘后读回核实失败（${file}）`, snapshot: null }
    }
    // 保留策略
    const after = readSnapshotDir({ home, readDir, readFile })
    const { removed } = applyRetention(after, keep)
    for (const victim of removed) { try { remove(join(dir, `${victim}.json`)) } catch {} }
    return { ok: true, written: true, snapshot: snapshotView(verified) }
  } catch (error) {
    return { ok: false, written: false, error: `快照写入失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 读快照目录（按文件名解析；坏文件跳过，绝不让一份坏快照挡住列表）。
 *  `withPatch: false` = 只列表用：**丢掉补丁正文**再返回（几十 KB/份，状态查询每次都会调，
 *  保留正文纯属浪费内存与 GC 压力）。 */
function readSnapshotDir({ home = undefined, readDir = (d) => readdirSync(d), readFile = (p) => readFileSync(p, 'utf8'), withPatch = true } = {}) {
  const dir = snapshotsDir(home)
  let names = []
  try { names = readDir(dir) } catch { return [] }
  const out = []
  for (const name of names) {
    if (typeof name !== 'string' || !/^snap-.*\.json$/u.test(name)) continue
    try {
      const rec = JSON.parse(readFile(join(dir, name)))
      if (rec !== null && typeof rec === 'object' && typeof rec.id === 'string') out.push(withPatch === true ? rec : { ...rec, patchText: undefined })
    } catch {}
  }
  return out.sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0))
}

/** 列出快照摘要（新→旧；只读元数据，不返回补丁正文）。 */
function listSnapshots({ home = undefined, readDir, readFile } = {}) {
  return readSnapshotDir({ home, readDir, readFile, withPatch: false }).map(snapshotView)
}

/**
 * 确保「当前这份补丁」有快照可回退（D5 的安全栏：**每一次自动禁用之前**都必须有可一键回滚的材料）。
 * 判据很直白：最新快照的 sha256 与当前补丁一致 → 已覆盖，零写盘；不一致 → **强制**写一份
 * （自动禁用改的是**当前**状态；拿一份更早的快照"顶着"等于回滚不到禁用前的样子）。
 * @returns {{ ok: boolean, covered: boolean, written: boolean, id: string|null, error?: string }}
 */
function ensureSnapshotForCurrentState({
  patchPath, patchText = null, fingerprint = null, frameworkVersion = null, reasons = [],
  note = '自动禁用前的安全快照', home = undefined, readFile, readDir, exists = existsSync, ...rest
} = {}) {
  try {
    const read = readFile ?? ((p) => readFileSync(p, 'utf8'))
    const text = typeof patchText === 'string' ? patchText : (exists(patchPath) ? read(patchPath) : '')
    const hash = sha256(text)
    const latest = pickSnapshot(readSnapshotDir({ home, readDir, readFile }))
    if (latest !== null && latest.patchSha256 === hash) return { ok: true, covered: true, written: false, id: latest.id ?? null }
    const result = writeSnapshot({
      patchPath, patchText: text, fingerprint, frameworkVersion, reasons, kind: 'auto',
      note, force: true, home, readFile, readDir, ...rest,
    })
    if (result.ok !== true) return { ok: false, covered: false, written: false, id: null, error: result.error ?? '快照写入失败' }
    return { ok: true, covered: true, written: result.written === true, id: result.snapshot?.id ?? null }
  } catch (error) {
    return { ok: false, covered: false, written: false, id: null, error: `快照失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 读 safe-boot 状态（lastGoodId / lastAutoId / 最近一次写入时间）。 */
function readSafeBootState({ home = undefined, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  try {
    const rec = JSON.parse(readFile(safeBootStateFile(home)))
    return {
      lastGoodId: typeof rec?.lastGoodId === 'string' ? rec.lastGoodId : null,
      lastAutoId: typeof rec?.lastAutoId === 'string' ? rec.lastAutoId : null,
      lastAutoAt: typeof rec?.lastAutoAt === 'number' ? rec.lastAutoAt : null,
      lastGoodAt: typeof rec?.lastGoodAt === 'number' ? rec.lastGoodAt : null,
      lastAutoPatchSha256: typeof rec?.lastAutoPatchSha256 === 'string' ? rec.lastAutoPatchSha256 : null,
    }
  } catch {
    return { lastGoodId: null, lastAutoId: null, lastAutoAt: null, lastGoodAt: null, lastAutoPatchSha256: null }
  }
}

/**
 * 记录「安全启动材料」的状态（lastGoodId / lastAutoId）—— 只记 id 与哈希，不重复存补丁。
 * 写盘失败不抛（调用方是只读状态查询）。
 */
function writeSafeBootState(patch, { home = undefined, writeFile = (p, d) => writeFileSync(p, d, 'utf8'), mkdir = (d) => mkdirSync(d, { recursive: true }), rename = (a, b) => renameSync(a, b) } = {}) {
  try {
    const dir = safeBootDir(home)
    mkdir(dir)
    const file = safeBootStateFile(home)
    const tmp = `${file}.tmp`
    writeFile(tmp, `${JSON.stringify({ schema: 1, ...patch }, null, 2)}\n`)
    rename(tmp, file)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: `状态写入失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * D3-① 恢复到 last-known-good（**改前再备份一份当前状态** + 读回核实 + 逐字节比对）。
 * 用户可指定 `id`；缺省 = 用户标记的 good 快照优先，否则最新一份（避免恢复到一个更早的"好状态"）。
 */
function restoreLastGood({
  patchPath, id = null, home = undefined, now = () => Date.now(),
  readFile = (p) => readFileSync(p, 'utf8'), writeFile = (p, d) => writeFileSync(p, d, 'utf8'),
  copyFile = (a, b) => copyFileSync(a, b), exists = existsSync, readDir, 
} = {}) {
  try {
    if (typeof patchPath !== 'string' || patchPath === '') return { ok: false, code: 'no-patch-path', error: '没有补丁路径，无法恢复' }
    const records = readSnapshotDir({ home, readDir, readFile })
    const target = pickSnapshot(records, { id })
    if (target === null) {
      return { ok: false, code: 'snapshot-missing', error: id === null ? '还没有任何安全启动快照（服务从未在正常状态下记录过）' : `找不到快照 ${id}` }
    }
    const currentText = exists(patchPath) ? readFile(patchPath) : ''
    const plan = planRestore({ snapshotText: target.patchText, currentText, snapshot: target })
    if (plan.ok !== true) return { ok: false, ...plan }
    const backupPath = exists(patchPath) ? `${patchPath}.bak-safe-boot-${Date.now()}` : null
    if (backupPath !== null) {
      try { copyFile(patchPath, backupPath) } catch (error) {
        return { ok: false, code: 'backup-failed', error: `改前备份失败，已放弃恢复：${error instanceof Error ? error.message : String(error)}`, snapshot: snapshotView(target) }
      }
    }
    if (plan.changed === false) {
      return {
        ok: true, code: 'already-identical', changed: false, backupPath, snapshot: snapshotView(target),
        patchPath, sha256: plan.sha256, note: { zh: '当前补丁与快照逐字节一致，无需恢复（已备份当前状态）', en: 'Patch already identical to the snapshot — nothing to restore (current state backed up)' },
      }
    }
    const tmp = `${patchPath}.safe-boot-tmp-${Date.now()}`
    try {
      writeFile(tmp, plan.text)
      renameSync(tmp, patchPath)
    } catch (error) {
      try { rmSync(tmp, { force: true }) } catch {}
      return { ok: false, code: 'write-failed', error: `写入失败（原文件未改动）：${error instanceof Error ? error.message : String(error)}`, backupPath }
    }
    const back = exists(patchPath) ? readFile(patchPath) : null
    const verified = back === plan.text && sha256(back) === target.patchSha256
    if (verified !== true) {
      return { ok: false, code: 'verify-failed', error: '写入后读回核实失败：内容与快照不一致（当前状态已备份，可用备份回退）', backupPath, patchPath }
    }
    const check = validatePatchYaml(back)
    return {
      ok: true, code: 'restored', changed: true, backupPath, patchPath,
      sha256: target.patchSha256, snapshot: snapshotView(target),
      yamlCheck: { ok: check.ok, problems: check.problems },
      note: { zh: '已按快照逐字节恢复（改前状态已另存备份）', en: 'Restored byte-for-byte from the snapshot (previous state was backed up)' },
    }
  } catch (error) {
    return { ok: false, code: 'restore-failed', error: `恢复失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * D3-② 只禁用点名的可疑行（**不删任何行**）：改前备份 → 逐行追加 `disabled: true` → 严格 YAML 校验 →
 * 原子写盘 → 读回核实。`rowIds` 必须由调用方显式给出（D1 的隔离计划 / 用户点名），本函数不猜。
 */
function disableSuspects({
  patchPath, rowIds = [], home = undefined, coreRowIds = CORE_PATCH_ROW_IDS,
  moduleNameOf = null, isProtected = null, isFrameworkOwned = null,
  readFile = (p) => readFileSync(p, 'utf8'), writeFile = (p, d) => writeFileSync(p, d, 'utf8'),
  copyFile = (a, b) => copyFileSync(a, b), exists = existsSync,
} = {}) {
  try {
    if (typeof patchPath !== 'string' || patchPath === '') return { ok: false, code: 'no-patch-path', error: '没有补丁路径，无法禁用' }
    if (!exists(patchPath)) return { ok: false, code: 'patch-missing', error: `补丁文件不存在：${patchPath}` }
    const currentText = readFile(patchPath)
    const plan = planDisableRows(currentText, rowIds, { coreRowIds, moduleNameOf, isProtected, isFrameworkOwned })
    if (plan.changed !== true) {
      return {
        ok: true, code: 'noop', changed: false, added: [], skipped: plan.skipped, backupPath: null,
        note: { zh: '没有需要禁用的行（点名行都已禁用 / 不在补丁里 / 属于核心行或受保护行）', en: 'Nothing to disable (already disabled, not in the patch, or a core/protected row)' },
      }
    }
    const check = validatePatchYaml(plan.next)
    if (check.ok !== true) {
      return { ok: false, code: 'invalid-yaml', error: `禁用后会写出非法补丁结构，已放弃（一个字节都没改）：${check.problems.slice(0, 3).join('；')}`, problems: check.problems, added: plan.add, skipped: plan.skipped }
    }
    const backupPath = `${patchPath}.bak-safe-boot-${Date.now()}`
    try { copyFile(patchPath, backupPath) } catch (error) {
      return { ok: false, code: 'backup-failed', error: `改前备份失败，已放弃禁用：${error instanceof Error ? error.message : String(error)}` }
    }
    const tmp = `${patchPath}.safe-boot-tmp-${Date.now()}`
    try {
      writeFile(tmp, plan.next)
      renameSync(tmp, patchPath)
    } catch (error) {
      try { rmSync(tmp, { force: true }) } catch {}
      return { ok: false, code: 'write-failed', error: `写入失败（原文件未改动）：${error instanceof Error ? error.message : String(error)}`, backupPath }
    }
    const back = exists(patchPath) ? readFile(patchPath) : null
    if (back !== plan.next) {
      return { ok: false, code: 'verify-failed', error: '写入后读回核实失败：内容与预期不一致（当前状态已备份，可用备份回退）', backupPath }
    }
    // 逐字节证明：只有点名行被追加了块，其余部分一字不动
    const prefixSame = back.startsWith(currentText.replace(/\s+$/u, ''))
    return {
      ok: true, code: 'disabled', changed: true, added: plan.add.map((a) => a.rowId), skipped: plan.skipped, backupPath,
      patchPath, sha256: sha256(back), prefixSame,
      note: { zh: `已只给 ${plan.add.length} 行点名行追加 disabled: true（未删任何行，改前状态已备份）`, en: `Appended disabled: true to ${plan.add.length} named row(s) only (no row deleted; previous state backed up)` },
    }
  } catch (error) {
    return { ok: false, code: 'disable-failed', error: `禁用失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 把一份快照标记为「良好」（永不随保留策略删除）。 */
function markSnapshotGood({ id = null, home = undefined, readFile = (p) => readFileSync(p, 'utf8'), writeFile = (p, d) => writeFileSync(p, d, 'utf8'), readDir } = {}) {
  try {
    const records = readSnapshotDir({ home, readDir, readFile })
    const target = pickSnapshot(records, { id })
    if (target === null) return { ok: false, code: 'snapshot-missing', error: id === null ? '还没有任何安全启动快照' : `找不到快照 ${id}` }
    const marked = { ...target, kind: 'good', markedAt: Date.now() }
    const file = join(snapshotsDir(home), `${marked.id}.json`)
    const tmp = `${file}.tmp`
    writeFile(tmp, `${JSON.stringify(marked, null, 2)}\n`)
    renameSync(tmp, file)
    const state = readSafeBootState({ home, readFile })
    writeSafeBootState({ ...state, lastGoodId: marked.id, lastGoodAt: marked.markedAt }, { home, writeFile })
    return { ok: true, snapshot: snapshotView(marked), note: { zh: '已标记为良好：这份快照永不随保留策略删除', en: 'Marked as good: this snapshot is never removed by retention' } }
  } catch (error) {
    return { ok: false, code: 'mark-failed', error: `标记失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export {
  AUTO_KEEP,
  SNAPSHOT_KINDS,
  applyRetention,
  disableSuspects,
  ensureSnapshotForCurrentState,
  isRowDisabled,
  listSnapshots,
  markSnapshotGood,
  patchRowState,
  pickSnapshot,
  planDisableRows,
  planRestore,
  readSafeBootState,
  readSnapshotDir,
  restoreLastGood,
  safeBootDir,
  safeBootStateFile,
  sameEnv,
  sha256,
  snapshotView,
  snapshotsDir,
  stampOf,
  validatePatchYaml,
  writeSafeBootState,
  writeSnapshot,
}
