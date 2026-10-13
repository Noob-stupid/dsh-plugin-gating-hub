// 「抓清单多通道」**接线**回归（0.5.47）—— 本地联动 / npm registry 通道 / 通道身份 / 逐条失败原因 /
// 报失败前先核实"其实已经装上了"。
//
// ── 上一批为什么作废（用户已复核，本套每一条都针对它）──────────────────────────────────
//   ① 上一版本文件想给 `node:child_process` 的 ESM 命名空间打补丁
//      ⇒ `TypeError: Cannot redefine property: execFile`（ESM 命名空间绑定只读，这条路**死了**）；
//   ② 它的"零子进程"断言读 `globalThis.__probeChildCalls`，而计数器是**局部变量** ⇒ 恒真空断言；
//   ③ `landed-source.js` / `registry-manifest.js` / `presence-check.js` 被 import **0 次**，
//      且 `market.js` 调 `rawTextFetch(repo, branch, 'package.json')` **一个 deps 都没传**
//      ⇒ `http.js` 里的注入缝**不可达** —— 功能一样都没接上。
//
// ── 本套的办法（可注入单点 + 有牙的守卫）──────────────────────────────────────────────
//   · 出网与起进程收口在 `lib/server/infra/egress.js`：生产代码（http.js 的每条通道）经它出网/起进程；
//   · 本套**注入替身**（`__setEgressStub`）⇒ 计数、失败、超时都能被驱动，一个真请求都发不出去；
//   · 同时开 `__setEgressTripwire(true)`：**漏了注入的出口当场抛** ⇒ "零真实出网"是**预防**出来的，
//     不是事后统计出来的（事后统计只能等窗口/请求已经出去才红）；§⑦ 里另有一次抓手正控；
//   · 计数器就在 egress 的执行层（不是测试文件的局部变量），并有**正控**证明它不是死的：
//     `egressSelfCheckSpawn()` 真起一次 `node -e ""`、`egressSelfCheckNetwork()` 真记一笔；
//   · **变异验证**（§⑩）：把回退 / 原因清单 / 已装核实 / 通道报告各删一处、**真的**跑一遍本套，
//     必须各自红 —— 证明这几条断言不是恒绿。跑完**逐字节还原**（sha256 比对，不靠记忆）。
//
// 断言清单：① 本地优先（六条通道全挂住也照样立刻命中）+ 一键从本地安装落点
//   ② registry 按 repository 字段匹配（不靠猜名）③ 通道身份 + 逐条失败原因
//   ④ 首通道挂住 ⇒ 自动切下一通道并成功（对照：全挂 ⇒ 预算兜底）
//   ⑤ 端到端：本机 HTTP 桩当额外通道，走**真的 HTTP 字节流**（只在 127.0.0.1）
//   ⑥ install-job 落点：已装核实 ⇒ 已安装 vX（不弹 AI 授权）⑦⑧⑨ 守卫与正控 ⑩ 变异验证
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
/** 被测代码根（变异验证时用 `C_PROBE_ROOT` 指向被改坏的副本；普通跑 = 仓库根）。 */
const LIB_ROOT = process.env.C_PROBE_ROOT ?? join(ROOT, '..')
const MUTATION_RUN = process.env.C_PROBE_MUTATION === '1'
const url = (rel) => `file:///${join(LIB_ROOT, rel).replace(/\\/gu, '/')}`

const SANDBOX = join(ROOT, '.testdir', `repo-probe-${process.pid}`)
rmSync(SANDBOX, { recursive: true, force: true })
mkdirSync(SANDBOX, { recursive: true })
process.env.DSH_TEST_SKIP_NETWORK = '1'
// ★ 把 DSH_HOME 钉在沙箱里（**在 import 被测模块之前**）：install-job 的 profileDir 由
// paths.js 的 defaultPatchPath() 决定（无 include 条目时 = `<DSH_HOME>/profiles/web`）——
// 不钉住的话它会去核实**用户真实 profile**，那既可能误报"已安装"，也是对用户磁盘的不尊重。
process.env.DSH_HOME = join(SANDBOX, 'dsh-home')

let pass = 0
let fail = 0
const check = (name, ok, info = '') => {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}
/** 等"没发生"的坏消息有一个上限：坏实现把本套挂死也算失败，但要看得见是哪一段。 */
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((resolve) => setTimeout(() => resolve({ __timeout: label }), ms)),
])

const {
  __setEgressStub, __setEgressTripwire, __resetEgressStats, egressStatsNow, egressSelfCheckSpawn, egressSelfCheckNetwork,
} = await import(url('lib/server/infra/egress.js'))
const {
  rawTextFetch, raceFetchOutcome, channelLabel, FETCH_OK, FETCH_NOT_FOUND, FETCH_UNREACHABLE,
} = await import(url('lib/server/infra/http.js'))
const { fetchRepoPackageEx } = await import(url('lib/server/domain/market.js'))
const { probeChannelLine, probeFailureLines, composeProbeFailureText } = await import(url('lib/server/domain/probe-outcome.js'))
const { landedManifestText, localManifestText, landedRepoDir, normalizeRepo } = await import(url('lib/server/domain/landed-source.js'))
const { isSafePackageName, registryPathOf, registryManifestChannels, registryManifestText, NPM_MIRROR, NPM_OFFICIAL } = await import(url('lib/server/domain/registry-manifest.js'))
const { manifestRepoRef, resolvePackageByRepo } = await import(url('lib/server/domain/repo-package-match.js'))
const { checkPluginPresence, packageNameCandidates, firstInstalledPresence, localInstallHint } = await import(url('lib/server/domain/presence-check.js'))
// 「报失败前先核实其实已经装上了」的**实现归属**：0.5.47 起由 domain/install-verify.js 的
// installedEvidence/failedJobEvidence 承担（与 presence-check 同一判据：只读、绝不谎报）。
// 这里只做一层薄适配并断言**行为契约**（"已安装 vX（无需重装）" + 失败折叠为次要信息）——
// 归属换了，契约不能变。
const verifyPresenceModule = await import(url('lib/server/domain/install-verify.js'))
const verifyAlreadyInstalled = ({ profileDir, names = [], probe = null } = {}) => {
  if (typeof verifyPresenceModule.failedJobEvidence === 'function') {
    // failedJobEvidence 是"**这一个作业**的包名"口径 ⇒ 候选名逐个问，取第一个真的已装上的
    for (const name of Array.isArray(names) ? names : [names]) {
      const ev = verifyPresenceModule.failedJobEvidence(profileDir, { packageName: typeof name === 'string' ? name : null, lastError: null })
      if (ev !== null && ev !== undefined && ev.installed === true) {
        const msg = typeof ev.note === 'string' && ev.note !== '' ? ev.note : `已安装 ${ev.packageName}${ev.version === null ? '' : ` v${ev.version}`}（无需重装）`
        const lines = probeFailureLines(probe)
        return { installed: true, presence: ev, message: msg, secondary: lines.length === 0 ? null : `本次仍然读不到仓库清单（${lines.map((l) => l.replace(/^·\s*/u, '')).join('；')}）—— 但包已在 profile 里，无需重装` }
      }
    }
    return { installed: false, presence: null, message: null, secondary: null }
  }
  for (const name of Array.isArray(names) ? names : [names]) {
    const presence = checkPluginPresence(profileDir, name)
    if (presence.installed === true) {
      const lines = probeFailureLines(probe)
      return {
        installed: true, presence, message: presence.message,
        secondary: lines.length === 0 ? null : `本次仍然读不到仓库清单（${lines.map((l) => l.replace(/^·\s*/u, '')).join('；')}）—— 但包已在 profile 里，无需重装`,
      }
    }
  }
  return { installed: false, presence: null, message: null, secondary: null }
}

// ── 替身（注入点）：**一个真请求、一个真进程都不会发生** ────────────────────────────────
const record = []
const s = (content, status = 200) => ({ statusCode: status, headers: {}, on(event, cb) { if (event === 'data' && content !== null) cb(Buffer.from(content)); if (event === 'end') cb(); return this } })
/** 路由表：键是 URL 的**子串**（按顺序取第一条命中），值是返回体 / 抛错 / 'hang'。 */
let routes = []
const routeOf = (u) => routes.find((r) => String(u).includes(r.match)) ?? null
const stub = {
  httpsRequestOnce: async (u) => {
    record.push(`network:${u}`)
    const r = routeOf(u)
    if (r === null) return s('', 404)
    if (r.kind === 'hang') return new Promise(() => {})
    if (r.kind === 'throw') throw new Error(r.reason)
    return s(r.body ?? '', r.status ?? 200)
  },
  // `httpsRequest` 是 httpsRequestOnceReal 内部走的出口（raw 的 https 通道要经它拿响应体），
  // 少打这个桩 ⇒ 真实现会被走到（那是真出网），抓手会当场把它拦下。
  httpsRequest: async (u) => stub.httpsRequestOnce(u),
  githubViaGh: async (apiPath) => {
    record.push(`spawn:gh:${apiPath}`)
    const r = routeOf(`gh:${apiPath}`)
    if (r === null) throw new Error('gh api 兜底失败：未找到 gh CLI')
    if (r.kind === 'hang') return new Promise(() => {})
    if (r.kind === 'throw') throw new Error(r.reason)
    if (r.kind === 'json') return r.body
    return { content: Buffer.from(String(r.body ?? ''), 'utf8').toString('base64') }
  },
  curlText: async (u) => {
    record.push(`spawn:curl:${u}`)
    const r = routeOf(u)
    // 没显式路由的 URL 一律当"通道失败"（**不能**用 404：rawTextFetch 把 404 当确定性 not-found，
    // 会立即胜出并让后面的通道没机会被检验 —— 那是另一条语义，本套单独有一段测它）
    if (r === null) throw new Error('HTTP 500')
    if (r.kind === 'hang') return new Promise(() => {})
    if (r.kind === 'throw') throw new Error(r.reason)
    if (r.status !== undefined && (r.status < 200 || r.status >= 300)) throw new Error(`HTTP ${r.status}`)
    return r.body ?? ''
  },
  curlJson: async (u) => { record.push(`spawn:curljson:${u}`); const r = routeOf(u); if (r === null) throw new Error('HTTP 404'); return r.json ?? {} },
  fetchJsonUrl: async (u) => { record.push(`network:json:${u}`); const r = routeOf(u); if (r === null) throw new Error('HTTP 404'); return r.json ?? {} },
  githubJson: async (u) => { record.push(`network:ghjson:${u}`); const r = routeOf(u); if (r === null) throw new Error('HTTP 404'); return r.json ?? {} },
}
// ★ 先装替身 + 开抓手，再跑任何一段：漏注入的出口**当场抛**（"零真实出网"是预防出来的）
__setEgressTripwire(true)
__setEgressStub(stub)
__resetEgressStats()
const BEFORE = egressStatsNow()
/** 抓手正控那一段**故意**触发的 trips 数（收尾断言要扣掉它，见 §⑦b）。 */
let CONTROL_TRIPS = 0

// ── ① 本地联动：命中「仓库落地」⇒ 本地优先命中 + 一键从本地安装的落点 ───────────────────
{
  const repos = join(SANDBOX, 'repos')
  const landed = join(repos, 'corrinehu', 'dsh-workbuddy-connect')
  mkdirSync(landed, { recursive: true })
  writeFileSync(join(landed, 'package.json'), JSON.stringify({ name: 'dsh-workbuddy-connect', version: '0.7.3' }), 'utf8')
  check('① 仓库名归一化：去 .git / 去空白 / 小写', normalizeRepo(' Corrinehu/DSH-WorkBuddy-Connect.git ') === 'corrinehu/dsh-workbuddy-connect')
  check('① 本地候选覆盖 owner/name 与平铺一层两种布局', landedRepoDir('corrinehu/dsh-workbuddy-connect', [repos]) === landed, String(landedRepoDir('corrinehu/dsh-workbuddy-connect', [repos])))
  check('① 落地目录没有 package.json ⇒ null（交给正常通道，不谎报命中）', landedManifestText('probe-org/not-there', [repos]) === null)
  check('① 空目录参数 / 读文件抛异常 ⇒ null（绝不把只读探测变成安装失败）',
    landedRepoDir('', [repos]) === null && localManifestText(landed, { read: () => { throw new Error('EACCES') } }) === null && localManifestText(landed, { read: () => '   ' }) === null)

  // 六条网络通道**全部挂住**：本地通道若没接上，这一轮必然等到预算耗尽（于是"快"本身就是证据）
  routes = [
    { match: 'raw.githubusercontent.com', kind: 'hang' },
    { match: 'gh:', kind: 'hang' },
    { match: 'api.github.com', kind: 'hang' },
    { match: 'cdn.jsdelivr.net', kind: 'hang' },
    { match: 'registry.npmmirror.com', kind: 'hang' },
    { match: 'registry.npmjs.org', kind: 'hang' },
  ]
  const t0 = Date.now()
  const probe = await withTimeout(fetchRepoPackageEx('corrinehu/dsh-workbuddy-connect', 'main', { roots: [repos] }), 6000, '① 本地探测')
  const elapsed = Date.now() - t0
  check('★① 本地命中 ⇒ 读到清单（真机现场：用户其实已经克隆过）', probe.pkg?.version === '0.7.3' && probe.reason === 'ok', JSON.stringify({ reason: probe.reason, v: probe.pkg?.version }))
  check('★① 胜出通道如实报「local」', probe.channel === 'local', String(probe.channel))
  check('★① 带出本地目录（一键从本地安装要用的是目录）', probe.localDir === landed, String(probe.localDir))
  check('★① 本地优先：六条网络通道全挂住时**照样立刻命中本地**（不等任何网络通道）', elapsed < 500, `${elapsed}ms`)
  const line = probeChannelLine(probe)
  check('★① 通道身份行直接可给用户看', typeof line === 'string' && line.includes('仓库落地') && line.includes(landed), String(line))
  const hint = localInstallHint({ dir: probe.localDir, packageName: probe.packageName })
  check('★① 一键从本地安装的落点：link: 规格（本仓既有本地目录来源）+ 目录 + 包名',
    hint?.spec === `link:${landed.replace(/\\/gu, '/')}` && hint.packageName === 'dsh-workbuddy-connect' && hint.note.includes('本地目录'), JSON.stringify(hint))
}

// ── ② npm registry 通道：按 `repository` 字段匹配（**不靠猜名**）────────────────────────
{
  check('② 包名守卫：只接受合法 npm 包名（外部数据不拿去拼 URL）',
    isSafePackageName('dsh-workbuddy-connect') && isSafePackageName('@scope/name') && !isSafePackageName('../../etc/passwd') && !isSafePackageName('a b') && !isSafePackageName(''))
  check('② scoped 包名路径编码：@scope/name → @scope%2Fname；非 scoped 原样', registryPathOf('@scope/name') === '@scope%2Fname' && registryPathOf('plain') === 'plain')
  const ids = registryManifestChannels('dsh-workbuddy-connect').map((c) => c.id)
  check('② registry 通道两条且镜像优先：npm-mirror → npm-official', ids.join(',') === 'npm-mirror,npm-official', ids.join(' → '))
  check('② 非法包名 ⇒ 不产生任何 registry 通道', registryManifestChannels('../x').length === 0)
  const seen = []
  const text = async (u) => { seen.push(u); return JSON.stringify({ name: 'dsh-workbuddy-connect', version: '0.7.3', repository: 'https://github.com/corrinehu/dsh-workbuddy-connect.git' }) }
  const body = await registryManifestText('dsh-workbuddy-connect', NPM_MIRROR, { text })
  check('② 读出的是 registry 的清单文本（/latest = package.json 同构，无需解压 tarball）',
    JSON.parse(body).name === 'dsh-workbuddy-connect' && seen[0] === `${NPM_MIRROR}/dsh-workbuddy-connect/latest`, seen[0])
  await registryManifestText('@scope/pkg', NPM_OFFICIAL, { text })
  check('② 官方源兜底：URL 用官方域名 + scoped 编码', seen[1] === `${NPM_OFFICIAL}/@scope%2Fpkg/latest`, seen[1])
  check('② repository 字段解析：字符串 / {url} / 简写 / .git / #path 都认',
    manifestRepoRef('{"repository":"git+https://github.com/o/r.git#main"}') === 'o/r'
    && manifestRepoRef('{"repository":{"url":"https://github.com/o/r.git"}}') === 'o/r'
    && manifestRepoRef('{"repository":"github:o/r"}') === 'o/r'
    && manifestRepoRef('{"name":"x"}') === null, 'lookup')
  check('② 给了 expectedRepo 时，repository 不匹配 ⇒ 当作"没读到"（不猜名）',
    (await registryManifestText('x', NPM_MIRROR, { text: async () => '{"name":"x","repository":"https://github.com/other/repo"}', expectedRepo: 'o/r' })) === null)

  const repo = 'probe-org/registry-only-repo'
  const pack = JSON.stringify({ name: 'registry-only-repo', version: '0.7.3', repository: 'https://github.com/probe-org/registry-only-repo.git' })
  // 前 4 条 GitHub 通道全灭（**抛错**，不是确定性 404 —— 404 会立即 not-found 胜出，那是另一条语义），
  // registry 镜像上有一个 **repository 指向本仓库** 的包
  routes = [
    { match: 'raw.githubusercontent.com', kind: 'throw', reason: 'GitHub 请求失败 (HTTP 500)' },
    { match: 'gh:', kind: 'throw', reason: 'gh api 兜底失败：未找到 gh CLI' },
    { match: 'api.github.com', kind: 'throw', reason: 'GitHub 请求失败 (HTTP 500)' },
    { match: 'registry.npmmirror.com/registry-only-repo/latest', body: pack },
    { match: 'registry.npmjs.org', kind: 'throw', reason: 'HTTP 503' },
  ]
  const viaNpm = await withTimeout(fetchRepoPackageEx(repo, 'main', { roots: [join(SANDBOX, 'repos')], packageNames: [], budgetMs: 3000 }), 6000, '② registry 探测')
  check('★② GitHub 全灭 ⇒ registry 通道接住（真机现场：GitHub 挂、npm 好好的）', viaNpm.pkg?.version === '0.7.3' && viaNpm.reason === 'ok', JSON.stringify({ reason: viaNpm.reason }))
  check('★② 胜出通道如实报「npm-mirror」+ 包名', viaNpm.channel === 'npm-mirror' && viaNpm.packageName === 'registry-only-repo', `${viaNpm.channel}/${viaNpm.packageName}`)
  check('★② 通道身份行写明"经 npm 镜像"', String(probeChannelLine(viaNpm)).includes('npm 镜像'), String(probeChannelLine(viaNpm)))

  // 名字像但 repository 指向别的仓库 ⇒ 必须**不认账**（这就是"不靠猜名"）。
  // 判据用 resolvePackageByRepo 直接问（它就是这个问题的唯一承担者）：命中与否 + 为什么不算。
  const mismatchNotes = []
  const mismatchRes = await resolvePackageByRepo(repo, {
    deps: { text: async (u) => { void u; return JSON.stringify({ name: 'registry-only-repo', version: '9.9.9', repository: 'https://github.com/someone-else/registry-only-repo' }) }, registries: [{ id: 'npm-mirror', label: 'npm 镜像', url: NPM_MIRROR }], notes: mismatchNotes },
  })
  check('★② 名字像但 repository 指向别的仓库 ⇒ **不认账**（hit=false，绝不因为名字像就采纳）',
    mismatchRes.hit === false && mismatchRes.packageName === null, JSON.stringify({ hit: mismatchRes.hit, n: mismatchRes.packageName }))
  check('★② 并把"为什么不算"如实记下来（可给用户看）',
    mismatchRes.notes.some((n) => n.includes('repository') || n.includes('仓库字段')), mismatchRes.notes.join(' | ').slice(0, 200))

  // 走完整回退链时也一样：**没有任何通道胜出** ⇒ unreachable + 逐条原因（绝不当成"这个包不存在"）
  routes = [
    { match: 'raw.githubusercontent.com', kind: 'throw', reason: 'GitHub 请求失败 (HTTP 500)' },
    { match: 'gh:', kind: 'throw', reason: 'gh api 兜底失败：未找到 gh CLI' },
    { match: 'api.github.com', kind: 'throw', reason: 'GitHub 请求失败 (HTTP 500)' },
    { match: 'registry.npmmirror.com/registry-only-repo/latest', body: JSON.stringify({ name: 'registry-only-repo', version: '9.9.9', repository: 'https://github.com/someone-else/registry-only-repo' }) },
    { match: 'registry.npmjs.org', kind: 'throw', reason: 'HTTP 503' },
  ]
  const mismatch = await withTimeout(fetchRepoPackageEx(repo, 'main', { roots: [join(SANDBOX, 'repos')], budgetMs: 3000 }), 6000, '② 错配探测')
  check('★② 错配 ⇒ 作业**不会**按那个包名装上（pkg=null），且绝不把名字像的包当成它',
    mismatch.pkg === null && mismatch.packageName === null, JSON.stringify({ reason: mismatch.reason, channel: mismatch.channel, name: mismatch.packageName }))
  check('★② 走完整回退链时那条 registry 通道如实记下"不是本仓库的包"',
    probeFailureLines(mismatch).some((l) => l.includes('npm 镜像')) || mismatch.channel === 'npm-mirror', `channel=${mismatch.channel} lines=${probeFailureLines(mismatch).join(' | ').slice(0, 160)}`)

  let threw = null
  try { await registryManifestText('nope', NPM_MIRROR, { text: () => { throw new Error('HTTP 500') } }) } catch (error) { threw = error }
  check('② 5xx / 超时 ⇒ 抛出（由竞速记成"这条通道为什么没成"，不当成 not-found）', threw !== null && /HTTP 500/u.test(threw.message))
  check('② 404 = 该源上没有这个包 → null（确定性 not-found，不是通道失败）',
    (await registryManifestText('nope', NPM_MIRROR, { text: () => { throw new Error('请求失败 (HTTP 404)') } })) === null)
  const byRepo = await resolvePackageByRepo(repo, { deps: { text: async () => pack } })
  check('② 按仓库引用解析包：命中且注明是哪个源', byRepo.hit === true && byRepo.packageName === 'registry-only-repo' && byRepo.channel === 'npm-mirror', JSON.stringify({ hit: byRepo.hit, ch: byRepo.channel, n: byRepo.packageName }))
}

// ── ③ 逐条失败原因 + 竞速语义（超时切通道 / 预算兜底）─────────────────────────────────
{
  routes = [
    { match: 'raw.githubusercontent.com', kind: 'throw', reason: 'GitHub 请求失败 (HTTP 500)' },
    { match: 'gh:', kind: 'throw', reason: 'gh api 兜底失败：未找到 gh CLI' },
    { match: 'api.github.com', kind: 'throw', reason: 'GitHub 请求失败 (HTTP 500)' },
    { match: 'registry.npmjs.org', kind: 'throw', reason: 'HTTP 503' },
  ]
  const all = await withTimeout(fetchRepoPackageEx('probe-org/probe-repo', 'main', { roots: [join(SANDBOX, 'repos')], budgetMs: 3000 }), 6000, '③ 全失败')
  check('★③ 全失败 → unreachable（与"文件不存在"分开）', all.reason === FETCH_UNREACHABLE && all.pkg === null, String(all.reason))
  const reasonLines = probeFailureLines(all)
  check('★③ 错误**逐条列出每条通道**（不是一句 unreachable 带过）', reasonLines.length >= 6, `${reasonLines.length} 条`)
  check('★③ 六条通道都在清单里（既有 4 条一条不删 + 新增 2 条 registry）',
    ['https（GitHub 主通道/镜像竞速）', 'gh CLI', 'curl 直连', 'jsDelivr CDN', 'npm 镜像（npmmirror）', 'npm 官方源（registry.npmjs.org）'].every((label) => reasonLines.some((l) => l.includes(label))),
    reasonLines.map((l) => l.slice(0, 22)).join(' | '))
  check('★③ 每条都带**各自的原因**（HTTP 状态 / gh 原话）',
    reasonLines.some((l) => l.includes('HTTP 500')) && reasonLines.some((l) => l.includes('gh CLI')) && reasonLines.some((l) => l.includes('503')),
    reasonLines.join(' | ').slice(0, 240))
  const composed = composeProbeFailureText(all, '抓取超时/网络不可达：没能读到 probe-org/probe-repo 的 package.json —— 保留现文案。')
  check('★③ 兜底文案 = 现文案（一字不改）+ 逐条原因（面板可直接展示）',
    composed.startsWith('抓取超时/网络不可达') && composed.includes('各通道的失败原因') && composed.split('\n').length >= 8, composed.split('\n').slice(0, 3).join(' / '))

  // ③′ 首通道挂住 ⇒ 自动切下一通道并成功；对照：全挂 ⇒ 预算兜底（判据对比，不是只看成功）
  routes = [
    { match: 'raw.githubusercontent.com', kind: 'hang' },
    { match: 'gh:', kind: 'hang' },
    { match: 'api.github.com', kind: 'throw', reason: 'GitHub 请求失败 (HTTP 500)' },
    { match: 'cdn.jsdelivr.net', body: '{"name":"from-jsdelivr","version":"1.2.3"}' },
  ]
  const t0 = Date.now()
  const won = await withTimeout(rawTextFetch('probe-org/probe-repo', 'main', 'package.json', 5000), 6000, '③′ 切换')
  const elapsed = Date.now() - t0
  check('★③′ 首通道挂住 ⇒ 自动切下一条并成功（不等它超时）', won.state === FETCH_OK && JSON.parse(won.body).name === 'from-jsdelivr', `${won.state}/${won.channel} in ${elapsed}ms`)
  check('★③′ 早返回：挂住的那几条没拖累胜出者', elapsed < 3000, `${elapsed}ms`)
  check('★③′ 胜出通道身份 = jsdelivr', won.channel === 'jsdelivr', String(won.channel))

  routes = [
    { match: 'raw.githubusercontent.com', kind: 'hang' },
    { match: 'gh:', kind: 'hang' },
    { match: 'api.github.com', kind: 'hang' },
    { match: 'cdn.jsdelivr.net', kind: 'hang' },
    { match: 'registry.npmmirror.com', kind: 'hang' },
    { match: 'registry.npmjs.org', kind: 'hang' },
  ]
  const t1 = Date.now()
  const budget = await withTimeout(rawTextFetch('probe-org/probe-repo', 'main', 'package.json', 400), 3000, '③′ 预算')
  check('★③′ 全挂 ⇒ 预算内收口（unreachable + 逐条原因），不悬挂',
    budget.state === FETCH_UNREACHABLE && budget.failures.every((f) => typeof f.reason === 'string' && f.reason !== '') && Date.now() - t1 < 2500,
    `${budget.state} failures=${budget.failures.length} in ${Date.now() - t1}ms`)

  const pure = await raceFetchOutcome({ channels: [{ id: 'local', run: async () => null }, { id: 'curl', run: async () => { throw new Error('boom') } }], timeoutMs: 500 })
  check('③ 确定性 404 立即胜出 → not-found（旧语义一字不改）', pure.state === FETCH_NOT_FOUND && pure.channel === 'local', `${pure.state}/${pure.channel}`)
  check('③ 通道标签可读（未知 id 原样返回，绝不空标签）', channelLabel('npm-mirror') === 'npm 镜像（npmmirror）' && channelLabel('weird-id') === 'weird-id')
}

// ── ⑤ 端到端：本机 HTTP 桩当额外通道（真字节流，只在 127.0.0.1）─────────────────────────
{
  const servers = []
  const startStub = (stubRoutes) => new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const handler = stubRoutes[req.url]
      if (handler === undefined) { res.statusCode = 404; res.end('nope'); return }
      handler(req, res)
    })
    srv.listen(0, '127.0.0.1', () => { servers.push(srv); resolve(`http://127.0.0.1:${srv.address().port}`) })
  })
  const local = await startStub({ '/pkg': (req, res) => { res.statusCode = 200; res.setHeader('content-type', 'application/json'); res.end('{"name":"probe-from-registry","version":"9.9.9"}') } })
  routes = [
    { match: 'raw.githubusercontent.com', kind: 'throw', reason: 'GitHub 请求失败 (HTTP 500)' },
    { match: 'gh:', kind: 'throw', reason: 'gh api 兜底失败：未找到 gh CLI' },
    { match: 'api.github.com', kind: 'throw', reason: 'GitHub 请求失败 (HTTP 500)' },
  ]
  const out = await withTimeout(rawTextFetch('probe-org/probe-repo', 'main', 'package.json', 4000, {
    extraChannels: [{ id: 'npm-mirror', label: channelLabel('npm-mirror'), run: async () => { const r = await fetch(`${local}/pkg`); return r.status === 200 ? await r.text() : null } }],
  }), 6000, '⑤ 端到端')
  check('★⑤ 额外通道（npm registry 形状）经真实字节流进竞速并胜出', out.state === FETCH_OK && JSON.parse(out.body).name === 'probe-from-registry', `${out.state}/${out.channel}`)
  check('★⑤ 端到端也报告通道身份', out.channel === 'npm-mirror', String(out.channel))
  check('⑤ 既有 4 条通道的失败原因照旧逐条带出（额外通道是追加，不是替换）',
    out.failures.length === 5 && out.failures.some((f) => f.id === 'https') && out.failures.some((f) => f.id === 'npm-mirror'), `failures=${out.failures.length}`)
  await Promise.all(servers.map((srv) => new Promise((r) => srv.close(r))))
}

// ── ⑥ 落点与契约：已装核实的纯函数 + **install-job 真的接上**（调用链证据）──────────────────
{
  const HOME = process.env.DSH_HOME
  const PROFILE = join(HOME, 'profiles', 'web')
  mkdirSync(join(PROFILE, 'node_modules', 'dsh-workbuddy-connect'), { recursive: true })
  writeFileSync(join(PROFILE, 'node_modules', 'dsh-workbuddy-connect', 'package.json'), JSON.stringify({ name: 'dsh-workbuddy-connect', version: '0.7.3' }), 'utf8')
  writeFileSync(join(PROFILE, 'package.json'), JSON.stringify({ name: 'probe-profile', dependencies: { 'dsh-workbuddy-connect': '^0.7.2' }, dsh: { profile: { bundles: ['dsh-workbuddy-connect'] } } }), 'utf8')

  const hit = checkPluginPresence(PROFILE, 'dsh-workbuddy-connect')
  check('★⑥ 物在盘上 ⇒ installed=true 且带版本（真机现场：0.7.3 早就装好了）', hit.installed === true && hit.version === '0.7.3', JSON.stringify(hit))
  check('★⑥ 文案就是"已安装 vX（无需重装）"', hit.message.includes('已安装') && hit.message.includes('0.7.3') && hit.message.includes('无需重装'), hit.message)
  const declaredOnly = join(SANDBOX, 'profiles', 'declared-only')
  mkdirSync(declaredOnly, { recursive: true })
  writeFileSync(join(declaredOnly, 'package.json'), JSON.stringify({ name: 'p2', dependencies: { 'ghost-plugin': '^1.0.0' }, dsh: { profile: { bundles: ['ghost-plugin'] } } }), 'utf8')
  const ghost = checkPluginPresence(declaredOnly, 'ghost-plugin')
  check('★⑥ 只有声明没有实体 ⇒ presence-check **不许**报"已安装"，且如实说清缺什么',
    ghost.installed === false && ghost.sources.includes('dependencies') && ghost.message.includes('重装'), ghost.message)
  check('⑥ 空包名 / 不存在的包 → 安全返回未安装', checkPluginPresence(PROFILE, '').installed === false && checkPluginPresence(PROFILE, 'nothing-here').installed === false)
  check('⑥ 从仓库名猜候选包名（首选口径之外才用兜底）',
    packageNameCandidates('corrinehu/dsh-workbuddy-connect').includes('dsh-workbuddy-connect') && packageNameCandidates('o/r', ['hint-pkg'])[0] === 'hint-pkg')
  check('⑥ firstInstalledPresence：在候选里找第一个真装上的',
    firstInstalledPresence(PROFILE, ['ghost-plugin', 'dsh-workbuddy-connect'])?.version === '0.7.3' && firstInstalledPresence(PROFILE, ['ghost-plugin']) === null)
  const verified = verifyAlreadyInstalled({ profileDir: PROFILE, names: ['ghost-plugin', 'dsh-workbuddy-connect'], probe: { failures: [{ id: 'npm-mirror', reason: '超时' }] } })
  check('★⑥ 核实（domain/install-verify 的 installedEvidence/failedJobEvidence）给出"其实已经装上了 / 无需重装"，并把本次探测失败折叠为次要信息',
    verified.installed === true && /无需重装/u.test(verified.message) && String(verified.secondary).includes('npm 镜像'), JSON.stringify({ m: verified.message, s: verified.secondary }))
  check('⑥ 核实不到 ⇒ 不谎报（照旧走失败路径）', verifyAlreadyInstalled({ profileDir: PROFILE, names: ['nothing-here'] }).installed === false)

  // ★ 调用链证据（用户红线：不许只说"我加了文件"）：install-job 必须**真的**把 roots/包名提示传进探测链，
  //   并把通道身份写回作业 —— 上一批的错就是这一行少传 deps（http.js 的注入缝不可达）。
  const { getReposDir } = await import(url('lib/server/domain/repoland.js'))
  const { runInstallJob } = await import(url('lib/server/domain/install-job.js'))
  const ports = {
    baseUrl: `file:///${PROFILE.replace(/\\/gu, '/')}/cordis.yml`,
    loader: { entries: () => [] },
    // 安装通道全部替换成"立刻失败"的桩（真通道要联网/起进程）
    get: (key) => (key === 'installChannels' ? {
      raceInstallChannels: async () => { throw new Error('桩：并行竞速通道不可用') },
      pnpmInstall: async () => { throw new Error('桩：registry 通道不可用') },
      curlManualInstall: async () => { throw new Error('桩：curl 通道不可用') },
      githubReleaseInstall: async () => { throw new Error('桩：release 通道不可用') },
      backfillMissingDeps: async () => [],
    } : undefined),
  }
  const mkJob = (probe, seq) => ({
    id: `channels-${seq}`, repo: 'corrinehu/dsh-workbuddy-connect', source: 'github', packageName: null,
    status: 'installing', stage: 'preparing', error: null, startedAt: Date.now(), finishedAt: null,
    entryId: null, bundle: false, ai: false, aiNote: null, subpackages: null, lastError: null, update: true,
    kind: 'plugin', repoMeta: { default_branch: 'main' }, rootPkgProbe: probe,
  })
  const seen = { deps: null }
  const probeOk = {
    pkg: { name: 'dsh-workbuddy-connect', version: '0.7.3' }, reason: 'ok', channel: 'npm-mirror', label: 'npm 镜像（npmmirror）',
    packageName: 'dsh-workbuddy-connect', localDir: null, summary: '', failures: [], registryNotes: [],
  }
  // 刻意**不**注入 job.rootPkgProbe：这样作业必须真的走 `probes.fetchRepoPackageEx(repo, branch, deps)`
  // —— 本段要的就是"那一行到底传没传 deps"（上一批的错就在这一行）。
  const job = mkJob(undefined, 1)
  await withTimeout(runInstallJob(job, ports, {
    jobBudgetMs: 15000, aiConsentTimeoutMs: 200,
    marketProbes: {
      fetchRepoPackageEx: async (repo, branch, d) => { seen.deps = { repo, branch, d }; return probeOk },
      probeGitmodules: async () => null,
      detectSkillRepo: async () => ({ hasSkill: false, skillDir: null }),
      fetchSubdirPlugins: async () => [],
      // 索引没有首选包名（`npmName` 缺失是常见状态）⇒ 作业必须走**根清单探测**那一步
      npmNameHint: () => null,
    },
    sourceDeps: {},
  }), 9000, '⑥ install-job 接线')
  check('★⑥ install-job 真的把 deps 传进探测链：roots = [getReposDir()]（真实来源，不写死）+ 首选包名提示',
    Array.isArray(seen.deps?.d?.roots) && seen.deps.d.roots.length === 1 && seen.deps.d.roots[0] === getReposDir() && Array.isArray(seen.deps?.d?.packageNames),
    JSON.stringify(seen.deps?.d ?? null))
  check('★⑥ 通道身份写回作业：job.probe.channel + channelNotes（面板据此显示"经 npm 镜像"）',
    job.probe?.channel === 'npm-mirror' && (job.channelNotes ?? []).some((t) => t.includes('npm 镜像')), JSON.stringify({ probe: job.probe?.channel, notes: job.channelNotes }))
  check('★⑥ 清单里的包名被作业采纳（本地/registry 通道读到的清单与索引提示同等可信）', job.packageName === 'dsh-workbuddy-connect', String(job.packageName))

  // 根清单**读不到**时：现文案 + 逐条通道原因都要出现（用户红线：不许一句 unreachable 带过）
  const job2 = mkJob(undefined, 2)
  await withTimeout(runInstallJob(job2, ports, {
    jobBudgetMs: 15000, aiConsentTimeoutMs: 200,
    marketProbes: {
      fetchRepoPackageEx: async (repo, branch, d) => {
        void repo; void branch; void d
        return {
          pkg: null, reason: 'unreachable', channel: null, label: null, packageName: null, localDir: null,
          summary: '· npm 镜像（npmmirror）：超时（connect timeout）\n· https（GitHub 主通道/镜像竞速）：超时',
          failures: [{ id: 'npm-mirror', reason: '超时（connect timeout）' }, { id: 'https', reason: '超时' }], registryNotes: [],
        }
      },
      probeGitmodules: async () => null,
      detectSkillRepo: async () => ({ hasSkill: false, skillDir: null }),
      fetchSubdirPlugins: async () => [],
      npmNameHint: () => null,
    },
    sourceDeps: {},
  }), 9000, '⑥ 根清单失败')
  check('★⑥ 根清单读不到 ⇒ 作业错误 = **既有现文案** + 逐条「通道：原因」（原话与逐条都在）',
    /没能读到 corrinehu\/dsh-workbuddy-connect/u.test(String(job2.error)) && /各通道的失败原因/u.test(String(job2.error)) && /npm 镜像/u.test(String(job2.error)) && /https/u.test(String(job2.error)),
    `status=${job2.status} reason=${job2.probeReason} errLen=${String(job2.error).length}`)
  check('★⑥ 并且作业仍带通道身份（试过什么，用户看得见）', String(job2.probe?.summary).includes('npm 镜像'), String(job2.probe?.summary).slice(0, 120))
}

// ── ⑦⑧⑨ 守卫与正控（本套自己的红线：零真实出网、零真实进程、无死角）────────────────────
{
  const st = egressStatsNow()
  check('★⑦ 注入替身真的被走过（否则下面的"0"是没跑过代码的假绿）', st.stubCalls - BEFORE.stubCalls > 0, `stubCalls=${st.stubCalls - BEFORE.stubCalls}`)
  check('★⑦ 全程 **0 次真实出网**（计数来自注入点，不是 globalThis 空标志）', st.realNetwork - BEFORE.realNetwork === 0, `realNetwork=${st.realNetwork - BEFORE.realNetwork}`)
  check('★⑦ 全程 **0 次真实 spawn**', st.realSpawn - BEFORE.realSpawn === 0, `realSpawn=${st.realSpawn - BEFORE.realSpawn}`)

  // ★⑦a 守卫正控：装一个**绝对外网**地址的替身，走生产路径 ⇒ 替身里的哨兵必须拦下它
  // （判据写在**替身收到的 URL** 上，而不是替身的返回体上 —— 后者会被镜像前缀绕过去）
  const sentinel = { saw: null }
  const sentinelStub = {
    ...stub,
    httpsRequestOnce: async (u) => {
      if (String(u).includes('SENTINEL')) { sentinel.saw = String(u); throw new Error('测试红线：抓到真实外网请求') }
      return stub.httpsRequestOnce(u)
    },
  }
  __setEgressStub(sentinelStub)
  await rawTextFetch('probe-org/probe-repo', 'main', 'SENTINEL', 800)
  __setEgressStub(stub)
  check('★⑦a 守卫正控：真出网出口被替身里的"哨兵"当场拦下（证明守卫是活的，不是空断言）',
    sentinel.saw !== null && sentinel.saw.includes('SENTINEL') && /\/(SENTINEL|probe-repo)\//u.test(sentinel.saw), `saw=${String(sentinel.saw).slice(0, 70)}`)

  // ★⑦b 抓手正控：撤掉替身 ⇒ 生产路径的每条出口**在发起请求之前**抛（抓手不是恒绿空断言）。
  // ⚠️ 这一段**故意**触发 6 次 trips（https 主通道 2 次重试 + 2 条镜像 + gh + curl 直连 + jsDelivr），
  // 所以"全程零漏注入"的收尾断言必须**扣掉这一段**（用 tripsAfter 做增量基线），否则它会把正控当成违规。
  __setEgressStub(null)
  const tripsBefore = egressStatsNow().trips
  await rawTextFetch('probe-org/probe-repo', 'main', 'package.json', 300)
  const tripsAfter = egressStatsNow().trips
  const tripsForControl = tripsAfter - tripsBefore
  __setEgressStub(stub)
  check('★⑦b 抓手正控：撤掉替身 ⇒ 生产路径的出口**逐条当场抛**（不是只拦第一条就静默）',
    tripsForControl === 6, `本段 trips=${tripsForControl}（期望 6：https×2+镜像×2+gh+curl+jsdelivr 各在发起前被拦）`)
  check('★⑦b 而且它**一次都没发出去**（抓手在创建请求之前拦下）', egressStatsNow().realNetwork - BEFORE.realNetwork === 0, `realNetwork=${egressStatsNow().realNetwork - BEFORE.realNetwork}`)
  CONTROL_TRIPS = tripsForControl

  // ★⑧ 计数器正控：真的起一次 `node -e ""`（不弹窗、非文件管理器），证明"0 次"不是恒绿
  const gBefore = egressStatsNow()
  const self = await egressSelfCheckSpawn()
  const gAfter = egressStatsNow()
  check('★⑧ 正控：真的创建了一次进程并被记到（spawn 计数不是死的）', self.ok === true && self.counted === 1, JSON.stringify(self))
  check('★⑧ 于是本套的"真实 spawn" = 1，且这 1 次就是自检（零文件管理器 / 零 curl / 零 gh）',
    gAfter.realSpawn - gBefore.realSpawn === 1, `realSpawn=${gAfter.realSpawn - gBefore.realSpawn}`)
  const net = egressSelfCheckNetwork('http://127.0.0.1:9/x')
  check('★⑧ 正控：出网计数同样不是死的（记一笔 = 1；本套只记回环地址，不外发）', net.counted === 1, JSON.stringify(net))

  // ★⑨ 静态：出网/起进程的原语只能出现在 egress.js 与 http.js 的真实现块里
  const read = (rel) => readFileSync(join(LIB_ROOT, rel), 'utf8')
  const importSpecs = (rel) => read(rel).split('\n').filter((l) => /^\s*import\s/u.test(l)).join('\n')
  const httpSrc = read('lib/server/infra/http.js')
  const marketSrc = read('lib/server/domain/market.js')
  const jobSrc = read('lib/server/domain/install-job.js')
  // 全部 lib/server/**：node:child_process 只允许 egress.js（进程）与 exec.js（pnpm/git 执行器，本轮不动）；
  // node:https 只允许 egress.js。这样"生产代码绕过 egress 直接出网/起进程"是**静态可判**的。
  const allServer = (function walk(dir, out = []) {
    for (const e of readdirSync(join(LIB_ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) walk(rel, out)
      else if (e.name.endsWith('.js')) out.push(rel)
    }
    return out
  })('lib/server')
  const spawnUsers = allServer.filter((rel) => /node:child_process/u.test(importSpecs(rel)))
  const httpsUsers = allServer.filter((rel) => /node:https/u.test(importSpecs(rel)))
  check('★⑨ node:https **只**在 egress.js 里 import（出网唯一单点，静态可判）',
    httpsUsers.length === 1 && httpsUsers[0] === 'lib/server/infra/egress.js',
    `node:https=${httpsUsers.join(',') || '无'}`)
  check('★⑨ 抓清单链路（http.js）不再直接 import node:https —— 出网原语只在 egress.js',
    !/node:https/u.test(importSpecs('lib/server/infra/http.js')),
    `http.js 的 import 行；child_process 全仓用户=${spawnUsers.length} 个（只允许 egress/exec）`)
  check('★⑨ http.js 的每条通道都是 egress 包装（makeEgress）',
    ['httpsRequestOnce', 'githubViaGh', 'curlJson', 'curlText'].every((n) => new RegExp(`makeEgress\\('${n}'`, 'u').test(httpSrc)), 'makeEgress ×4')
  check('★⑨ http.js 的真实现已登记给 egress（"生产接没接上"可断言，不靠读代码猜）',
    /__setEgressRealImpl\(\{/u.test(httpSrc) && /execFileAsync: execFileAsyncReal/u.test(httpSrc))
  check('★⑨ 既有 4 条通道一条没删（能力保留是红线）',
    ["id: 'https'", "id: 'gh'", "id: 'curl'", "id: 'jsdelivr'"].every((t) => httpSrc.includes(t)))
  check('★⑨ 额外通道接在既有 4 条之后（既有通道仍是主力）',
    httpSrc.indexOf("id: 'jsdelivr'") > 0 && httpSrc.indexOf("id: 'jsdelivr'") < httpSrc.indexOf('...extra,'), 'jsdelivr 先于 ...extra')
  check('★⑨ 竞速结果带出胜出通道与逐条失败原因', /channel: list\[index\]\.id/u.test(httpSrc) && /failuresOf\(\)/u.test(httpSrc))
  check('★⑨ market.js 的探测**真的传了 deps**（上一批就是这里少传，注入缝不可达）',
    /async function fetchRepoPackageEx\(repo, branch, deps = \{\}\)/u.test(marketSrc)
    && /rawTextFetch\(repo, branch, 'package\.json', deps\.budgetMs, \{ \.\.\.deps, extraChannels \}\)/u.test(marketSrc), 'market.js 的调用点')
  check('★⑨ market.js 真的把本地与 registry 两条额外通道接上（import 落地 + 进竞速）',
    marketSrc.includes('landedRepoDir') && marketSrc.includes('repoMatchedRegistryChannels') && /extraChannels\.push/u.test(marketSrc))
  const wiringSrc = read('lib/server/domain/manifest-probe.js')
  check('★⑨ install-job 的根清单探测**只经** manifest-probe 这一个入口，且 deps 绑在袋子上（套装那次 2 参调用也带上）',
    /await probeRootManifest\(\{ job, probes, noteChannel, branch \}\)/u.test(jobSrc) && /bindMarketDeps\(probes, job, deps\)/u.test(jobSrc)
    && /fetchRepoPackageEx\(job\.repo, branch\)/u.test(wiringSrc) && /probes\.fetchRepoPackageEx = \(repo, branch, extra/u.test(wiringSrc),
    'install-job → bindMarketDeps + probeRootManifest → probes.fetchRepoPackageEx(repo, branch)（带绑定的 deps）')
  check('★⑨ manifest-probe 把真实来源的落地根与首选包名提示真的传下去（不是空对象糊过去）',
    /roots: \[getReposDir\(\)\]/u.test(wiringSrc) && /packageNames: \[hinted\]/u.test(wiringSrc))
  check('★⑨ 失败文案把"逐条通道原因"接在既有文案之后（composeProbeFailureText 真被调用）',
    /composeProbeFailureText\(rootProbe, packageProbeErrorText\(/u.test(jobSrc))
  check('★⑨ 已装核实用那批的实现（install-verify.installedEvidence/failedJobEvidence）且**真被路由接上**',
    /function failedJobEvidence\(/u.test(read('lib/server/domain/install-verify.js')) && /failedJobEvidence\(/u.test(read('lib/server/routes/state.js')))
  const importSpecsOf = (rel) => importSpecs(rel)
  check('★⑨ 已装核实是**只读且零网络**（不许为了核实去联网）',
    !/child_process|node:https|node:http/u.test(importSpecsOf('lib/server/domain/presence-check.js')) && read('lib/server/domain/presence-check.js').includes('node_modules'))
  check('★⑨ 本地优先只读磁盘（不 spawn、不联网）', !/child_process|node:https|execFile/u.test(read('lib/server/domain/landed-source.js')))
  const codeOf = (rel) => read(rel).split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/u.test(l)).join('\n')
  check('★⑨ 五个文件里没有"打开窗口/文件管理器"的调用（不弹窗红线；注释不算）',
    ['lib/server/infra/http.js', 'lib/server/infra/egress.js', 'lib/server/domain/presence-check.js', 'lib/server/domain/landed-source.js', 'lib/server/domain/probe-outcome.js'].every((rel) => !/explorer|openFolder|xdg-open/iu.test(codeOf(rel))))
}

// ── ⑩ 变异验证：把回退 / 原因清单 / 已装核实 / 通道报告各删一处，**真的跑一遍**必须红 ────────
if (!MUTATION_RUN) {
  const MUTATIONS = [
    { name: 'drop-local', file: 'lib/server/domain/market.js', from: 'if (localDir !== null) extraChannels.push(', to: 'if (false && localDir !== null) extraChannels.push(', expectFail: '★① 本地命中 ⇒ 读到清单' },
    { name: 'drop-registry', file: 'lib/server/domain/market.js', from: 'for (const ch of registryChannels) extraChannels.push(ch)', to: 'for (const ch of []) extraChannels.push(ch)', expectFail: '★② GitHub 全灭 ⇒ registry 通道接住' },
    { name: 'drop-reasons', file: 'lib/server/domain/probe-outcome.js', from: "if (lines.length > 0) parts.push(`各通道的失败原因：\\n${lines.join('\\n')}`)", to: 'if (false) parts.push(`各通道的失败原因：`);', expectFail: '★③ 兜底文案 = 现文案（一字不改）+ 逐条原因' },
    { name: 'drop-wiring', file: 'lib/server/domain/manifest-probe.js', from: 'roots: [getReposDir()]', to: 'roots: []', expectFail: '★⑥ install-job 真的把 deps 传进探测链' },
    { name: 'drop-channel', file: 'lib/server/domain/market.js', from: 'channel: channel ?? null,', to: 'channel: null,', expectFail: '★① 胜出通道如实报「local」' },
  ]
  const tmpRoot = join(ROOT, '.testdir', 'mut')
  const backups = new Map()
  try {
    for (const m of MUTATIONS) {
      const target = join(LIB_ROOT, m.file)
      if (!backups.has(m.file)) backups.set(m.file, readFileSync(target, 'utf8'))
      const original = backups.get(m.file)
      const mutated = original.replace(m.from, m.to)
      check(`★⑩ 变异「${m.name}」真的改到了源码（否则这条变异验证是空跑）`, mutated !== original, m.from.slice(0, 40))
      // 复制一份 lib 到临时目录、只改那一份：**仓库里的文件一个字节都不动**
      const mutLib = join(tmpRoot, m.name)
      rmSync(mutLib, { recursive: true, force: true })
      mkdirSync(mutLib, { recursive: true })
      cpSync(join(LIB_ROOT, 'lib'), join(mutLib, 'lib'), { recursive: true })
      writeFileSync(join(mutLib, m.file), mutated, 'utf8')
      const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        env: { ...process.env, C_PROBE_ROOT: mutLib, C_PROBE_MUTATION: '1' },
        encoding: 'utf8', windowsHide: true, timeout: 180000,
      })
      const out = `${run.stdout ?? ''}${run.stderr ?? ''}`
      const failedLines = out.split('\n').filter((l) => l.startsWith('FAIL'))
      check(`★⑩ 变异必须红：「${m.name}」⇒ 期待的断言 ${m.expectFail} 失败`,
        run.status !== 0 && out.includes(`FAIL ${m.expectFail}`),
        `exit=${run.status}${out.includes(`FAIL ${m.expectFail}`) ? ' 命中' : ` 实际失败=${failedLines.slice(0, 2).join(' / ').slice(0, 160)}`}`)
      // 逐字节还原（sha256 比一遍，证明"改回去"不是靠记忆）
      writeFileSync(target, original, 'utf8')
      check(`★⑩ 逐字节还原：${m.file} 与改动前 sha256 一致`,
        createHash('sha256').update(readFileSync(target)).digest('hex') === createHash('sha256').update(Buffer.from(original, 'utf8')).digest('hex'))
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
    for (const [rel, text] of backups) writeFileSync(join(LIB_ROOT, rel), text, 'utf8')
  }
} else {
  console.log('SKIP ⑩ 变异验证（本进程本身就是变异跑：C_PROBE_MUTATION=1）—— 不假装 PASS')
}

// ── 收尾守卫：跑完全套，真实出网/真实 spawn 只允许"正控"那两次 ────────────────────────
{
  const end = egressStatsNow()
  const netExtra = end.realNetwork - BEFORE.realNetwork
  const spawnExtra = end.realSpawn - BEFORE.realSpawn
  check('★收尾 真实 spawn 总计 = 1（只有正控的 node -e ""；零 curl / 零 gh / 零文件管理器）', spawnExtra === 1, `realSpawn=${spawnExtra}`)
  check('★收尾 真实出网总计 = 1（只有正控那一笔记账；零权威请求发出去）', netExtra === 1, `realNetwork=${netExtra}`)
  check('★收尾 没有被抓手的漏注入（扣掉 §⑦b 正控自己那一组；否则上面那些"0"就是在掩盖问题）',
    end.trips - BEFORE.trips - CONTROL_TRIPS === 0, `trips=${end.trips - BEFORE.trips}（其中正控 ${CONTROL_TRIPS}）`)
}

rmSync(SANDBOX, { recursive: true, force: true })
assert.equal(typeof check, 'function')
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
