// L1 · domain —— auto-disable.js（把「自动禁用」的**触发源**从"我们升级"扩到"指纹变化 / 启动失败记录"；
// 0.5.32 加法 D5，用户 2026-09-29 明确要求「我们本来就有自动禁用，要的是扩展」）
//
// 现状（0.5.31）自动禁用只有两个触发点，**都绑在我们自己的动作上**：
//   ① `healPatchSafety`（判"模块确证缺失"，随 GET /state 每 ≤2min 跑一次）
//   ② 我们升级流程里的 `preflightDisableIncompatible`
// 于是**别人**改框架（官方桌面端更新器 / 手动 pnpm / npx 缓存变化）时，两者都不触发 ——
// 用户看到的是一堆报错，而不是"肇事行已被关掉、服务能起来"。
//
// 本模块把触发源接到 D1 的预检清单与启动失败记录上，**但必须带上 0.5.30 已立的安全栏**：
//   ① **只禁有证据的行**：`package-unresolvable`（解析器在所有基准上都解析不到）/ `file-target-missing`
//      （`file://` 目标确实不存在）/ 启动失败日志**点名**的行。**解析不确定**（没有基准、解析器抛错、
//      子路径解析不到）一律**只报告不写盘**。
//   ② **`@deepseek-ai/*`（框架自带）永不自动禁用**、**受保护/核心行永不自动禁用**
//      （`framework.js:483/493` 那两类判据：`CORE_PATCH_ROW_IDS` + `isProtected`）。
//   ③ **禁前先写 last-known-good 快照**：任何一次自动禁用都能一键 / 一条命令回滚。
//   ④ **幂等零写盘** + **每次留一条可读记录**（时间 / 行 id / 证据 / 恢复命令）。
//   ⑤ **开关**：`compat-gate.json#autoDisableOnEvidence`（默认启用；关闭 = 退回"只报告 + 等你点"）。
//
// 分层：L1 domain —— 无 ctx；落盘复用 `domain/safe-boot.js` 的同一套原语（备份 + 原子写 + 读回核实）。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CORE_PATCH_ROW_IDS } from './patch.js'
import { parsePatchRows } from './patch-composition-audit.js'
import { disableSuspects, ensureSnapshotForCurrentState } from './safe-boot.js'
import { dshHome } from '../infra/paths.js'

/** 自动禁用的可读记录（追加式 JSONL：每次自动禁用一条，永不覆盖历史）。 */
const autoDisableLog = (home = undefined) => join(home ?? dshHome(), 'plugin-console', 'auto-disable.log')

/** 有证据的行必须落在这些 `code` 上（其余一律只报告）。 */
const EVIDENCE_CODES = {
  'package-unresolvable': '包在所有解析基准上都解析不到（确证缺失）',
  'file-target-missing': 'file:// 目标文件确实不存在（确证缺失）',
  'boot-log': '启动失败日志点名了这一行',
  'boot-quarantine': '升级脚本留下的启动失败隔离记录点名了这一行',
}

/** 明确**不算**证据的形态（写在这里是为了让"为什么没禁"可查，而不是静默放过）。 */
const NON_EVIDENCE_CODES = {
  'subpath-unresolvable': '子路径解析不到（父包还在，可能只是导出变了）',
  'row-without-name': '行既没有 name 也没有 config（形态可疑但无证据）',
  'legacy-source-kind': '源码里的旧形状（可以自动改，不需要禁用）',
  'legacy-source-kind-unresolved': '旧形状无法安全改写（需要人工过一眼）',
  'schemastery-volatile': '依赖副本陈旧（对齐依赖即可，不需要禁用）',
}

/** 框架自带包（`@deepseek-ai/*`）—— 永不由本模块自动禁用。 */
const isFrameworkOwnedName = (name) => {
  const text = String(name ?? '')
  if (text.startsWith('@deepseek-ai/')) return true
  // 裸包名形态（补丁行写 `dsh-xxx` 而不是全名）也要认：框架内置包在补丁里两种写法都出现过
  return /^dsh-[a-z0-9-]+$/iu.test(text)
}

/**
 * 从「D1 预检清单 + 启动失败记录」里挑出**有确证证据、且过得了安全栏**的行（纯函数，不写盘）。
 * @returns {{ disable: Array<{rowId,moduleName,evidence,detail}>, skipped: Array<{rowId,reason,evidence?}>, hasEvidence: boolean }}
 */
function planEvidenceDisable({
  affected = [], bootRows = [], patchText = '', coreRowIds = CORE_PATCH_ROW_IDS,
  isProtected = null, uncertainty = null, maxRows = 20,
} = {}) {
  const rows = parsePatchRows(patchText)
  const byId = new Map(rows.map((r) => [r.id, r]))
  const disable = []
  const skipped = []
  const pushSkip = (rowId, reason, evidence = null) => {
    if (typeof rowId !== 'string' || rowId === '') return
    if (disable.some((d) => d.rowId === rowId)) return
    if (skipped.some((s) => s.rowId === rowId)) return
    skipped.push({ rowId, reason, evidence })
  }

  // 解析面**不确定**（一个基准都没有 / 解析器建不起来）→ 整批只报告，绝不写盘
  if (typeof uncertainty === 'string' && uncertainty !== '') {
    for (const item of affected) if (item?.rowId) pushSkip(item.rowId, `resolution-uncertain: ${uncertainty}`, item.code ?? null)
    return { disable, skipped, hasEvidence: false }
  }

  // ① D1 预检清单里的**确证**证据
  for (const item of (Array.isArray(affected) ? affected : [])) {
    const rowId = typeof item?.rowId === 'string' ? item.rowId : null
    if (rowId === null) continue
    const code = item.code ?? null
    if (EVIDENCE_CODES[code] === undefined) { pushSkip(rowId, `not-evidence: ${NON_EVIDENCE_CODES[code] ?? code ?? 'unknown'}`, code); continue }
    if (coreRowIds.has(rowId)) { pushSkip(rowId, 'core-row', code); continue }
    if (rowId === 'plugin-console') { pushSkip(rowId, 'self', code); continue }
    const row = byId.get(rowId) ?? null
    if (row === null) { pushSkip(rowId, 'not-in-patch', code); continue }
    if (row.disabled === true) { pushSkip(rowId, 'already-disabled', code); continue }
    const moduleName = typeof item.moduleName === 'string' && item.moduleName !== '' ? item.moduleName : (row.name ?? null)
    if (moduleName === null) { pushSkip(rowId, 'module-unknown', code); continue }
    if (isFrameworkOwnedName(moduleName)) { pushSkip(rowId, 'framework-owned', code); continue }
    if (typeof isProtected === 'function' && isProtected(moduleName) === true) { pushSkip(rowId, 'protected-module', code); continue }
    if (disable.length >= maxRows) { pushSkip(rowId, 'row-limit', code); continue }
    disable.push({ rowId, moduleName, evidence: code, detail: EVIDENCE_CODES[code] })
  }

  // ② 启动失败记录点名的行（计划里的 `rows`：分析器已剔除核心行/不可开关行）
  for (const rowId of (Array.isArray(bootRows) ? bootRows : [])) {
    if (typeof rowId !== 'string' || rowId === '') continue
    if (coreRowIds.has(rowId) || rowId === 'plugin-console') { pushSkip(rowId, 'core-row', 'boot-log'); continue }
    const row = byId.get(rowId) ?? null
    if (row === null) { pushSkip(rowId, 'not-in-patch', 'boot-log'); continue }
    if (row.disabled === true) { pushSkip(rowId, 'already-disabled', 'boot-log'); continue }
    const moduleName = row.name ?? null
    if (moduleName !== null && isFrameworkOwnedName(moduleName)) { pushSkip(rowId, 'framework-owned', 'boot-log'); continue }
    if (moduleName !== null && typeof isProtected === 'function' && isProtected(moduleName) === true) { pushSkip(rowId, 'protected-module', 'boot-log'); continue }
    if (disable.length >= maxRows) { pushSkip(rowId, 'row-limit', 'boot-log'); continue }
    disable.push({ rowId, moduleName, evidence: 'boot-log', detail: EVIDENCE_CODES['boot-log'] })
  }
  return { disable, skipped, hasEvidence: disable.length > 0 }
}

/** 追加一条可读记录（JSONL；失败不抛 —— 它不能把自动禁用本身带崩）。 */
function appendDisableLog(entry, { home = undefined, appendFile = (p, d) => appendFileSync(p, d, 'utf8'), mkdir = (d) => mkdirSync(d, { recursive: true }) } = {}) {
  try {
    const file = autoDisableLog(home)
    mkdir(dirname(file))
    appendFile(file, `${JSON.stringify(entry)}\n`)
    return { ok: true, file }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 读记录（新→旧；损坏行跳过）。 */
function readDisableLog({ home = undefined, limit = 50, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  try {
    return readFile(autoDisableLog(home))
      .split(/\r?\n/u)
      .filter((l) => l.trim() !== '')
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter((x) => x !== null)
      .slice(-limit)
      .reverse()
  } catch { return [] }
}

/**
 * 有证据就自动禁用（D5 的落盘入口）。**顺序是关键**：
 *   计划（纯判定）→ **禁前快照**（当前状态有可回滚材料）→ 复用 `disableSuspects`
 *   （改前备份 + 严格 YAML 闸门 + 原子写 + 读回核实）→ 追加可读记录。
 * 任一步失败都如实返回，**绝不部分静默**；`enabled !== true` 时只报告不写盘（退回"等你点"）。
 */
function applyEvidenceDisable({
  patchPath, patchText = null, affected = [], bootRows = [], enabled = true,
  fingerprint = null, frameworkVersion = null, reasons = [], home = undefined,
  isProtected = null, uncertainty = null, coreRowIds = CORE_PATCH_ROW_IDS,
  readFile = (p) => readFileSync(p, 'utf8'), exists = existsSync, ...rest
} = {}) {
  try {
    if (typeof patchPath !== 'string' || patchPath === '') return { ok: false, code: 'no-patch-path', disabled: [], skipped: [] }
    // 补丁不存在 → 如实拒绝（**绝不创建**：凭一份"没读到的补丁"去写 disabled 块等于凭空造文件）
    if (typeof patchText !== 'string' && exists(patchPath) !== true) {
      return { ok: false, code: 'patch-missing', disabled: [], skipped: [], error: `补丁文件不存在：${patchPath}` }
    }
    const text = typeof patchText === 'string' ? patchText : readFile(patchPath)
    const plan = planEvidenceDisable({ affected, bootRows, patchText: text, coreRowIds, isProtected, uncertainty })
    if (plan.disable.length === 0) {
      return { ok: true, code: 'no-evidence', disabled: [], skipped: plan.skipped, snapshot: null, note: '没有确证证据可禁用（只报告不写盘）' }
    }
    if (enabled !== true) {
      return {
        ok: true, code: 'switch-off', disabled: [], skipped: plan.skipped, snapshot: null,
        candidates: plan.disable.map((d) => d.rowId),
        note: '自动禁用开关已关闭：只报告，等你手动点「只禁可疑行」（或离线脚本 --disable-suspects）',
      }
    }
    // ③ 禁前先写 last-known-good 快照：没有可回滚材料就不动手
    const snap = ensureSnapshotForCurrentState({
      patchPath, patchText: text, fingerprint, frameworkVersion, reasons, home,
      note: `自动禁用前的安全快照（点名 ${plan.disable.length} 行：${plan.disable.map((d) => d.rowId).join('、')}）`,
      readFile,
    })
    if (snap.ok !== true) {
      return { ok: false, code: 'snapshot-failed', disabled: [], skipped: plan.skipped, snapshot: snap, error: `禁前快照失败，已放弃自动禁用：${snap.error ?? '未知原因'}` }
    }
    const result = disableSuspects({
      patchPath, rowIds: plan.disable.map((d) => d.rowId), home, coreRowIds,
      moduleNameOf: (rowId) => plan.disable.find((d) => d.rowId === rowId)?.moduleName ?? null,
      isProtected, isFrameworkOwned: null, readFile,
    })
    const entry = {
      at: Date.now(),
      kind: 'auto-disable',
      source: 'evidence',
      added: result.ok === true ? (result.added ?? []) : [],
      skipped: result.skipped ?? plan.skipped,
      evidence: plan.disable.map((d) => ({ rowId: d.rowId, moduleName: d.moduleName, code: d.evidence, detail: d.detail })),
      snapshotId: snap.id ?? null,
      backupPath: result.backupPath ?? null,
      patchPath,
      frameworkVersion: frameworkVersion ?? fingerprint?.frameworkVersion ?? null,
      fingerprint: fingerprint ?? null,
      restoreCommand: 'node scripts/safe-boot.mjs --restore-last-good',
      result: { ok: result.ok === true, code: result.code ?? null, error: result.error ?? null },
    }
    const logged = appendDisableLog(entry, { home })
    if (result.ok !== true) {
      return { ok: false, code: result.code ?? 'disable-failed', disabled: [], skipped: result.skipped ?? plan.skipped, snapshot: snap, error: result.error ?? '自动禁用失败', log: logged }
    }
    return {
      ok: true, code: result.changed === true ? 'auto-disabled' : 'noop', disabled: result.added ?? [], skipped: result.skipped ?? plan.skipped,
      snapshot: snap, backupPath: result.backupPath ?? null, log: logged, prefixSame: result.prefixSame === true,
      note: result.changed === true
        ? `已自动禁用 ${result.added.length} 行（有确证证据；禁前快照 ${snap.id}，可一条命令回滚）`
        : '点名行都已处于禁用状态（幂等零写盘）',
    }
  } catch (error) {
    return { ok: false, code: 'auto-disable-failed', disabled: [], skipped: [], error: `自动禁用失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export {
  EVIDENCE_CODES,
  NON_EVIDENCE_CODES,
  appendDisableLog,
  applyEvidenceDisable,
  autoDisableLog,
  isFrameworkOwnedName,
  planEvidenceDisable,
  readDisableLog,
}
