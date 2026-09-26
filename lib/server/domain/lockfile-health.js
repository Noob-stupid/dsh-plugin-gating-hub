// L1 · domain —— lockfile-health.js（live profile 的「依赖锁体检」与**用户显式触发**的 lock 重建）
//
// ── 为什么（2026-09-27，真问题，隔离环境已复现）────────────────────────────────
// web profile 的 `dsh plugin remove` / 任何一次 pnpm 全量解析都会失败，三条独立原因叠在一起：
//   ① 声明的依赖 `dsh-github-login@0.1.0` 在 registry.npmmirror.com 与 registry.npmjs.org **双双 404**
//      （`ERR_PNPM_FETCH_404`）——这是用户环境里"装不回来"的真因，**不能**靠改 lock 解决；
//   ② `pnpm-lock.yaml` 陈旧残缺：importers 里写着 0.5.4/0.5.13、manifest 写 0.5.14，7 个依赖里缺 4 个
//      （frozen-lockfile 下直接 `ERR_PNPM_OUTDATED_LOCKFILE`）；
//   ③ pnpm 的供应链闸 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`（新发版本不足 24h）。
//
// ── 安全边界（写死，不许越线）─────────────────────────────────────────────────
//   · 本模块**绝不**自动改用户 profile：体检（runLockfileCheck）纯只读；重建（runLockfileRepair）
//     必须由用户显式点/显式调用路由才会跑，且只跑 `pnpm install --lockfile-only`（只重写 lock，
//     不动 package.json、不动 node_modules）。
//   · **绝不**为了"让重建成功"而绕过供应链闸，也绝不静默丢弃依赖：
//     - 遇到 404 依赖 → **停下**，把包名如实列出来（`action: 'blocked'`），一个文件都不写；
//     - supply-chain-age → 只提示"可自行 `--config.minimumReleaseAge=0` 显式绕过（有安全代价）"。
//   · 命令参数由 `repairArgsFor()` 唯一产出（纯函数，单测直接断言 argv 里没有绕过开关）。
//
// 分层：本模块属于 L1 domain —— 不认识 cordis ctx，IO 一律以参数注入（便于离线单测）。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { probeRegistryPackage } from './dep-source.js'
import { classifyInstallFailure, hintForKind } from './install-diagnose.js'
import { buildPnpmEnv, runPnpmWithFallback } from '../infra/exec.js'
import { semverRangeMatch } from '../infra/semver.js'

const MANIFEST_NAME = 'package.json'
const LOCKFILE_NAME = 'pnpm-lock.yaml'
const DEFAULT_REGISTRY = 'https://registry.npmmirror.com'
/** 供应链闸的窗口：pnpm 的 minimumReleaseAge 默认 24h（本模块只用它做**只读判定**，不复制 pnpm 的策略）。 */
const RELEASE_AGE_HOURS = 24
const PROBE_TIMEOUT_MS = 8000
const REPAIR_TIMEOUT_MS = 180000
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies']

/** 重建 lock 的 argv（纯函数，唯一产出点）：只重写 lock，不碰 node_modules；
 *  `--no-frozen-lockfile` 是必需的（我们的 pnpm env 带 CI=true，pnpm 在 CI 下默认 frozen-lockfile，
 *  不加它就只会得到 `ERR_PNPM_OUTDATED_LOCKFILE` —— 正是要修的那个症状）。
 *  ⚠️ 这里**永远不会**出现 `--config.minimumReleaseAge=0` 这类绕过开关（临时 profile 真跑实测过）。 */
function repairArgsFor(registry) {
  const reg = typeof registry === 'string' && registry.trim() !== '' ? registry.trim() : DEFAULT_REGISTRY
  return ['install', '--lockfile-only', '--no-frozen-lockfile', '--registry', reg]
}

/** 读 profile 清单里的依赖声明（纯函数，容错）：返回 { ok, error, deps: [{ name, spec, section }] }。 */
function readManifestDeps(manifestText) {
  let pkg = null
  try {
    pkg = JSON.parse(typeof manifestText === 'string' ? manifestText : String(manifestText ?? ''))
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), deps: [] }
  }
  if (pkg === null || typeof pkg !== 'object') return { ok: false, error: 'package.json 不是对象', deps: [] }
  const deps = []
  for (const section of DEP_SECTIONS) {
    const block = pkg[section]
    if (block === null || typeof block !== 'object') continue
    for (const [name, spec] of Object.entries(block)) {
      if (typeof spec !== 'string') continue
      deps.push({ name, spec, section })
    }
  }
  return { ok: true, error: null, deps }
}

/** 解析 pnpm-lock.yaml 的 importers 段（纯函数，只认 pnpm v6/v9 的确定性形状）：
 * 返回 { present, parsed, importers: [{ name, specifier, version }] }。
 * 为什么只认形状而不是上 YAML 解析器：本仓库零依赖（不能为读一个字段引入 yaml 包），
 * 而 importers 段的缩进是 pnpm 写死的（section 4 空格、包名 6 空格、字段 8 空格）。 */
function parseLockImporters(lockText) {
  const text = typeof lockText === 'string' ? lockText : String(lockText ?? '')
  const lines = text.split(/\r?\n/u)
  const start = lines.findIndex((l) => /^importers:\s*$/u.test(l))
  if (start === -1) return { present: true, parsed: false, importers: [] }
  const importers = []
  let section = null
  let current = null
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^[A-Za-z]/u.test(line)) break // 下一个顶层段（packages: / settings:）
    const sectionMatch = /^\s{2,6}([A-Za-z]+):\s*$/u.exec(line)
    if (sectionMatch !== null && DEP_SECTIONS.includes(sectionMatch[1])) {
      section = sectionMatch[1]
      current = null
      continue
    }
    const keyMatch = /^\s{6,}(?:'([^']+)'|"([^"]+)"|([^\s:'"][^\s:]*)):\s*$/u.exec(line)
    if (keyMatch !== null && section !== null) {
      current = { name: keyMatch[1] ?? keyMatch[2] ?? keyMatch[3], specifier: null, version: null }
      importers.push(current)
      continue
    }
    if (current !== null) {
      const field = /^\s+(specifier|version):\s*(.+?)\s*$/u.exec(line)
      if (field !== null) {
        const value = field[2].replace(/^'|'$/gu, '')
        if (field[1] === 'specifier') current.specifier = value
        else current.version = value
        continue
      }
      if (/^\s{6,}\S/u.test(line)) current = null // 同一段里的下一个包
    }
  }
  return { present: true, parsed: importers.length > 0, importers }
}

/** 依赖是否满足 manifest 的 spec（纯函数，容错）：
 *  · 版本范围（^ ~ >= …）→ semver 匹配；
 *  · 精确版本 → 字符串相等；
 *  · 非 registry 来源（link:/file:/git+/http…）→ 交给 specifier 相等判定，这里恒 true。 */
function specSatisfiedBy(spec, version) {
  if (typeof spec !== 'string' || spec === '') return true
  if (/^(?:link|file|workspace|portal|npm|git\+|git:|github:|https?:)/iu.test(spec)) return true
  if (typeof version !== 'string' || version === '') return false
  if (/^[\^~]?\d/u.test(spec) || /^(?:>=|>|=|<=|<)\s*\d/u.test(spec)) return semverRangeMatch(version, spec)
  return version === spec
}

/**
 * 清单 vs lock vs 磁盘的三方对账（**纯函数**，体检结论的唯一来源）：
 *   · missing            —— manifest 里有、lock importer 里没有（陈旧残缺）；
 *   · specifierMismatch  —— lock 记的 specifier 与 manifest 现在的 spec 不一致（改过范围没重装）；
 *   · versionMismatch    —— lock 钉住的版本不满足 manifest 的 spec（如 manifest 0.5.14 / lock 0.5.4）；
 *   · drift              —— node_modules 里实际装的版本 != lock 钉住的版本（装了但没写进 lock）。
 * `installed` 由调用方读盘后传入（纯函数不做 IO）。 */
function diffLockfile({ manifestText, lockText, installed = {} } = {}) {
  const manifest = readManifestDeps(manifestText)
  const lock = lockText === null || lockText === undefined
    ? { present: false, parsed: false, importers: [] }
    : parseLockImporters(lockText)
  const byName = new Map(lock.importers.map((entry) => [entry.name, entry]))
  const deps = []
  const missing = []
  const specifierMismatch = []
  const versionMismatch = []
  const drift = []
  for (const dep of manifest.deps) {
    const locked = byName.get(dep.name) ?? null
    if (locked === null) {
      missing.push(dep.name)
      deps.push({ name: dep.name, spec: dep.spec, section: dep.section, lockSpecifier: null, lockVersion: null, state: 'missing' })
      continue
    }
    let state = 'ok'
    if (locked.specifier !== null && locked.specifier !== dep.spec) {
      specifierMismatch.push({ name: dep.name, spec: dep.spec, lockSpecifier: locked.specifier })
      state = 'specifier-mismatch'
    } else if (!specSatisfiedBy(dep.spec, locked.version)) {
      versionMismatch.push({ name: dep.name, spec: dep.spec, lockVersion: locked.version })
      state = 'version-mismatch'
    }
    const onDisk = installed[dep.name] ?? null
    if (onDisk !== null && locked.version !== null && onDisk !== locked.version) {
      drift.push({ name: dep.name, installed: onDisk, lockVersion: locked.version })
    }
    deps.push({ name: dep.name, spec: dep.spec, section: dep.section, lockSpecifier: locked.specifier, lockVersion: locked.version, state })
  }
  return {
    manifestOk: manifest.ok,
    manifestError: manifest.error,
    lockfilePresent: lock.present,
    lockfileParsed: lock.parsed,
    deps,
    missing,
    specifierMismatch,
    versionMismatch,
    drift,
    upToDate: manifest.ok && lock.present && lock.parsed
      && missing.length === 0 && specifierMismatch.length === 0 && versionMismatch.length === 0,
  }
}

/** registry 元数据里"刚发布不久"的版本（纯函数）：只看 dist-tags.latest 的发布时间。
 * 返回 [{ name, version, publishedAt, ageHours }]；镜像没给 `time` 时返回 []（调用方口径：不判定）。 */
function freshReleases(name, meta, { now = Date.now(), hours = RELEASE_AGE_HOURS } = {}) {
  const latest = meta !== null && typeof meta === 'object' && typeof meta['dist-tags']?.latest === 'string' ? meta['dist-tags'].latest : null
  const time = meta !== null && typeof meta === 'object' && meta.time !== null && typeof meta.time === 'object' ? meta.time : null
  if (latest === null || time === null || typeof time[latest] !== 'string') return []
  const at = Date.parse(time[latest])
  if (!Number.isFinite(at)) return []
  const ageHours = (now - at) / 3600000
  return ageHours >= 0 && ageHours < hours ? [{ name, version: latest, publishedAt: time[latest], ageHours: Math.round(ageHours * 10) / 10 }] : []
}

/** registry 探测结论 → 分类（纯函数）：能从 tried 文本里认出 404 就点名 404，否则算"不可达"。 */
function probeVerdict(probe) {
  const tried = Array.isArray(probe?.tried) ? probe.tried.join(' | ') : ''
  if (/HTTP 404|Not Found|E404|is not in the npm registry/iu.test(tried)) return 'fetch-404'
  return 'network-timeout'
}

/** manifest 的 spec 里能确定"就是这一个版本"时取出来（用于探测"这个版本在不在 registry 上"）。 */
function exactVersionOf(spec) {
  const m = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(String(spec ?? '').trim())
  return m === null ? null : m[1]
}

/** 一句话总结（短句，面板用）。 */
function summarizeCheck(view) {
  if (view.ok) return '依赖锁与清单一致，无需处理。'
  const kinds = [...new Set(view.problems.map((p) => p.kind))]
  const named = view.problems.flatMap((p) => p.packages).slice(0, 4)
  return `发现 ${view.problems.length} 类问题（${kinds.join('、')}）${named.length === 0 ? '' : `：${named.join('、')}`}`
}

/**
 * 只读体检（**不写任何文件**）。
 * IO 全部注入：probe（registry 探测，默认 probeRegistryPackage）、readFile、exists。
 * 返回体检视图（HTTP 响应体同款）：
 *   { ok, checkedAt, profileDir, registry, manifestDeps, lockfile, problems, packages404,
 *     outdated, supplyChainAge, repair, hint }
 */
async function runLockfileCheck({
  profileDir,
  registries = [],
  probe = probeRegistryPackage,
  readFile = (p) => readFileSync(p, 'utf8'),
  exists = existsSync,
  now = Date.now(),
  releaseAgeHours = RELEASE_AGE_HOURS,
} = {}) {
  const regList = (Array.isArray(registries) ? registries : []).filter((r) => typeof r === 'string' && r.trim() !== '')
  const probeList = regList.length > 0 ? regList : [DEFAULT_REGISTRY]
  const registry = probeList[0]
  const dir = typeof profileDir === 'string' && profileDir !== '' ? profileDir : null
  const read = (name) => {
    if (dir === null) return null
    const file = join(dir, name)
    try {
      return exists(file) ? readFile(file) : null
    } catch {
      return null
    }
  }
  const manifestText = read(MANIFEST_NAME)
  const lockText = read(LOCKFILE_NAME)
  const installed = {}
  if (dir !== null) {
    for (const dep of readManifestDeps(manifestText ?? '').deps) {
      const text = read(join('node_modules', ...dep.name.split('/'), MANIFEST_NAME))
      if (text === null) continue
      try {
        const version = JSON.parse(text)?.version
        if (typeof version === 'string') installed[dep.name] = version
      } catch {}
    }
  }
  const diff = diffLockfile({ manifestText: manifestText ?? '', lockText, installed })
  const manifest = readManifestDeps(manifestText ?? '')

  // ① 依赖能不能在 registry 上解析（404 要点名；不可达与 404 分开说）
  const probes = await Promise.all((manifest.ok ? manifest.deps : []).map(async (dep) => {
    const result = await probe(dep.name, probeList, {
      version: exactVersionOf(dep.spec),
      timeoutMs: PROBE_TIMEOUT_MS,
      includeMeta: true,
    }).catch((error) => ({ resolvable: false, hasVersion: false, latest: null, registry: null, tried: [String(error?.message ?? error)] }))
    return { dep, result }
  }))
  const missing404 = []
  const missingVersion = []
  const unreachable = []
  const supplyChainAge = []
  for (const { dep, result } of probes) {
    if (result.resolvable !== true) {
      if (probeVerdict(result) === 'fetch-404') missing404.push(dep.name)
      else unreachable.push(dep.name)
      continue
    }
    if (result.hasVersion === false) missingVersion.push(`${dep.name}@${exactVersionOf(dep.spec) ?? '?'}`)
    supplyChainAge.push(...freshReleases(dep.name, result.meta, { now, hours: releaseAgeHours }))
  }

  const problems = []
  const name404 = [...missing404, ...missingVersion]
  if (name404.length > 0) {
    problems.push({ kind: 'fetch-404', hint: hintForKind('fetch-404', name404), packages: name404, note: 'registry 上解析不到这些依赖：修 lock 解决不了，必须先核对包名/版本或换源。' })
  }
  if (unreachable.length > 0) {
    problems.push({
      kind: 'network-timeout',
      hint: '有依赖没能探测成功（registry 不可达或超时）：先确认网络/镜像，再体检一次；本次不重建 lock。',
      packages: unreachable,
      note: null,
    })
  }
  if (!diff.upToDate || diff.drift.length > 0) {
    const names = [...new Set([...diff.missing, ...diff.specifierMismatch.map((x) => x.name), ...diff.versionMismatch.map((x) => x.name)])]
    problems.push({
      kind: 'lockfile-outdated',
      hint: hintForKind('lockfile-outdated', names),
      packages: names,
      note: diff.lockfilePresent
        ? `lock 与清单对不上：缺 ${diff.missing.length} 项、specifier 漂移 ${diff.specifierMismatch.length} 项、版本不满足 ${diff.versionMismatch.length} 项`
        : 'pnpm-lock.yaml 不存在（任何 pnpm 全量解析都会重建它）',
    })
  }
  if (supplyChainAge.length > 0) {
    problems.push({
      kind: 'supply-chain-age',
      hint: hintForKind('supply-chain-age', supplyChainAge.map((x) => `${x.name}@${x.version}`)),
      packages: supplyChainAge.map((x) => `${x.name}@${x.version}（${x.ageHours}h）`),
      note: '只提示：重建 lock 时 pnpm 的 minimumReleaseAge 闸可能拦下这些"刚发布"的版本。',
    })
  }
  const blockedBy = problems.filter((p) => p.kind === 'fetch-404' || p.kind === 'network-timeout').map((p) => p.kind)
  const fixable = problems.some((p) => p.kind === 'lockfile-outdated')
  const view = {
    ok: problems.length === 0,
    checkedAt: now,
    profileDir: dir,
    registry,
    manifestDeps: manifest.deps.length,
    lockfile: { present: diff.lockfilePresent, parsed: diff.lockfileParsed, entries: diff.deps.filter((d) => d.lockVersion !== null).length },
    problems,
    packages404: name404,
    outdated: {
      lockfileMissing: !diff.lockfilePresent,
      missing: diff.missing,
      specifierMismatch: diff.specifierMismatch,
      versionMismatch: diff.versionMismatch,
      drift: diff.drift,
    },
    supplyChainAge,
    repair: {
      applicable: fixable && blockedBy.length === 0,
      blockedBy,
      command: repairArgsFor(registry).join(' '),
    },
    hint: null,
  }
  view.hint = summarizeCheck(view)
  return view
}

/** 体检视图 → 短句清单（面板只放短句；长文本走 hint/note）。 */
function problemLines(view) {
  return (view?.problems ?? []).map((p) => ({ kind: p.kind, text: p.hint, packages: p.packages ?? [] }))
}

/**
 * **用户显式触发**的 lock 重建（本模块唯一会写文件的地方，而且只让 pnpm 写 pnpm-lock.yaml）：
 *   ① 先只读体检；发现 404 / 探测不到 → `action: 'blocked'`，**一个文件都不写**，如实列出包名；
 *   ② 否则跑 `pnpm install --lockfile-only --no-frozen-lockfile --registry <主源>`（argv 由 repairArgsFor 唯一产出）；
 *   ③ 复检：lock 与清单一致才算成功（不谎报），否则 `action: 'partial'` 并留下剩余问题；
 *   ④ pnpm 报错时按 install-diagnose 的分类如实回报（supply-chain-age 只给"可自行显式绕过"的提示）。
 * 返回 { ok, action, kind, hint, packages, before, after, command, stderrTail, ... }。
 */
async function runLockfileRepair({
  profileDir,
  registries = [],
  check = runLockfileCheck,
  runPnpm = runPnpmWithFallback,
  now = Date.now(),
  deps = {},
} = {}) {
  const registry = (Array.isArray(registries) ? registries : []).find((r) => typeof r === 'string' && r.trim() !== '') ?? DEFAULT_REGISTRY
  const args = repairArgsFor(registry)
  const base = { checkedAt: now, profileDir: profileDir ?? null, registry, command: args.join(' '), packages: [], stderrTail: null }
  const before = await check({ profileDir, registries, now, ...(deps ?? {}) })
  base.before = before.outdated
  const notFound = before.problems.find((p) => p.kind === 'fetch-404') ?? null
  if (notFound !== null) {
    return {
      ...base,
      ok: false,
      action: 'blocked',
      kind: 'fetch-404',
      hint: notFound.hint,
      packages: notFound.packages,
      after: before.outdated,
      reason: '有依赖在 registry 上解析不到：重建 lock 必然失败，而且"跳过它"等于静默丢弃你的依赖 —— 已停下，未改任何文件。',
    }
  }
  const unreachable = before.problems.find((p) => p.kind === 'network-timeout') ?? null
  if (unreachable !== null) {
    return { ...base, ok: false, action: 'blocked', kind: 'network-timeout', hint: unreachable.hint, packages: unreachable.packages, after: before.outdated, reason: 'registry 探测未全部成功：先解决网络/镜像再重建 lock。' }
  }
  if (before.repair.applicable !== true) {
    return { ...base, ok: true, action: 'noop', kind: null, hint: before.hint, after: before.outdated, reason: '体检未发现需要重建的 lock 问题。' }
  }
  try {
    await runPnpm(args, { execOpts: { cwd: profileDir, timeout: REPAIR_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: buildPnpmEnv(registry) } })
  } catch (error) {
    const diagnosis = classifyInstallFailure(error?.message)
    return {
      ...base,
      ok: false,
      action: 'failed',
      kind: diagnosis.kind,
      hint: diagnosis.hint,
      packages: diagnosis.packages,
      after: before.outdated,
      stderrTail: String(error?.message ?? error).slice(-600),
      reason: 'pnpm 重建 lock 失败（原因见分类与原始输出）——未动 package.json / node_modules。',
    }
  }
  const after = await check({ profileDir, registries, now: Date.now(), ...(deps ?? {}) })
  const remaining = after.problems.filter((p) => p.kind === 'lockfile-outdated')
  const repaired = after.outdated.missing.length === 0 && after.outdated.versionMismatch.length === 0 && after.outdated.specifierMismatch.length === 0 && after.lockfile.present
  return {
    ...base,
    ok: repaired,
    action: repaired ? 'repaired' : 'partial',
    kind: repaired ? null : 'lockfile-outdated',
    hint: repaired ? 'lock 已按清单重建（pnpm install --lockfile-only）。' : (remaining[0]?.hint ?? after.hint),
    packages: repaired ? [] : [...new Set(remaining.flatMap((p) => p.packages))],
    after: after.outdated,
    reason: repaired ? '只重写了 pnpm-lock.yaml；package.json 与 node_modules 未改动。' : '重建后 lock 与清单仍有差距（详见 after）。',
  }
}

export {
  DEFAULT_REGISTRY,
  LOCKFILE_NAME,
  MANIFEST_NAME,
  RELEASE_AGE_HOURS,
  REPAIR_TIMEOUT_MS,
  DEP_SECTIONS,
  diffLockfile,
  exactVersionOf,
  freshReleases,
  parseLockImporters,
  problemLines,
  probeVerdict,
  readManifestDeps,
  repairArgsFor,
  runLockfileCheck,
  runLockfileRepair,
  specSatisfiedBy,
  summarizeCheck,
}
