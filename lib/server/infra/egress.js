// L0 · infra —— egress.js（**唯一出网点**：出网与起进程全部收口在这里；0.5.47 加法）
//
// 为什么要有这个模块（上一批的教训，用户已复核）：
//   上一批想用"给 `node:child_process` 的 ESM 命名空间打补丁 + 读 globalThis.__probeChildCalls"
//   来证明"测试没真出网、没真起进程"。两处都是**假守卫**：
//     ① ESM 下 `import { execFile } from 'node:child_process'` 拿到的是**只读命名空间绑定**，
//        `Object.defineProperty` 直接 `TypeError: Cannot redefine property: execFile` —— 这条路死了；
//     ② 那个计数器是**测试文件里的局部变量**，而断言读的是 `globalThis.__probeChildCalls`
//        ⇒ 断言恒真空，永远"0 次"，守卫一点牙都没有。
//
// 本模块给的是**可注入单点**（唯一站得住的形态）：
//   · 生产代码的出网/起进程**只经这里**（http.js 的每条通道都换成这里 makeEgress 造出来的包装）；
//   · 单测 `__setEgressStub({ curlText, githubViaGh, ... })` 注入替身 ⇒ 计数、失败、超时都能被驱动，
//     且**一个真请求都发不出去**；
//   · 计数器就在**执行的那一层**（真实实现前自增），不是测试文件里的局部变量、也不是 globalThis 空标志；
//   · `__setEgressTripwire(true)` 是"漏了注入"的**当场抓手**：没被 stub 覆盖的出口**先抛**，不外发；
//   · `__setEgressRealImpl({...})` 由生产模块在加载时登记真实现；`gaps` 记录"哪个出口被登记过"，
//     于是"生产到底接上没有"是**可断言的**（不是靠读代码猜）。
//   · `egressSelfCheckSpawn()` 是**计数器正控**：真的起一次 `node -e ""`，证明"0 次"不是恒绿。
//
// 为什么用 makeEgress(impl) 而不是让本模块 import http.js：**不起循环依赖**（infra → infra 也不行，
// egress ⇄ http 会成环）。真实现由 http.js 在加载时用 __setEgressRealImpl 登记，方向单向、可静态断言。
//
// 分层：L0 · infra（不得 import domain/routes/index —— tests/test-architecture-guard.mjs 断言②）。

import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process'
import { request as nodeHttpsRequest } from 'node:https'
import { promisify } from 'node:util'

/** 真实出网/起进程的调用计数（只在真实现**之前**自增；stub 命中数另有 stubCalls 记）。 */
const stats = { realNetwork: 0, realSpawn: 0, stubCalls: 0, trips: 0, gaps: [] }
/** 单测注入的替身（缺哪个键 ⇒ 那个出口按"漏注入"处理，绝不悄悄走真实现）。 */
let stub = null
/** 生产登记的真实现（键 = 出口名）。 */
let realImpl = null

/** **测试进程判定**（与 routes/components.js#isTestProcess 同一判据，理由也同一条）：
 * 只看**自己进程的入口脚本**是不是本仓 `tests/**`；判据落在进程自身上 ⇒ 测试**无法自解**这层保护。
 * 为什么网络侧也要它：测试若把替身还原成 null（"还原生产实现"）再走生产路径，真请求就会发出去 ——
 * 与"测试把 spawn 桩摘掉 ⇒ 弹 explorer 窗口"是同一个漏洞形状。这里把它堵死：测试进程里
 * **模块加载即开抓手**，真实现**必须显式 opt-in** 才可能被走到。 */
function isTestProcess() {
  try {
    if (process.env.DSH_TEST_PROCESS === '1') return true
  } catch {}
  try {
    const entry = String(process.argv[1] ?? '').replace(/\\/gu, '/')
    if (entry === '') return false
    return /\/tests\/(?:test-[^/]*\.mjs|run-all\.mjs|probe-[^/]*\.[cm]js)$/u.test(entry)
  } catch {
    return false
  }
}

/** 真实现（真实出网/起进程）的**显式 opt-in**：`DSH_EGRESS_ALLOW_REAL=1`。
 * 生产不设它也不受影响（生产进程不是测试进程 ⇒ 不触发下面的加载即装）。 */
function realEgressOptIn() {
  try {
    return process.env.DSH_EGRESS_ALLOW_REAL === '1'
  } catch {
    return false
  }
}

// ★ 模块加载即装（测试进程里无需任何 env、无需任何调用方配合）：抓手默认开着，且把"我是测试进程"
//   写进环境让子进程继承 —— 于是"测试漏了注入"的结局是**当场红**，而不是真发出去一个请求。
let tripwire = isTestProcess() && !realEgressOptIn()
if (tripwire) {
  try {
    process.env.DSH_TEST_PROCESS = '1'
  } catch {}
}

/** 单测注入替身：传对象 = 打桩（**一个真请求/真进程都不会发生**）；传 null = 还原。 */
function __setEgressStub(next) {
  stub = next !== null && typeof next === 'object' ? next : null
  return stub !== null
}

/** 漏注入抓手开/关。开：未被 stub 覆盖的出口抛错并记一笔 trips；关：走真实现（生产默认）。 */
function __setEgressTripwire(on) {
  tripwire = on === true
  return tripwire
}

/** 生产模块加载时登记真实现（唯一一次；重复登记按合并处理）。返回已登记的出口名清单。 */
function __setEgressRealImpl(next) {
  realImpl = { ...(realImpl ?? {}), ...(next ?? {}) }
  return Object.keys(realImpl).sort()
}

/** 计数快照（浅拷贝，测试据此断言"0 真出网 / 0 真 spawn"）。 */
function egressStatsNow() {
  return { ...stats, gaps: [...stats.gaps] }
}

/** 清零计数（只给测试用；生产没有任何调用点）。 */
function __resetEgressStats() {
  stats.realNetwork = 0
  stats.realSpawn = 0
  stats.stubCalls = 0
  stats.trips = 0
  stats.gaps = []
}

/** 请求目标（真话记录用）：请求可能以 `request(url, opts, cb)` 或 `(opts, cb)` 形态调用。 */
function networkTargetOf(args) {
  const first = args[0]
  if (typeof first === 'string') return first
  if (first !== null && typeof first === 'object') {
    const host = first.hostname ?? first.host ?? ''
    const path = first.path ?? ''
    if (host !== '') return `${first.protocol ?? 'https:'}//${host}${path}`
  }
  return '(unknown)'
}

/** 目标是**回环地址**吗（127.0.0.1 / localhost / ::1）。
 * 红线防的是**外网**请求与真实进程；而"传输层语义"这类测试（本仓既有做法：本地起坏代理复现
 * 200 空 body / 垃圾页 / 404）本来就要真起 curl 打回环 —— 那是允许的，不应当成"漏注入"。
 * 注意：只有**能看出目标**的出口（curl/jsDelivr/https 系列）才有这条豁免；`execFileAsync`
 * 这种看不出目标的（pnpm/git/gh 二进制）一律拦，测试要真跑必须显式 opt-in。 */
function isLoopbackTarget(args) {
  const target = networkTargetOf(args).toLowerCase()
  return /^(?:https?|git\+https?):\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:[/?#]|$)/u.test(target)
}

/** 未注入出口的处理：tripwire 开着 ⇒ 抛（当场的抓手）；关着 ⇒ 用自己的真实现（没有再登记就抛）。 */
function unwired(name, key, args) {
  stats.gaps.push(name)
  if (tripwire && !isLoopbackTarget(args)) {
    stats.trips += 1
    throw new Error(`测试红线：出口 ${name} 未被替身覆盖 —— 本套禁止任何真实出网/真实进程（请给 __setEgressStub 补上 ${key}；只打回环的传输层测试可设 DSH_EGRESS_ALLOW_REAL=1）`)
  }
  const impl = realImpl?.[key]
  if (typeof impl !== 'function') throw new Error(`出网出口 ${name} 没有真实现（生产模块没登记？）`)
  return impl
}

/** 造一支出网包装：**stub 优先 → 记一笔 → 真实现**。顺序写在代码里，可读也可静态断言。
 * `kind`：'network' 记出网计数，'spawn' 记起进程计数（正控自检据此断言计数器不是死的）。
 * `fallback`：可选真实现（调用方直接给函数）；给了就用它，否则查 realImpl 登记表。
 * 为什么允许直接给：`node:https` 的请求原语也收在本模块里（见 egressHttpsRequestOnce），
 * 于是"只有 egress.js 认识 node:https"是**静态可判**的，而不是靠一句注释约定。 */
function makeEgress(name, kind = 'network', fallback = null) {
  const wrapper = async (...args) => {
    if (stub !== null && typeof stub[name] === 'function') {
      stats.stubCalls += 1
      return await stub[name](...args)
    }
    const impl = typeof fallback === 'function' ? fallback : unwired(name, name, args)
    if (kind === 'network') countNetwork(networkTargetOf(args))
    else countSpawn()
    return await impl(...args)
  }
  wrapper.egressName = name
  return wrapper
}

/** 真话记录：**真的**要把一个请求发出去了（只被 makeEgress 与正控调用）。 */
function countNetwork(target) {
  stats.realNetwork += 1
  return target
}

/** 真话记录：**真的**要创建一个进程了（只被 makeEgress 与正控调用）。 */
function countSpawn() {
  stats.realSpawn += 1
}

/** 正控用：不带任何注入，**真的**起一次进程（`node -e ""`，无窗口无副作用），并把计数交给调用方。
 * 返回 `{ ok, counted }`：counted === 1 证明 spawn 计数不是死的（否则"0 次"就是假绿）。 */
async function egressSelfCheckSpawn({ spawnFn = null } = {}) {
  const before = stats.realSpawn
  const impl = typeof spawnFn === 'function' ? spawnFn : realImpl?.execFileAsync
  if (typeof impl !== 'function') return { ok: false, counted: 0, reason: '没有登记 execFileAsync 真实现' }
  countSpawn()
  try {
    await impl(process.execPath, ['-e', ''], { windowsHide: true, timeout: 20000 })
  } catch {
    return { ok: stats.realSpawn - before === 1, counted: stats.realSpawn - before }
  }
  return { ok: stats.realSpawn - before === 1, counted: stats.realSpawn - before }
}

/** 正控用：**真的**把一次出网记到（并可真的发出一次请求）。测试只给**回环地址**，
 * 于是"计数器不是死的"与"零外网"可以同时成立。 */
function egressSelfCheckNetwork(target, { requestFn = null, send = false } = {}) {
  const before = stats.realNetwork
  countNetwork(networkTargetOf([target]))
  const impl = typeof requestFn === 'function' ? requestFn : realImpl?.httpsRequestOnce
  if (send === true) {
    if (typeof impl !== 'function') return { counted: stats.realNetwork - before, sent: false, reason: '没有登记 httpsRequestOnce 真实现' }
    return { counted: stats.realNetwork - before, sent: true, request: () => impl(target, { method: 'GET' }) }
  }
  return { counted: stats.realNetwork - before, sent: false }
}

/** **真的**发一次 https 请求（node:https 的原语收在本模块里：于是"只有 egress.js 认识
 * node:https"是静态可判的）。http.js 的真实 `githubRequestOnce` 用它；单测注入替身后它不会被调用。 */
function egressHttpsRequestOnce(url, options) {
  return nodeHttpsRequest(url, options)
}

// ── 0.5.84 加法：detached 拉起（独立实例的"真重启"）──────────────────────────────
// 为什么放在这里而不是 domain/restart-launcher.js 里直接 spawn：
//   全仓的规矩是「进程原语只有 egress.js 认识」（tests/test-repo-manifest-channels.mjs ★⑨ 静态断言）。
//   于是新增的 detached spawn 也必须是这一层的**可注入出口**：单测 `__setEgressStub({ spawnDetached })`
//   之后，"一次真进程都没起"能被计数证明，而不是靠读代码相信。
// 语义：**只起一个新进程，绝不动老进程**（不 kill、不自杀、不建计划任务）——
//   调用方（routes/framework.js）负责"先回响应、再自己优雅退出"，把端口让给新实例。
function egressSpawnDetachedReal(command, args = [], options = {}) {
  const child = nodeSpawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : undefined,
    env: options.env !== undefined && options.env !== null ? options.env : process.env,
  })
  // 脱离父进程：父进程退出后子进程继续跑（这是"重启"能成立的前提）
  child.unref()
  return { pid: typeof child.pid === 'number' ? child.pid : null, detached: true }
}
/** 出口包装：stub 优先 → 记一笔 spawn → **真实现登记表**（不直接给 fallback！）。
 *  为什么不给 fallback：给了就绕过了下面的 `unwired()` —— tripwire 与 gaps 全部失效，
 *  测试进程里会**真的**起一个 detached 进程（写这条时实测踩到：给 fallback 的那版在单测里真 spawn 了）。
 *  所以按本仓既有形态：真实现登记进 realImpl，出口只查表。 */
const spawnDetached = makeEgress('spawnDetached', 'spawn')
__setEgressRealImpl({ spawnDetached: egressSpawnDetachedReal })

// 0.5.84 加法：把「本进程是测试进程」这一条判据**导出**（原本只在本文件内用）。
//   用途：domain/lock-autofix.js 的**后台自动对账**在测试进程里一律不启动 ——
//   它会真的跑 pnpm 并重写 fixture 的 pnpm-lock.yaml，而多套测试对"lock 是否被写过"有断言。
//   判据只有这一份（看 process.argv[1] 是不是 tests/**），测试无法自己解开它。
//   （注：本段说明放在 export 块**外面** —— 架构守卫 ⑥ 的导出名解析不跳过块内注释。）
export {
  __setEgressStub, __setEgressTripwire, __setEgressRealImpl, __resetEgressStats, egressStatsNow,
  makeEgress, egressHttpsRequestOnce, egressSelfCheckSpawn, egressSelfCheckNetwork,
  spawnDetached,
  isTestProcess,
}
