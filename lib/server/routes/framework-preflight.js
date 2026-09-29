// L2 · routes —— 会话格式契约预检（Step 1+2）
//   POST /plugin-console/framework-preflight        只读预检：抓目标版本契约 + 扫描本地生产方
//   POST /plugin-console/framework-preflight-patch  补丁：mode=plan 出 diff；mode=apply 备份后写回
//
// 为什么要有它（2026-09-24 事故）：框架 0.1.5-rc.2 → 0.1.7-rc.1 把会话消息格式升到 V4，
// 运行期生产方（agent-presets + 插件 runtime）仍写 V3 的 `kind: 'plugin'` 包装 →
// 「一发消息就报错、会话整体不可用」。包级适配门（peerDependencies / 版本号）看不见这类
// 运行期契约破坏，所以必须在**升级前**单独预检、先把本地适配好再装。

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isFrameworkOwnedPackage } from '../domain/compat.js'
import { classifyTargetAvailability, frameworkPackageRows, parsePatchRows } from '../domain/patch-composition-audit.js'
import { collectPresetAudit } from '../domain/preset-audit.js'
import { loadContractRules, summarizeContractRules } from '../domain/contract-rules.js'
import { discoverFormatContract, summarizeContract } from '../domain/format-contract.js'
import { applyFormatPatch, collectProducerTargets, scanProducerFiles } from '../domain/format-scan.js'
import { currentFrameworkVersion } from '../domain/framework.js'
import { listEntries } from '../domain/runtime.js'
import { curlText, fetchJsonUrl } from '../infra/http.js'
import { checkPublishedVersions, makeVersionProbe } from '../infra/registry-versions.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { baseDirOf, dshHome, findPatchPath, pluginRoot, profileDirOf, resolvePackageJson } from '../infra/paths.js'

const REGISTRY = 'https://registry.npmmirror.com'

/** `preflightRoots` 的默认依赖（0.5.32：把这段抽成可注入形式，让"指纹变化自动预检"与离线脚本
 *  复用**同一套扫描面**推导，而不是各写一份 —— 两套推导迟早会分叉，而分叉的表现是"自动预检看不见
 *  用户装的那个包"，属于静默漏报）。生产路径不传 deps，行为与抽取前一字不差。 */
const defaultListEntries = listEntries
const defaultResolvePackageJson = resolvePackageJson
const defaultIsFrameworkOwned = isFrameworkOwnedPackage
const defaultPluginRoot = pluginRoot

/** 预检的两个扫描面：用户预设目录 + profile 内每个已装插件包。
 *  框架自带包（解析到 profile 之外，即 npx 缓存里的 @deepseek-ai/*）标成 kind='framework'：
 *  仍然扫（能暴露框架自身的契约不一致），但**只报告不改**——改它等于污染框架安装树。
 *
 *  ★ 2026-09-27 改错（真 bug）：用户预设目录写成了 `join(dshHome(), 'agent-presets')` —— **少一个点**。
 *  框架的目录是 `<DSH_HOME>/.agent-presets`（旧 discovery 的 `USER_PRESET_DIR = '.agent-presets'`），
 *  所以这一路**一直指向一个不存在的目录**：静默扫到 0 个文件，预设里的 V3 生产方从来没被预检看见
 *  （升级前"0 blocker"的结论因此是**假绿**）。现在由 `userPresetsRoot()` 单点推导，配断言钉死。 */
function userPresetsRoot(home = undefined) {
  return join(home ?? dshHome(), '.agent-presets')
}

function preflightRoots(ports, profileDir, deps = {}) {
  const userPresetsRoot = deps.userPresetsRoot ?? ((home = undefined) => join(home ?? dshHome(), '.agent-presets'))
  const listEntries = deps.listEntries ?? defaultListEntries
  const resolvePackageJson = deps.resolvePackageJson ?? defaultResolvePackageJson
  const isFrameworkOwnedPackage = deps.isFrameworkOwnedPackage ?? defaultIsFrameworkOwned
  const pluginRoot = deps.pluginRoot ?? defaultPluginRoot
  const roots = [{ root: userPresetsRoot(), kind: 'preset' }]
  // 控制台自身排除在外：它是工具、不是会话消息生产方，而它的报错文案/文档里本身就含
  // `kind: 'plugin'`、`.volatile(` 这类字样 —— 发版门槛自扫时正是这些字串报出了无意义条目。
  let selfName = null
  try { selfName = JSON.parse(readFileSync(join(pluginRoot(), 'package.json'), 'utf8')).name ?? null } catch {}
  let entries = []
  try { entries = listEntries(ports) } catch {}
  const baseDir = baseDirOf(ports?.baseUrl ?? 'file:///')
  for (const entry of entries) {
    if (typeof entry.moduleName !== 'string' || entry.moduleName === '' || entry.moduleName.startsWith('cordis:')) continue
    if (selfName !== null && entry.moduleName === selfName) continue
    let pkgPath = null
    try { pkgPath = resolvePackageJson(entry.moduleName, baseDir, profileDir) } catch {}
    if (pkgPath === null) continue
    const pkgDir = dirname(pkgPath)
    let kind = 'plugin'
    // 框架自带包判定用两个信号（缺一不可）：
    //   ① 解析到 profile 之外（junction 进 npx 缓存的常见形态）；
    //   ② 包名落在 @deepseek-ai/ 作用域 —— profile 里存在**手工铺的真实副本**（实网见到
    //      @deepseek-ai/dsh-schedule@0.0.1-rc.3、schemastery@3.18.1 这种陈旧副本），
    //      它们物理上在 profile 内，路径判定认不出来，但同样不该被预检手改（正确处置是升级/回滚该包）。
    try {
      if (isFrameworkOwnedPackage(pkgDir, profileDir) || entry.moduleName.startsWith('@deepseek-ai/')) kind = 'framework'
    } catch {}
    roots.push({ root: pkgDir, kind, moduleName: entry.moduleName })
  }
  return roots
}

/** 目标版本：请求体优先，缺省用当前已装版本（预检当前版本同样能发现历史遗留的旧形状）。 */
function resolveTargetVersion(rc, body) {
  if (typeof body?.targetVersion === 'string' && body.targetVersion.trim() !== '') return body.targetVersion.trim()
  try { return currentFrameworkVersion(rc.ctx) } catch { return null }
}

/** 当前已装版本（用于算「目标版本新增了哪条迁移边」——这才是契约变更的信号）。 */
function resolveCurrentVersion(rc) {
  try { return currentFrameworkVersion(rc.ctx) } catch { return null }
}

/** 测试/离线模式：CI 里 DSH_TEST_SKIP_NETWORK=1，跳过 registry 拉取（扫描仍照跑）。 */
function networkAllowed() {
  return process.env.DSH_TEST_SKIP_NETWORK !== '1'
}

async function routeFrameworkPreflight(req, res, rc) {
  const body = rc.body ?? {}
  const profileDir = profileDirOf(rc.ctx)
  const targetVersion = resolveTargetVersion(rc, body)
  if (targetVersion === null) { sendError(res, 400, '无法确定目标框架版本（请在请求里带 targetVersion）'); return }

  const roots = preflightRoots(rc.ctx, profileDir)
  const targets = collectProducerTargets(roots)

  let contract = null
  let contractError = null
  let contractWarnings = []
  if (!networkAllowed()) {
    contractError = '已跳过网络（DSH_TEST_SKIP_NETWORK=1）：仅使用内置规则扫描'
  } else {
    const discovered = await discoverFormatContract({
      targetVersion,
      currentVersion: resolveCurrentVersion(rc),
      registry: REGISTRY,
      fetchJson: (url) => fetchJsonUrl(url, 20000),
      fetchText: (url) => curlText(url, 12000),
    })
    contract = discovered.contract
    contractError = discovered.error
    contractWarnings = discovered.warnings ?? []
  }

  const rules = contract?.rules ?? { producerKindRequired: false, forbiddenKinds: ['plugin'], pluginPrefix: 'plugin:', renames: {} }
  const scan = scanProducerFiles({ targets, rules, targetVersion })

  // 补丁 ↔ 目标版本核对（2026-09-28 加法；真机事故：0.2.0-rc.1 移除了
  // `@deepseek-ai/dsh-workflow-worker-thread`，补丁三处仍引用 → 升级后 `workflowEngine`
  // 没有提供方 → `dsh-tool-workflow`/`dsh-tool-ralph` 永久 waiting → 老会话 resume 失败）。
  // 只核对**随框架版本走**的包（`@deepseek-ai/*`）：目标版本还没装到本机，只有 registry 元数据能提前看见。
  // 网络不可用/查询失败一律记 `unknown`，**绝不判死**。
  let patchTarget = { checked: 0, missing: [], unknown: [], skipped: null, patchPath: null }
  try {
    const patchPath = findPatchPath(rc.ctx)
    patchTarget.patchPath = patchPath
    if (patchPath === null || !existsSync(patchPath)) {
      patchTarget.skipped = '找不到 profile 补丁文件（cordis.patch.yml）'
    } else {
      const rows = parsePatchRows(readFileSync(patchPath, 'utf8'))
      const fwRows = frameworkPackageRows(rows)
      if (fwRows.length === 0) patchTarget.skipped = '补丁里没有随框架版本走的包（@deepseek-ai/*）'
      else if (!networkAllowed()) patchTarget.skipped = '已跳过网络（DSH_TEST_SKIP_NETWORK=1）'
      else {
        const probe = makeVersionProbe({ registry: REGISTRY, fetchJson: (url, timeoutMs) => fetchJsonUrl(url, timeoutMs) })
        const results = await checkPublishedVersions(fwRows, { probe, version: targetVersion })
        const publishedBy = new Map(results.map((row) => [row.name, row.published]))
        const classified = classifyTargetAvailability(fwRows, { publishedBy, targetVersion })
        patchTarget = { ...patchTarget, checked: results.length, missing: classified.missing, unknown: classified.unknown, skipped: null }
      }
    }
  } catch (error) {
    patchTarget.skipped = '核对失败：' + String(error?.message ?? error)
  }
  // 预设声明行体检（2026-09-28 加法）：升级前就能看见"补丁里的声明行已陈旧/缺失"。
  // 真机事故：预设自身被改成 v10、补丁行还指向 v1 → 老会话 resume 到错的模块，且没有任何地方会报。
  // 只读、不阻塞：作为 presetAudit 字段随预检一起下发（blockers>0 时由面板提示先修再升）。
  let presetAudit = null
  try {
    presetAudit = collectPresetAudit({ presetsRoot: join(dshHome(), '.agent-presets'), patchPath: findPatchPath(rc.ctx) })
  } catch (error) {
    presetAudit = { ok: false, error: String(error?.message ?? error), blockers: 0, stale: [], missing: [], orphan: [], targetMissing: [] }
  }
  sendJson(res, 200, {
    ok: true,
    targetVersion,
    contract,
    contractError,
    contractWarnings,
    contractSummary: contract === null ? null : summarizeContract(contract),
    sessionFormatVersion: contract?.sessionFormatVersion ?? null,
    // 规则库覆盖情况（2026-09-24）：预检读的是**数据化规则**，所以它对我们没发过升级包的
    // 框架版本同样有效；source='unavailable' 时说明规则文件缺失，调用方不应把它当「零发现」。
    rules: summarizeContractRules(loadContractRules()),
    roots: roots.map((r) => ({ root: r.root, kind: r.kind, moduleName: r.moduleName ?? null })),
    scan,
    patchTarget,
    presetAudit,
  })
}

async function routeFrameworkPreflightPatch(req, res, rc) {
  const body = rc.body ?? {}
  const mode = body.mode === 'apply' ? 'apply' : 'plan'
  const profileDir = profileDirOf(rc.ctx)
  const targetVersion = resolveTargetVersion(rc, body)
  if (targetVersion === null) { sendError(res, 400, '无法确定目标框架版本（请在请求里带 targetVersion）'); return }

  const roots = preflightRoots(rc.ctx, profileDir)
  const allTargets = collectProducerTargets(roots)
  // 允许名单：请求可收窄到指定文件（dry-run 后前端只提交它看到的那几条），否则用全量。
  const picked = Array.isArray(body.files) && body.files.length > 0
    ? allTargets.filter((t) => body.files.some((f) => String(f).toLowerCase() === t.file.toLowerCase()))
    : allTargets

  let rules = { producerKindRequired: false, forbiddenKinds: ['plugin'], pluginPrefix: 'plugin:', renames: {} }
  if (networkAllowed()) {
    try {
      const discovered = await discoverFormatContract({
        targetVersion,
        currentVersion: resolveCurrentVersion(rc),
        registry: REGISTRY,
        fetchJson: (url) => fetchJsonUrl(url, 20000),
        fetchText: (url) => curlText(url, 12000),
      })
      if (discovered.contract !== null) rules = discovered.contract.rules
    } catch {}
  }

  const result = applyFormatPatch({ targets: picked, rules, targetVersion, dryRun: mode !== 'apply' })
  // 应用后复扫（同一批目标），给前端一个「还剩几条」的确定答案
  const remaining = scanProducerFiles({ targets: picked, rules, targetVersion })

  sendJson(res, 200, {
    ok: true,
    mode,
    targetVersion,
    applied: mode === 'apply',
    changes: result.changes,
    backups: result.backups,
    skipped: result.skipped,
    unresolved: result.unresolved,
    remaining,
  })
}

export { routeFrameworkPreflight, routeFrameworkPreflightPatch, preflightRoots, resolveTargetVersion, resolveCurrentVersion, userPresetsRoot }
