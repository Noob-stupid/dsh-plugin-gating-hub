// ③ 安装失败分类 → 定向重试一次（2026-09-26）
//
// 交付两件事（都是加法）：
//   ① 纯函数 classifyInstallFailure(text) → { kind, hint, retry }：覆盖 minimumReleaseAge /
//      allowBuilds / missing-tool / not-found / locked / network-timeout / other；
//   ② 安装失败路径接线：只有 network-timeout（retry='longer-timeout'）会用**更长超时**自动重试**一次**，
//      其余分类只把 hint 写进 job.diagnosis（installJobView 下发），不新增任何自动重试。
// 安全边界（本用例钉死）：allowBuilds / ignored build scripts **只提示**，绝不自动写用户的
// allowBuilds / 构建白名单 —— 用例会在临时 DSH_HOME 里搜 "allowBuilds" 字样确认没有任何落盘。
//
// 全部离线：DSH_HOME 指向临时目录，安装通道用 strictCtx 注入桩（与 test-suite-install.mjs 同款替身）。
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { strictCtx, violationsOf } from './strict-ctx.mjs'
import { removeDirVerifiedAsync } from '../lib/server/infra/fsx.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const HOME = join(tmpdir(), `dsh-diagnose-${Date.now()}-${process.pid}`)
process.env.DSH_HOME = HOME
const profileDir = join(HOME, 'profiles', 'web')
mkdirSync(profileDir, { recursive: true })
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }, null, 2), 'utf8')
writeFileSync(join(profileDir, 'cordis.patch.yml'), '# diagnose test\n', 'utf8')

const { classifyInstallFailure, longerTimeoutFor, diagnosisText } = await import(new URL('../lib/server/domain/install-diagnose.js', import.meta.url).href)
const { runInstallJob } = await import(new URL('../lib/server/domain/install-job.js', import.meta.url).href)
const { installJobView } = await import(new URL('../lib/server/domain/install.js', import.meta.url).href)
const mod = await import(new URL('../lib/index.js', import.meta.url).href)

// ── ① 纯函数分类 ────────────────────────────────────────────────────────────
{
  const cases = [
    ['minimumReleaseAge', 'ERR_PNPM_MINIMUM_RELEASE_AGE The version 1.2.3 was published too recently (minimumReleaseAge)'],
    ['minimumReleaseAge', 'minimum release age: 1440 minutes (发布年龄未满)'],
    ['allowBuilds', 'Ignored build scripts: sharp, esbuild. Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.'],
    ['allowBuilds', 'ERR_PNPM_IGNORED_BUILDS  The following packages have build scripts that were ignored: sharp'],
    ['missing-tool', 'spawn git.exe ENOENT'],
    ['missing-tool', "Error: Cannot find module '/usr/local/bin/node_modules/corepack/dist/corepack.js'"],
    ['not-found', "ERR_PNPM_FETCH_404  GET https://registry.npmmirror.com/dsh-nope: Not Found - 404"],
    ['locked', 'EPERM: operation not permitted, rename node_modules/left-pad_tmp_1234'],
    ['locked', 'EBUSY: resource busy or locked, unlink node_modules/.pnpm/x'],
    ['network-timeout', 'request to https://registry.npmmirror.com/left-pad failed, reason: connect ETIMEDOUT 104.16.0.1:443'],
    ['network-timeout', 'ECONNRESET socket hang up'],
    ['network-timeout', 'Command failed: … pnpm add left-pad（超时 4000ms：已终止整棵进程树 pid=1234）'],
    ['network-timeout', 'ERR_PNPM_TARBALL_FETCH_FAIL'],
    ['other', 'ERR_PNPM_UNSUPPORTED_ENGINE  Unsupported environment'],
  ]
  for (const [kind, text] of cases) {
    const d = classifyInstallFailure(text)
    check(`分类：${kind} ← ${text.slice(0, 52)}`, d.kind === kind, `得到 ${d.kind}`)
  }
  const wt = classifyInstallFailure('ECONNRESET')
  check('network-timeout → retry=longer-timeout（唯一会被自动重试的分类）', wt.retry === 'longer-timeout')
  check('allowBuilds → retry=null（绝不自动重试）', classifyInstallFailure('Ignored build scripts: sharp').retry === null)
  check('allowBuilds 的 hint 明写"绝不自动写 allowBuilds / 构建白名单"（安全边界写进面向用户的文案）',
    /绝不自动写 allowBuilds/u.test(classifyInstallFailure('Ignored build scripts: sharp').hint))
  check('minimumReleaseAge → retry=later（提示稍后重试，不自动放宽安全间隔）',
    classifyInstallFailure('ERR_PNPM_MINIMUM_RELEASE_AGE').retry === 'later'
    && /不替你放宽安全间隔/u.test(classifyInstallFailure('ERR_PNPM_MINIMUM_RELEASE_AGE').hint))
  check('每个分类都有非空 hint（面板不会出现空提示）',
    cases.every(([, text]) => typeof classifyInstallFailure(text).hint === 'string' && classifyInstallFailure(text).hint.length > 10))
  check('空/非字符串输入不炸，回落 other',
    classifyInstallFailure(undefined).kind === 'other' && classifyInstallFailure(null).kind === 'other' && classifyInstallFailure(123).kind === 'other')

  check('longerTimeoutFor：90s → 180s（默认通道的两倍）', longerTimeoutFor(90000) === 180000)
  check('longerTimeoutFor：60s → 120s', longerTimeoutFor(60000) === 120000)
  check('longerTimeoutFor：小超时至少 +15s', longerTimeoutFor(4000) === 19000)
  check('longerTimeoutFor：封顶 4 分钟（重试不能变成再卡很久）', longerTimeoutFor(600000) === 240000 && longerTimeoutFor(90000, { cap: 100000 }) === 100000)
  check('longerTimeoutFor：非法输入回落 90s 再翻倍', longerTimeoutFor(0) === 180000 && longerTimeoutFor(undefined) === 180000 && longerTimeoutFor(-5) === 180000)
  check('diagnosisText：一行文案含分类与"已自动重试"',
    /失败分类：network-timeout（已自动重试一次：更长超时）/u.test(diagnosisText({ kind: 'network-timeout', hint: 'h', retry: 'longer-timeout', retried: true }))
    && diagnosisText(null) === null)
}

// ── ②③ 安装失败路径接线（真跑 runInstallJob，通道打桩，DSH_HOME 在临时目录）──
const PKG = 'dsh-diagnose-probe'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 跑一个作业：所有确定性通道都失败（pnpm 抛传入的错误文本），走到 AI 授权后自动拒绝。 */
async function runScenario(label, pnpmMessage) {
  const calls = []
  const installChannels = {
    raceInstallChannels: async (dir, name) => { calls.push(`race:${name}`); return null },
    pnpmInstall: async (dir, spec, registry, timeout) => {
      calls.push(`pnpm:${spec}:${timeout}`)
      if (spec === PKG) throw new Error(pnpmMessage)
      throw new Error(`离线夹具：git 规格 ${spec} 不联网`)
    },
    curlManualInstall: async (dir, name) => { calls.push(`curl:${name}`); throw new Error('离线夹具：curl 不联网') },
    githubReleaseInstall: async (dir, repo, name) => { calls.push(`release:${name}`); throw new Error('离线夹具：release 不联网') },
    backfillMissingDeps: async () => [],
  }
  const ctx = strictCtx({
    inject: mod.inject,
    services: {
      loader: {
        entries: () => [{
          id: 'include', options: { name: 'cordis:include', group: true, config: { path: pathToFileURL(join(profileDir, 'cordis.yml')).href } },
        }],
      },
      installChannels,
    },
    own: { baseUrl: pathToFileURL(join(profileDir, 'cordis.yml')).href },
  })
  const job = {
    id: `job-${label}`, repo: null, source: 'github', packageName: PKG, status: 'installing', stage: null,
    error: null, startedAt: Date.now(), finishedAt: null, entryId: null, bundle: false, ai: false, aiNote: null,
    subpackages: null, lastError: null, update: false, kind: 'plugin',
  }
  const running = runInstallJob(job, ctx)
  for (let i = 0; i < 200 && job.stage !== 'ai-consent'; i += 1) await sleep(25)
  const reachedConsent = job.stage === 'ai-consent'
  if (reachedConsent) job.aiPending.resolver({ approved: false }) // 真实前端"取消"同款路径
  await running
  return { job, calls, ctx, reachedConsent }
}

{
  // 场景 A：网络类超时 → 定向重试**一次**、且用更长超时
  // 注意：pnpm 通道本身会对**每个** registry 各试一次（默认源 2 个：npmmirror → npmjs），
  // 所以"原超时"那几次是既有语义；本条断言的是**额外**出现了且只出现了一次 180s 的定向重试。
  const a = await runScenario('a', 'ERR_PNPM_META_FETCH_FAIL request to https://registry.npmmirror.com/x failed, reason: connect ETIMEDOUT 104.16.0.1:443')
  const pnpmOfPkg = a.calls.filter((c) => c.startsWith(`pnpm:${PKG}:`))
  const aRetries = pnpmOfPkg.filter((c) => c.endsWith(':180000'))
  check('A 走到 AI 授权（说明确定性通道都试完了，不是提前中断）', a.reachedConsent === true, `stage=${a.job.stage}`)
  check('A 网络超时 → 定向重试恰好一次（180s），其余是既有的逐源尝试（不加试）',
    aRetries.length === 1 && pnpmOfPkg.length === aRetries.length + 2, pnpmOfPkg.join(' | '))
  check('A 既有逐源尝试的超时参数没有被改动（仍走默认 90s）',
    pnpmOfPkg.filter((c) => !c.endsWith(':180000')).every((c) => c.endsWith(':undefined')), pnpmOfPkg.join(' | '))
  check('A job.diagnosis 记下分类与"已重试"', a.job.diagnosis?.kind === 'network-timeout' && a.job.diagnosis?.retried === true && a.job.diagnosis?.retryTimeoutMs === 180000,
    JSON.stringify(a.job.diagnosis))
  check('A 作业仍按既有语义失败（重试失败不改变成功判定）',
    a.job.status === 'failed' && /取消本地 AI 兜底/u.test(a.job.error ?? ''), `status=${a.job.status}`)
  const viewA = installJobView(a.job)
  check('A 面板视图下发 diagnosis（新增可选字段）', viewA.diagnosis?.kind === 'network-timeout' && /重试/u.test(viewA.diagnosis.hint))
  check('A 其它通道行为不变（race/curl/release/git 仍按原顺序尝试）',
    a.calls.some((c) => c.startsWith('race:')) && a.calls.some((c) => c.startsWith('curl:')) && a.calls.some((c) => c.startsWith('release:'))
    && a.calls.some((c) => c.startsWith('pnpm:git+')), a.calls.join(' → ').slice(0, 180))

  // 场景 B：404 → 不自动重试，只提示
  const b = await runScenario('b', 'ERR_PNPM_FETCH_404  GET https://registry.npmmirror.com/dsh-diagnose-probe: Not Found - 404')
  const pnpmOfPkgB = b.calls.filter((c) => c.startsWith(`pnpm:${PKG}:`))
  check('B 404 → 没有任何定向重试（只有既有的逐源尝试）',
    pnpmOfPkgB.every((c) => !c.endsWith(':180000')) && pnpmOfPkgB.length >= 1, pnpmOfPkgB.join(' | '))
  check('B job.diagnosis.kind=not-found 且 retry=null，无 retried 标记',
    b.job.diagnosis?.kind === 'not-found' && b.job.diagnosis?.retry === null && b.job.diagnosis?.retried === undefined,
    JSON.stringify(b.job.diagnosis))
  check('B hint 指向"核对包名/镜像未同步"', /镜像未同步/u.test(b.job.diagnosis?.hint ?? ''))

  // 场景 C：allowBuilds → 只提示、绝不自动写白名单、绝不重试
  const c = await runScenario('c', 'Ignored build scripts: sharp, esbuild. Run "pnpm approve-builds" to allow them.')
  const pnpmOfPkgC = c.calls.filter((x) => x.startsWith(`pnpm:${PKG}:`))
  check('C allowBuilds → 没有任何定向重试（只提示）',
    pnpmOfPkgC.every((x) => !x.endsWith(':180000')) && pnpmOfPkgC.length >= 1, pnpmOfPkgC.join(' | '))
  check('C job.diagnosis.kind=allowBuilds，hint 明写"绝不自动写 allowBuilds"',
    c.job.diagnosis?.kind === 'allowBuilds' && /绝不自动写 allowBuilds/u.test(c.job.diagnosis?.hint ?? ''), JSON.stringify(c.job.diagnosis))
  check('C 严格替身账本为空（新代码没有属性式读取未声明的 ctx 名字）',
    violationsOf(c.ctx).length === 0, [...new Set(violationsOf(c.ctx))].join('、'))
}

// ── 安全边界落盘核对：整个临时 DSH_HOME 里不该出现任何 allowBuilds 写入 ──────
{
  const hits = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(json|yaml|yml|npmrc|txt)$/u.test(e.name)) {
        try { if (/allowBuilds|onlyBuiltDependencies/iu.test(readFileSync(p, 'utf8'))) hits.push(p) } catch {}
      }
    }
  }
  try { walk(HOME) } catch {}
  check('安全边界：临时 profile 里没有任何 allowBuilds / 构建白名单被写入（只提示，不代写）',
    hits.length === 0, hits.join('、') || '（无）')
}

// 清理临时 DSH_HOME：本机实测 rmSync 会静默落空（目录仍在、不抛错）→ 用仓库自己的"删除+核实"助手
try {
  const cleaned = await removeDirVerifiedAsync(HOME, { attempts: 1, pollMs: 400 })
  if (cleaned.ok !== true) console.log(`（提示：临时目录未能删除：${HOME} — ${cleaned.error ?? '未知'}）`)
} catch {}
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
