// 自更新（「只更新控制台自己」）的自动化验证 —— 用户 2026-11-04 第 2 项，加法。
//
//   用户原话：「我的意思是，自更新我们的插件本身」「然后弄功能包一个按钮，[自更新]，默认打开」。
//   范围**严格限定** `@noob-stupid/dsh-plugin-console` 自己：绝不自动更新任何别的插件。
//
// 本套钉住九件事（每条都对应 domain/self-auto-update.js 顶部的一条硬规矩）：
//   ① `enabled:false` ⇒ 零请求、零安装、零写盘（负控：关掉就必须真的什么都不做）；
//   ② 远端**不高于**本地 ⇒ 不装（相等 / 更低都算"不用装"）；
//   ③ 远端更高 ⇒ 走**覆盖式安装**（真实跑 install-self-overlay + selfupdate-copy 那条路）、
//      **断言 pnpm 调用 0 次**、版本读回核对通过、`lastResult` 如实落盘；
//   ④ 安装失败 ⇒ 如实失败 + 从 `self-update-guard` 的备份**真的恢复**了 + 记下 `failedVersion`；
//   ⑤ 同一版本 6 小时内不重试（注入时间），过了窗口才重试；成功后清空退避；
//   ⑥ 有安装锁 / 有安装作业 / 框架升级中 ⇒ `skipped` 且**零动作**（框架升级那条与既有
//      `/framework-upgrade-status` 路由**对同一现场给同一结论**，不是自己猜状态）；
//   ⑦ 配置文件损坏 ⇒ 降级默认值、**不覆盖原文件**（要么原样不动、要么改名留档）、有 note；
//   ⑧ UI：默认开启显示、字段缺失显示「—」、切换真的发 POST、失败显示服务端原文；
//   ⑨ 变异防线：只更新自己 / 零 pnpm / 退避 三处一松，本套必红（见文件末尾 === ⑨ ===）。
//
// 纪律：隔离 `DSH_HOME`（绝不碰用户真实的 ~/.dsh）；夹具全部绝对路径；不联网（fetchJson / download /
// extract 全注入）；跑测试前清 ELECTRON_RUN_AS_NODE。
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, utimesSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'self-auto-update-home')
const SELF = '@noob-stupid/dsh-plugin-console'
const PROFILE = join(HOME, 'profiles', 'web')
const CONSOLE_DIR = join(HOME, 'plugin-console')
const CONFIG = join(CONSOLE_DIR, 'auto-update.json')
const PKG_DIR = join(PROFILE, 'node_modules', ...SELF.split('/'))

process.env.DSH_HOME = HOME // 必须在 import 之前落地（dshHome() 每次调用现读）
rmSync(HOME, { recursive: true, force: true })
mkdirSync(CONSOLE_DIR, { recursive: true })
mkdirSync(join(HOME, 'tmp'), { recursive: true })

let failed = 0
const check = (labelText, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${labelText}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const quiet = (fn) => { const saved = console.log; console.log = () => {}; try { return fn() } finally { console.log = saved } }

// 静态 import 已全部在上面；这两个是"要在 DSH_HOME 落地之后才求值"的，用动态 import。
const domain = await import('../lib/server/domain/self-auto-update.js')
const installLock = await import('../lib/server/domain/install-lock.js')

// ── 夹具 ───────────────────────────────────────────────────────────────────────
const clock = {
  t: Date.parse('2026-11-04T20:00:00Z'),
  latest: '0.5.101',
  now() { return this.t },
}

function writeSelfPackage(version) {
  mkdirSync(PKG_DIR, { recursive: true })
  writeFileSync(join(PKG_DIR, 'package.json'), JSON.stringify({ name: SELF, version, main: 'index.js' }, null, 2), 'utf8')
  writeFileSync(join(PKG_DIR, 'index.js'), 'export const ok = true\n', 'utf8')
}

/** 每节测试前的洁净现场：profile 里装着一份 0.5.100 的完整自身副本，没有任何配置文件。 */
function reset(state) {
  rmSync(join(PROFILE, 'node_modules'), { recursive: true, force: true })
  rmSync(CONSOLE_DIR, { recursive: true, force: true })
  mkdirSync(CONSOLE_DIR, { recursive: true })
  mkdirSync(join(HOME, 'tmp'), { recursive: true })
  installLock.__resetInstallLocks()
  writeSelfPackage(state?.version ?? '0.5.100')
  clock.t = Date.parse('2026-11-04T20:00:00Z')
  clock.latest = state?.latest ?? '0.5.101'
}

function writeConfigRaw(text) {
  mkdirSync(CONSOLE_DIR, { recursive: true })
  writeFileSync(CONFIG, text, 'utf8')
}
const writeConfig = (obj) => writeConfigRaw(`${JSON.stringify(obj, null, 2)}\n`)
const readConfigFile = () => JSON.parse(readFileSync(CONFIG, 'utf8'))

/**
 * 注入全套依赖（**不联网、不跑外部命令**）：probe / 元数据 / tarball 下载 / 解包全部打桩，
 * 但覆盖式安装、硬链接处理、备份与自愈都是**真实实现** —— 只有"字节从哪来"是假的。
 * `counters.pnpm` 是"有没有偷偷跑包管理器"的记录桩；`counters.exec` 是"有没有跑任何外部命令"。
 */
function makeDeps(overrides = {}) {
  const counters = { probe: 0, fetchJson: 0, download: 0, extract: 0, pnpm: 0, exec: 0 }
  const deps = {
    profileDir: PROFILE,
    registries: ['https://registry.example'],
    env: {}, // 不继承 DSH_TEST_SKIP_NETWORK（CI 里那个＝1，会把 tarball 预下载直接跳过）
    tmpDir: () => join(HOME, 'tmp'),
    now: () => clock.now(),
    probeRegistry: async () => { counters.probe += 1; return { resolvable: true, latest: clock.latest, tried: [] } },
    fetchJson: async () => {
      counters.fetchJson += 1
      return { versions: { [clock.latest]: { dist: { tarball: `https://registry.example/pkg-${clock.latest}.tgz`, integrity: 'sha512-dGVzdA==' } } } }
    },
    download: async (url, dest) => { counters.download += 1; writeFileSync(dest, Buffer.from('fake-tarball-bytes'), 'utf8') },
    extract: async (tgz, dir) => {
      counters.extract += 1
      const pkg = join(dir, 'package')
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: SELF, version: clock.latest, main: 'index.js' }, null, 2), 'utf8')
      writeFileSync(join(pkg, 'index.js'), 'export const ok = true\n', 'utf8')
      writeFileSync(join(pkg, 'lib-note.txt'), `来自 ${clock.latest} 的覆盖包\n`, 'utf8')
    },
    exec: async (cmd) => {
      counters.exec += 1
      if (/pnpm/iu.test(String(cmd))) counters.pnpm += 1
      throw new Error('测试里不许执行任何外部命令')
    },
    ...overrides,
  }
  return { deps, counters }
}
const installedVersion = () => {
  try { return JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version } catch { return null }
}

console.log('=== ① enabled:false ⇒ 零请求、零安装、零写盘（负控）===')
{
  reset({ latest: '0.5.101' })
  writeConfig({ enabled: false, intervalHours: 6, lastCheckAt: null, lastResult: null })
  const before = readFileSync(CONFIG, 'utf8')
  const { deps, counters } = makeDeps()
  const r = await domain.checkAndUpdate({ deps })
  check('① 关掉后 skipped = disabled', r.skipped === 'disabled', `skipped=${r.skipped} reason=${r.reason}`)
  check('① 关掉后没查过版本（checked=false）', r.checked === false, `checked=${r.checked}`)
  check('① 关掉后零 registry 探测、零元数据请求、零下载、零解包',
    counters.probe === 0 && counters.fetchJson === 0 && counters.download === 0 && counters.extract === 0,
    JSON.stringify(counters))
  check('① 关掉后零写盘（配置文件一个字节都没变）', readFileSync(CONFIG, 'utf8') === before)
  check('① 关掉后盘上版本没被碰过', installedVersion() === '0.5.100', String(installedVersion()))
}

console.log('\n=== ② 远端不高于本地 ⇒ 不装 ===')
{
  reset({ latest: '0.5.100' }) // 相等
  const { deps, counters } = makeDeps()
  const r = await domain.checkAndUpdate({ deps })
  check('② 远端 = 本地 ⇒ skipped = up-to-date', r.skipped === 'up-to-date' && r.updated === false, `skipped=${r.skipped}`)
  check('② 相等时零安装动作（没下载、没解包）', counters.download === 0 && counters.extract === 0, JSON.stringify(counters))
  check('② up-to-date 也如实记了 lastCheckAt / lastResult',
    readConfigFile().lastCheckAt === clock.t && readConfigFile().lastResult.skipped === 'up-to-date',
    JSON.stringify(readConfigFile().lastResult))

  reset({ latest: '0.5.99' }) // 更低
  const second = makeDeps()
  const lower = await domain.checkAndUpdate({ deps: second.deps })
  check('② 远端 < 本地 ⇒ 也不装（绝不降级）', lower.skipped === 'up-to-date' && lower.updated === false && installedVersion() === '0.5.100',
    `skipped=${lower.skipped} installed=${installedVersion()}`)
  check('② 更低时零下载 / 零解包', second.counters.download === 0 && second.counters.extract === 0, JSON.stringify(second.counters))
}

console.log('\n=== ③ 远端更高 ⇒ 覆盖式安装（真实路径）+ pnpm 调用必须为 0 ===')
{
  reset({ latest: '0.5.101' })
  const { deps, counters } = makeDeps()
  const r = await domain.checkAndUpdate({ deps })
  check('③ 真的装上了（updated=true、ok=true）', r.updated === true && r.ok === true, `updated=${r.updated} ok=${r.ok} reason=${r.reason}`)
  check('③ from / to / version 三件都如实', r.from === '0.5.100' && r.to === '0.5.101' && r.version === '0.5.101',
    `from=${r.from} to=${r.to} version=${r.version}`)
  check('③ 读回核对：盘上就是目标版本', installedVersion() === '0.5.101', String(installedVersion()))
  check('★ ③ 覆盖式安装全程 **pnpm 调用 0 次**（counters.pnpm === 0）', counters.pnpm === 0, JSON.stringify(counters))
  check('③ 全程也 **没有执行任何外部命令**（counters.exec === 0）', counters.exec === 0, JSON.stringify(counters))
  check('③ 走的是覆盖式通道（channel=manual-overlay）', r.channel === 'manual-overlay', String(r.channel))
  check('③ 结果里写明「重启后生效」（宿主不能安全重启自己）', String(r.reason).includes('重启服务后生效'), String(r.reason))
  check('③ 只覆盖、没清空：原地保留的文件还在（overlay 的不删语义）',
    existsSync(join(PKG_DIR, 'index.js')) && existsSync(join(PKG_DIR, 'lib-note.txt')))
  const saved = readConfigFile()
  check('③ lastResult 如实落盘（ok/updated/to/version）',
    saved.lastResult.ok === true && saved.lastResult.updated === true && saved.lastResult.to === '0.5.101'
    && saved.lastResult.version === '0.5.101' && saved.lastResult.channel === 'manual-overlay',
    JSON.stringify(saved.lastResult))
  check('③ 成功后清空失败退避（failedVersion / failedAt 都是 null）',
    saved.lastResult.failedVersion === null && saved.lastResult.failedAt === null, JSON.stringify(saved.lastResult))
  check('③ 装完备份已收口（成功路径不残留 .pre-update-*）',
    readdirSync(join(PROFILE, 'node_modules', ...SELF.split('/', 1))).every((n) => !n.includes('.pre-update-')),
    readdirSync(join(PROFILE, 'node_modules', ...SELF.split('/', 1))).join(','))

  // 静态防线：本模块的源码里不许出现包管理器调用（与上面的运行期记录桩互为双保险）
  const src = readFileSync(join(ROOT, '..', 'lib', 'server', 'domain', 'self-auto-update.js'), 'utf8')
  check('★ ③ 源码里没有 pnpm 字面量（变异：把 pnpm 加回来必红）', !/['"`]pnpm['"`]/iu.test(src), (src.match(/.*pnpm.*/iu) ?? [''])[0].slice(0, 80))
  check('③ 源码里没有直接 spawn / execFile（一切外部命令只能从注入缝进来）',
    !/execFileAsync\(|execFile\(|spawn\(/u.test(src))
}

console.log('\n=== ④ 安装失败 ⇒ 如实失败 + 从备份恢复 + 记下 failedVersion ===')
{
  reset({ latest: '0.5.102' })
  const { deps, counters } = makeDeps({
    // 真实故障形状：通道动过目录之后失败（这里让"下载"这一步先把 package.json 删掉再抛错）
    download: async () => {
      counters.download += 1
      rmSync(join(PKG_DIR, 'package.json'), { force: true })
      throw new Error('模拟下载失败：EPIPE')
    },
  })
  const r = await domain.checkAndUpdate({ deps })
  check('④ 如实失败（ok=false、updated=false）', r.ok === false && r.updated === false, `ok=${r.ok} reason=${r.reason}`)
  check('④ 原因里带上真实故障（EPIPE）', String(r.reason).includes('EPIPE'), String(r.reason))
  check('★ ④ 从更新前的备份**真的恢复**了（healed=true，盘上回到 0.5.100）',
    r.healed === true && installedVersion() === '0.5.100', `healed=${r.healed} installed=${installedVersion()}`)
  check('④ 恢复这条也在 reason 里说清了（"没有生效"，绝不谎报成功）', String(r.reason).includes('恢复'), String(r.reason))
  check('④ 残缺目录改名保留（.broken-*，没删除）',
    readdirSync(join(PROFILE, 'node_modules', ...SELF.split('/', 1))).some((n) => n.includes('.broken-')),
    readdirSync(join(PROFILE, 'node_modules', ...SELF.split('/', 1))).join(','))
  const saved = readConfigFile()
  check('★ ④ lastResult 记下 failedVersion = 目标版本、failedAt = 本轮时间',
    saved.lastResult.failedVersion === '0.5.102' && saved.lastResult.failedAt === clock.t,
    JSON.stringify(saved.lastResult))
  check('④ 失败时也没有偷偷跑 pnpm', counters.pnpm === 0, JSON.stringify(counters))

  console.log('\n=== ⑤ 同一版本 6 小时内不重试（注入时间）===')
  {
    clock.t = clock.t + 60 * 60 * 1000 // +1 小时
    const within = makeDeps()
    const again = await domain.checkAndUpdate({ deps: within.deps })
    check('⑤ 6 小时内同版本 ⇒ skipped = backoff，且零动作',
      again.skipped === 'backoff' && within.counters.download === 0 && within.counters.extract === 0,
      `skipped=${again.skipped} ${JSON.stringify(within.counters)}`)
    check('⑤ 退避时也没打 registry 元数据（只探了一次版本）', within.counters.fetchJson === 0, JSON.stringify(within.counters))
    clock.t = clock.t + 6 * 60 * 60 * 1000 // 越过 6 小时窗口
    const after = makeDeps()
    const retried = await domain.checkAndUpdate({ deps: after.deps })
    check('★ ⑤ 过了 6 小时窗口 ⇒ 真的重试并装上了（退避不是永久拉黑）',
      retried.updated === true && after.counters.download === 1, `updated=${retried.updated} ${JSON.stringify(after.counters)}`)
    check('⑤ 成功后 failedVersion 被清空', readConfigFile().lastResult.failedVersion === null, JSON.stringify(readConfigFile().lastResult))
  }
}

console.log('\n=== ⑥ 安装锁 / 安装作业 / 框架升级中 ⇒ skipped 且零动作 ===')
{
  reset({ latest: '0.5.101' })
  // ⑥-a 宿主注入「有安装作业在跑」
  const busyDeps = makeDeps({ installBusy: () => '有安装作业正在跑（job-x：@other/pkg）' })
  const busy = await domain.checkAndUpdate({ deps: busyDeps.deps })
  check('⑥-a 有安装作业 ⇒ skipped = busy，且零探测零安装',
    busy.skipped === 'busy' && busyDeps.counters.probe === 0 && busyDeps.counters.download === 0,
    `skipped=${busy.skipped} ${JSON.stringify(busyDeps.counters)}`)
  check('⑥-a 原因里点名是哪个作业（不是一句"忙"）', String(busy.reason).includes('job-x'), String(busy.reason))

  // ⑥-b 真的占着这个包的安装锁（复用 domain/install-lock.js，不是假的）
  let release = null
  const holding = installLock.withInstallLock({ profileDir: PROFILE, packageName: SELF }, () => new Promise((resolve) => { release = resolve }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  const lockedDeps = makeDeps()
  const locked = await domain.checkAndUpdate({ deps: lockedDeps.deps })
  check('★ ⑥-b 包锁被占 ⇒ skipped = busy，零探测零安装',
    locked.skipped === 'busy' && lockedDeps.counters.probe === 0 && lockedDeps.counters.download === 0,
    `skipped=${locked.skipped} ${JSON.stringify(lockedDeps.counters)}`)
  release()
  await holding

  // ⑥-c 框架升级进行中：与既有 /framework-upgrade-status 路由**对同一现场给同一结论**
  const fwState = join(CONSOLE_DIR, 'fw-upgrade-state.txt')
  const { routeFrameworkUpgradeStatusGet } = await import('../lib/server/routes/framework.js')
  const callStatusRoute = async () => {
    const res = { status: 0, body: null, writeHead(s) { this.status = s }, end(p) { this.body = p } }
    await routeFrameworkUpgradeStatusGet({}, res, { ctx: { baseUrl: 'file:///' }, url: new URL('http://x/plugin-console/framework-upgrade-status'), pathname: '/plugin-console/framework-upgrade-status', method: 'GET', deps: {} })
    return JSON.parse(res.body)
  }
  writeFileSync(fwState, 'installing|升级框架 0.5.100 -> 0.5.101', 'utf8')
  const routeSays = await callStatusRoute()
  const fwDeps = makeDeps()
  const fwSkipped = await domain.checkAndUpdate({ deps: fwDeps.deps })
  check('⑥-c 框架升级中 ⇒ skipped = framework-upgrade，零探测零安装',
    fwSkipped.skipped === 'framework-upgrade' && fwDeps.counters.probe === 0 && fwDeps.counters.download === 0,
    `skipped=${fwSkipped.skipped} ${JSON.stringify(fwDeps.counters)}`)
  check('★ ⑥-c 与既有 /framework-upgrade-status 判据一致（那条路由此刻也说"正在进行中"，不是我猜的）',
    routeSays.status !== 'idle' && routeSays.status !== 'done' && routeSays.status !== 'failed' && routeSays.status !== 'ready',
    `route=${routeSays.status} 判据=${JSON.stringify(domain.frameworkUpgradeBusy({ deps: { now: () => Date.now() } }))}`)
  writeFileSync(fwState, 'done|升级完成', 'utf8')
  const routeDone = await callStatusRoute()
  check('⑥-c 状态变成终止态 ⇒ 两边都当"没在升级"',
    routeDone.status === 'done' && domain.frameworkUpgradeBusy({ deps: { now: () => Date.now() } }) === null,
    `route=${routeDone.status} busy=${JSON.stringify(domain.frameworkUpgradeBusy({ deps: { now: () => Date.now() } }))}`)
  // 陈旧残留（非终止态但超过 15 分钟）⇒ 与既有路由的"残留自愈"口径一致，不再挡住自动更新
  const stale = Date.now() - 20 * 60 * 1000
  writeFileSync(fwState, 'installing|很久以前', 'utf8')
  utimesSync(fwState, new Date(stale), new Date(stale))
  check('⑥-c 非终止态但超过 15 分钟 ⇒ 按既有路由的残留口径不当"在升级"', domain.frameworkUpgradeBusy({ deps: { now: () => Date.now() } }) === null,
    JSON.stringify(domain.frameworkUpgradeBusy({ deps: { now: () => Date.now() } })))
  rmSync(fwState, { force: true })
}

console.log('\n=== ⑦ 配置文件损坏 ⇒ 降级默认值、不覆盖原文件、有 note ===')
{
  reset({ latest: '0.5.100' })
  const garbage = '{ 这不是 JSON ：enabled: false'
  writeConfigRaw(garbage)
  const read = domain.readAutoUpdateConfig({ deps: {} })
  check('⑦ 读坏文件 ⇒ 降级为默认值（enabled 仍为 true，即"默认打开"）', read.config.enabled === true && read.corrupt === true, JSON.stringify(read.config))
  check('⑦ 读坏文件 ⇒ 有一条如实 note（说清按默认值继续、没有覆盖）',
    typeof read.note === 'string' && read.note.includes('没有覆盖你的文件'), String(read.note))
  check('★ ⑦ 光"读一下"绝不改用户的文件（字节逐字相同）', readFileSync(CONFIG, 'utf8') === garbage)
  // 真的跑一次检查（会记录结果）⇒ 原件必须**改名留档**，不是被覆盖掉
  const { deps } = makeDeps()
  const r = await domain.checkAndUpdate({ deps })
  const kept = readdirSync(CONSOLE_DIR).filter((n) => n.startsWith('auto-update.json.corrupt-'))
  check('★ ⑦ 首次写盘时把读不出来的原件改名留档（auto-update.json.corrupt-*）', kept.length === 1, readdirSync(CONSOLE_DIR).join(','))
  check('⑦ 留档的那份内容就是用户原来写的（一个字都没丢）', kept.length === 1 && readFileSync(join(CONSOLE_DIR, kept[0]), 'utf8') === garbage)
  check('⑦ 新写出来的配置是合法 JSON 且记下了本轮结论', (() => { try { return readConfigFile().lastResult.skipped === 'up-to-date' } catch { return false } })(), JSON.stringify(readConfigFile()))
  check('⑦ 结论里带上了"原件已改名保留"这条 note', String(r.configNote).includes('保留') || String(r.reason).includes('保留'), `${r.configNote} | ${r.reason}`)
}

console.log('\n=== ⑧ UI：默认开启 / 字段缺失显示「—」/ 切换真的发 POST / 失败显示原文 ===')
{
  const clientSrc = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')

  // ⑧-a 纯函数部分：把 client.js 里那几个函数**原样抠出来求值**（不是在这里重写一遍）
  const extractFn = (name) => {
    const lines = clientSrc.split('\n')
    const start = lines.findIndex((l) => l.includes(`function ${name}(`))
    if (start < 0) return null
    let depth = 0
    let started = false
    const body = []
    for (let i = start; i < lines.length; i += 1) {
      body.push(lines[i])
      for (const ch of lines[i]) {
        if (ch === '{') { depth += 1; started = true }
        else if (ch === '}') depth -= 1
      }
      if (started && depth === 0) break
    }
    return body.join('\n')
  }
  const build = (names) => {
    const src = names.map((n) => extractFn(n)).filter(Boolean)
    if (src.length !== names.length) return null
    // eslint-disable-next-line no-new-func
    return new Function(`${src.join('\n')}\n return { ${names.join(', ')} }`)()
  }
  const ui = build(['selfAutoUpdateEnabledOf', 'selfAutoUpdateLastCheckOf', 'selfAutoUpdateLastResultOf', 'selfUpdateOutcomeText'])
  check('⑧-a 四个 UI 纯函数都在 client.js 里（抠得出来）', ui !== null)
  const fakeT = (key) => ({
    selfUpdateResultNever: '还没有跑过检查', selfUpdateUpToDate: '已是最新',
    selfUpdateUpdated: '已更新到 {version}', selfUpdateSkipped: '本轮跳过：{reason}', selfUpdateFailed: '失败：{reason}',
  }[key] ?? key)
  check('★ ⑧-b 字段缺失（/state 没给 selfAutoUpdate）⇒ 按**默认开启**显示', ui.selfAutoUpdateEnabledOf(null) === true && ui.selfAutoUpdateEnabledOf(undefined) === true)
  check('⑧-b 服务端说关了就显示关闭', ui.selfAutoUpdateEnabledOf({ enabled: false }) === false && ui.selfAutoUpdateEnabledOf({ enabled: true }) === true)
  check('★ ⑧-c 字段缺失 ⇒ 上次检查显示「—」（不编造时间）', ui.selfAutoUpdateLastCheckOf(null, '从未检查') === '—')
  check('★ ⑧-c 字段缺失 ⇒ 上次结果显示「—」', ui.selfAutoUpdateLastResultOf(null, fakeT) === '—')
  check('⑧-c 有值 ⇒ 照服务端原话（时间可读、结果分类正确）', (() => {
    const info = { enabled: true, lastCheckAt: 1794057827972, lastResult: { skipped: 'up-to-date', ok: true, reason: '已是最新' } }
    return ui.selfAutoUpdateLastCheckOf(info, '从未检查') !== '—' && ui.selfAutoUpdateLastResultOf(info, fakeT) === '已是最新'
  })(), String(ui.selfAutoUpdateLastResultOf({ enabled: true, lastCheckAt: 1, lastResult: { skipped: 'up-to-date', ok: true } }, fakeT)))
  check('⑧-c 从没检查过（lastCheckAt 为 null）⇒ 明说"从未检查"，不说「—」也不编时间',
    ui.selfAutoUpdateLastCheckOf({ enabled: true, lastCheckAt: null, lastResult: null }, '从未检查') === '从未检查')
  check('⑧-d 结果映射：更新成功 / 跳过 / 失败三态都说真话',
    ui.selfUpdateOutcomeText({ updated: true, to: '0.5.109' }, fakeT) === '已更新到 0.5.109'
    && ui.selfUpdateOutcomeText({ skipped: 'busy', ok: true, reason: '有安装作业在跑' }, fakeT) === '本轮跳过：有安装作业在跑'
    && ui.selfUpdateOutcomeText({ ok: false, reason: '模拟下载失败：EPIPE' }, fakeT) === '失败：模拟下载失败：EPIPE',
    [ui.selfUpdateOutcomeText({ updated: true, to: '0.5.109' }, fakeT), ui.selfUpdateOutcomeText({ skipped: 'busy', ok: true, reason: 'x' }, fakeT), ui.selfUpdateOutcomeText({ ok: false, reason: 'y' }, fakeT)].join(' | '))

  // ⑧-e 静态接线：**位置已按用户要求搬到「升级安全」面板的跳转行末尾**（2026-11-05 契约随需求迁移）。
  //   原来是长在「功能包」工具栏（`styles.toolItem`）里的；用户原话：
  //   「然后自更新和立即检测，可移除功能包，将位置放在这（红笔在『AI 部署』之后）」，
  //   并已确认「从功能包移走，只在安全面板这排末尾出现」。
  //   ★ 本组断言**一条都没删、没弱化**：位置断言从"在工具栏里"改成"在跳转行 `jump("ai")` 之后"，
  //     并补了一条**负控**（工具栏里必须已经没有了 —— 防"复制一份"而不是"搬走"）。
  const srcLines = clientSrc.split('\n')
  const mainBlock = srcLines.slice(
    srcLines.findIndex((l) => l.includes('function PluginConsoleTab({')),
    srcLines.findIndex((l) => l.includes('function PluginSafetyTab({')),
  ).join('\n')
  const safetyBlock = srcLines.slice(
    srcLines.findIndex((l) => l.includes('function PluginSafetyTab({')),
    srcLines.findIndex((l) => l.includes('function apply(ctx)')),
  ).join('\n')
  const posOf = (needle, hay) => hay.indexOf(needle)
  check('★ ⑧-e 按钮在**安全面板跳转行**里、紧跟 `jump("ai", …)`（className 用同排的 styles.toggle，不引入新样式）',
    /jump\("ai", t\("safetyJumpAi"\)\),[\s\S]{0,600}?className: styles\.toggle[\s\S]{0,300}?"aria-label": t\("selfUpdateAria"\)/u.test(safetyBlock)
    && /jump\("ai", t\("safetyJumpAi"\)\),[\s\S]{0,1400}?className: styles\.toggle[\s\S]{0,300}?"aria-label": t\("selfUpdateCheckHint"\)/u.test(safetyBlock))
  check('★ ⑧-e 负控：功能包工具栏（PluginConsoleTab）里**已经没有了**这两颗（是真搬走，不是复制一份）',
    !/selfUpdateAria/u.test(mainBlock) && !/selfUpdateCheckHint/u.test(mainBlock) && !/self-auto-update/u.test(mainBlock)
    && !/styles\.toolItem[\s\S]{0,300}?"aria-label": t\("selfUpdate/u.test(mainBlock))
  check('⑧-e 开关状态取自 `GET /plugin-console/state` 的 selfAutoUpdate（不自己猜）',
    /call\("\/plugin-console\/state"\)/u.test(safetyBlock) && /data\.selfAutoUpdate/u.test(safetyBlock))
  check('★ ⑧-e 点一下发 POST `{action:"toggle", enabled:<下一值>}`',
    /call\("\/plugin-console\/self-auto-update", \{ action: "toggle", enabled: next \}\)/u.test(safetyBlock))
  check('⑧-e 另有「立即检查」走 `{action:"check"}`', /call\("\/plugin-console\/self-auto-update", \{ action: "check" \}\)/u.test(safetyBlock))
  check('★ ⑧-e 失败必须把服务端原文念出来（error.message 串进 safetySwitchFailed 前缀），两个动作都走同一个漏斗、不许静默',
    (safetyBlock.match(/error\.message/gu) ?? []).length >= 1
    && /t\("safetySwitchFailed"\) \+ "："\s*\+ \(\(error/u.test(safetyBlock)
    && (safetyBlock.match(/selfUpdateFailText\(error/g) ?? []).length === 2)
  check('★ ⑧-e 写请求期间禁用并显示进行中（disabled + data-busy + 省略号）',
    /disabled: selfUpdateBusy/u.test(safetyBlock) && /"data-busy": selfUpdateBusy \? "true" : "false"/u.test(safetyBlock)
    && /selfUpdateBusy \? " …"/u.test(safetyBlock))
  // 顺序断言只用**渲染出来的那两处 aria-label**（title 构造函数里也提到了同一把键，不能拿它当位置证据）
  const jumpTail = (() => {
    const at = posOf('jump("ai", t("safetyJumpAi"))', safetyBlock)
    return at < 0 ? '' : safetyBlock.slice(at)
  })()
  const ariaOn = posOf('"aria-label": t("selfUpdateAria")', jumpTail)
  const ariaCheck = posOf('"aria-label": t("selfUpdateCheckHint")', jumpTail)
  check('★ ⑧-e 顺序：两颗按钮都在「AI 部署」之后，且「自更新」在「立即检查」之前（用户要的"放在这"）',
    jumpTail !== '' && ariaOn > 0 && ariaCheck > ariaOn, `ariaOn=${ariaOn} ariaCheck=${ariaCheck}`)

  check('★ ⑧-f 绝不"自作主张写回"：挂载时不发任何 self-auto-update 请求（只有点击才发）',
    !/useEffect\(\(\) => \{[^}]*self-auto-update/su.test(clientSrc)
    && (clientSrc.match(/call\("\/plugin-console\/self-auto-update"/gu) ?? []).length === 2,
    `调用点=${(clientSrc.match(/call\("\/plugin-console\/self-auto-update"/gu) ?? []).length}`)
  check('⑧-g 中英两本字典都有这把开关的键（en ⊆ zh 由 test-i18n-keys 兜底，这里钉存在性）',
    ['selfUpdateLabel', 'selfUpdateAria', 'selfUpdateLastCheck', 'selfUpdateLastResult', 'selfUpdateCheckLabel'].every((k) => (clientSrc.match(new RegExp(`^\\t{3}${k}:`, 'gmu')) ?? []).length === 2),
    'zh/en 各一处')

  // ⑧-h 真发一次切换请求（走真实路由），确认"默认开启 → 点一下变关闭"这条路是活的
  reset({ latest: '0.5.100' })
  const { routeSelfAutoUpdate } = await import('../lib/server/routes/self-auto-update.js')
  const callRoute = async (body) => {
    const res = { status: 0, body: null, writeHead(s) { this.status = s }, end(p) { this.body = p } }
    await routeSelfAutoUpdate({}, res, { body, ctx: { baseUrl: 'file:///' }, deps: {} })
    return { status: res.status, json: res.body === null ? null : JSON.parse(res.body) }
  }
  const stateBefore = domain.selfAutoUpdateState({ deps: {} })
  check('⑧-h 没有配置文件时 /state 视图默认 enabled = true（默认打开）', stateBefore.enabled === true && stateBefore.intervalHours === 6, JSON.stringify(stateBefore))
  const off = await callRoute({ action: 'toggle' })
  check('★ ⑧-h 点一下 ⇒ 200 且服务端真的关了（selfAutoUpdate.enabled=false）',
    off.status === 200 && off.json.ok === true && off.json.selfAutoUpdate.enabled === false, `status=${off.status} ${JSON.stringify(off.json?.selfAutoUpdate)}`)
  check('⑧-h 关掉这件事**真的写进了** auto-update.json（不是只改内存）', readConfigFile().enabled === false, JSON.stringify(readConfigFile()))
  const on = await callRoute({ action: 'toggle' })
  check('⑧-h 再点一下 ⇒ 又开起来（toggle 是翻转，不是单向）', on.status === 200 && on.json.selfAutoUpdate.enabled === true, JSON.stringify(on.json?.selfAutoUpdate))
  const explicit = await callRoute({ action: 'set-enabled', enabled: false })
  check('⑧-h set-enabled 能按给定值设（面板以外的调用方也能用）', explicit.json?.selfAutoUpdate?.enabled === false, JSON.stringify(explicit.json?.selfAutoUpdate))
  const bad = await callRoute({ action: 'nonsense' })
  check('⑧-h 不认识的 action ⇒ 400 + 可读原因（绝不 200 假装做过）', bad.status === 400 && String(bad.json?.error).includes('不认识的 action'), `status=${bad.status} error=${bad.json?.error}`)
}

console.log('\n=== ⑨ 变异防线（把这条放宽就必须红）===')
{
  const src = readFileSync(join(ROOT, '..', 'lib', 'server', 'domain', 'self-auto-update.js'), 'utf8')
  check('★ ⑨-1 只更新自己：判据仍是 isSelfUpdate(...) + skipped = not-self（放宽成任意包 ⇒ 本行红）',
    /isSelfUpdate\(target, io\) !== true/u.test(src) && /out\.skipped = 'not-self'/u.test(src))
  check('★ ⑨-2 零 pnpm：源码里没有 pnpm 字面量（加回来 ⇒ 本行红）', !/['"`]pnpm['"`]/iu.test(src))
  check('★ ⑨-3 退避：RETRY_BACKOFF_MS 仍是 6 小时且真的被用于判定',
    /const RETRY_BACKOFF_MS = 6 \* 60 \* 60 \* 1000/u.test(src) && /at - failedAt < RETRY_BACKOFF_MS/u.test(src))
  check('★ ⑨-4 只在远端**严格更高**时才装（cmp <= 0 ⇒ up-to-date）',
    /if \(cmp <= 0\)/u.test(src) && /out\.skipped = 'up-to-date'/u.test(src))
  // 需求侧的反向验证：把目标包名换成别的包，必须被拒绝（这条就是"只更新自己"的行为断言）
  reset({ latest: '0.5.101' })
  const other = makeDeps()
  const rejected = await domain.checkAndUpdate({ deps: other.deps, targetPackage: '@fake/some-other-plugin' })
  check('★ ⑨-5 点名别的包 ⇒ 拒绝（skipped=not-self），零探测零安装',
    rejected.skipped === 'not-self' && other.counters.probe === 0 && other.counters.download === 0 && installedVersion() === '0.5.100',
    `skipped=${rejected.skipped} ${JSON.stringify(other.counters)}`)
}

console.log('\n=== ⑩ 调度：幂等 / 单飞 / 异常只记一条 / unref 不阻塞退出 ===')
{
  reset({ latest: '0.5.100' })
  // ⑩-a 幂等 + 首检延迟 2 分钟 + 定时器 unref（不阻塞进程退出）
  const first = domain.startSelfAutoUpdateScheduler({ deps: { ...makeDeps().deps, firstDelayMs: 5 * 60 * 1000 } })
  const second = domain.startSelfAutoUpdateScheduler({ deps: makeDeps().deps })
  check('⑩-a 重复启动幂等（第二次只回 alreadyStarted，不再排第二个定时器）',
    first.started === true && first.alreadyStarted === false && second.alreadyStarted === true, JSON.stringify([first, second]))
  const sched = domain.selfAutoUpdateSchedulerState()
  check('⑩-a 定时器已排上，且首检不是立刻（默认 2 分钟）',
    sched.started === true && sched.hasTimer === true && first.firstDelayMs === 5 * 60 * 1000, JSON.stringify(sched))
  check('★ ⑩-a 定时器 unref（宿主退出不被这一轮拖住）', sched.ref === false, `ref=${sched.ref}`)
  const stopped = domain.stopSelfAutoUpdateScheduler()
  check('⑩-a 停掉之后不再持有定时器', stopped.stopped === true && domain.selfAutoUpdateSchedulerState().hasTimer === false)

  // ⑩-b 单飞：上一轮没跑完，再来一次只回 skipped:'busy'（零动作，不叠第二轮）
  reset({ latest: '0.5.101' })
  let releaseProbe = null
  const slowDeps = makeDeps({ probeRegistry: () => new Promise((resolve) => { releaseProbe = () => resolve({ resolvable: true, latest: '0.5.100', tried: [] }) }) })
  domain.startSelfAutoUpdateScheduler({ deps: { ...slowDeps.deps, firstDelayMs: 60 * 60 * 1000 } })
  const inFlight = domain.runCheckOnce({ deps: slowDeps.deps })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const overlapping = makeDeps()
  const second2 = await domain.runCheckOnce({ deps: overlapping.deps })
  check('★ ⑩-b 上一轮没跑完时再来一次 ⇒ skipped = busy 且零请求',
    second2.skipped === 'busy' && overlapping.counters.probe === 0 && overlapping.counters.download === 0,
    `skipped=${second2.skipped} ${JSON.stringify(overlapping.counters)}`)
  releaseProbe()
  await inFlight
  check('⑩-b 上一轮跑完之后恢复正常', domain.selfAutoUpdateSchedulerState().running === false)
  domain.stopSelfAutoUpdateScheduler()

  // ⑩-c 定时到点：探测抛错也只变成**一条如实记录**，且之后仍会排下一轮（绝不把调度搞死）
  reset({ latest: '0.5.100' })
  const boom = makeDeps({ probeRegistry: () => { throw new Error('探测炸了') } })
  const started = domain.startSelfAutoUpdateScheduler({ deps: { ...boom.deps, firstDelayMs: 0 } })
  await new Promise((resolve) => setTimeout(resolve, 120))
  const afterTick = readConfigFile()
  check('⑩-c 首检 0ms 真的跑了，抛错被吞成一条记录（ok=false + 原文）',
    started.started === true && afterTick.lastResult.ok === false && String(afterTick.lastResult.reason).includes('探测炸了'),
    JSON.stringify(afterTick.lastResult))
  check('★ ⑩-c 抛错之后仍排上了下一轮（调度不会因为一次异常就死掉）',
    domain.selfAutoUpdateSchedulerState().hasTimer === true && domain.selfAutoUpdateSchedulerState().started === true,
    JSON.stringify(domain.selfAutoUpdateSchedulerState()))
  const recordCounters = domain.selfAutoUpdateSchedulerState()
  check('⑩-c 调度轮次被记了一笔（runs ≥ 1）', recordCounters.runs >= 1, JSON.stringify(recordCounters))
  domain.stopSelfAutoUpdateScheduler()
  check('⑩-c 收尾：停掉后零定时器', domain.selfAutoUpdateSchedulerState().started === false && domain.selfAutoUpdateSchedulerState().hasTimer === false)

  // ⑩-d "如实记录"这条单独钉一次（recordSchedulerFailure 自身绝不抛、也不改写既有字段以外的东西）
  const beforeRecord = readConfigFile().lastResult
  domain.recordSchedulerFailure(new Error('模拟调度异常'), { deps: {} })
  const afterRecord = readConfigFile().lastResult
  check('⑩-d recordSchedulerFailure 把异常写成 lastResult（ok=false + 原文），并保留退避字段',
    afterRecord.ok === false && String(afterRecord.reason).includes('模拟调度异常')
    && afterRecord.failedVersion === beforeRecord.failedVersion, JSON.stringify(afterRecord))
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
