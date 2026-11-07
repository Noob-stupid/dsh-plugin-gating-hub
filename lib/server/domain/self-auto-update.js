// L1 · domain —— self-auto-update.js（控制台**只更新它自己**的自动更新：配置 + 检查 + 覆盖式安装 + 退避 + 调度）
//
// ── 用户原话（2026-11-04）────────────────────────────────────────────────────────────
//   「我的意思是，自更新我们的插件本身」「然后弄功能包一个按钮，[自更新]，默认打开」。
//   范围**严格限定**在 `@noob-stupid/dsh-plugin-console` 自己：任何别的插件都绝不自动更新。
//
// ── 本模块做什么（一切"装"的动作都复用既有实现，这里只做编排）─────────────────────────────
//   ① 配置持久化 `~/.dsh/plugin-console/auto-update.json`：`{ enabled, intervalHours, lastCheckAt, lastResult }`，
//      `enabled` 默认 **true**；写盘走"临时文件 + rename"（原子）；读坏文件**降级为默认值并且绝不覆盖用户文件**。
//   ② `checkAndUpdate()`：纯编排 —— 关掉 ⇒ 不动；有安装作业 / 拿不到锁 ⇒ 不动；框架升级中 ⇒ 不动；
//      远端**严格高于**本地才装；装走 `install-self-overlay.js`（下载 tarball → 只覆盖不清空 → 读回核对版本）；
//      备份 / 失败自愈 / manualCommand 走 `self-update-guard.js`（唯一实现）。**全程不调用 pnpm**，
//      也**绝不重启服务**（宿主不能安全地重启自己）—— 结果里写明"重启后生效"。
//   ③ 失败退避：同一目标版本失败过一次，6 小时内不再重试（防无限循环刷日志）；成功后清空。
//   ④ 进程内定时器：启动后延迟约 2 分钟首检，之后每 `intervalHours` 一次；**单飞**（上一轮没跑完不叠下一轮）；
//      定时器一律 `unref()`，绝不阻塞进程退出。
//
// ── 硬规矩（改代码时别越线）────────────────────────────────────────────────────────
//   ① **只对自己生效**：目标包名恒等于 `selfPackageNameOf()`；调用方就算点名别的包，也只会拿到
//      `skipped:'not-self'` 的如实拒绝（`tests/test-self-auto-update.mjs` ⑨ 钉住：放宽成任意包必须变红）。
//   ② **零 pnpm**：装包只走覆盖式（`runSelfOverlayInstall`）；本文件里不出现任何包管理器调用
//      （⑨ 的变异断言：把 pnpm 加回来必须变红 —— 运行期有 exec 记录桩，静态还有源码扫描）。
//   ③ 绝不因为自动更新失败而影响宿主：调度里每一步都 catch 成**一条如实记录**，路由层也只回结果。
//   ④ 不谎报：`updated:true` 只在"读回的版本 === 目标版本"时成立；探测不到、不可比、装失败都如实说。
//   ⑤ domain 层不认识 cordis（分层断言），profileDir / 作业表这类宿主信息一律由调用方注入。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { compareSemverText, parseSemverText } from '../infra/semver.js'
import { dshHome, pluginRoot } from '../infra/paths.js'
import { probeRegistryPackage } from './dep-source.js'
import { preferredRegistries } from './sources.js'
import { installLockHolder, withInstallLockOr } from './install-lock.js'
import { runSelfOverlayInstall } from './install-self-overlay.js'
import { beginSelfUpdateGuard, isSelfUpdate, selfPackageNameOf, settleSelfUpdateGuard } from './self-update-guard.js'
import { readInstalledVersion } from './selfupdate-read.js'

/** 配置文件（与其它控制台状态文件同目录：`<DSH_HOME>/plugin-console/`）。 */
const CONFIG_FILE = 'auto-update.json'
/** 默认检查间隔（小时）。用户没改过就是这个值。 */
const DEFAULT_INTERVAL_HOURS = 6
/** 首检延迟：**启动后约 2 分钟**（先把宿主自己的启动活干完，再谈更新）。 */
const DEFAULT_FIRST_DELAY_MS = 2 * 60 * 1000
/** 失败退避窗口：同一目标版本 6 小时内不重试。 */
const RETRY_BACKOFF_MS = 6 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
/** 框架升级状态文件的"仍在进行中"窗口 —— 与 `/framework-upgrade-status` 的 15 分钟残留清理同一口径。 */
const FW_STATE_STALE_MS = 15 * 60 * 1000
/** 框架升级的终止状态（与 routes/framework.js#routeFrameworkUpgradeStatusGet 同一批；那边贴着 600 行
 *  棘轮、import 不出来，本文件只在**窗口判定**上复述这份名单，取值口径逐字相同）。 */
const FW_TERMINAL_STATUS = new Set(['idle', 'done', 'failed', 'ready'])

const label = (error) => (error instanceof Error ? error.message : String(error))
const nowOf = (deps = {}) => (typeof deps.now === 'function' ? Number(deps.now()) : Date.now())

// ── ① 配置：路径 / 默认值 / 归一化 / 原子读 / 原子写 ────────────────────────────────────
function autoUpdateConfigPath(home = undefined) {
  return join(home ?? dshHome(), 'plugin-console', CONFIG_FILE)
}

/** 默认配置（`enabled: true` —— 用户要的"默认打开"）。 */
function defaultAutoUpdateConfig() {
  return { enabled: true, intervalHours: DEFAULT_INTERVAL_HOURS, lastCheckAt: null, lastResult: null }
}

/** 把磁盘上的原始对象归一成合法配置：不合法的项按默认值、并逐项记下"哪里说不过去"。 */
function normalizeAutoUpdateConfig(raw) {
  const base = defaultAutoUpdateConfig()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { config: base, problems: ['顶层不是对象'] }
  const problems = []
  const out = { ...base }
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  else if (raw.enabled !== undefined) problems.push('enabled 不是布尔值')
  if (Number.isFinite(Number(raw.intervalHours)) && Number(raw.intervalHours) > 0) {
    out.intervalHours = Math.min(168, Math.max(1, Number(raw.intervalHours)))
  } else if (raw.intervalHours !== undefined) problems.push('intervalHours 不是正数')
  if (Number.isFinite(Number(raw.lastCheckAt)) && Number(raw.lastCheckAt) > 0) out.lastCheckAt = Number(raw.lastCheckAt)
  else if (raw.lastCheckAt !== undefined && raw.lastCheckAt !== null) problems.push('lastCheckAt 不是时间戳')
  if (raw.lastResult !== null && raw.lastResult !== undefined) {
    if (typeof raw.lastResult === 'object' && raw.lastResult !== null && !Array.isArray(raw.lastResult)) out.lastResult = raw.lastResult
    else problems.push('lastResult 不是对象')
  }
  return { config: out, problems }
}

/**
 * 读配置。**只读**：读坏/形状不对 ⇒ 回默认值 + 一条如实 note，**绝不在这一步写盘**
 * （用户的文件不能被"读一下就改掉"，规矩见本文件头 ①）。
 * 返回 `{ config, file, present, corrupt, note }`。
 */
function readAutoUpdateConfig({ home = undefined, deps = {} } = {}) {
  const dir = home ?? deps.home
  const file = autoUpdateConfigPath(dir)
  const read = typeof deps.readFile === 'function' ? deps.readFile : readFileSync
  const exists = typeof deps.exists === 'function' ? deps.exists : existsSync
  if (exists(file) !== true) return { config: defaultAutoUpdateConfig(), file, present: false, corrupt: false, note: null }
  let raw = null
  try {
    raw = JSON.parse(read(file, 'utf8'))
  } catch (error) {
    return {
      config: defaultAutoUpdateConfig(), file, present: true, corrupt: true,
      note: `自动更新配置读不出来（${file}）：${label(error)} —— 本次按默认值（开启、每 ${DEFAULT_INTERVAL_HOURS} 小时）继续，**没有覆盖你的文件**`,
    }
  }
  const { config, problems } = normalizeAutoUpdateConfig(raw)
  if (problems.length === 0) return { config, file, present: true, corrupt: false, note: null }
  return {
    config, file, present: true, corrupt: true,
    note: `自动更新配置有 ${problems.length} 处说不过去（${problems.join('；')}，文件 ${file}）—— 这几项按默认值处理，**没有覆盖你的文件**`,
  }
}

/**
 * 写配置（**原子**：临时文件 + rename；失败只回 note，绝不抛）。
 * 只覆盖调用方点名的字段，其余沿用磁盘上的现值（读坏了就按默认值）。
 * `patch.lastResult === null` 表示**清空**该字段；`undefined` 表示不动它。
 */
function writeAutoUpdateConfig(patch = {}, { home = undefined, deps = {} } = {}) {
  const dir = home ?? deps.home
  const file = autoUpdateConfigPath(dir)
  const read = readAutoUpdateConfig({ home: dir, deps })
  const next = { ...read.config }
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
  if (Number.isFinite(Number(patch.intervalHours)) && Number(patch.intervalHours) > 0) {
    next.intervalHours = Math.min(168, Math.max(1, Number(patch.intervalHours)))
  }
  if (Number.isFinite(Number(patch.lastCheckAt)) && Number(patch.lastCheckAt) > 0) next.lastCheckAt = Number(patch.lastCheckAt)
  if (patch.lastResult !== undefined) next.lastResult = patch.lastResult
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  let keepNote = null
  // 磁盘上那份**读不出来**时，先把原件改名留档再写 —— 用户的内容一个字都不丢（规矩见 readAutoUpdateConfig）：
  // 换个名字放着，并如实写进 note（`auto-update.json.corrupt-<时间戳>`）。
  if (read.corrupt === true && read.present === true) {
    const kept = `${file}.corrupt-${String(nowOf(deps)).padStart(13, '0')}`
    try {
      renameSync(file, kept)
      keepNote = `原来那份读不出来的配置已改名保留为 ${kept}（没有删除）`
    } catch (error) {
      keepNote = `原来那份读不出来的配置没能改名保留（${label(error)}）`
    }
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(tmp, file) // 同目录 rename：要么旧文件、要么新文件，不会读到写了一半的 JSON
    return { ok: true, config: next, file, note: [read.note, keepNote].filter((x) => typeof x === 'string' && x !== '').join('；') || null }
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch {}
    return { ok: false, config: next, file, note: `写自动更新配置失败（${file}）：${label(error)}` }
  }
}

// ── ② 忙判据（都是既有实现的复用，不自己猜状态）───────────────────────────────────────
/** 正在运行的这一份包根的版本（profile 里读不到时用它兜底；读不到返回 null）。 */
function runningVersionOf(deps = {}) {
  const read = typeof deps.readFile === 'function' ? deps.readFile : readFileSync
  try {
    const pkg = JSON.parse(read(join(pluginRoot(), 'package.json'), 'utf8'))
    return typeof pkg?.version === 'string' && pkg.version !== '' ? pkg.version : null
  } catch { return null }
}

/** 框架升级状态（`<DSH_HOME>/plugin-console/fw-upgrade-state.txt`，格式 `status|message`）。 */
function readFrameworkUpgradeStatus({ home = undefined, deps = {} } = {}) {
  const file = join(home ?? deps.home ?? dshHome(), 'plugin-console', 'fw-upgrade-state.txt')
  const exists = typeof deps.exists === 'function' ? deps.exists : existsSync
  if (exists(file) !== true) return null
  let raw = ''
  try { raw = String((typeof deps.readFile === 'function' ? deps.readFile : readFileSync)(file, 'utf8')) } catch { return null }
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1) // PS5.1 Set-Content -Encoding UTF8 会写 BOM
  const head = String(raw.split('|')[0] ?? '').trim()
  let at = null
  try { at = statSync(file).mtimeMs } catch { at = null }
  return { status: head === '' ? 'idle' : head, at }
}

/**
 * 框架升级是否**正在进行中**（是 ⇒ 返回 `{ status, ageMs }`，否则 null）。
 * 判据与 `/framework-upgrade-status` 同口径：非终止状态 + 状态文件在 15 分钟窗口内。
 * 为什么要窗口：那条路由把"非终止状态但超过 15 分钟没动静"判为上次升级的残留并自愈成 idle，
 * 这里如果照旧当"在升级"，自动更新会被一份陈旧记录永久挡住。
 */
function frameworkUpgradeBusy({ home = undefined, deps = {} } = {}) {
  const state = readFrameworkUpgradeStatus({ home, deps })
  if (state === null) return null
  if (FW_TERMINAL_STATUS.has(state.status) === true) return null
  if (state.at === null) return { status: state.status, ageMs: null }
  const ageMs = nowOf(deps) - state.at
  if (ageMs > FW_STATE_STALE_MS) return null
  return { status: state.status, ageMs }
}

/** 有安装作业在跑？宿主侧能注入 `deps.installBusy`（内存作业表最准）；没注入就只看**包锁**。 */
function installBusyOf({ profileDir = '', packageName = '', deps = {} } = {}) {
  if (typeof deps.installBusy === 'function') {
    let verdict = null
    try { verdict = deps.installBusy() } catch (error) { return `安装作业表读不出来：${label(error)}` }
    if (typeof verdict === 'string' && verdict !== '') return verdict
    if (verdict !== null && verdict !== undefined && verdict !== false) return '有安装作业正在跑'
  }
  const holder = installLockHolder(profileDir, packageName)
  if (holder === null) return null
  return `这个包正在安装中（另一个作业 ${holder.jobId ?? '未命名'} 从 ${holder.since ?? '?'} 起占着锁）`
}

/** 远端是否**严格高于**本地：`1` 是、`0/-1` 否、`null` = 版本号不可比（不敢动）。 */
function compareVersions(remote, local) {
  const a = parseSemverText(remote)
  const b = parseSemverText(local)
  if (a === null || b === null) return null
  return compareSemverText(a, b)
}

// ── ③ 一次检查 + 一次安装（编排；装/备份/自愈全是既有实现）──────────────────────────────
/**
 * 在**包锁**里做一次真实的覆盖式安装（拿不到锁 ⇒ 什么都不做）。
 * 返回 `{ ok, reason, version, backedUp, healed, manualCommand, overlay, entry }`。
 */
async function attemptOverlayUpdate({ target, latest, profileDir, registries, deps = {} } = {}) {
  const overlay = typeof deps.runOverlay === 'function' ? deps.runOverlay : runSelfOverlayInstall
  const beginGuard = typeof deps.beginGuard === 'function' ? deps.beginGuard : beginSelfUpdateGuard
  const settleGuard = typeof deps.settleGuard === 'function' ? deps.settleGuard : settleSelfUpdateGuard
  const out = { ok: false, reason: null, version: null, backedUp: false, healed: false, manualCommand: null, overlay: null }
  const locked = await withInstallLockOr(
    { profileDir, packageName: target, waitMs: 0 }, // waitMs=0：有人占着就立刻放弃，绝不排队等
    async () => {
      // 更新前备份 + "磁盘上本来就有可解析的自身副本"这道闸都在 beginSelfUpdateGuard 里（规矩② 的既有实现）
      const session = beginGuard({ packageName: target, profileDir, targetVersion: latest, deps })
      if (session === null) {
        return { noSession: true }
      }
      out.backedUp = session.backedUp === true
      // 点名目标版本 ⇒ 覆盖式安装自己会跳过 registry 探测，并按"读回版本 === 目标版本"核对（既有实现）
      const overlayResult = await overlay({
        job: { packageName: target, version: latest },
        packageName: target, profileDir, registries, deps,
      })
      out.overlay = overlayResult
      out.version = overlayResult?.version ?? null
      out.ok = overlayResult?.ok === true && out.version === latest
      // 收尾（**无论成败都跑**）：校验 → 不过就改名挪开 + 从备份恢复 + 同一判据复核 → 产出 manualCommand。
      // 期望版本只在"这次真装上了"时才要求是 latest；装失败时期望值置空 =
      // "目录里得仍是一份完整的自身副本"，坏了才自愈 —— 否则每失败一次就把好目录改名成 .broken-。
      const settled = settleGuard(session, { targetVersion: out.ok === true ? latest : null, landed: out.ok === true, deps })
      out.healed = settled?.healed === true
      out.manualCommand = settled?.manualCommand ?? null
      if (out.ok !== true) {
        const parts = [overlayResult?.reason ?? '覆盖式安装没有成功']
        if (settled?.healed === true) parts.push(`已从更新前的备份恢复成 v${settled.restoredVersion ?? '?'}（本次更新**没有生效**）`)
        else if (settled?.verified === true) parts.push(`磁盘上仍是完整的一份旧副本（v${settled.restoredVersion ?? '?'}），没有动它`)
        else parts.push(`校验也没过：${settled?.reason ?? '原因未知'}`)
        out.reason = parts.join('；')
      } else {
        out.reason = null
      }
      return { done: true }
    },
    (error) => ({ lockTimeout: true, error }),
  )
  if (locked?.lockTimeout === true) {
    return { ...out, ok: false, busy: true, reason: `拿不到安装锁（${label(locked.error)}）—— 本轮不做自更新` }
  }
  if (locked?.noSession === true) {
    return {
      ...out, ok: false, noSession: true,
      reason: `磁盘上没有可解析的自身副本（${join(profileDir, 'node_modules', ...String(target).split('/'))}）—— `
        + '自动更新不接管首次安装 / 链接安装；需要时请用卡片上的「更新」按钮',
    }
  }
  return out
}

/**
 * **一次检查（必要时安装）** —— 本模块的唯一编排入口。
 * 返回 `{ checked, from, to, updated, reason, skipped? }`（另附 ok/at/version/backedUp/healed/manualCommand/
 * packageName/channel/configNote 等如实字段，只增不删）。
 * `targetPackage` 只用于**拒绝**：不是本插件自己的包名一律 `skipped:'not-self'`（规矩 ①）。
 */
async function checkAndUpdate({ deps = {}, profileDir = null, targetPackage = null } = {}) {
  const io = deps
  const at = nowOf(io)
  const selfName = selfPackageNameOf(io)
  const dir = typeof profileDir === 'string' && profileDir !== ''
    ? profileDir
    : (typeof io.profileDir === 'string' ? io.profileDir : '')
  const out = {
    checked: false, from: null, to: null, updated: false, reason: null, skipped: null,
    ok: false, at, version: null, channel: null, packageName: null,
    backedUp: false, healed: false, manualCommand: null, configNote: null,
  }
  const target = typeof targetPackage === 'string' && targetPackage !== '' ? targetPackage : selfName
  out.packageName = target
  if (isSelfUpdate(target, io) !== true) {
    out.skipped = 'not-self'
    out.reason = `自动更新只对控制台自己生效（${target} 不是 ${selfName}），已拒绝`
    return out
  }
  const read = readAutoUpdateConfig({ deps: io })
  out.configNote = read.note
  const config = read.config
  out.from = readInstalledVersion(dir, target) ?? runningVersionOf(io)
  if (config.enabled !== true) {
    out.skipped = 'disabled'
    out.reason = '自动更新已关闭（功能包 → [自更新] 开关）'
    return out
  }
  // ② 忙判据：有安装作业 / 包锁被占 ⇒ 本轮零动作（连 registry 都不打）
  const installBusy = installBusyOf({ profileDir: dir, packageName: target, deps: io })
  if (installBusy !== null) {
    out.skipped = 'busy'
    out.reason = `${installBusy} —— 本轮不做自更新`
    return out
  }
  // ③ 框架升级进行中 ⇒ 本轮零动作（框架正在换整棵树，这时候动插件目录毫无意义）
  const fwBusy = typeof io.frameworkUpgradeBusy === 'function' ? io.frameworkUpgradeBusy() : frameworkUpgradeBusy({ deps: io })
  if (fwBusy !== null && fwBusy !== undefined && fwBusy !== false) {
    out.skipped = 'framework-upgrade'
    out.reason = `框架升级进行中（状态 ${typeof fwBusy === 'object' ? (fwBusy.status ?? '?') : String(fwBusy)}）—— 本轮不做自更新`
    return out
  }
  // ④ 查远端版本（复用既有探针 probeRegistryPackage：与 install-self-overlay 同一个口径）
  const registries = Array.isArray(io.registries) ? io.registries : preferredRegistries()
  const probe = typeof io.probeRegistry === 'function' ? io.probeRegistry : probeRegistryPackage
  out.checked = true
  let latest = null
  try {
    const found = await probe(target, registries, { fetchJson: io.fetchJson, timeoutMs: io.metaTimeoutMs })
    latest = typeof found?.latest === 'string' && found.latest !== '' ? found.latest : null
    if (found?.resolvable !== true || latest === null) {
      const tried = Array.isArray(found?.tried) && found.tried.length > 0 ? `（${found.tried.join('；')}）` : ''
      out.reason = `探测不到 ${target} 的最新版本${tried}`
      return persistResult(out, { deps: io })
    }
  } catch (error) {
    out.reason = `探测最新版本失败：${label(error)}`
    return persistResult(out, { deps: io })
  }
  out.to = latest
  // ⑤ 只在远端**严格更高**时才装（相等 / 更低 / 不可比 ⇒ 不装）
  const cmp = compareVersions(latest, out.from)
  if (cmp === null) {
    out.reason = `版本号不可比（本地 ${out.from ?? '读不到'}，远端 ${latest}）—— 不敢自动更新`
    return persistResult(out, { deps: io })
  }
  if (cmp <= 0) {
    out.skipped = 'up-to-date'
    out.ok = true
    out.reason = `已是最新（本地 ${out.from}，远端 ${latest}）`
    return persistResult(out, { deps: io, lastResult: { failedVersion: null, failedAt: null } })
  }
  // ⑥ 失败退避：同一个目标版本在 6 小时窗口内失败过 ⇒ 不重试（防无限循环刷日志）
  const last = config.lastResult !== null && typeof config.lastResult === 'object' ? config.lastResult : null
  const failedVersion = last !== null && typeof last.failedVersion === 'string' ? last.failedVersion : null
  const failedAt = last !== null && Number.isFinite(Number(last.failedAt)) ? Number(last.failedAt) : null
  if (failedVersion !== null && failedVersion === latest && failedAt !== null && at - failedAt < RETRY_BACKOFF_MS) {
    const minutes = Math.max(1, Math.round((RETRY_BACKOFF_MS - (at - failedAt)) / 60000))
    out.skipped = 'backoff'
    out.ok = true
    out.reason = `${latest} 这个版本上次装失败了，${Math.round(RETRY_BACKOFF_MS / HOUR_MS)} 小时冷却中（还要等约 ${minutes} 分钟）`
    return persistResult(out, { deps: io })
  }
  // ⑦ 真装（覆盖式，零 pnpm）
  out.channel = 'manual-overlay'
  const attempt = await attemptOverlayUpdate({ target, latest, profileDir: dir, registries, deps: io })
  out.backedUp = attempt.backedUp === true
  out.healed = attempt.healed === true
  out.manualCommand = attempt.manualCommand ?? null
  out.version = attempt.version ?? null
  out.ok = attempt.ok === true
  out.updated = attempt.ok === true
  out.reason = attempt.ok === true
    ? `已用覆盖式安装升到 v${latest}（只覆盖、没有清空目录，全程没有调用包管理器）—— **重启服务后生效**`
    : (attempt.reason ?? '覆盖式安装没有成功')
  if (attempt.ok !== true && attempt.manualCommand !== null) out.reason += `；要手动处理可直接复制运行：${attempt.manualCommand}`
  return persistResult(out, { deps: io })
}

/**
 * 把本轮结论落盘（`lastCheckAt` + `lastResult`）。写盘失败只并入 note，绝不抛。
 * `failedVersion/failedAt`：装失败时记下（退避要用）；成功时清空；"没装"的轮次沿用上一轮（不能把退避弄丢）。
 * 只有真的**查过**（`checked === true`）才写盘 —— 关闭 / 忙 / 框架升级中的轮次零写盘。
 */
function persistResult(out, { deps = {}, lastResult = null } = {}) {
  if (out.checked !== true) return out
  const previous = readAutoUpdateConfig({ deps }).config.lastResult
  const prevFailedVersion = previous !== null && typeof previous === 'object' && typeof previous.failedVersion === 'string' ? previous.failedVersion : null
  const prevFailedAt = previous !== null && typeof previous === 'object' && Number.isFinite(Number(previous.failedAt)) ? Number(previous.failedAt) : null
  const installed = out.updated === true
  const attempted = out.channel !== null
  const next = {
    at: out.at,
    ok: out.ok === true,
    updated: out.updated === true,
    from: out.from ?? null,
    to: out.to ?? null,
    version: out.version ?? null,
    skipped: out.skipped ?? null,
    reason: out.reason ?? null,
    channel: out.channel ?? null,
    failedVersion: installed ? null : (attempted === true ? (out.to ?? null) : (lastResult?.failedVersion ?? prevFailedVersion)),
    failedAt: installed ? null : (attempted === true ? out.at : (lastResult?.failedAt ?? prevFailedAt)),
  }
  const written = writeAutoUpdateConfig({ lastCheckAt: out.at, lastResult: next }, { deps })
  // 写盘那边可能有话要说（比如"读不出来的原件已改名留档"）—— 如实并进 configNote，绝不错过
  if (typeof written.note === 'string' && written.note !== '') {
    out.configNote = [out.configNote, written.note].filter((x) => typeof x === 'string' && x !== '').join('；')
  }
  if (written.ok !== true) out.reason = `${out.reason ?? ''}${out.reason === null ? '' : '；'}${written.note ?? '写配置失败'}`
  return out
}

// ── ④ 给 /state 与面板用的只读视图 ─────────────────────────────────────────────────
/** `/state.selfAutoUpdate` 的形状（字段固定，**不编造**：拿不到的项就是 null，界面显示"—"）。 */
function selfAutoUpdateState({ deps = {}, profileDir = null } = {}) {
  const read = readAutoUpdateConfig({ deps })
  const selfName = selfPackageNameOf(deps)
  const dir = typeof profileDir === 'string' && profileDir !== ''
    ? profileDir
    : (typeof deps.profileDir === 'string' ? deps.profileDir : '')
  const currentVersion = readInstalledVersion(dir, selfName) ?? runningVersionOf(deps)
  const view = {
    enabled: read.config.enabled === true,
    intervalHours: read.config.intervalHours,
    lastCheckAt: read.config.lastCheckAt,
    lastResult: read.config.lastResult,
    currentVersion,
  }
  if (read.note !== null) view.note = read.note
  return view
}

// ── ⑤ 调度：进程内定时器（单飞 / unref / 异常吞成一条记录）──────────────────────────────
const scheduler = { started: false, timer: null, running: false, deps: null, runs: 0, lastError: null }

/** 下一轮间隔（每次现读配置：用户改 intervalHours 立刻生效）。读不到就按默认值。 */
function nextIntervalMs(deps = {}) {
  const read = readAutoUpdateConfig({ deps })
  const hours = Number.isFinite(Number(read.config.intervalHours)) && Number(read.config.intervalHours) > 0
    ? Number(read.config.intervalHours) : DEFAULT_INTERVAL_HOURS
  return Math.max(1, hours) * HOUR_MS
}

/** 调度里出的任何异常都只变成**一条如实记录**（绝不影响宿主，也绝不静默）。 */
function recordSchedulerFailure(error, { deps = {} } = {}) {
  const at = nowOf(deps)
  try {
    const previous = readAutoUpdateConfig({ deps }).config.lastResult
    writeAutoUpdateConfig({
      lastCheckAt: at,
      lastResult: {
        at, ok: false, updated: false, from: null, to: null, version: null, skipped: null,
        reason: `自更新检查抛错：${label(error)}`, channel: null,
        failedVersion: previous !== null && typeof previous === 'object' ? (previous.failedVersion ?? null) : null,
        failedAt: previous !== null && typeof previous === 'object' ? (previous.failedAt ?? null) : null,
      },
    }, { deps })
  } catch { /* 连记录都写不进去：那也不许影响宿主 */ }
}

/** 单飞的一次检查（`/self-auto-update` 的"立即检查"与定时器共用）：上一轮没跑完就直接回 busy。 */
async function runCheckOnce({ deps = {}, profileDir = null } = {}) {
  if (scheduler.running === true) {
    return {
      checked: false, from: null, to: null, updated: false, ok: true, skipped: 'busy',
      at: nowOf(deps), reason: '上一轮自更新检查还没跑完（单飞，不叠下一轮）',
      version: null, channel: null, packageName: null, backedUp: false, healed: false, manualCommand: null, configNote: null,
    }
  }
  scheduler.running = true
  try {
    const result = await checkAndUpdate({ deps, profileDir })
    scheduler.runs += 1
    return result
  } finally {
    scheduler.running = false
  }
}

function clearSchedulerTimer() {
  if (scheduler.timer !== null) {
    try { clearTimeout(scheduler.timer) } catch {}
    scheduler.timer = null
  }
}

function scheduleNext(delayMs, deps) {
  clearSchedulerTimer()
  const timer = setTimeout(() => {
    scheduler.timer = null
    void tick(deps)
  }, Math.max(0, Number(delayMs) || 0))
  // 绝不阻塞进程退出（宿主关掉就该立刻退出，不等这一轮）
  if (typeof timer?.unref === 'function') timer.unref()
  scheduler.timer = timer
  return timer
}

/** 一轮定时检查：异常吞成记录，之后永远排下一轮（除非已 stop）。 */
async function tick(deps) {
  if (scheduler.started !== true) return
  try {
    await runCheckOnce({ deps })
  } catch (error) {
    scheduler.lastError = label(error)
    recordSchedulerFailure(error, { deps })
  } finally {
    if (scheduler.started === true) scheduleNext(nextIntervalMs(deps), deps)
  }
}

/**
 * 启动调度（**幂等**：重复调用只返回"已经启动过"，不会再排一个定时器）。
 * 首检延迟默认 2 分钟（`deps.firstDelayMs` 可注入），之后按配置的 intervalHours 轮转。
 */
function startSelfAutoUpdateScheduler({ deps = {} } = {}) {
  if (scheduler.started === true) return { started: true, alreadyStarted: true, firstDelayMs: null }
  scheduler.started = true
  scheduler.deps = deps
  const firstDelayMs = Number.isFinite(Number(deps.firstDelayMs)) && Number(deps.firstDelayMs) >= 0
    ? Number(deps.firstDelayMs) : DEFAULT_FIRST_DELAY_MS
  try {
    scheduleNext(firstDelayMs, deps)
  } catch (error) {
    scheduler.lastError = label(error)
    scheduler.started = false
    return { started: false, alreadyStarted: false, firstDelayMs, note: `自更新调度没能启动：${label(error)}` }
  }
  return { started: true, alreadyStarted: false, firstDelayMs }
}

/** 停掉调度（宿主卸载 / 测试收尾用；不抛）。 */
function stopSelfAutoUpdateScheduler() {
  scheduler.started = false
  clearSchedulerTimer()
  return { stopped: true }
}

/** 调度现状（诊断 / 测试用；`ref` = 定时器是否还"引用"着事件循环，`false` 才是不阻塞进程退出）。 */
function selfAutoUpdateSchedulerState() {
  const timer = scheduler.timer
  return {
    started: scheduler.started, running: scheduler.running, hasTimer: timer !== null,
    ref: timer !== null && typeof timer.hasRef === 'function' ? timer.hasRef() : null,
    runs: scheduler.runs, lastError: scheduler.lastError,
  }
}

export {
  CONFIG_FILE, DEFAULT_FIRST_DELAY_MS, DEFAULT_INTERVAL_HOURS, RETRY_BACKOFF_MS, FW_STATE_STALE_MS,
  autoUpdateConfigPath, defaultAutoUpdateConfig, normalizeAutoUpdateConfig, readAutoUpdateConfig, writeAutoUpdateConfig,
  readFrameworkUpgradeStatus, frameworkUpgradeBusy, installBusyOf, runningVersionOf, compareVersions,
  attemptOverlayUpdate, checkAndUpdate, persistResult, selfAutoUpdateState,
  nextIntervalMs, runCheckOnce, startSelfAutoUpdateScheduler, stopSelfAutoUpdateScheduler, selfAutoUpdateSchedulerState,
  recordSchedulerFailure,
}
