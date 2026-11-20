// L1 · domain —— framework-diagnosis.js（issue #28：核心行进/服务活但 UI 白屏的只读诊断）
//
// 背景：桌面端官方更新器绕过本插件的升级流程，把框架升到新版本；profile 里如果还有
// `file:`/`link:` 的 @deepseek-ai/* vendored 包（peerDeps 钉死旧版本），DSH 自己的版本闸
// 会禁用对应核心行 → sessionController 等服务消失 → 客户端 pending/白屏，但 host 进程还活着。
//
// 这里只做三件事：
//   ① 找出版本与当前框架不一致、且处于 disabled/failed/pending 的核心行；
//   ② 找出 profile 里 `file:`/`link:` 的 @deepseek-ai/* 依赖，读它的真实版本/peerDeps；
//   ③ 写一份 diagnosis-<ts>.json，附“换包 / 回滚框架”两条恢复建议。
// 绝不改 profile、绝不重新启用核心行、绝不自动执行恢复命令。
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dshHome } from '../infra/paths.js'

const CORE_PREFIX = '@deepseek-ai/'
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }
let lastDiagnosis = null

/** profile 里非 registry 的 @deepseek-ai/* 依赖（官方升级后最容易变成“版本没跟上”的一类）。 */
function vendoredCoreDeps(profileDir) {
  if (typeof profileDir !== 'string' || profileDir === '') return []
  const pkg = readJson(join(profileDir, 'package.json'))
  const deps = pkg?.dependencies !== null && typeof pkg?.dependencies === 'object' ? pkg.dependencies : {}
  const out = []
  for (const [name, spec] of Object.entries(deps)) {
    if (!name.startsWith(CORE_PREFIX) || typeof spec !== 'string') continue
    if (!/^(?:file|link):/iu.test(spec)) continue
    const rel = spec.replace(/^(?:file|link):/iu, '')
    const dir = resolve(profileDir, rel)
    const depPkg = readJson(join(dir, 'package.json'))
    out.push({
      name,
      spec,
      path: dir,
      version: typeof depPkg?.version === 'string' ? depPkg.version : null,
      peerDependencies: depPkg?.peerDependencies !== null && typeof depPkg?.peerDependencies === 'object' ? depPkg.peerDependencies : null,
    })
  }
  return out
}

function recoveryFor({ currentVersion, previousVersion, profileDir, blockedCoreRows, vendoredCoreDeps: vendored }) {
  const profile = typeof profileDir === 'string' && profileDir !== '' ? profileDir.split(/[\\/]/u).filter(Boolean).pop() : 'desktop'
  const names = [...new Set([...blockedCoreRows.map((x) => x.moduleName), ...vendored.map((x) => x.name)].filter(Boolean))]
  const commands = names.map((name) => ({
    kind: 'pin-core-package',
    package: name,
    version: currentVersion,
    command: `dsh plugin --profile ${profile} add '${name}@${currentVersion}'`,
  }))
  if (typeof previousVersion === 'string' && previousVersion !== '') {
    commands.push({ kind: 'rollback-framework', version: previousVersion, command: `在插件控制台执行「框架回滚」到 ${previousVersion}（先备份，再回滚）` })
  }
  return commands
}

/**
 * 只读诊断。返回 `{ok, critical, currentVersion, previousVersion, blockedCoreRows, vendoredCoreDeps, recovery, diagnosisPath, summary}`。
 * `write` 只在 critical 时落盘，且文件名带时间戳；不覆盖旧诊断。
 */
function diagnoseFrameworkCoreRows({
  entries = [], framework = null, profileDir = null, home = undefined,
  now = Date.now(), write = true,
} = {}) {
  try {
    const currentVersion = typeof framework?.version === 'string' ? framework.version : null
    const previousVersion = typeof framework?.from === 'string' ? framework.from : null
    const core = (Array.isArray(entries) ? entries : []).filter((e) => typeof e?.moduleName === 'string' && e.moduleName.startsWith(CORE_PREFIX))
    const blockedCoreRows = core.filter((e) => {
      if (typeof e.version !== 'string' || currentVersion === null || e.version === currentVersion) return false
      return e.enabled === false || e.fiberPhase === 'failed' || e.fiberPhase === 'pending'
    }).map((e) => ({ rowId: e.rowId ?? null, moduleName: e.moduleName, version: e.version, fiberPhase: e.fiberPhase ?? null, disableSource: e.disableSource ?? null }))
    const vendored = vendoredCoreDeps(profileDir).filter((x) => currentVersion !== null && x.version !== currentVersion)
    const critical = blockedCoreRows.length > 0 || vendored.length > 0
    const recovery = critical ? recoveryFor({ currentVersion, previousVersion, profileDir, blockedCoreRows, vendoredCoreDeps: vendored }) : []
    const summary = critical
      ? `${blockedCoreRows.length} 个核心行版本与当前框架不一致；${vendored.length} 个非 registry 核心依赖未跟上。恢复：换到 ${currentVersion}，或回滚到 ${previousVersion ?? '上一版'}。`
      : '核心行与 profile 依赖均未发现版本错配。'
    let diagnosisPath = null
    const key = JSON.stringify({ currentVersion, blockedCoreRows, vendored })
    if (critical && write === true) {
      if (lastDiagnosis !== null && lastDiagnosis.key === key) {
        diagnosisPath = lastDiagnosis.path
      } else {
        const dir = join(home ?? dshHome(), 'plugin-console')
        mkdirSync(dir, { recursive: true })
        diagnosisPath = join(dir, `diagnosis-${now}.json`)
        writeFileSync(diagnosisPath, `${JSON.stringify({
          at: new Date(now).toISOString(), currentVersion, previousVersion,
          blockedCoreRows, vendoredCoreDeps: vendored, recovery, summary,
        }, null, 2)}\n`, 'utf8')
        lastDiagnosis = { key, path: diagnosisPath }
      }
    }
    return { ok: true, critical, currentVersion, previousVersion, blockedCoreRows, vendoredCoreDeps: vendored, recovery, diagnosisPath, summary }
  } catch (error) {
    return { ok: false, critical: false, error: error instanceof Error ? error.message : String(error), blockedCoreRows: [], vendoredCoreDeps: [], recovery: [] }
  }
}

/** 最新一份诊断文件（供 safe-boot --diagnosis 打印）。 */
function latestDiagnosis({ home = undefined } = {}) {
  try {
    const dir = join(home ?? dshHome(), 'plugin-console')
    const names = readdirSync(dir).filter((n) => /^diagnosis-.*\.json$/u.test(n)).sort().reverse()
    return names.length === 0 ? null : readJson(join(dir, names[0]))
  } catch { return null }
}

export { diagnoseFrameworkCoreRows, latestDiagnosis, vendoredCoreDeps }
