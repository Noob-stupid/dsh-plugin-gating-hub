// L1 · domain —— plugin-actions.js（**结构化建议动作的执行器**：白名单动作 + 服务端自拼 argv）
//
// 为什么单开一个模块（2026-09-27 加法 + 改错，用户明确要求「可执行的钉住/修复动作框」）：
//   · 面板过去只给一句文案（"要钉住请执行：dsh plugin … add …"），用户得自己开终端抄命令，
//     抄错一个字符就是另一种事故；而**让面板自由执行命令**又是绝不能开的口子。
//   · 所以接口只接受**结构化的动作类型 + 目标**（`{ action, packageName, version, profile }`），
//     命令行的每一个参数都由本模块的 ACTION_SPECS 自己拼 —— 客户端**没有任何位置**能传命令字符串。
//     出现 command/cmd/argv/args/exec/shell/script/run/spawn/bin 任一字段即 400（配套测试钉死）。
//   · `profile` 字段**只作回显**：服务端一律按当前实例的 profile 目录施工（绝不按请求体挑目录）。
//
// 动作表（唯一真源，新增动作必须同时进这张表与测试）：
//   · pin-dependency：把清单里的该包钉成 `link:<DSH_HOME>/plugin-src/<包名>`，再跑一次
//     `pnpm add <link:…>` 把 lock / node_modules 对齐（argv 由 infra/exec.js#pnpmAddArgs 产出）；
//   · reconcile-lock：只重写 pnpm-lock.yaml，复用 lockfile-health 的 repair（argv 由 repairArgsFor
//     唯一产出，**不带**任何绕过供应链闸的开关）。
//
// 供应链闸的一次性放宽（写清代价，绝不静默）：pnpm 11 的 `minimumReleaseAge` 默认 24h，
// 本控制台自己刚发的版本 (<24h) 会让**任何** lockfile 校验失败 —— 连"把本地 link: 记进 lock"都做不成。
// 处理：第一次**原样跑**（不带任何放宽）；只有当失败原因**确定**是 ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION
// 时，才为**这一条命令**追加 `--config.minimumReleaseAge=0` 重试一次，并在结果里显式回报
// `relaxedReleaseAge: true`（面板原样展示）。绝不写进任何配置文件、绝不用它绕过错配的包名/版本。
//
// 分层：L1 domain —— 不认识 cordis ctx，IO/执行器一律可注入（便于离线单测）。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NPM_NAME_RE } from './dep-source.js'
import { runLockfileRepair } from './lockfile-health.js'
import { pinProfileDependency, specOf } from './manifest.js'
import { lockVersion } from './selfupdate.js'
import { buildPnpmEnv, pnpmAddArgs, runPnpmWithFallback } from '../infra/exec.js'

const DEFAULT_REGISTRY = 'https://registry.npmmirror.com'
/** 动作白名单（客户端只能给这些 kind；执行分支与 argv 全在服务端）。 */
const ACTION_KINDS = ['pin-dependency', 'reconcile-lock']
/** 一旦出现这些键就整条拒绝：本接口不存在"传命令"的位置。 */
const COMMAND_KEYS = ['command', 'cmd', 'argv', 'args', 'exec', 'execute', 'shell', 'script', 'run', 'spawn', 'bin', 'shellCommand']
const OUTPUT_LIMIT = 4000

/** 校验并翻译成结构化请求。返回 { ok, error, status, action, packageName, version, profile }。 */
function parseActionRequest(body) {
  const raw = body !== null && typeof body === 'object' ? body : {}
  for (const key of COMMAND_KEYS) {
    if (key in raw) {
      return { ok: false, status: 400, error: `不接受客户端传来的命令字符串（字段 ${key} 非法）：本接口只认结构化动作，命令行由服务端自己拼` }
    }
  }
  const action = typeof raw.action === 'string' ? raw.action.trim() : ''
  if (action === '') return { ok: false, status: 400, error: '缺少 action（只允许 pin-dependency / reconcile-lock）' }
  if (!ACTION_KINDS.includes(action)) {
    return { ok: false, status: 400, error: `未知动作 ${action}（只允许 ${ACTION_KINDS.join(' / ')}）` }
  }
  const packageName = typeof raw.packageName === 'string' ? raw.packageName.trim() : ''
  if (action === 'pin-dependency') {
    if (packageName === '') return { ok: false, status: 400, error: 'pin-dependency 需要 packageName' }
    if (packageName.length > 214 || !NPM_NAME_RE.test(packageName)) return { ok: false, status: 400, error: 'packageName 不是合法的 npm 包名' }
  }
  const version = typeof raw.version === 'string' && raw.version.length <= 120 ? raw.version : null
  const profile = typeof raw.profile === 'string' && raw.profile.length <= 64 ? raw.profile : null
  return { ok: true, error: null, status: 200, action, packageName: packageName === '' ? null : packageName, version, profile }
}

/** 该包是否属于当前 profile（已声明在 dependencies / devDependencies / optionalDependencies 或
 *  `dsh.profile.bundles` 里）。**安全边界**：动作只对该 profile 自己认得的包生效，
 *  请求体说了不算（包名由客户端给，但"这个包属不属于这个 profile"必须服务端自己读盘判定）。 */
function isProfilePackage(profileDir, packageName) {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      if (manifest?.[section] !== null && typeof manifest?.[section] === 'object' && packageName in manifest[section]) return true
    }
    const bundles = manifest?.dsh?.profile?.bundles
    return Array.isArray(bundles) && bundles.includes(packageName)
  } catch {
    return false
  }
}

/** 目标包是否已落在该 profile 的 node_modules 里（pin 的物理前提）。 */
function isInstalled(profileDir, packageName) {
  return existsSync(join(profileDir, 'node_modules', ...String(packageName).split('/'), 'package.json'))
}

function tail(text, limit = OUTPUT_LIMIT) {
  const s = typeof text === 'string' ? text : String(text ?? '')
  return s.length <= limit ? s : s.slice(-limit)
}

/** 供应链闸判据（只认 pnpm 自己的错误码/文案；认不出就绝不放宽）。 */
function isReleaseAgeBlock(message) {
  return /ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION|minimumReleaseAge/iu.test(String(message ?? ''))
}

/** 跑一次 pnpm（原样），必要时**只对这一条命令**放宽供应链闸并如实标记。
 *  返回 { ok, exitCode, stdout, stderr, relaxedReleaseAge, error }。 */
async function runAddWithReleaseAgeRetry({ profileDir, spec, registry, runAdd, timeoutMs = 180000 }) {
  const argv = pnpmAddArgs(spec, registry)
  const execOpts = { cwd: profileDir, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: buildPnpmEnv(registry) }
  const attempt = async (args) => {
    try {
      const out = await runAdd(args, { execOpts })
      return { ok: true, exitCode: 0, stdout: tail(out?.stdout), stderr: tail(out?.stderr), error: null }
    } catch (error) {
      return {
        ok: false,
        exitCode: Number.isInteger(error?.code) ? error.code : 1,
        stdout: tail(error?.stdout),
        stderr: tail(error?.stderr ?? error?.message ?? String(error)),
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }
  const first = await attempt(argv)
  // 放宽条件**必须同时**成立：第一次真的失败了，且失败原因确定是供应链闸（文案/错误码认得出）
  const blocked = !first.ok && (isReleaseAgeBlock(first.stderr) || isReleaseAgeBlock(String(first.error?.message ?? '')))
  if (!blocked) return { ...first, relaxedReleaseAge: false }
  const retried = await attempt([...argv, '--config.minimumReleaseAge=0'])
  return { ...retried, relaxedReleaseAge: true }
}

/**
 * 执行一个结构化建议动作（**唯一入口**，路由只做鉴权/取 profileDir）。
 * 返回统一形状：{ ok, status, action, packageName, exitCode, command, stdout, stderr, relaxedReleaseAge,
 *                manifest: { before, after, changed, pinned }, lock: { entry, synced }, notes, reason, hint, detail }
 * `ok` = 目标状态**真的**达成（pin：清单是 link: **且** lock 里也有该 link 条目）；只达成一半时
 * `partial: true` 并如实说明哪一半没成 —— 绝不把"写了一半"报成成功。
 */
async function runSuggestedAction({ body, profileDir, registries = [], deps = {} } = {}) {
  const parsed = parseActionRequest(body)
  if (parsed.ok !== true) return { ok: false, status: parsed.status, action: null, error: parsed.error }
  const registry = (Array.isArray(registries) ? registries : []).find((r) => typeof r === 'string' && r.trim() !== '') ?? DEFAULT_REGISTRY
  const runAdd = typeof deps.runAdd === 'function' ? deps.runAdd : runPnpmWithFallback
  const pin = typeof deps.pin === 'function' ? deps.pin : pinProfileDependency
  const repair = typeof deps.repair === 'function' ? deps.repair : runLockfileRepair
  const base = {
    ok: false, status: 200, action: parsed.action, packageName: parsed.packageName, profile: parsed.profile,
    registry, exitCode: null, command: null, stdout: '', stderr: '', relaxedReleaseAge: false,
    manifest: null, lock: null, notes: [], reason: null, hint: null, detail: null,
  }
  if (parsed.action === 'reconcile-lock') {
    const view = await repair({ profileDir, registries: Array.isArray(registries) && registries.length > 0 ? registries : [registry] })
    const done = view?.action === 'repaired' || view?.action === 'noop'
    return {
      ...base,
      ok: done,
      exitCode: view?.action === 'failed' ? 1 : 0,
      command: view?.command ?? null,
      stderr: tail(view?.stderrTail),
      notes: [view?.reason].filter((n) => typeof n === 'string'),
      reason: view?.reason ?? null,
      hint: view?.hint ?? null,
      detail: view ?? null,
      lock: { entry: null, synced: view?.action === 'repaired' || view?.action === 'noop' },
    }
  }
  // pin-dependency
  if (!isProfilePackage(profileDir, parsed.packageName)) {
    return { ...base, ok: false, status: 400, error: `${parsed.packageName} 不在本 profile 的清单（dependencies / dsh.profile.bundles）里，拒绝改动` }
  }
  if (!isInstalled(profileDir, parsed.packageName)) {
    return { ...base, ok: false, status: 400, error: `${parsed.packageName} 没有装在当前 profile 的 node_modules 里，无法钉住（先安装）` }
  }
  const before = await specOf(profileDir, parsed.packageName)
  let pinned = null
  try {
    pinned = await pin(profileDir, parsed.packageName, {})
  } catch (error) {
    return { ...base, ok: false, status: 200, manifest: { before, after: before, changed: false, pinned: false }, reason: error instanceof Error ? error.message : String(error) }
  }
  const argv = pnpmAddArgs(pinned.spec, registry)
  const run = await runAddWithReleaseAgeRetry({ profileDir, spec: pinned.spec, registry, runAdd, timeoutMs: deps.timeoutMs })
  const after = await specOf(profileDir, parsed.packageName)
  const entry = lockVersion(profileDir, parsed.packageName)
  const lockSynced = typeof entry === 'string' && entry.startsWith('link:')
  // "钉住了"的判据：清单里该包**是 link: 形式**（不要求与计划的绝对路径逐字相同 —— pnpm 自己也可能把它
  // 规范化成相对路径，那同样是"不经 registry 解析"的来源型 spec，判据见 domain/dep-source.js#linkSpecIsIntact）
  const pinnedOk = typeof after === 'string' && after.startsWith('link:')
  const manifests = { before, after, changed: before !== after, planned: pinned.spec, pinned: pinnedOk }
  const notes = []
  if (run.relaxedReleaseAge) notes.push('本机 pnpm 的 24h 供应链闸（minimumReleaseAge）拦下了这次 lock 校验，已**仅对这一条命令**追加 --config.minimumReleaseAge=0 重试一次（有安全代价，未写进任何配置文件）。')
  // 三种"pnpm 那一步没跑成"的形态都如实记一句（2026-09-27 真机桌面端实例实测：corepack 在该进程里
  // 解析不到 → pnpm 那一步失败，而清单/lock 其实已达成目标；只留 stderr 会让用户自己猜发生了什么）
  if (!run.ok) {
    notes.push(manifests.pinned
      ? (lockSynced
        ? `pnpm 那一步没跑完（exitCode=${run.exitCode}，原始输出见 stderr）：清单与 lock 已经是 link:，目标状态已达成。`
        : `清单已钉住（下次 pnpm 操作不会再 404），但 lock 没能对齐（exitCode=${run.exitCode}）：见 stderr。`)
      : `清单与 lock 都没改成功（exitCode=${run.exitCode}）：见 stderr（原始输出已原样回显）。`)
  }
  return {
    ...base,
    // 只有"清单真的是 link: **且** lock 里也有这条 link"才算成功；只成一半时 partial=true 并如实说明
    ok: manifests.pinned && lockSynced,
    partial: manifests.pinned && !lockSynced,
    exitCode: run.exitCode,
    command: `pnpm ${argv.join(' ')}`,
    stdout: run.stdout,
    stderr: run.stderr,
    relaxedReleaseAge: run.relaxedReleaseAge,
    manifest: manifests,
    lock: { entry: entry ?? null, synced: lockSynced },
    notes,
    reason: manifests.pinned
      ? (lockSynced ? `${parsed.packageName} 已钉住：清单与 pnpm-lock.yaml 都指向 link:${pinned.dir}` : `${parsed.packageName} 的清单已钉住，lock 未对齐`)
      : `${parsed.packageName} 的清单写回未生效（实际是 ${after ?? '（无该条目）'}）`,
  }
}

export { ACTION_KINDS, COMMAND_KEYS, DEFAULT_REGISTRY, OUTPUT_LIMIT, isProfilePackage, isReleaseAgeBlock, parseActionRequest, runAddWithReleaseAgeRetry, runSuggestedAction }
