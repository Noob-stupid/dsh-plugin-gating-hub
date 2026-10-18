// L1 · domain —— lock-autofix.js（清单 ↔ lock 口径不一致的**后台自动对账**；0.5.84 加法）
// 分层分组：L1 · domain（不认识 cordis ctx；pnpm 执行与读盘都可注入）
//
// ── 为什么（用户 2026-10 反馈）──────────────────────────────────────────────────
//   profile 的 `package.json` 与 `pnpm-lock.yaml` 经常对不上（改过依赖没重装 / 装完没写 lock / 手改过清单），
//   而唯一会把它收敛的动作是用户自己去点「重建 lock」。不点时每一次 pnpm 操作都要重新解析，
//   还可能在 frozen-lockfile 下直接 `ERR_PNPM_OUTDATED_LOCKFILE`（安装失败的头号原因之一）。
//   所以：**检测到就自己修**，不必等用户。
//
// ── 三条硬约束（用户明确要求，任何一条都不能松）──────────────────────────────────
//   ① **后台**：调用方 `void scheduleLockAutofix(...)` 即返回，**绝不 await**、绝不阻塞 /state。
//      这里所有慢动作（registry 探测 + pnpm）都在自己的 promise 里跑，异常一律被吞进状态字段。
//   ② **冷却窗**：两次尝试之间至少 `COOLDOWN_MS`（10 分钟）；期间任何触发都直接跳过（不排队、不重试）。
//   ③ **失败就停**：一旦失败，**不再自动重试** —— 除非"不一致的样子"变了（signature 变化，
//      即用户又改了清单/lock）。失败原因与 pnpm 输出尾部如实留在状态里，面板据此提示，不静默。
//
// ── 为什么可以整份 `--lockfile-only`（以及为什么**只**在这个场景可以）──────────────
//   仓库既有事实（见 domain/lock-importer.js 顶部那段实测）：本机 pnpm 的 `--lockfile-only`
//   会把**无关条目**的 peer 后缀剥掉 ⇒ 它**不是**"定点补一条"的无损工具。
//   但本模块是**整包对账**：argv 由 lockfile-health.js#repairArgsFor 唯一产出
//   （`install --lockfile-only --no-frozen-lockfile --registry …`），让 pnpm 按清单重算整份 lock ——
//   这正是它擅长的场景；而"定点补条目"走 lock-importer 的纯文本外科手术，两条路**不混用**。
//   另外还守住一条：**只要不一致里出现来源型依赖（link:/file:/git/URL）就不自动修** ——
//   那类条目除了 importer 两行还有 packages/snapshots 的解析记录，整份重算可能把它们改写成别的形态，
//   交给「一键钉住」（persist.js 的收口）才对。
//
// ── 复用的是既有唯一实现，不新造第二条修 lock 的路 ────────────────────────────────
//   检测：lockfile-health.js#diffLockfile（纯函数，清单 vs lock vs 磁盘三方对账）
//   修：  lockfile-health.js#runLockfileRepair（用户显式点「重建」时走的就是它：先只读体检、
//         有 404/探测不到就 blocked 一个文件都不写、跑完复检、按 install-diagnose 分类如实回报）
//   本模块只加"什么时候该跑 / 多久跑一次 / 失败了怎么办"这三件调度上的事。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { diffLockfile, isSourceSpec, runLockfileRepair } from './lockfile-health.js'
import { isTestProcess } from '../infra/egress.js'
import { dshHome } from '../infra/paths.js'

/** 两次自动尝试之间的最小间隔（冷却窗）。 */
const COOLDOWN_MS = 10 * 60 * 1000
/** 状态落盘文件（跨重启也有记忆，避免一重启就再跑一次）。 */
const STATE_FILE_NAME = 'lock-autofix.json'

/** 进程内状态（`__resetLockAutofix()` 供单测还原）。 */
let state = null
const blank = () => ({
  inFlight: false,
  lastAt: null,          // 上次尝试的时间戳
  lastResult: null,      // 上次结论（如实下发，含原因/包名/pnpm 输出尾部）
  failures: 0,           // 连续失败次数（>0 ⇒ 已停）
  stopped: false,        // 失败后停止自动重试
  stoppedReason: null,
  stoppedSignature: null // 停下时那份"不一致的样子"；样子变了才允许再试
})

const stateFile = () => join(dshHome(), 'plugin-console', STATE_FILE_NAME)

function readStateFile() {
  try {
    const raw = JSON.parse(readFileSync(stateFile(), 'utf8'))
    if (raw === null || typeof raw !== 'object') return null
    return raw
  } catch {
    return null
  }
}

function writeStateFile(snapshot) {
  try {
    mkdirSync(dirname(stateFile()), { recursive: true })
    writeFileSync(stateFile(), JSON.stringify(snapshot, null, 2), 'utf8')
  } catch {}
}

/** 取（必要时从磁盘恢复）状态。 */
function stateNow() {
  if (state !== null) return state
  state = blank()
  const saved = readStateFile()
  if (saved !== null) {
    state.lastAt = typeof saved.lastAt === 'number' ? saved.lastAt : null
    state.lastResult = saved.lastResult ?? null
    state.stopped = saved.stopped === true
    state.stoppedReason = typeof saved.stoppedReason === 'string' ? saved.stoppedReason : null
    state.stoppedSignature = typeof saved.stoppedSignature === 'string' ? saved.stoppedSignature : null
    state.failures = Number.isFinite(saved.failures) ? saved.failures : 0
  }
  return state
}

/** 单测还原：清空内存状态（落盘文件由调用方自己决定要不要清）。 */
function __resetLockAutofix() {
  state = null
}

/**
 * 「这次不一致」的样子（用于"失败后不重试，除非样子变了"）。
 * 只由**不一致本身**构成：缺哪些、specifier 怎么漂、版本怎么不符 —— 修好或再变都会改变它。
 */
function mismatchSignature(outdated) {
  const miss = Array.isArray(outdated?.missing) ? [...outdated.missing].sort() : []
  const spec = Array.isArray(outdated?.specifierMismatch)
    ? outdated.specifierMismatch.map((x) => `${x.name}@${x.spec}/${x.lockSpecifier ?? ''}`).sort() : []
  const ver = Array.isArray(outdated?.versionMismatch)
    ? outdated.versionMismatch.map((x) => `${x.name}@${x.spec}/${x.lockVersion ?? ''}`).sort() : []
  return JSON.stringify({ miss, spec, ver })
}

/**
 * 该不该自动修（**纯判据**，不写盘、不发网络、不 spawn）。
 * @returns {{ applicable: boolean, reason: string|null, signature: string|null, outdated: object|null, sourceSpecNames: string[] }}
 *   · applicable=false 时 reason 说明为什么不动手（面板可原样展示，**不许**含糊成"跳过了"）
 */
function planLockAutofix({ profileDir, readFile = (p) => readFileSync(p, 'utf8'), exists = existsSync, now = Date.now() } = {}) {
  const dir = typeof profileDir === 'string' && profileDir !== '' ? profileDir : null
  if (dir === null) return { applicable: false, reason: 'profile 目录未知，未自动对账', signature: null, outdated: null, sourceSpecNames: [] }
  const read = (name) => {
    try {
      const file = join(dir, name)
      return exists(file) ? readFile(file) : null
    } catch {
      return null
    }
  }
  const manifestText = read('package.json')
  if (manifestText === null) return { applicable: false, reason: 'profile 没有 package.json（清单都读不到，无从对账）', signature: null, outdated: null, sourceSpecNames: [] }
  let manifest = null
  try {
    manifest = JSON.parse(manifestText)
  } catch {
    return { applicable: false, reason: 'package.json 不是合法 JSON —— 不碰它（那是用户的文件），请先修好清单', signature: null, outdated: null, sourceSpecNames: [] }
  }
  if (manifest === null || typeof manifest !== 'object') {
    return { applicable: false, reason: 'package.json 不是对象 —— 不碰它', signature: null, outdated: null, sourceSpecNames: [] }
  }
  const lockText = read('pnpm-lock.yaml')
  const diff = diffLockfile({ manifestText, lockText })
  const signature = mismatchSignature(diff)
  const outdated = {
    lockfileMissing: !diff.lockfilePresent,
    missing: diff.missing,
    specifierMismatch: diff.specifierMismatch,
    versionMismatch: diff.versionMismatch,
    drift: diff.drift,
  }
  const mismatchNames = [...new Set([
    ...diff.missing,
    ...diff.specifierMismatch.map((x) => x.name),
    ...diff.versionMismatch.map((x) => x.name),
  ])]
  if (mismatchNames.length === 0) {
    return { applicable: false, reason: null, signature, outdated, sourceSpecNames: [] }
  }
  // 来源型依赖一旦出现在不一致清单里 ⇒ 整份重算不是无损工具（见文件头那段），**不自动修**
  const specsByName = new Map()
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const block = manifest[section]
    if (block === null || typeof block !== 'object') continue
    for (const [name, spec] of Object.entries(block)) if (typeof spec === 'string') specsByName.set(name, spec)
  }
  const sourceSpecNames = mismatchNames.filter((name) => isSourceSpec(specsByName.get(name) ?? ''))
  if (sourceSpecNames.length > 0) {
    return {
      applicable: false,
      reason: `不一致里有来源型依赖（${sourceSpecNames.slice(0, 4).join('、')}）—— 整份 pnpm install --lockfile-only 可能改写它们的解析记录，已改为交给「一键钉住」处理，本次不自动对账`,
      signature, outdated, sourceSpecNames,
    }
  }
  return { applicable: true, reason: null, signature, outdated, sourceSpecNames: [] }
}

/**
 * 后台调度一次自动对账（**fire-and-forget**：调用方不要 await）。
 * 所有前置条件（冷却窗 / 已停 / 在跑 / 无不一致）都只**读**内存状态 —— 快速返回，绝不阻塞 HTTP 响应。
 * @returns {{ started: boolean, reason: string|null }}
 */
function scheduleLockAutofix({ profileDir, registries = [], now = Date.now(), deps = {} } = {}) {
  // ★ 测试进程里一律不自动跑 pnpm：它会重写 fixture 的 pnpm-lock.yaml，而多套测试对
  //   "lock 是否被写过"有断言（例如 test-route-inventory 的只读体检那条）。判据来自
  //   infra/egress.js#isTestProcess（看 process.argv[1]，测试自己解不开这条保护）。
  //   注入了 repair 替身 = 调用方自己承担（离线单测就是这样覆盖全流程的），此时不拦。
  const repairImpl = typeof deps.repair === 'function' ? deps.repair : null
  if (repairImpl === null && isTestProcess()) {
    return { started: false, reason: '测试进程：不自动跑 pnpm（见 infra/egress.js#isTestProcess）' }
  }
  const st = stateNow()
  const plan = planLockAutofix({ profileDir, now, ...(deps.plan ?? {}) })
  if (plan.applicable !== true) {
    // 没有不一致时 quiet（reason=null）；有但不动手时如实说明
    return { started: false, reason: plan.reason }
  }
  if (st.inFlight) return { started: false, reason: '上一次自动对账还在跑，本次跳过' }
  if (st.stopped && st.stoppedSignature === plan.signature) {
    // 说清"停了"与"什么情况下才会再试"，再带上上次的真实原因（不让人以为它还会自己动）
    const why = st.stoppedReason ?? '上次自动对账未成功'
    return { started: false, reason: `已停止自动重试（清单/lock 变化后会再试）—— ${why}` }
  }
  if (st.lastAt !== null && now - st.lastAt < COOLDOWN_MS) {
    return { started: false, reason: `冷却中（${Math.max(1, Math.round((COOLDOWN_MS - (now - st.lastAt)) / 1000))}s 后才会再试）` }
  }
  st.inFlight = true
  st.lastAt = now
  if (st.stopped && st.stoppedSignature !== plan.signature) {
    // 样子变了 ⇒ 解除停止（但失败计数留着，让人看得出历史上失败过）
    st.stopped = false
    st.stoppedReason = null
    st.stoppedSignature = null
  }
  const repair = repairImpl ?? runLockfileRepair
  // ★ 绝不在调用栈里 await：让 HTTP 立刻返回，pnpm 在自己的 promise 里跑
  void (async () => {
    let result = null
    try {
      const out = await repair({ profileDir, registries, now: Date.now(), ...(deps.repairDeps ?? {}) })
      const action = typeof out?.action === 'string' ? out.action : 'unknown'
      const ok = out?.ok === true
      result = {
        at: Date.now(),
        action,
        ok,
        kind: out?.kind ?? null,
        reason: out?.reason ?? null,
        hint: out?.hint ?? null,
        packages: Array.isArray(out?.packages) ? out.packages.slice(0, 8) : [],
        stderrTail: typeof out?.stderrTail === 'string' ? out.stderrTail.slice(-600) : null,
        command: out?.command ?? null,
        signature: plan.signature,
      }
      // blocked / noop 不是"失败"：blocked 是真做不了（如实提示，但**不改**停止位以免反复试），
      // noop = 已经没有需要修的（不动停止位）；只有 failed / partial 才算失败并停。
      if (action === 'failed' || action === 'partial' || (ok !== true && action === 'unknown')) {
        st.failures += 1
        st.stopped = true
        st.stoppedSignature = plan.signature
        st.stoppedReason = action === 'failed'
          ? `自动对账失败：${result.kind ?? '未知原因'} —— ${(result.stderrTail ?? result.reason ?? '').slice(-200)}`
          : `自动对账只修好一部分：${result.reason ?? result.hint ?? '仍有差距'}`
      } else if (action === 'blocked') {
        st.failures += 1
        st.stopped = true
        st.stoppedSignature = plan.signature
        st.stoppedReason = `自动对账被拦下（未改任何文件）：${result.reason ?? result.kind ?? '未知原因'}`
      } else {
        st.stopped = false
        st.stoppedReason = null
        st.stoppedSignature = null
      }
    } catch (error) {
      result = {
        at: Date.now(),
        action: 'failed',
        ok: false,
        kind: 'exception',
        reason: error instanceof Error ? error.message : String(error),
        hint: null,
        packages: [],
        stderrTail: null,
        command: null,
        signature: plan.signature,
      }
      st.failures += 1
      st.stopped = true
      st.stoppedSignature = plan.signature
      st.stoppedReason = `自动对账抛错：${result.reason}`
    } finally {
      st.inFlight = false
      st.lastResult = result
      writeStateFile({ lastAt: st.lastAt, lastResult: st.lastResult, failures: st.failures, stopped: st.stopped, stoppedReason: st.stoppedReason, stoppedSignature: st.stoppedSignature })
    }
  })()
  return { started: true, reason: null }
}

/** 面板/诊断用的状态快照（纯读，不触发任何动作）。 */
function lockAutofixStatus({ profileDir = null, now = Date.now() } = {}) {
  const st = stateNow()
  let mismatch = null
  if (typeof profileDir === 'string' && profileDir !== '') {
    try {
      const plan = planLockAutofix({ profileDir, now })
      mismatch = plan.outdated
    } catch {
      mismatch = null
    }
  }
  return {
    cooldownMs: COOLDOWN_MS,
    inFlight: st.inFlight,
    lastAt: st.lastAt,
    lastResult: st.lastResult,
    failures: st.failures,
    stopped: st.stopped,
    stoppedReason: st.stoppedReason,
    mismatch,
    note: st.lastResult === null
      ? null
      : (st.lastResult.ok === true
        ? `已自动对账：${st.lastResult.action === 'repaired' ? 'lock 已按清单重写' : st.lastResult.action}`
        : `自动对账未成功（${st.lastResult.action}）：${st.lastResult.reason ?? st.lastResult.stoppedReason ?? '原因未知'}`),
  }
}

export {
  COOLDOWN_MS,
  STATE_FILE_NAME,
  lockAutofixStatus,
  mismatchSignature,
  planLockAutofix,
  scheduleLockAutofix,
  __resetLockAutofix,
}
