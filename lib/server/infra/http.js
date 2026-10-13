// 由 Step 1 搬运工具从 lib/index.js 原样切出（只移动、未改逻辑）
// 分层分组：L0 · infra（边界由 tests/test-architecture-guard.mjs 断言）

// ★ 出网/起进程的唯一出口（0.5.47 接线）：本文件的每条网络/进程通道都是 infra/egress.js
// makeEgress 造出来的**包装**（stub 优先 → 计数 → 真实现）。单测 `__setEgressStub({…})`
// 注入替身之后，`egressStatsNow()` 能如实证明"0 次真实出网、0 次真实 spawn"——上一批那种
// "给 node:child_process 命名空间打补丁 + 读 globalThis 空标志"的假守卫已废（ESM 下也打不上）。
// ★ 连 `node:https` 的请求原语也不在本文件（在 egress.js）：于是"只有 egress.js 认识
// node:https / node:child_process"是**静态可判**的（tests/test-repo-manifest-channels.mjs 钉死），
// 而不是靠注释约定。本文件只留"怎么用"（协议/重试/竞速）。
import { execFile as nodeExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { GH_BIN_CANDIDATES } from './exec.js'
import { __setEgressRealImpl, egressHttpsRequestOnce, makeEgress } from './egress.js'

/** 单次 https 请求；卡死的连接会在超时后被销毁。 */

/** 并行竞速：任一分支拿到 2xx 即胜出；非 2xx 与错误都视为失败，全部失败则拒绝。 */

/**
 * GitHub 公开元数据请求。用 node:https 而非全局 fetch，并跳过证书校验：
 * 国内网络环境的中间设备会注入不可信证书，全局 fetch 因此直接失败；
 * 本插件只经此通道拉取公开的仓库/包元数据，npm 安装本身仍走 registry 的
 * 完整 TLS 校验，所以这里放宽校验不会让安装环节失去 TLS 保护。
 *
 * 原逻辑保持不动：官方通道两次尝试（每次 20 秒，间隔 1.5 秒）。
 * 在此基础上新增并行分支：镜像（api/raw 各自前缀）同时竞速，15 秒封顶，
 * 任一分支先拿到 2xx 即胜出；全部失败时回退官方通道的最终错误。
 */

/** 用 curl 子进程请求 JSON（绕过本机中间设备对 node:https TLS 指纹的拦截；curl 走系统网络栈）。 */

/** 用 curl 拉取文本（raw 文件用：本机 curl 直连 raw.githubusercontent.com 秒回，绕开 node:https 黑洞）。 */

/** 任意 https JSON 接口（Gitee/自定义源用）：curl 优先、node:https 兜底；4xx/5xx 确定性失败直接抛出。 */

/** raw 文件读取：https 主通道（含镜像）、gh CLI、curl 直连、curl jsDelivr CDN **四通道并行竞速**。
 * 黑洞期 https/ghproxy 全挂、gh 可能不在服务进程 PATH——jsDelivr CDN 走系统网络且国内可达，是最后兜底。
 * 关键语义：**404 是确定性结果**（文件不存在，探测 .gitmodules/SKILL.md 等时的正常答案），
 * 必须立即返回 null，不能等其它分支（黑洞期 https 通道 20s+ 才失败会拖死整个请求）。 */

/** 简单 https POST 表单（Gitee token 交换用），返回 {status, body}。 */

/** api.github.com 的镜像竞速前缀（主通道黑洞期可用的兜底）。 */

/** raw.githubusercontent.com 的镜像竞速前缀（与浏览器端四通道一致）。 */

// ── 出网单点的**真实现**（0.5.47）────────────────────────────────────────────────────
// 下面这一块是本文件里**唯一**碰 node 进程/网络原语的地方（另一处是 egress.js）。对外导出的
// 同名函数则是 egress 包装：stub 优先 → 记一笔 → 回到这里。`__setEgressRealImpl` 把真实现登记给
// egress，于是"生产到底接上没有"是**可断言的**（egress 的 gaps 会列出被登记过的出口名），
// 不靠读代码猜 —— 上一批的教训正是"加了文件但没人 import"。
function githubRequestOnceReal(url, { signal, accept, token, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = egressHttpsRequestOnce(url, {
      method: 'GET',
      headers: {
        'user-agent': GITHUB_UA,
        accept: accept ?? 'application/vnd.github+json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, resolve)
    req.on('error', reject)
    req.setTimeout(timeout, () => req.destroy(new Error('GitHub 请求超时')))
    if (signal !== undefined) {
      if (signal.aborted) {
        req.destroy(new Error('请求已取消'))
        return
      }
      signal.addEventListener('abort', () => req.destroy(new Error('请求已取消')), { once: true })
    }
  })
}
function httpsRequestReal(url, options) {
  return egressHttpsRequestOnce(url, options)
}
const execFileAsyncReal = promisify(nodeExecFile)
async function githubViaGhReal(apiPath, token = null) {
  // 环境变量而不是命令行参数：token 不能出现在进程命令行（同机其他进程可见）
  const env = token === null ? undefined : { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token }
  let lastError = null
  for (const bin of GH_BIN_CANDIDATES) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const { stdout } = await execFileAsyncReal(bin, ['api', apiPath, '--jq', '.'], { windowsHide: true, timeout: 45000, maxBuffer: 8 * 1024 * 1024, ...(env === undefined ? {} : { env }) })
      try {
        return JSON.parse(stdout)
      } catch {
        throw new Error('gh api 兜底返回的不是合法 JSON')
      }
    } catch (error) {
      lastError = error
      // ENOENT = 该路径不存在，继续下一个候选；其他错误（网络/认证）直接失败
      if (error?.code === 'ENOENT') continue
      throw new Error(`gh api 兜底失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(lastError?.code === 'ENOENT'
    ? 'gh api 兜底失败：未找到 gh CLI'
    : `gh api 兜底失败：${lastError instanceof Error ? lastError.message : String(lastError)}`)
}
async function curlJsonReal(url, timeout = 15000, headers = {}, { ipv4 = false } = {}) {
  const bin = process.platform === 'win32' ? 'curl.exe' : 'curl'
  const args = ['-s', '-m', String(Math.max(5, Math.ceil(timeout / 1000))), '-H', 'accept: application/json', '-w', '\n__HTTP__%{http_code}']
  // ipv4：只给 GitHub 域名用——「解析出 IPv6 但没有 IPv6 路由」的环境里 curl 默认要先空等 ~5.2s 才回退
  // IPv4（2026-09-20 另一位用户实测：默认 5473ms vs `-4` 的 461ms）；双栈正常的环境无副作用。
  if (ipv4) args.push('-4')
  for (const [key, value] of Object.entries(headers)) args.push('-H', `${key}: ${value}`)
  args.push(url)
  const { stdout } = await execFileAsyncReal(bin, args, { timeout: timeout + 3000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  const m = String(stdout).match(/\n__HTTP__(\d+)\s*$/u)
  const code = m ? Number(m[1]) : 0
  const body = m ? String(stdout).slice(0, m.index) : String(stdout)
  if (code !== 0 && (code < 200 || code >= 300)) throw new Error(`请求失败 (HTTP ${code})`)
  return JSON.parse(body)
}
async function curlTextReal(url, timeout = 10000, { ipv4 = false } = {}) {
  const bin = process.platform === 'win32' ? 'curl.exe' : 'curl'
  const args = ['-s', '-m', String(Math.max(3, Math.ceil(timeout / 1000))), '-H', 'accept: text/plain', '-w', '\n__HTTP__%{http_code}']
  // 见 curlJson 注释：GitHub 域名走 IPv4 快通道（IPv6 无路由的环境下默认要白等 ~5.2s）
  if (ipv4) args.push('-4')
  args.push(url)
  const { stdout } = await execFileAsyncReal(
    bin,
    args,
    { timeout: timeout + 3000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  )
  const m = String(stdout).match(/\n__HTTP__(\d+)\s*$/u)
  const code = m ? Number(m[1]) : 0
  const body = m ? String(stdout).slice(0, m.index) : String(stdout)
  if (code !== 0 && (code < 200 || code >= 300)) throw new Error(`HTTP ${code}`)
  return body
}

// ── 对外导出的出网出口 = egress 包装（stub 优先 → 计数 → 真实现）──────────────────────
const githubRequestOnce = makeEgress('httpsRequestOnce', 'network')
const httpsRequest = makeEgress('httpsRequest', 'network')
const githubViaGh = makeEgress('githubViaGh', 'spawn')
const curlJson = makeEgress('curlJson', 'spawn')
const curlText = makeEgress('curlText', 'spawn')

/** 登记真实现（**方向单向**：egress 不 import 本文件，避免 infra 内部成环）。 */
__setEgressRealImpl({
  httpsRequestOnce: githubRequestOnceReal,
  httpsRequest: httpsRequestReal,
  execFileAsync: execFileAsyncReal,
  githubViaGh: githubViaGhReal,
  curlJson: curlJsonReal,
  curlText: curlTextReal,
})

function raceFirst2xx(promises) {
  return new Promise((resolve, reject) => {
    let pending = promises.length
    let done = false
    for (const promise of promises) {
      promise.then(
        (res) => {
          if (done) return
          const ok = res.statusCode === undefined || (res.statusCode >= 200 && res.statusCode < 300)
          if (ok) {
            done = true
            resolve(res)
            return
          }
          if (--pending === 0) reject(new Error(`HTTP ${res.statusCode}`))
        },
        () => {
          if (done) return
          if (--pending === 0) reject(new Error('GitHub 请求失败'))
        },
      )
    }
  })
}
async function githubRequest(url, options) {
  const isApi = url.startsWith(GITHUB_API)
  const isRaw = url.startsWith(GITHUB_RAW)
  // ── 原逻辑：官方通道两次尝试 ──
  const official = (async () => {
    let lastError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1500))
      try {
        return await githubRequestOnce(url, options)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error('GitHub 请求失败')
  })()
  // ── 新增并行分支：镜像竞速（15 秒封顶；非 2xx 视为失败）──
  const prefixes = isApi ? API_MIRROR_PREFIXES : isRaw ? RAW_MIRROR_PREFIXES : []
  const mirrors = prefixes.map((prefix) => (async () => {
    const res = await githubRequestOnce(`${prefix}${url.slice(isApi ? GITHUB_API.length : GITHUB_RAW.length)}`, { ...options, timeout: 15000 })
    if (res.statusCode !== undefined && (res.statusCode < 200 || res.statusCode >= 300)) throw new Error(`HTTP ${res.statusCode}`)
    return res
  })())
  try {
    return await raceFirst2xx([official, ...mirrors])
  } catch {
    // 全灭：回退官方通道的最终错误（保留原始报错语义）
    try {
      return await official
    } catch (error) {
      throw error
    }
  }
}
function collectBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = []
    res.on('data', (chunk) => chunks.push(chunk))
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    res.on('error', reject)
  })
}
/** gh CLI 通道。传 token 时用 GH_TOKEN/GITHUB_TOKEN 环境变量**覆盖 gh 的 keyring 凭据** ——
 * 这是"校验某个 token 是否有效"时唯一安全的用法：否则 gh 会拿本机已登录的身份作答，
 * 一个填错的 token 也会"验证成功"（详见 routes/github-login.js 的说明）。
 * 真实现见上面的 githubViaGhReal；这里往下都是**组合逻辑**（竞速/兜底），不再直接碰进程。 */
async function githubJson(url, signal, token = null) {
  const apiPath = url.startsWith(GITHUB_API) ? url.slice(GITHUB_API.length) : null
  // https 主通道（官方重试+镜像并行）与 gh CLI **并行竞速**：黑洞期 gh 秒回，不再等 https 超时
  if (apiPath !== null) {
    const https = (async () => {
      const res = await githubRequest(url, { signal, token })
      const status = res.statusCode ?? 0
      if (status === 403 && Number(res.headers['x-ratelimit-remaining'] ?? '1') === 0) {
        throw new Error('GitHub 接口限流已用尽，请稍后再试')
      }
      const body = await collectBody(res)
      if (status < 200 || status >= 300) throw new Error(`GitHub 请求失败 (HTTP ${status})`)
      return JSON.parse(body)
    })()
    try {
      return await raceFirst2xx([https, githubViaGh(apiPath)])
    } catch (error) {
      try { return await https } catch (httpsError) { throw httpsError }
    }
  }
  const res = await githubRequest(url, { signal, token })
  const status = res.statusCode ?? 0
  if (status === 403 && Number(res.headers['x-ratelimit-remaining'] ?? '1') === 0) {
    throw new Error('GitHub 接口限流已用尽，请稍后再试')
  }
  const body = await collectBody(res)
  if (status < 200 || status >= 300) throw new Error(`GitHub 请求失败 (HTTP ${status})`)
  return JSON.parse(body)
}
async function githubText(url, signal, token = null) {
  const res = await githubRequest(url, { signal, accept: 'application/json', token })
  const status = res.statusCode ?? 0
  const body = await collectBody(res)
  if (status < 200 || status >= 300) return null
  return body
}
async function fetchJsonUrl(url, timeout = 15000, headers = {}) {
  let lastError
  const isHttps = /^https:\/\//u.test(url)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000))
    try {
      return await curlJson(url, timeout, headers)
    } catch (error) {
      // HTTP 状态错误（4xx/5xx）是确定性失败：直接抛出，不重试、不走 node 兜底
      if (error instanceof Error && /^请求失败 \(HTTP \d+\)$/u.test(error.message)) throw error
      lastError = error
    }
    // node:https 兜底仅对 https 有效：私网 http 镜像只走 curl 通道，
    // 否则会抛出 "Protocol http: not supported" 掩盖 curl 的真实连接错误
    if (!isHttps) continue
    try {
      // 走 egress 包装（不是上面的真实现）：单测注入替身后这条兜底也发不出去
      const res = await httpsRequest(url, { headers })
      const status = res.statusCode ?? 0
      const body = await collectBody(res)
      if (status < 200 || status >= 300) throw new Error(`请求失败 (HTTP ${status})`)
      return JSON.parse(body)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('请求失败')
}
/** 「真的读到了文件内容」判定：null / 空串 / 纯空白都不算。
 * 真实事故（2026-09-19，用户反馈装 dsh-whale-widget 报「未找到 .gitmodules」）：
 * 本机加速器/代理（Watt Toolkit 之类，劫持 raw.githubusercontent.com 到 127.0.0.1）
 * 会对**不存在的文件**回 2xx + 空 body；旧代码只判 `body === null`，
 * 于是空串被当成"文件存在" → 普通插件被判定成 submodule 套装置仓库 → 安装必然失败。 */
function readBodyOrNull(body) {
  return typeof body === 'string' && body.trim() !== '' ? body : null
}

/** .gitmodules 内容校验：必须是真 gitmodules（含 [submodule "x"] 段）才算套装仓库。
 * 只判"探测非 null"会把代理/CDN 的垃圾响应也算成套装；判定权交给内容，不交给状态码。 */
function looksLikeGitmodules(text) {
  return typeof text === 'string' && /^\s*\[submodule\s+"/mu.test(text)
}

/** raw 抓取外层预算（毫秒）。事件（2026-09-20，另一位用户：Android + proot Ubuntu 容器，域名解析出
 * IPv6 但容器无 IPv6 路由）：4 条通道最快也要 5.4s（curl 直连被 -m 6 掐死、node:https 5435ms、
 * jsDelivr 5564ms），旧的 5000ms 预算**必然先超时** → 抓取失败被当成"文件不存在"，
 * 报成「仓库没有 package.json」。放宽到 10s：真 404 仍是毫秒级返回，只有全网慢时才多等。 */
const FETCH_BUDGET_MS = 10000
/** 仓库元数据（默认分支）探测预算：旧值 3s 在同一环境下同样必输 → branch 恒为 'main'，
 * 默认分支为 dev 的仓库会取错分支。 */
const META_BUDGET_MS = 8000
const FETCH_OK = 'ok'
const FETCH_NOT_FOUND = 'not-found'
const FETCH_UNREACHABLE = 'unreachable'

// 旧的 raceFetchOutcome(anyPromise, budgetMs) 已被下面的通道版取代（胜出通道 + 逐条失败原因）。

// 旧的 rawTextFetch/rawTextWithFallback 已被下面的通道版取代（四条既有通道一条不删）。

function postJsonUrl(url, formBody) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(formBody).toString()
    const req = httpsRequestReal(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': GITHUB_UA,
        accept: 'application/json',
      },
      timeout: 20000,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch {
          resolve({ status: res.statusCode ?? 0, body: null })
        }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}
const GITHUB_API = 'https://api.github.com'
const GITHUB_RAW = 'https://raw.githubusercontent.com'
const GITHUB_UA = 'dsh-plugin-console/0.1 (local dsh web instance)'
const API_MIRROR_PREFIXES = [
  'https://ghproxy.net/https://api.github.com',
  'https://ghfast.top/https://api.github.com',
]
// 2026-09-19 移除 mirror.ghproxy.com：该域名早已失效（实测连接超时；失效域名被停放页接管时
// 会回 2xx HTML —— 正是"普通插件被误判成 submodule 套装"的假阳性来源之一）。
const RAW_MIRROR_PREFIXES = [
  'https://ghproxy.net/https://raw.githubusercontent.com',
  'https://ghfast.top/https://raw.githubusercontent.com',
]
// ── 通道身份 + 逐通道失败原因（2026-10-13 加法）─────────────────────────────────
// 缺口：Promise.any 只把**胜出者**当返回值，胜出的是哪条通道被丢弃；全失败时 AggregateError
// 被 catch 成一句 unreachable —— 用户看到的只有"抓取超时"，**看不到哪几条通道试过、各自为什么没成**，
// 于是无从判断该修网络、该换源，还是该等一会儿重试。下面把两样都带出来。
//
// 关键性能约束（与旧行为逐字一致）：**成功必须早返回** —— 旧代码 curl 400ms 赢时不会去等
// node:https 的 20s 超时；所以这里用"首个成功即解析"的 race，只有**全部失败**时才收齐全量原因
// （那时本来就要等到预算耗尽）。
const CHANNEL_LABELS = {
  local: '本地落地',
  https: 'https（GitHub 主通道/镜像竞速）',
  gh: 'gh CLI',
  curl: 'curl 直连',
  jsdelivr: 'jsDelivr CDN',
  'npm-mirror': 'npm 镜像（npmmirror）',
  'npm-official': 'npm 官方源（registry.npmjs.org）',
  budget: '总预算',
}
/** 通道 id → 用户可读名（未知 id 原样返回，绝不显示空标签）。 */
function channelLabel(id) {
  return CHANNEL_LABELS[String(id ?? '')] ?? String(id ?? '未知通道')
}
/** 失败原因归一：超时/HTTP 状态/网络原话，取最短且可读的一句（保留原始 error.message 关键片段）。 */
function compactFailReason(error) {
  const message = error instanceof Error ? error.message : String(error ?? '失败')
  const text = message.replace(/\s+/gu, ' ').trim()
  if (text === '') return '失败（无原因）'
  if (/timed out|timeout|超时|ETIMEDOUT|too slow/iu.test(text)) return `超时（${text.slice(0, 80)}）`
  if (/^(HTTP \d+|请求失败 \(HTTP \d+\))/u.test(text)) return text
  return text.slice(0, 120)
}
/** 各通道结果 → 逐条「通道名：原因」清单（供用户可读报错；顺序即探测顺序，可追溯）。 */
function channelFailureLines(failures) {
  const list = Array.isArray(failures) ? failures : []
  return list.filter((f) => f !== null && typeof f === 'object').map((f) => {
    const reason = typeof f.reason === 'string' && f.reason !== '' ? f.reason : '失败（无原因）'
    return `· ${channelLabel(f.id)}：${typeof f.detail === 'string' && f.detail !== '' ? `${reason} —— ${f.detail}` : reason}`
  })
}
/** 逐通道原因清单文本（空列表 → 空串，调用方据此决定要不要加这段）。 */
function channelFailureSummary(failures) {
  const lines = channelFailureLines(failures)
  return lines.length === 0 ? '' : lines.join('\n')
}

/** 竞速组合（纯逻辑，导出供单测）：通道描述数组 + 预算 → `{ state, body, channel, failures }`。
 * · 某通道返回 null（确定性 404）→ 立刻 not-found（旧语义：不等慢分支）
 * · 某通道返回字符串（2xx 且内容非空白）→ 立刻 ok，并带出**胜出通道 id**
 * · 全部失败 / 超出预算 → unreachable，且 `failures` **逐条**列出每条通道各自的原因
 * 成败的判定权仍在通道自己（它们已按 notFound/real 归一成 null/string/throw）。
 * **向后兼容**：旧形态 `raceFetchOutcome(promise, budgetMs)`（单个 Promise 竞速）仍然可用 ——
 * 单测与老调用点一个字都不用改，只是它现在也会带上 channel/failures。 */
function raceFetchOutcome(input, legacyBudgetMs) {
  const isObjectForm = input !== null && typeof input === 'object' && !Array.isArray(input)
    && (Array.isArray(input.channels) || typeof input.channels !== 'undefined')
  const channels = isObjectForm ? (input.channels ?? []) : [input]
  const deps = isObjectForm ? (input.deps ?? {}) : {}
  const timeoutMs = Number.isFinite(isObjectForm ? input.timeoutMs : legacyBudgetMs) ? (isObjectForm ? input.timeoutMs : legacyBudgetMs) : FETCH_BUDGET_MS
  const setTimer = deps.setTimeout ?? setTimeout
  const list = (Array.isArray(channels) ? channels : [channels])
    // 旧形态：单个 Promise / 值，包成一条通道（默认 id 沿用最老的那条 'https'，语义不变）
    .map((ch, index) => (ch !== null && typeof ch === 'object' && typeof ch?.run === 'function'
      ? ch
      : { id: `channel-${index}`, label: channelLabel(`channel-${index}`), run: () => (typeof ch?.then === 'function' ? ch : Promise.resolve(ch)) }))
  if (list.length === 0) return Promise.resolve({ state: FETCH_UNREACHABLE, body: null, channel: null, failures: [] })
  // 每条通道**只启动一次**：raw[index] 同时是"结果"与"该通道已了结"的标记（null = 还在等）。
  const raw = new Array(list.length).fill(null)
  let settled = false
  let pending = list.length
  return new Promise((resolve) => {
    const done = (outcome) => { if (!settled) { settled = true; resolve(outcome) } }
    const failuresOf = () => raw.map((entry, index) => (entry === null
      ? { id: list[index].id ?? `channel-${index}`, label: channelLabel(list[index].id), reason: '预算内未返回（超时/仍在等待）', state: FETCH_UNREACHABLE, detail: '' }
      : { id: list[index].id ?? `channel-${index}`, label: entry.label, reason: entry.reason, state: entry.state, detail: entry.detail ?? '' }))
    const settleOne = (index, body) => {
      const label = list[index].label ?? channelLabel(list[index].id)
      raw[index] = { state: body === null ? FETCH_NOT_FOUND : FETCH_OK, reason: '', detail: '', label }
      pending -= 1
      // ★ 胜出通道与"当时已知的其余通道失败原因"一起带出（确定性 404 同样立即胜出，不等慢分支）
      done(body === null
        ? { state: FETCH_NOT_FOUND, body: null, channel: list[index].id ?? `channel-${index}`, failures: failuresOf() }
        : { state: FETCH_OK, body, channel: list[index].id ?? `channel-${index}`, failures: failuresOf() })
    }
    const failOne = (index, error) => {
      raw[index] = { state: FETCH_UNREACHABLE, reason: compactFailReason(error), detail: '', label: list[index].label ?? channelLabel(list[index].id) }
      pending -= 1
      // 全部失败 → unreachable + **逐条**原因（这时本来就要等到预算耗尽，收齐不影响速度）
      if (pending === 0) done({ state: FETCH_UNREACHABLE, body: null, channel: null, failures: failuresOf() })
    }
    for (let index = 0; index < list.length; index += 1) {
      // 同步抛出也算这条通道失败（不能让它把整个竞速掀掉）
      try {
        Promise.resolve().then(list[index].run).then(
          (body) => settleOne(index, body),
          (error) => failOne(index, error),
        )
      } catch (error) {
        failOne(index, error)
      }
    }
    // 外层预算兜底（与旧实现同为 FETCH_BUDGET_MS）
    setTimer(() => done({ state: FETCH_UNREACHABLE, body: null, channel: null, failures: failuresOf() }), timeoutMs)
  })
}

/** raw 抓取（带状态 + **通道身份** + 逐通道失败原因）：返回 `{ state, body, channel, failures }`。
 * 通道 = 既有 4 条竞速（node:https 官方+镜像 / gh CLI / curl 直连 / curl jsDelivr，一条不删）
 * **加上**调用方注入的额外通道（本地落地、npm registry 包清单 —— 见 domain/landed-source.js、
 * domain/registry-manifest.js）。额外通道排在既有 4 条**之后**：优先级按可达性，
 * 本地 > 既有网络通道 > registry。 */
async function rawTextFetch(repo, branch, path, budgetMs = FETCH_BUDGET_MS, deps = {}) {
  const url = `${GITHUB_RAW}/${repo}/${encodeURIComponent(branch)}/${path}`
  // 404/4xx：确定性"不存在"，立即以 null 胜出（不等慢分支）
  const notFound = (promise) => promise
    .catch((error) => {
      if (error instanceof Error && /HTTP 404|HTTP 400|Not Found|not found|非 2xx|HTTP 非 2xx/u.test(error.message)) return null
      throw error
    })
  // 各通道统一口径：状态 2xx **且** body 非空白，才算读到文件（否则抛"非 2xx"→ 归一为 null）
  const real = (promise) => promise.then((body) => {
    const text = readBodyOrNull(body)
    if (text === null) throw new Error('HTTP 非 2xx')
    return text
  })
  const https = notFound(real(githubText(url)))
  const gh = notFound(real(githubViaGh(`repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`)
    .then((data) => {
      if (data && typeof data.content === 'string') return Buffer.from(data.content, 'base64').toString('utf8')
      throw new Error('contents 无内容')
    })
    .then((text) => {
      const body = readBodyOrNull(text)
      if (body === null) throw new Error('contents 无内容')
      return body
    })))
  const curl = notFound(real(curlText(url, 9000, { ipv4: true })))
  const cdn = notFound(real(curlText(`https://cdn.jsdelivr.net/gh/${repo}@${encodeURIComponent(branch)}/${path}`, 9000, { ipv4: true })))
  // 额外通道（本地落地 / npm registry 包清单）：按注入顺序追加，**排在既有 4 条之后** ——
  // 既有 4 条仍是主力（能力不许删），额外通道只增加可达性。
  const extra = (Array.isArray(deps.extraChannels) ? deps.extraChannels : [])
    .filter((ch) => ch !== null && typeof ch?.run === 'function')
    // 口径与既有 4 条完全一致：确定性 404 → null（立即胜出）；空内容 → 当作"没读到"
    .map((ch) => ({ id: ch.id, label: ch.label, run: () => notFound(real(Promise.resolve().then(ch.run))) }))
  const channels = [
    { id: 'https', run: () => https },
    { id: 'gh', run: () => gh },
    { id: 'curl', run: () => curl },
    { id: 'jsdelivr', run: () => cdn },
    ...extra,
  ]
  const race = deps.race ?? raceFetchOutcome
  return await race({ channels, timeoutMs: budgetMs, deps })
}

/** 兼容入口：调用方只关心"有没有内容"（null = 没有）。需要区分超时/404 的场景用 rawTextFetch。 */
async function rawTextWithFallback(repo, branch, path) {
  const { state, body } = await rawTextFetch(repo, branch, path)
  return state === FETCH_OK ? body : null
}
export { githubRequestOnce, raceFirst2xx, githubRequest, collectBody, githubViaGh, githubJson, githubText, curlJson, curlText, fetchJsonUrl, rawTextWithFallback, rawTextFetch, raceFetchOutcome, readBodyOrNull, looksLikeGitmodules, postJsonUrl, GITHUB_API, GITHUB_RAW, GITHUB_UA, API_MIRROR_PREFIXES, RAW_MIRROR_PREFIXES, FETCH_BUDGET_MS, META_BUDGET_MS, FETCH_OK, FETCH_NOT_FOUND, FETCH_UNREACHABLE, CHANNEL_LABELS, channelLabel, compactFailReason, channelFailureLines, channelFailureSummary }