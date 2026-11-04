// L1 · domain —— install-lock.js（**同一个 profile + 包名** 的安装互斥；2026-11-04 加法）
// 分层分组：L1 · domain（边界由 tests/test-architecture-guard.mjs 断言；不认识 cordis ctx）
//
// ── 现场（真机 2026-11-04，用户提供的原始日志）────────────────────────────────────
//   一次「详情页更新控制台自己」失败，日志里 pnpm 先被 180s 超时杀树，随后：
//       [WARN] Moving @noob-stupid/dsh-plugin-console_tmp_13796_2 to node_modules\.ignored\…
//       [WARN] Moving dsh-workbuddy-connect_tmp_13796_3 to node_modules\.ignored\…
//   后果：正式目录被清空（只剩 1 个文件、package.json 不见），`node_modules/.ignored` 堆到 118 项 / 335 MB。
//   用户的判断（原文要点）：「这是**两个 pnpm 安装同时装同一个包**造成的冲突 —— 并行竞速本身没问题，
//   要的是『如果下载一个的时候，就停止另一个相同的安装』」。
//
// ── 本模块只做一件事：包的**互斥**（粒度 = 包，不是全局）────────────────────────────
//   · 同一个 `profileDir + 包名` 同一时刻只允许**一个**安装作业；第二个**排队等待**（FIFO，先到先得）。
//   · 不同包**照旧并行** —— 用户明确要「支持同时下载多个」，把闸门做成全局串行是错的。
//   · 等待有上限（默认真机作业预算 10 分钟）：到点如实拒绝（`INSTALL_LOCK_TIMEOUT`），绝不放行去动目录。
//   · **可重入**：同一个异步上下文里已经持有该包的锁时直接放行（否则"安装收口里再调一次 pnpm"这种
//     嵌套会自己把自己锁死；用 AsyncLocalStorage 认上下文，不靠猜）。
//
// ── 为什么队列实现要复用 enrich-throttle.js#makeLimiter ────────────────────────────
//   仓库里已经有一份经过真机验证的 FIFO 计数闸门（`makeLimiter(max)`：绝不丢任务、先到先得、能报
//   active/queued/peak）。用户的原话是「先搜，能复用就复用，不要另造一套」——所以这里**只**复用它的队列，
//   不重写调度。本模块新增的只有三样它没有的东西：
//     ① 以「包」为键（每个键一个 `max=1` 的 limiter ⇒ 天然就是该包的串行队列）；
//     ② **可取消的排队票**：等待超时后把票标记作废，轮到它时**不执行**（`makeLimiter` 本身不支持取消，
//        但我们不需要改它 —— 传入的 fn 自己看票）；
//     ③ **可重入**（同上，AsyncLocalStorage）。
//
// ── 语义边界（别越线）────────────────────────────────────────────────────────────
//   · 本模块**不安装任何东西**，也不判断安装成败：它只保证"同一时刻只有一个人在动同一个目录"。
//   · 拿不到锁 ⇒ 抛错（由调用方如实报成失败）；**绝不**降级成"不拿锁直接装"。
//   · 空包名 / 空 profileDir ⇒ 直接放行（既有调用路径不传这些参数时行为一个字都不变）。
import { AsyncLocalStorage } from 'node:async_hooks'
import { resolve } from 'node:path'
import { makeLimiter } from './enrich-throttle.js'

/** 排队等待上限（默认 10 分钟）：到点就如实拒绝，绝不无限等。
 *  取值理由：单次作业预算 8 分钟（domain/install-job.js#jobBudgetMs），最快的一轮 pnpm 失败约 90s；
 *  10 分钟足以覆盖"前一个作业跑完一轮"的绝大多数情形，又不会让第二个作业挂到用户以为死了。 */
const INSTALL_LOCK_WAIT_MS = 10 * 60 * 1000
/** 拒绝时的错误码（调用方据此产出如实文案；不要靠匹配中文）。 */
const INSTALL_LOCK_TIMEOUT = 'INSTALL_LOCK_TIMEOUT'

/** 锁键：`<规范化的 profileDir>::<包名>`。Windows 路径不区分大小写 ⇒ 统一小写，否则同一个目录会有两把锁。 */
function installLockKey(profileDir, packageName) {
  const name = typeof packageName === 'string' ? packageName.trim() : ''
  if (name === '') return ''
  const dir = typeof profileDir === 'string' && profileDir.trim() !== '' ? profileDir.trim() : '<unknown-profile>'
  let normalized = ''
  try { normalized = resolve(dir) } catch { normalized = dir }
  if (process.platform === 'win32') normalized = normalized.toLowerCase()
  return `${normalized}::${name.toLowerCase()}`
}

// ── 模块级状态（一个进程一份；`__resetInstallLocks()` 供单测还原）─────────────────────────
const states = new Map()
const heldStore = new AsyncLocalStorage()

function lockStateFor(key) {
  let st = states.get(key)
  if (st === undefined) {
    st = { key, limiter: makeLimiter(1), holder: null, acquired: 0, waits: 0, timeouts: 0, peakQueued: 0, lastWaitMs: 0, seq: 0 }
    states.set(key, st)
  }
  return st
}

/** 当前是否有人在装这个包（**不拿锁**，只读状态；给"要不要提示用户在排队"用）。 */
function installLockHolder(profileDir, packageName) {
  const key = installLockKey(profileDir, packageName)
  if (key === '') return null
  const st = states.get(key)
  if (st === undefined || st.holder === null) return null
  const s = st.limiter.stats()
  return { ...st.holder, active: s.active, queued: s.queued }
}

/** 闸门现状（诊断 / 单测断言"不同包确实并行、同一个包确实串行"用）。 */
function installLockStats() {
  const items = []
  for (const st of states.values()) {
    const s = st.limiter.stats()
    items.push({ key: st.key, holder: st.holder?.packageName ?? null, holderSince: st.holder?.since ?? null, active: s.active, queued: s.queued, peak: s.max, acquired: st.acquired, waits: st.waits, timeouts: st.timeouts, lastWaitMs: st.lastWaitMs, peakQueued: st.peakQueued })
  }
  return { locks: items.length, items }
}

/** 清空全部在途记录（单测 & 诊断用；已在跑的作业不会被取消 —— 它们退出时也不会再写回这张表）。 */
function __resetInstallLocks() {
  states.clear()
}

/** 超时拒绝的错误对象（文案要能直接展示给用户：谁在装、等了多久、下一步怎么做）。 */
function installLockTimeoutError({ packageName, waitedMs, holder = null }) {
  const seconds = Math.max(1, Math.round(waitedMs / 1000))
  const who = typeof holder?.packageName === 'string'
    ? `另一个作业（${holder.jobId ?? '未命名作业'}）正在安装这个包，已进行 ${Math.max(1, Math.round((Date.now() - Number(holder.since ?? Date.now())) / 1000))}s`
    : '另一个作业正在安装这个包'
  const error = new Error(`这个包正在安装中：${who}。本次已排队等待 ${seconds}s 仍未轮到，已放弃（没有动任何文件）——请等它结束后重试。`)
  error.code = INSTALL_LOCK_TIMEOUT
  error.packageName = packageName
  error.waitedMs = waitedMs
  error.holder = holder
  return error
}

/**
 * 过闸执行一次"动 `node_modules/<包名>`"的动作（**唯一入口**）。
 * @param {object} spec
 * @param {string} [spec.profileDir]   profile 目录（与另一个作业同一个 profile 才会互斥）
 * @param {string} [spec.packageName]  包名（锁的粒度就是它；空字符串 ⇒ 不过闸、直接执行）
 * @param {number} [spec.waitMs]       排队上限（默认 INSTALL_LOCK_WAIT_MS；传 0 = 有人占着就立刻拒绝）
 * @param {object} [spec.job]          作业（只用于把"我在排队 / 我等了多久"写回去，便于面板显示）
 * @param {(info:{queued:boolean,waitedMs:number,key:string})=>void} [spec.onWait] 排队回调（写日志用）
 * @param {() => Promise<any>} fn      真正要做的活
 * @returns {Promise<any>} fn 的返回值；拿不到锁 ⇒ 抛 INSTALL_LOCK_TIMEOUT
 */
async function withInstallLock(spec, fn, deps = {}) {
  const packageName = typeof spec?.packageName === 'string' ? spec.packageName.trim() : ''
  const key = installLockKey(spec?.profileDir, packageName)
  if (key === '' || typeof fn !== 'function') return await fn()
  // 可重入：同一个异步上下文里已经持有这个包 ⇒ 直接执行（防"安装收口里再调一次"把自己锁死）
  const held = heldStore.getStore()
  if (held !== undefined && held !== null && held.has(key) === true) return await fn({ queued: false, waitedMs: 0, key, reentrant: true })
  const st = lockStateFor(key)
  const now = typeof deps.now === 'function' ? deps.now : Date.now
  const waitMs = Number.isFinite(spec?.waitMs) && spec.waitMs >= 0 ? spec.waitMs : INSTALL_LOCK_WAIT_MS
  const startedAt = now()
  // 「前面还有人」的判据要有两条：`holder` 是人可读的当前持有者，`limiter.active` 是队列的**权威**计数
  // （同一个 tick 里两个调用同时进来时 holder 还是 null，只有 limiter 已经把它算进去了）。
  const queued = st.holder !== null || st.limiter.stats().active > 0
  const ticket = { cancelled: false }
  if (queued) {
    st.waits += 1
    const depth = st.limiter.stats().queued + 1
    if (depth > st.peakQueued) st.peakQueued = depth
    const holder = st.holder === null ? null : { ...st.holder }
    if (spec?.job !== null && spec?.job !== undefined && typeof spec.job === 'object') {
      // 只增字段：面板/诊断据此显示"在排队等谁"，不改任何既有作业字段的语义
      spec.job.installLock = { key, packageName, queued: true, since: startedAt, waitedFor: holder?.packageName ?? null, holderJobId: holder?.jobId ?? null, waitMs }
    }
    if (typeof spec?.onWait === 'function') {
      try { spec.onWait({ queued: true, waitedMs: 0, key, holder }) } catch {}
    }
  }
  // 排队（max=1 的 FIFO；票作废后轮到它时**不执行**，只把队列让给下一位）
  // `queueTimer` 在**拿到锁的那一刻**就清掉 —— 排队上限只约束"排队"，绝不能把**已经轮到自己、
  // 正在装**的那一次作业从后面掐断（真实形状：等 9 分钟才轮到，再装 8 分钟，旧写法会在第 10 分钟误杀）。
  let queueTimer = null
  const task = st.limiter.run(async () => {
    if (ticket.cancelled === true) return { skipped: true }
    if (queueTimer !== null) { clearTimeout(queueTimer); queueTimer = null }
    const waitedMs = now() - startedAt
    st.holder = { key, packageName, since: now(), jobId: spec?.job?.id ?? null, serial: (st.seq += 1) }
    st.acquired += 1
    st.lastWaitMs = waitedMs
    if (spec?.job !== null && spec?.job !== undefined && typeof spec.job === 'object') {
      spec.job.installLock = { key, packageName, queued: queued, waitedMs, acquiredAt: now() }
    }
    try {
      return await heldStore.run(new Set([...(heldStore.getStore() ?? []), key]), () => fn({ queued, waitedMs, key, reentrant: false }))
    } finally {
      st.holder = null
    }
  })
  // `waitMs === 0` = 明确拒绝策略（有人占着就立刻失败，不排队）；否则立刻放行或排队
  if (waitMs === 0) {
    if (queued === true) {
      st.timeouts += 1
      ticket.cancelled = true
      void task.catch(() => {})
      throw installLockTimeoutError({ packageName, waitedMs: 0, holder: st.holder === null ? null : { ...st.holder } })
    }
    return await task
  }
  if (queued !== true) return await task
  // 有上限地等：到点把票作废并如实拒绝（**不会**降级成"不拿锁直接装"）
  const guard = new Promise((resolveGuard, rejectGuard) => {
    queueTimer = setTimeout(() => {
      queueTimer = null
      ticket.cancelled = true
      const waitedMs = now() - startedAt
      st.timeouts += 1
      rejectGuard(installLockTimeoutError({ packageName, waitedMs, holder: st.holder === null ? null : { ...st.holder } }))
    }, waitMs)
  })
  try {
    return await Promise.race([task, guard])
  } finally {
    if (queueTimer !== null) { clearTimeout(queueTimer); queueTimer = null }
    // 票作废后那个 limiter 任务仍会用 { skipped: true } 落地 —— 这里接住它，别留下未处理的 rejection
    if (ticket.cancelled === true) void task.catch(() => {})
  }
}

/** 失败文案（作业 error / 面板提示共用一份；非锁超时返回 null）：拿不到锁时**如实失败**，绝不报成功。 */
function installLockFailureText(job) {
  const lock = job !== null && job !== undefined && typeof job === 'object' ? job.installLock : null
  if (lock === null || lock === undefined) return null
  if (lock.timeout !== true) return null
  return lock.reason ?? `这个包正在安装中（${lock.packageName ?? '未知包'}），本次排队等待超时，已放弃`
}

/** `withInstallLock` 的"拿不到锁就返回一份**如实**的结果"版本（只吞 `INSTALL_LOCK_TIMEOUT`，其余照抛）。
 *  `onTimeout(error)` 的返回值原样交给调用方 —— 调用方据此产出"没装成 + 原因"，绝不假装成功。 */
async function withInstallLockOr(spec, fn, onTimeout, deps = {}) {
  try {
    return await withInstallLock(spec, fn, deps)
  } catch (error) {
    if (error?.code !== INSTALL_LOCK_TIMEOUT || typeof onTimeout !== 'function') throw error
    return await onTimeout(error)
  }
}

export {
  INSTALL_LOCK_WAIT_MS,
  INSTALL_LOCK_TIMEOUT,
  installLockKey,
  installLockHolder,
  installLockStats,
  installLockTimeoutError,
  installLockFailureText,
  withInstallLock,
  withInstallLockOr,
  __resetInstallLocks,
}
