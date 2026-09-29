// L1 · domain —— auto-preflight-run.js（**只读**预检运行器：指纹变化后现场跑一次扫描；0.5.32 加法 D1）
//
// 与 `routes/framework-preflight.js` 的分工：
//   · 那条路由是**用户手动点**的完整预检（目标版本可指定、会打 registry 抓契约、可能写补丁）；
//   · 本模块是**指纹变化自动触发**的**只读**预检 —— 不下载、不安装、不改补丁、不碰 loader，
//     只用「内置规则库 + 本地文件 + 补丁体检 + 启动失败日志分析」产出三样东西：
//       ① 兼容清单（受影响行）  ② 隔离计划（建议禁用哪些行、为什么）  ③ 变更摘要（版本 from→to / 包增减 / 指纹 reasons）
// 网络：自动模式下**一律跳过外部 registry**（自动触发不该偷偷联网）—— 结论完全由本地判据得出，
//      这也是「离线脚本能在服务没跑时用同一套判据」的前提。
//
// 分层：L1 domain —— 不出现 ctx（loader 条目 / 扫描根由调用方注入）；IO 与纯判据分离，离线可断言。

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { affectedRows, planSuspectRows, summarizeDelta } from './auto-preflight.js'
import { loadContractRules, summarizeContractRules } from './contract-rules.js'
import { collectProducerTargets, scanProducerFiles } from './format-scan.js'
import { CORE_PATCH_ROW_IDS } from './patch.js'
import { classifyPatchRows, parsePatchRows } from './patch-composition-audit.js'
import { collectPresetAudit } from './preset-audit.js'
import { planQuarantine, readQuarantineRecord } from './quarantine.js'
import { makePackageResolver } from '../infra/package-resolve.js'

/** 扫不到规则库时的兜底规则（与 routes/framework-preflight.js 的兜底一字不差）。 */
const DEFAULT_RULES = { producerKindRequired: false, forbiddenKinds: ['plugin'], pluginPrefix: 'plugin:', renames: {} }

/** 自动模式下的固定说明（如实告诉用户"这份结论没打网络"）。 */
const OFFLINE_NOTE = {
  zh: '自动预检是只读且不联网的：结论来自内置规则库与本地文件；目标版本的 registry 契约未核对（可手动跑完整预检）',
  en: 'Auto-preflight is read-only and offline: conclusions come from the built-in rule pack and local files; the target-version registry contract was not checked (run the full preflight manually)',
}

/**
 * `<pnpmRoot>/.pnpm` 下的 `@deepseek-ai+*` 实体名（去版本后缀）—— 用于变更摘要的「新增/消失的包」。
 * ★ 只用于**摘要展示**，绝不用于「包在不在」的判定：pnpm 会截断超长目录名（见 infra/package-resolve.js 头注释），
 *   所以解析性判定一律走 Node 解析器（本文件里的 `resolve`）。
 */
function packageNamesOf(pnpmRoot, readDir = (dir) => readdirSync(dir)) {
  if (typeof pnpmRoot !== 'string' || pnpmRoot === '') return []
  let names = []
  try { names = readDir(join(pnpmRoot, '.pnpm')) } catch { return [] }
  const out = new Set()
  for (const name of names) {
    if (typeof name !== 'string' || !name.startsWith('@deepseek-ai+')) continue
    const at = name.indexOf('@', 1)
    out.add(at === -1 ? name : name.slice(0, at))
  }
  return [...out].sort()
}

/** `file://` URL → 路径（离线安全；解析失败抛给调用方，由调用方转成 false）。 */
function fileUrlToPath(url) {
  return fileURLToPath(String(url ?? ''))
}

/**
 * 跑一次只读预检（**同步**：全部是本地文件扫描，调用方用 withTimeout 包裹即可）。
 * @param {object} input
 * @param {string|null} input.profileDir   profile 目录（补丁所在目录）
 * @param {string|null} input.patchPath    cordis.patch.yml 绝对路径
 * @param {object|null} input.current      当前指纹（frameworkVersion / pnpmEntities / pnpmRoot）
 * @param {object|null} input.previous     基线指纹（可能为 null）
 * @param {string[]} input.presetRoots     预设扫描根（通常 `<dshHome>/.agent-presets`）
 * @param {Array<{root:string,kind:string,moduleName?:string|null}>} input.roots 生产方扫描根
 * @param {string[]} input.reasons         指纹变更原因（直接来自 compareFingerprint）
 * @param {string[]} input.previousPackages 上一次记录的框架包名（没有则空数组 → 摘要如实标 rationaleAvailable=false）
 * @param {boolean} input.networkAllowed   是否允许打网络（自动预检一律 false）
 * @param {Array} [input.targets]          直接给扫描目标（测试注入；缺省由 roots 推导）
 * @param {boolean} [input.includeBootLog] 是否把 profile 下的 `.dsh-boot.log` 纳入启动失败分析（缺省 true）
 */
function runAutoPreflightScan(input = {}) {
  const {
    profileDir = null, patchPath = null, current = null, previous = null,
    presetRoots = [], roots = [], reasons = [], previousPackages = [],
    networkAllowed = false, targets = null, includeBootLog = true,
    readFile = (p) => readFileSync(p, 'utf8'), existsFile = existsSync, readDir = (dir) => readdirSync(dir),
  } = input

  // ① 补丁体检（只读）：行 → 包可解析性（blocker / warning / 改名建议）
  const patchText = typeof patchPath === 'string' && existsFile(patchPath) ? readFile(patchPath) : ''
  const rows = parsePatchRows(patchText)
  const bases = [profileDir, current?.pnpmRoot]
    .map((b) => (typeof b === 'string' && b !== '' ? b : null))
    .filter(Boolean)
  const resolve = bases.length > 0 ? makePackageResolver(bases) : null
  const patchReport = resolve === null
    ? { blockers: [], warnings: [], resolvable: [], patchOnly: [], skipped: '没有可用的解析基准（profile 目录与框架运行时根都拿不到）' }
    : classifyPatchRows(rows, {
      resolve: (name) => resolve(name),
      existsFile: (url) => { try { return existsFile(fileUrlToPath(url)) } catch { return false } },
      candidates: [],
    })

  // ② 生产方源码扫描（会话格式契约）：规则来自**数据化规则库**（对我们没发过升级包的框架版本同样有效）
  const rulePack = (() => { try { return loadContractRules() } catch { return null } })()
  const hasRules = Array.isArray(rulePack?.rules) && rulePack.rules.length > 0
  const scanTargets = Array.isArray(targets) ? targets : collectProducerTargets(roots)
  const scan = scanProducerFiles({ targets: scanTargets, rules: hasRules ? rulePack.rules : DEFAULT_RULES, targetVersion: current?.frameworkVersion ?? null })
  const scanSafe = { ...scan, files: (scan.files ?? []).slice(0, 40), findings: (scan.findings ?? []).slice(0, 40) }

  // ③ 预设声明行体检（只读；失败如实记 error，不假装"零发现"）
  let presetAudit = null
  try {
    presetAudit = collectPresetAudit({ presetsRoot: presetRoots[0] ?? null, patchPath })
  } catch (error) {
    presetAudit = { ok: false, error: error instanceof Error ? error.message : String(error), blockers: 0, stale: [], missing: [], orphan: [], targetMissing: [] }
  }

  // ④ 受影响行 + 隔离计划（只**建议**，绝不写盘）
  const affected = affectedRows({ patchReport, scan, rows })
  const plan = planSuspectRows(affected, { coreRowIds: CORE_PATCH_ROW_IDS, toggleableById: new Map() })

  // ⑤ 我们的升级脚本若曾留下隔离记录，把它并进计划（旧记录仍有效）。
  //    别人升级时没有这份记录 —— 这正是 0.5.32 补的缺口：兜底输入换成「指纹变化自动预检」的结论。
  let bootQuarantine = null
  try { bootQuarantine = readQuarantineRecord() } catch { bootQuarantine = null }
  if (bootQuarantine !== null && Array.isArray(bootQuarantine.rows)) {
    for (const rowId of bootQuarantine.rows) {
      if (typeof rowId !== 'string' || rowId === '') continue
      if (plan.suspects.some((s) => s.rowId === rowId)) continue
      plan.suspects.push({ rowId, moduleName: null, reason: 'boot-quarantine', detail: '升级脚本留下的启动失败隔离记录', line: null })
    }
  }

  // ⑥ 启动失败日志（若存在）：把「谁把服务搞挂了」也变成点名行
  let bootPlan = null
  if (includeBootLog === true) {
    try {
      const logPath = join(dirname(String(patchPath ?? join(profileDir ?? '.', 'x'))), '.dsh-boot.log')
      if (existsFile(logPath)) {
        bootPlan = planQuarantine({ logText: readFile(logPath), candidates: rows.map((r) => ({ rowId: r.id, moduleName: r.name, toggleable: true })) })
        for (const rowId of bootPlan.rows ?? []) {
          if (!plan.suspects.some((s) => s.rowId === rowId)) plan.suspects.push({ rowId, moduleName: null, reason: 'boot-log', detail: '启动失败日志点名', line: null })
        }
      }
    } catch { bootPlan = null }
  }

  const delta = summarizeDelta({
    current,
    previous,
    currentPackages: packageNamesOf(current?.pnpmRoot ?? null, readDir),
    previousPackages,
  })
  const blockers = affected.filter((a) => a.severity === 'blocker').length
  return {
    ok: true,
    at: Date.now(),
    targetVersion: current?.frameworkVersion ?? null,
    previousVersion: previous?.frameworkVersion ?? null,
    reasons: Array.isArray(reasons) ? reasons : [],
    summary: {
      frameworkVersionFrom: previous?.frameworkVersion ?? null,
      frameworkVersionTo: current?.frameworkVersion ?? null,
      versionChanged: (previous?.frameworkVersion ?? null) !== (current?.frameworkVersion ?? null),
      blockers,
      affectedCount: affected.length,
      suspectCount: plan.suspects.length,
      packagesAdded: delta.packagesAdded,
      packagesRemoved: delta.packagesRemoved,
      note: blockers > 0 ? `预检发现 ${blockers} 行受影响` : '预检未发现受影响行',
    },
    affected,
    suspects: plan.suspects,
    skipped: plan.skipped,
    delta,
    // D5（自动禁用的扩展触发源）要用的两样东西：确证证据（affected 的行/码）与启动失败点名行。
    // 这里是**只读**产出，是否落盘由 routes 层按开关决定（domain 不做"要不要动用户文件"的判断）。
    evidence: {
      uncertainty: resolve === null ? '没有可用的解析基准（profile 目录与框架运行时根都拿不到）' : (typeof patchReport.skipped === 'string' ? patchReport.skipped : null),
      rows: affected.filter((a) => a.rowId !== null).map((a) => ({ rowId: a.rowId, moduleName: a.moduleName ?? null, code: a.code ?? null, severity: a.severity })),
      bootRows: (bootPlan?.rows ?? []),
    },
    patch: { patchPath, rows: rows.length, blockers: (patchReport.blockers ?? []).length, warnings: (patchReport.warnings ?? []).length, skipped: patchReport.skipped ?? null },
    scan: scanSafe,
    rules: hasRules ? summarizeContractRules(rulePack) : { source: 'unavailable', version: null, updatedAt: null, total: 0, blockers: 0, autoDetected: 0, ids: [], error: '规则库不可用：本次扫描只用内置兜底规则（结论偏保守）' },
    presetAudit,
    bootPlan,
    network: { allowed: networkAllowed === true, note: networkAllowed === true ? null : OFFLINE_NOTE },
  }
}

export { DEFAULT_RULES, OFFLINE_NOTE, fileUrlToPath, packageNamesOf, runAutoPreflightScan }
