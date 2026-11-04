// 同一个包**不许被并发安装**（跨作业互斥）的判据测试（2026-11-04 加法，纯离线）
//
// 现场（真机 2026-11-04，用户提供的原始日志）：一次「详情页更新控制台自己」失败，pnpm 被 180s 超时杀树，
// 同一条日志里还有
//     [WARN] Moving @noob-stupid/dsh-plugin-console_tmp_13796_2 to node_modules\.ignored\…
//     [WARN] Moving dsh-workbuddy-connect_tmp_13796_3 to node_modules\.ignored\…
// ⇒ 正式目录被清空（只剩 1 个文件、package.json 不见），`node_modules/.ignored` 堆到 118 项 / 335 MB。
// 用户的判断与要求（原文要点）：「这是**两个 pnpm 同时装同一个包**的冲突。可以弄：如果下载一个的时候，
// 那么就停止另一个相同的安装。**我们的并行竞速本身是没问题的**…要支持同时下载多个」。
//
// 本套钉死的判据（每条都要能失败）：
//   ① 同一个 profile + 包名：**串行**（第二个进不去，通道里同一时刻最多 1 个）
//   ② 不同包：**照旧并行**（同一时刻 2 个，总耗时 ≈ 单个而不是两个相加）
//   ③ 跨 profile：同一个包名在**两个不同 profile** 里互不干扰（锁的粒度是"包 + profile"）
//   ④ 排队是**等**不是**丢**：第二个最终也真的装上了（拿到锁之后自己走完整条通道序列）
//   ⑤ 排队超时 ⇒ 第二个**如实失败**：installedName=null、错误码 INSTALL_LOCK_TIMEOUT、磁盘一个字都没动
//   ⑥ 负控/变异：把闸门改成 4 路并发（改一行）⇒ ① 那个场景**真的会重叠**（证明 ① 的断言不是空的）
//   ⑦ 可重入：同一个异步上下文里再拿同一把锁不会死锁（否则"安装收口里再调一次 pnpm"会自己锁死）
//   ⑧ 边界：空包名 / 空 profileDir ⇒ 不过闸、直接执行（既有调用路径行为不变）；锁键对大小写与斜杠归一
//   ⑨ 接线：作业层拿不到锁 ⇒ 如实失败（stage=install-lock）、**不进 AI 兜底**、诊断分类是 package-locked
//   ⑩ 契约：/state 既有字段一个不少（installJobView 只多了 installLock，默认恒 null）
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = join(HERE, '.testdir', 'install-lock')
// 隔离数据根（作业层会碰 DSH_HOME 下的 trash/源配置 —— 绝不落到真实用户目录）
process.env.DSH_HOME = join(BASE, 'home')

const url = (rel) => pathToFileURL(join(HERE, '..', rel)).href
const { tryCandidateChannels } = await import(url('lib/server/domain/install-channels.js'))
const { runInstallJob } = await import(url('lib/server/domain/install-job.js'))
const { installJobView } = await import(url('lib/server/domain/install.js'))
const { classifyInstallFailure } = await import(url('lib/server/domain/install-diagnose.js'))
const lock = await import(url('lib/server/domain/install-lock.js'))

let pass = 0
let fail = 0
const check = (name, ok, info = '') => {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

rmSync(BASE, { recursive: true, force: true })

// ── 夹具写盘的唯一入口：路径必须先是绝对路径，否则直接抛（真事故：join('', …) 把仓库 lib/index.js 写坏了）
function writeFixture(absPath, content) {
  const target = String(absPath ?? '')
  if (target === '' || isAbsolute(target) !== true) throw new Error(`夹具拒绝写非绝对路径：${target}`)
  if (target.startsWith(join(HERE, '..', 'lib')) && target.endsWith(join('lib', 'index.js'))) throw new Error(`夹具拒绝写插件入口：${target}`)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

/** 一个 profile 夹具（**不装任何包**：目录不存在 ⇒ 恢复那层不接管，本套只量互斥）。 */
function makeProfile(tag) {
  const profileDir = join(BASE, tag, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  writeFixture(join(profileDir, 'cordis.patch.yml'), '# fixture\n')
  writeFixture(join(profileDir, 'package.json'), `${JSON.stringify({ name: `dsh-profile-${tag}`, private: true, dependencies: {} }, null, 2)}\n`)
  return profileDir
}

/** 通道桩：**记录进入/离开**，用一个共享的并发计数器量"同一时刻有几个"。
 *  `raceInstallChannels` 一律返回 null（保证走下面的串行 pnpm 腿），`pnpmInstall` 睡 `holdMs` 再返回。 */
function makeChannels(probe, { holdMs = 60, onPnpm = null } = {}) {
  const enter = (tag) => {
    probe.inFlight += 1
    probe.peak = Math.max(probe.peak, probe.inFlight)
    probe.order.push(`${tag}:in`)
  }
  const leave = (tag) => { probe.inFlight -= 1; probe.order.push(`${tag}:out`) }
  return {
    raceInstallChannels: async () => null,
    pnpmInstall: async (dir, spec) => {
      enter(`pnpm:${spec}`)
      try {
        await new Promise((resolve) => setTimeout(resolve, holdMs))
        if (typeof onPnpm === 'function') onPnpm({ dir, spec })
      } finally { leave(`pnpm:${spec}`) }
    },
    curlManualInstall: async () => { throw new Error('桩：curl 不该被走到') },
    githubReleaseInstall: async () => { throw new Error('桩：release 不该被走到') },
    backfillMissingDeps: async () => [],
  }
}

const newProbe = () => ({ inFlight: 0, peak: 0, order: [] })
const runChannels = async ({ profileDir, ch, job, name, lockWaitMs = undefined, selfUpdateDeps = undefined }) => tryCandidateChannels({
  job, ch, name, profileDir, registries: ['https://registry.fake'],
  repoChannelAllowed: false, budget: { release: 0 }, expanded: true, deadline: null,
  ...(lockWaitMs === undefined ? {} : { lockWaitMs }),
  ...(selfUpdateDeps === undefined ? {} : { selfUpdateDeps }),
})
const jobOf = (id, name) => ({ id, repo: '', packageName: name, source: 'github', update: true, version: null })

// ── ① 同一个包：串行 ─────────────────────────────────────────────────────────────────
{
  lock.__resetInstallLocks()
  const profileDir = makeProfile('serial')
  const probe = newProbe()
  const ch = makeChannels(probe, { holdMs: 80 })
  const jobA = jobOf('lock-a', 'pkg-shared')
  const jobB = jobOf('lock-b', 'pkg-shared')
  const startedAt = Date.now()
  const [ra, rb] = await Promise.all([
    runChannels({ profileDir, ch, job: jobA, name: 'pkg-shared' }),
    runChannels({ profileDir, ch, job: jobB, name: 'pkg-shared' }),
  ])
  const elapsed = Date.now() - startedAt
  check('① 同一个包 ⇒ 通道里同一时刻最多 1 个（peak=1）', probe.peak === 1, `peak=${probe.peak} order=${probe.order.join(',')}`)
  check('① 顺序是"先到先得"（第一个 in/out 完整结束后第二个才进来）',
    probe.order.join(',') === 'pnpm:pkg-shared:in,pnpm:pkg-shared:out,pnpm:pkg-shared:in,pnpm:pkg-shared:out', probe.order.join(','))
  check('① 两次请求都各自走完了自己的通道序列（串行而不是被合并/丢弃）',
    ra?.installedName === 'pkg-shared' && rb?.installedName === 'pkg-shared', JSON.stringify({ a: ra?.installedName, b: rb?.installedName }))
  check('① 串行的代价是"等"：总耗时 ≥ 两个 hold 之和', elapsed >= 160, `${elapsed}ms`)
  check('① 排队的那个作业上留了可读的现场（job.installLock.queued/waitedMs）',
    jobB.installLock?.queued === true && Number.isFinite(jobB.installLock?.waitedMs), JSON.stringify(jobB.installLock ?? null))
}

// ── ② 不同包：照旧并行 ──────────────────────────────────────────────────────────────
{
  lock.__resetInstallLocks()
  const profileDir = makeProfile('parallel')
  const probe = newProbe()
  const ch = makeChannels(probe, { holdMs: 100 })
  const startedAt = Date.now()
  const results = await Promise.all([
    runChannels({ profileDir, ch, job: jobOf('p1', 'pkg-one'), name: 'pkg-one' }),
    runChannels({ profileDir, ch, job: jobOf('p2', 'pkg-two'), name: 'pkg-two' }),
  ])
  const elapsed = Date.now() - startedAt
  check('② ★ 不同包仍然并行（peak=2）', probe.peak === 2, `peak=${probe.peak} order=${probe.order.join(',')}`)
  check('② 不同包没有被串行化（耗时 ≈ 单个而不是两个相加）', elapsed < 180, `${elapsed}ms`)
  check('② 两件都装上了', results.every((r) => typeof r?.installedName === 'string' && r.installedName !== ''))
}

// ── ③ 跨 profile：同一个包名互不干扰 ────────────────────────────────────────────────
{
  lock.__resetInstallLocks()
  const profileOne = makeProfile('cross-a')
  const profileTwo = makeProfile('cross-b')
  const probe = newProbe()
  const ch = makeChannels(probe, { holdMs: 100 })
  await Promise.all([
    runChannels({ profileDir: profileOne, ch, job: jobOf('c1', 'pkg-same'), name: 'pkg-same' }),
    runChannels({ profileDir: profileTwo, ch, job: jobOf('c2', 'pkg-same'), name: 'pkg-same' }),
  ])
  check('③ 同一个包名但**不同 profile** ⇒ 互不阻塞（peak=2）', probe.peak === 2, `peak=${probe.peak}`)
}

// ── ④ 排队超时 ⇒ 如实失败，且**磁盘一个字都没动** ─────────────────────────────────────
{
  lock.__resetInstallLocks()
  const profileDir = makeProfile('timeout')
  const probe = newProbe()
  let secondRan = 0
  const ch = makeChannels(probe, { holdMs: 200, onPnpm: () => { secondRan += 1 } })
  const holder = runChannels({ profileDir, ch, job: jobOf('t-holder', 'pkg-busy'), name: 'pkg-busy' })
  // 等第一个真的拿到锁（否则可能两个都在"未竞争"状态下进入）
  await new Promise((resolve) => setTimeout(resolve, 40))
  const jobB = jobOf('t-second', 'pkg-busy')
  const second = await runChannels({ profileDir, ch, job: jobB, name: 'pkg-busy', lockWaitMs: 60 })
  await holder
  check('④ ★ 排队超时 ⇒ installedName=null（绝不报装上）', second?.installedName === null, String(second?.installedName))
  check('④ 错误码是 INSTALL_LOCK_TIMEOUT（调用方不靠中文匹配）', second?.lastError?.code === lock.INSTALL_LOCK_TIMEOUT, String(second?.lastError?.code))
  check('④ 文案说清"这个包正在安装中"（面板原样显示）', /正在安装中/u.test(String(second?.lastError?.message ?? '')), String(second?.lastError?.message ?? '').slice(0, 120))
  check('④ 作业上如实标了 timeout + reason（便于诊断，不改既有字段）',
    jobB.installLock?.timeout === true && typeof jobB.installLock?.reason === 'string' && jobB.installLock.reason !== '', JSON.stringify(jobB.installLock ?? null))
  check('④ ★ 超时那一次**没有启动任何安装**（通道只被第一个作业调过 1 次）', secondRan === 1, `pnpm 调用 ${secondRan} 次`)
}

// ── ⑤ 负控/变异：把闸门改成 4 路并发 ⇒ ① 的断言**真的会红** ──────────────────────────
// 做法：把 install-lock.js 的源码读出来，只改一行（makeLimiter(1) → makeLimiter(4)），写成临时模块再 import。
// 这样跑的是**同一份逻辑**，唯一不同的是"没有互斥"——如果 ① 的断言是空的，这里就会同样绿（那是假绿）。
{
  const src = readFileSync(join(HERE, '..', 'lib', 'server', 'domain', 'install-lock.js'), 'utf8')
  const mutated = src
    .replace("from './enrich-throttle.js'", `from '${pathToFileURL(join(HERE, '..', 'lib', 'server', 'domain', 'enrich-throttle.js')).href}'`)
    .replace('limiter: makeLimiter(1)', 'limiter: makeLimiter(4)')
  check('⑤ 变异点确实改到了（负控的前提）', mutated.includes('makeLimiter(4)') && !mutated.includes('limiter: makeLimiter(1)'),
    mutated.includes('makeLimiter(4)') ? '已改成 4 路' : '变异没改到 —— 负控无效')
  const mutantPath = join(BASE, 'mutant', 'install-lock.js')
  writeFixture(mutantPath, mutated)
  const mutant = await import(`${pathToFileURL(mutantPath).href}?v=${Date.now()}`)
  const profileDir = makeProfile('mutant')
  const probe = newProbe()
  const ch = makeChannels(probe, { holdMs: 80 })
  // 用**变异模块**的闸门跑同一段逻辑（包装 tryCandidateChannels 的通道层调用）
  const runMutant = async (job) => mutant.withInstallLock({ profileDir, packageName: 'pkg-mut', job }, async () => {
    await ch.pnpmInstall(profileDir, 'pkg-mut')
    return { installedName: 'pkg-mut' }
  })
  await Promise.all([runMutant(jobOf('m1', 'pkg-mut')), runMutant(jobOf('m2', 'pkg-mut'))])
  check('⑤ ★ 负控成立：去掉互斥之后同一个包**真的会重叠**（peak=2）⇒ ① 的 peak=1 是有意义的',
    probe.peak === 2, `peak=${probe.peak} order=${probe.order.join(',')}`)
}

// ── ⑥ 可重入：持有者内部再拿同一把锁不死锁 ───────────────────────────────────────────
{
  lock.__resetInstallLocks()
  const inner = await lock.withInstallLock({ profileDir: BASE, packageName: 'pkg-re' }, async () => {
    return await lock.withInstallLock({ profileDir: BASE, packageName: 'pkg-re' }, async (info) => `inner:${info.reentrant}`)
  })
  check('⑥ ★ 可重入：同一异步上下文里再拿同一把锁直接放行（不会自己锁死）', inner === 'inner:true', String(inner))
}

// ── ⑥b 排队上限只约束"排队"，**不**能掐断"已经轮到自己、正在装"的那一次 ────────────────
// 真实形状：等 9 分钟才轮到，再装 8 分钟 —— 旧写法把计时器从**调用时**一直挂着，会在第 10 分钟
// 把已经拿到锁、正在安装的作业从后面掐断（那才是最坏的结果：报失败，而 pnpm 还在跑）。
{
  lock.__resetInstallLocks()
  const holder = lock.withInstallLock({ profileDir: BASE, packageName: 'pkg-timer' }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 80))
  })
  let done = false
  let threw = null
  const second = lock.withInstallLock({ profileDir: BASE, packageName: 'pkg-timer', waitMs: 120 }, async () => {
    // 排队 ~80ms 后拿到锁，然后自己干 120ms ⇒ 从调用算约 200ms > waitMs(120)
    await new Promise((resolve) => setTimeout(resolve, 120))
    done = true
    return 'ok'
  }).catch((error) => { threw = error; return 'threw' })
  await holder
  const result = await second
  check('⑥b ★ 排队上限不会掐断"已经拿到锁、正在装"的作业（定时器在拿到锁时就清掉）',
    threw === null && result === 'ok' && done === true, `${result} / ${String(threw?.code ?? '')}`)
}

// ── ⑦ 边界：空包名/空目录直接放行；锁键归一 ──────────────────────────────────────────
{
  lock.__resetInstallLocks()
  let ran = 0
  await lock.withInstallLock({ profileDir: '', packageName: '' }, async () => { ran += 1 })
  await lock.withInstallLock({ profileDir: BASE, packageName: '' }, async () => { ran += 1 })
  check('⑦ 空包名/空目录 ⇒ 不过闸、直接执行（既有调用路径行为不变）', ran === 2 && lock.installLockStats().locks === 0, `ran=${ran} locks=${lock.installLockStats().locks}`)
  check('⑦ 锁键对大小写与斜杠归一（Windows 上同一个目录只有一把锁）',
    lock.installLockKey('D:/p', 'Pkg-X') === lock.installLockKey('D:\\p\\', 'pkg-x'), lock.installLockKey('D:/p', 'Pkg-X'))
}

// ── ⑧ 接线：作业层拿不到锁 ⇒ 如实失败、不进 AI 兜底、诊断分类是 package-locked ────────────
{
  lock.__resetInstallLocks()
  const profileDir = makeProfile('job-wiring')
  const probe = newProbe()
  let pnpmCalls = 0
  const ch = makeChannels(probe, { holdMs: 5, onPnpm: () => { pnpmCalls += 1 } })
  // 作业层用到的模板：profileDir 由 loader 的 cordis:include 行推导（与真机同一条路）
  const ports = {
    baseUrl: 'file:///',
    get: (key) => (key === 'installChannels' ? ch : null),
    loader: { entries: () => [{ id: 'include', options: { name: 'cordis:include', group: true, config: { path: pathToFileURL(join(profileDir, 'cordis.yml')).href } } }] },
  }
  const holder = lock.withInstallLock({ profileDir, packageName: 'pkg-wired' }, async () => await new Promise((resolve) => setTimeout(resolve, 200)))
  await new Promise((resolve) => setTimeout(resolve, 30))
  const job = {
    id: 'wired', repo: '', source: 'github', packageName: 'pkg-wired', status: 'installing', stage: 'preparing',
    update: true, version: null, kind: 'plugin', candidateTotal: 1,
  }
  await runInstallJob(job, ports, { aiConsentTimeoutMs: 30, installLockWaitMs: 50 })
  await holder
  check('⑧ ★ 作业如实失败（status=failed / stage=install-lock）', job.status === 'failed' && job.stage === 'install-lock', `${job.status}/${job.stage}`)
  check('⑧ ★ 不进 AI 兜底（这不是"哪一步坏了"，而是"这个包正被装着"）', job.aiPending === null || job.aiPending === undefined, JSON.stringify(job.aiPending ?? null))
  check('⑧ ★ 错误文案说清"正在安装中"，而不是"安装失败"', /正在安装中/u.test(String(job.error ?? '')), String(job.error ?? '').slice(0, 120))
  check('⑧ 诊断分类是 package-locked（不会被 network-timeout 的宽判据抢走）', job.diagnosis?.kind === 'package-locked', String(job.diagnosis?.kind))
  check('⑧ ★ 这条路上一次 pnpm 都没跑（别人的目录一个字都没动）', pnpmCalls === 0, `pnpm 调用 ${pnpmCalls} 次`)
  check('⑧ 视图里带 installLock（面板能显示"在排队/超时"）', installJobView(job).installLock?.timeout === true, JSON.stringify(installJobView(job).installLock ?? null))
}

// ── ⑨ 契约：/state 既有字段一个不少，installLock 默认恒 null ─────────────────────────
{
  const view = installJobView({ id: 'v', status: 'done', packageName: 'x', repo: 'o/r', startedAt: 1 })
  const MUST = ['jobId', 'repo', 'packageName', 'status', 'stage', 'error', 'startedAt', 'finishedAt', 'entryId', 'bundle', 'ai', 'aiNote',
    'version', 'installedVersion', 'versionMiss', 'subpackages', 'source', 'curlNote', 'bundleNote', 'lockUpdated', 'lockVersion', 'lockNote',
    'depNote', 'channelNotes', 'compatNote', 'kind', 'skillName', 'skillDir', 'skillNote', 'suiteReport', 'suiteNote', 'repoSize', 'hint',
    'subplugin', 'progress', 'aiConsent', 'diagnosis', 'entryCheck', 'integrity', 'persisted', 'persistNote', 'persist',
    'installedEvidence', 'selfUpdate', 'probe', 'localDir', 'localHint']
  const missing = MUST.filter((k) => !(k in view))
  check('⑨ ★ /state 里作业视图的既有字段一个不少（47 项逐项对照）', missing.length === 0, missing.length === 0 ? '全在' : `缺：${missing.join(', ')}`)
  check('⑨ 未并发时 installLock 恒 null（既有契约不受影响）', view.installLock === null, JSON.stringify(view.installLock))
}

// ── ⑩ 正控：诊断规则不会把"锁"误判成网络超时 ────────────────────────────────────────
{
  const text = '这个包正在安装中：另一个作业（job-3）正在安装这个包，已进行 12s。本次已排队等待 60s 仍未轮到，已放弃（没有动任何文件）——请等它结束后重试。'
  const diagnosis = classifyInstallFailure(text)
  check('⑩ ★ "正在安装中"归到 package-locked（不是 network-timeout：那段文案里也有"超时"字样）', diagnosis.kind === 'package-locked', diagnosis.kind)
  check('⑩ 该分类**不触发任何自动重试**（retry=null）', diagnosis.retry === null, String(diagnosis.retry))
  check('⑩ 真正的网络超时仍归 network-timeout（正控：别把分类改宽了）',
    classifyInstallFailure('fetch timeout while downloading tarball').kind === 'network-timeout')
}

const summary = `\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`
process.stdout.write(`${summary}\n`, () => process.exit(fail === 0 ? 0 : 1))
