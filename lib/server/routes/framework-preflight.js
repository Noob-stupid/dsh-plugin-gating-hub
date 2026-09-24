// L2 · routes —— 会话格式契约预检（Step 1+2）
//   POST /plugin-console/framework-preflight        只读预检：抓目标版本契约 + 扫描本地生产方
//   POST /plugin-console/framework-preflight-patch  补丁：mode=plan 出 diff；mode=apply 备份后写回
//
// 为什么要有它（2026-09-24 事故）：框架 0.1.5-rc.2 → 0.1.7-rc.1 把会话消息格式升到 V4，
// 运行期生产方（agent-presets + 插件 runtime）仍写 V3 的 `kind: 'plugin'` 包装 →
// 「一发消息就报错、会话整体不可用」。包级适配门（peerDependencies / 版本号）看不见这类
// 运行期契约破坏，所以必须在**升级前**单独预检、先把本地适配好再装。

import { dirname, join } from 'node:path'
import { isFrameworkOwnedPackage } from '../domain/compat.js'
import { discoverFormatContract, summarizeContract } from '../domain/format-contract.js'
import { applyFormatPatch, collectProducerTargets, scanProducerFiles } from '../domain/format-scan.js'
import { currentFrameworkVersion } from '../domain/framework.js'
import { listEntries } from '../domain/runtime.js'
import { curlText, fetchJsonUrl } from '../infra/http.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { baseDirOf, dshHome, profileDirOf, resolvePackageJson } from '../infra/paths.js'

const REGISTRY = 'https://registry.npmmirror.com'

/** 预检的两个扫描面：用户预设目录 + profile 内每个已装插件包。
 *  框架自带包（解析到 profile 之外，即 npx 缓存里的 @deepseek-ai/*）标成 kind='framework'：
 *  仍然扫（能暴露框架自身的契约不一致），但**只报告不改**——改它等于污染框架安装树。 */
function preflightRoots(ports, profileDir) {
  const roots = [{ root: join(dshHome(), 'agent-presets'), kind: 'preset' }]
  let entries = []
  try { entries = listEntries(ports) } catch {}
  const baseDir = baseDirOf(ports?.baseUrl ?? 'file:///')
  for (const entry of entries) {
    if (typeof entry.moduleName !== 'string' || entry.moduleName === '' || entry.moduleName.startsWith('cordis:')) continue
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

  sendJson(res, 200, {
    ok: true,
    targetVersion,
    contract,
    contractError,
    contractWarnings,
    contractSummary: contract === null ? null : summarizeContract(contract),
    sessionFormatVersion: contract?.sessionFormatVersion ?? null,
    roots: roots.map((r) => ({ root: r.root, kind: r.kind, moduleName: r.moduleName ?? null })),
    scan,
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

export { routeFrameworkPreflight, routeFrameworkPreflightPatch, preflightRoots, resolveTargetVersion, resolveCurrentVersion }
