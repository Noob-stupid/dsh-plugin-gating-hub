// 批次 D-③ 的**接线**验收（2026-09-27）：预设型子包的源码装配通道被真的接进候选循环了吗？
//
// 真机事故：yjh051108/dsh-routing-suite 三件套只装到两件。第三件 `dsh-router-standard` 的
// 按包名通道（registry / curl / release）必然全 404，唯一出路是"稀疏取源码 → 按预设装配"。
// 本用例把接线钉死（真 git + 本机裸仓库 + 真 runInstallJob；一个网络请求都不发）：
//   ① 通道顺序：竞速 → pnpm → curl → release → 展开 → **预设源码装配**；预设成功时 git 通道**不再被调**
//   ② 预设通道成功 → 返回 installedName（外层据此收口），job.presetDone=true
//   ③ runInstallJob 全链路：**绝不写补丁行 / 绝不声明依赖**（否则补丁行指向不存在的模块 → 启动崩溃）、
//      预设真的落盘、job.status=done、presetNote 含"新建会话时选择"
//   ④ 反例：候选不是预设型 → 预设通道零副作用，照旧走后面的通道（不掉既有能力）
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { runInstallJob, tryCandidateChannels } from '../lib/server/domain/install-job.js'
import { disposeDir } from '../lib/server/infra/fsx.js'
import { gitBin } from '../lib/server/infra/exec.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const HOME = join(tmpdir(), `dsh-preset-wiring-${process.pid}`)
const PROFILE = join(HOME, 'profiles', 'web')
mkdirSync(PROFILE, { recursive: true })
writeFileSync(join(PROFILE, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }, null, 2), 'utf8')
writeFileSync(join(PROFILE, 'cordis.patch.yml'), '# wiring fixture\n', 'utf8')
writeFileSync(join(PROFILE, 'cordis.yml'), 'plugins: []\n', 'utf8')
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })
const savedHome = process.env.DSH_HOME
process.env.DSH_HOME = HOME

// ── 夹具：结构照抄真机仓库（根包 private + 三个子包目录，preset/ 里有两个预设）────────────
const GITROOT = join(HOME, 'gitroot')
const WORK = join(HOME, 'work')
mkdirSync(join(WORK, 'graded'), { recursive: true })
mkdirSync(join(WORK, 'injector'), { recursive: true })
mkdirSync(join(WORK, 'preset', 'router-standard'), { recursive: true })
const AGENT_YML = '# agent.cordis.yml（接线夹具）\nplugins:\n  - id: router\n    name: "@probe/router-bootstrap"\n'
writeFileSync(join(WORK, 'package.json'), JSON.stringify({ name: '@dsh-external/dsh-super-injector', version: '0.3.3', private: true }, null, 2), 'utf8')
writeFileSync(join(WORK, 'README.md'), '# wiring\n', 'utf8')
writeFileSync(join(WORK, 'graded', 'package.json'), JSON.stringify({ name: '@probe/stub-graded-mode', version: '0.0.1' }, null, 2), 'utf8')
writeFileSync(join(WORK, 'graded', 'index.js'), 'module.exports = "graded"\n', 'utf8')
writeFileSync(join(WORK, 'injector', 'package.json'), JSON.stringify({ name: '@probe/stub-super-injector', version: '0.3.3' }, null, 2), 'utf8')
writeFileSync(join(WORK, 'injector', 'index.js'), 'module.exports = "injector"\n', 'utf8')
writeFileSync(join(WORK, 'preset', 'package.json'), JSON.stringify({ name: 'dsh-router-standard', version: '0.3.0' }, null, 2), 'utf8')
writeFileSync(join(WORK, 'preset', 'router-standard', 'agent.cordis.yml'), AGENT_YML, 'utf8')
writeFileSync(join(WORK, 'preset', 'router-standard', 'preset.yml'), 'name: Router Standard\norder: 1\n', 'utf8')
writeFileSync(join(WORK, 'preset', 'router-standard', 'router-core.mjs'), 'export const core = 1\n', 'utf8')
{
  const git = gitBin()
  const run = (cwd, args) => execFileSync(git, args, {
    cwd, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@local', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@local' },
  })
  run(WORK, ['init', '-q'])
  run(WORK, ['add', '-A'])
  run(WORK, ['commit', '-qm', 'fixture'])
  mkdirSync(join(GITROOT, 'probe-org'), { recursive: true })
  run(HOME, ['clone', '-q', '--bare', WORK, join(GITROOT, 'probe-org', 'routing-suite.git')])
  writeFileSync(join(HOME, 'plugin-console-sources.json'), JSON.stringify({
    registries: [{ id: 'noop', name: '无源', url: 'http://127.0.0.1:1', primary: true }],
    gitSources: [{ id: 'local-bare', name: '本机裸仓库', urlTemplate: `${pathToFileURL(GITROOT).href}/{owner}/{repo}.git`, primary: true }],
    archiveSources: [{ id: 'dead', name: '死源', urlTemplate: 'http://127.0.0.1:1/{owner}/{repo}/archive/{branch}.tar.gz', primary: true }],
    indexSources: [],
  }, null, 2), 'utf8')
}
const cloneOpts = { probeDetail: async () => ({ alive: true, kind: 'local', status: null, note: '本地裸仓库' }), archive: null, reuseLanded: false }
const sourceDeps = { sizeDeps: { probe: async () => ({ state: 'known', sizeKb: 1334 }) }, fetchDeps: { cloneOpts }, presetsRoot: join(HOME, 'presets-order'), now: () => 42 }

const ports = {
  baseUrl: pathToFileURL(join(PROFILE, 'cordis.yml')).href,
  loader: { entries: () => [] },
  get: () => undefined,
}
const REPO = 'probe-org/routing-suite'
const PRESET_NAME = 'dsh-router-standard'

// ── ① 通道顺序：预设源码装配在 release 之后、git 之前；预设成功 → git 一次都不调 ──────────────
{
  const calls = []
  const ch = {
    raceInstallChannels: async () => { calls.push('race'); return null },
    pnpmInstall: async (dir, spec) => {
      if (String(spec).startsWith('git+') || String(spec).startsWith('github:')) { calls.push('git'); throw new Error('桩：git 不通') }
      calls.push(`pnpm:${spec}`)
      throw new Error('桩：registry 404（该子包没发布）')
    },
    curlManualInstall: async () => { calls.push('curl'); throw new Error('桩：curl 404') },
    githubReleaseInstall: async () => { calls.push('release'); throw new Error('桩：release 无资产') },
    backfillMissingDeps: async () => [],
  }
  const job = { id: 'order', repo: REPO, packageName: null, update: false, source: 'github', channelNotes: [] }
  const res = await tryCandidateChannels({
    job, ch, name: PRESET_NAME, profileDir: PROFILE, registries: ['http://127.0.0.1:1'],
    repoChannelAllowed: true, budget: { release: 3 }, expanded: false, sourceDeps,
    expand: async () => 0,
  })
  check('① 预设通道成功 → 返回 installedName（外层据此收口）', res.installedName === PRESET_NAME, JSON.stringify(res))
  check('① job.presetDone=true 且 presetNote 含「新建会话时选择」',
    job.presetDone === true && /新建会话时选择/u.test(String(job.presetNote)), String(job.presetNote))
  check('★① 顺序：竞速 → pnpm → curl → release 都在；且**预设成功时 git 通道一次都没被调**',
    ['race', 'curl', 'release'].every((c) => calls.includes(c)) && calls.some((c) => c.startsWith('pnpm:')) && !calls.includes('git'),
    calls.join(' → '))
  check('① 预设真的落盘（<presetsRoot>/router-standard/agent.cordis.yml）',
    existsSync(join(HOME, 'presets-order', 'router-standard', 'agent.cordis.yml')))
  check('① channelNotes 记下稀疏取源码与 sparse-checkout set（面板可见）',
    job.channelNotes.some((n) => n.includes('--filter=blob:none --sparse')) && job.channelNotes.some((n) => n.includes('sparse-checkout set preset')),
    JSON.stringify(job.channelNotes))
}

// ── ② 反例：候选不是预设型 → 预设通道零副作用，照旧走 git（既有能力一点没少）────────────────
{
  const calls = []
  const ch = {
    raceInstallChannels: async () => { calls.push('race'); return null },
    pnpmInstall: async (dir, spec) => {
      if (String(spec).startsWith('git+') || String(spec).startsWith('github:')) { calls.push('git'); throw new Error('桩：git 不通') }
      calls.push('pnpm')
      throw new Error('桩：registry 404')
    },
    curlManualInstall: async () => { calls.push('curl'); throw new Error('桩：curl 404') },
    githubReleaseInstall: async () => { calls.push('release'); throw new Error('桩：release 无资产') },
    backfillMissingDeps: async () => [],
  }
  const job = { id: 'order2', repo: REPO, packageName: null, update: false, source: 'github', channelNotes: [] }
  await tryCandidateChannels({
    job, ch, name: '@probe/stub-graded-mode', profileDir: PROFILE, registries: ['http://127.0.0.1:1'],
    repoChannelAllowed: true, budget: { release: 3 }, expanded: false, sourceDeps,
    expand: async () => 0,
  })
  check('★② 名字不像预设型 → 预设通道零副作用（不建 presetTried、不取源码），git 照旧被尝试',
    calls.includes('git') && job.presetTried === undefined && job.presetDone === undefined, calls.join(' → '))
  check('② 尺寸门禁也没被白跑（没写 presetSource / 没动 presetsRoot）',
    job.presetSource === undefined && !existsSync(join(HOME, 'presets-order', 'router-spec')))
}

// ── ③ runInstallJob 全链路：绝不写补丁行 / 绝不声明依赖；预设真的装成 ─────────────────────
{
  const presetsRoot = join(HOME, 'presets-full')
  const patchBefore = readFileSync(join(PROFILE, 'cordis.patch.yml'), 'utf8')
  const manifestBefore = readFileSync(join(PROFILE, 'package.json'), 'utf8')
  const job = {
    id: 'job-preset-full', repo: REPO, source: 'github', packageName: null,
    status: 'installing', stage: 'preparing', error: null, startedAt: Date.now(), finishedAt: null,
    entryId: null, bundle: false, ai: false, aiNote: null, subpackages: null, lastError: null, update: false, kind: 'plugin',
  }
  const ch = {
    raceInstallChannels: async () => null,
    pnpmInstall: async () => { throw new Error('桩：registry 404（该子包没发布）') },
    curlManualInstall: async () => { throw new Error('桩：curl 404') },
    githubReleaseInstall: async () => { throw new Error('桩：release 无资产') },
    backfillMissingDeps: async () => [],
  }
  let thrown = null
  try {
    await runInstallJob(job, { ...ports, get: (key) => (key === 'installChannels' ? ch : undefined) }, {
      jobBudgetMs: 60000,
      aiConsentTimeoutMs: 300,
      marketProbes: {
        fetchRepoPackageEx: async () => ({ pkg: { name: '@dsh-external/dsh-super-injector', private: true }, reason: 'ok' }),
        fetchRepoPackage: async () => ({ name: '@dsh-external/dsh-super-injector', private: true }),
        subpackageCandidates: async () => ['@probe/stub-graded-mode', PRESET_NAME],
        fetchSubpackageNames: async () => [],
        expandSubpackages: async () => [],
        namePublished: async () => false,
        probeGitmodules: async () => null,
      },
      sourceDeps: { sizeDeps: { probe: async () => ({ state: 'known', sizeKb: 1334 }) }, fetchDeps: { cloneOpts }, presetsRoot, now: () => 99 },
    })
  } catch (error) { thrown = error }
  const patchAfter = readFileSync(join(PROFILE, 'cordis.patch.yml'), 'utf8')
  const manifestAfter = readFileSync(join(PROFILE, 'package.json'), 'utf8')
  console.log(`INFO ③ status=${job.status} stage=${job.stage} presetNote=${String(job.presetNote ?? '').slice(0, 200)}`)
  check('③ 作业自己收尾（无异常逃逸）+ status=done', thrown === null && job.status === 'done', thrown === null ? JSON.stringify({ status: job.status, stage: job.stage }) : String(thrown?.message).slice(0, 200))
  check('★★③ **绝不写补丁行**（旧路径会给一个不存在的模块 appendInsert → 下次启动服务崩）',
    !patchAfter.includes(PRESET_NAME) && patchAfter === patchBefore, `patchChanged=${patchAfter !== patchBefore}`)
  check('★★③ **绝不声明依赖**（预设不是 npm 包，写进 profile 清单会让后续 pnpm 操作硬失败）',
    !manifestAfter.includes(PRESET_NAME), manifestAfter.replace(/\s+/gu, ' ').slice(0, 160))
  check('★③ 预设真的落盘到 <presetsRoot>/router-standard/agent.cordis.yml（字节数可贴）',
    existsSync(join(presetsRoot, 'router-standard', 'agent.cordis.yml')),
    `bytes=${existsSync(join(presetsRoot, 'router-standard', 'agent.cordis.yml')) ? readFileSync(join(presetsRoot, 'router-standard', 'agent.cordis.yml')).length : 0}`)
  check('★③ job.presetNote 说清落盘根目录 + 「新建会话时选择」+ 稀疏取源码',
    String(job.presetNote).includes(presetsRoot) && /新建会话时选择/u.test(String(job.presetNote)) && /稀疏取源码/u.test(String(job.presetNote)),
    String(job.presetNote).slice(0, 300))
  check('③ job.packageName 就是那个候选（面板显示的是真正装上的那一件）', job.packageName === PRESET_NAME, String(job.packageName))
  check('③ 面板可读的结构化结果：presetInstalled[0] 有 name/dest/bytes/subdir/sparse',
    Array.isArray(job.presetInstalled) && job.presetInstalled.length === 1 && job.presetInstalled[0].name === 'router-standard'
    && job.presetInstalled[0].bytes > 0 && job.presetInstalled[0].subdir === 'preset' && job.presetInstalled[0].sparse === true,
    JSON.stringify(job.presetInstalled))
  check('③ 没有留下 AI 兜底等待（预设成功后不该再挂起等授权）', job.aiPending === null || job.aiPending === undefined, String(job.aiPending))
  check('③ 没有 _tmp_ / 半成品目录残留（node_modules 里不该出现这个预设包名）',
    !existsSync(join(PROFILE, 'node_modules', PRESET_NAME)))
}

// ── ④ 面板契约（加法）：服务端字段 + 客户端文案（中英两套）+ 失败不笼统 ────────────────
{
  const { installJobView } = await import('../lib/server/domain/install.js')
  const view = installJobView({
    id: 'v1', repo: REPO, packageName: PRESET_NAME, status: 'done',
    presetNote: '预设已装配：router-standard（落盘 X/.agent-presets）',
    presetInstalled: [{ name: 'router-standard', ok: true, bytes: 16538 }],
    presetSource: { repo: REPO, subdir: 'preset', sparse: true },
    repoSize: { state: 'known', sizeKb: 1334, limitMb: 20 },
    channelNotes: ['已用稀疏取源码'],
  })
  check('④ installJobView 下发 presetNote / presetInstalled / presetSource / repoSize（面板与排障都能看到）',
    typeof view.presetNote === 'string' && Array.isArray(view.presetInstalled) && view.presetSource?.sparse === true && view.repoSize?.sizeKb === 1334,
    JSON.stringify({ p: view.presetNote, i: view.presetInstalled?.length, s: view.presetSource, r: view.repoSize }))
  check('④ 老客户端兼容：没有预设字段时不报错（全是 null）',
    installJobView({ id: 'v2' }).presetNote === null && installJobView({ id: 'v2' }).presetInstalled === null)

  const clientSrc = readFileSync('lib/client.js', 'utf8')
  check('④ 客户端有「预设：新建会话时选择」短句，且中英两套都在',
    /presetDot:\s*"。预设：新建会话时选择"/u.test(clientSrc) && /presetDot:\s*"\. Preset: pick it when starting a new session"/u.test(clientSrc))
  check('④ 客户端有「预设已装配」标题（中英两套）',
    clientSrc.includes('presetInstalledMsg: "预设已装配"') && clientSrc.includes('presetInstalledMsg: "Presets installed"'))
  check('★④ 成功路径按 presetNote 分支渲染（含落盘路径 + 新建会话提示）',
    /data\.presetNote === "string"[\s\S]{0,400}t\("presetInstalledMsg"\)[\s\S]{0,200}t\("presetDot"\)/u.test(clientSrc))
  check('★④ 失败路径把服务端 channelNotes 逐条展示（不再只显示笼统"失败"）',
    /view\.status === "failed" && channelNotes\.length > 0/u.test(clientSrc) && clientSrc.includes('diagChannelNotes'))
  check('★④ 预设装配成功时不再自动刷新页面（否则「落盘路径 + 新建会话时选择」会被冲掉）',
    /typeof data\.presetNote === "string" && data\.presetNote !== ""\)\)\s*\{/u.test(clientSrc))

  // 失败不笼统：预设通道失败时 lastError 必须是**具体原因**
  // 把 git 源换成"连上就断"的死源（本机 127.0.0.1:1），逼出真实的失败路径。
  writeFileSync(join(HOME, 'plugin-console-sources.json'), JSON.stringify({
    registries: [{ id: 'noop', name: '无源', url: 'http://127.0.0.1:1', primary: true }],
    gitSources: [{ id: 'dead-git', name: '死源', urlTemplate: 'http://127.0.0.1:1/{owner}/{repo}.git', primary: true }],
    archiveSources: [{ id: 'dead', name: '死源', urlTemplate: 'http://127.0.0.1:1/{owner}/{repo}/archive/{branch}.tar.gz', primary: true }],
    indexSources: [],
  }, null, 2), 'utf8')
  const jobFail = { id: 'fail', repo: REPO, packageName: null, update: false, source: 'github', channelNotes: [] }
  const chFail = {
    raceInstallChannels: async () => null,
    pnpmInstall: async () => { throw new Error('桩：registry 404') },
    curlManualInstall: async () => { throw new Error('桩：curl 404') },
    githubReleaseInstall: async () => { throw new Error('桩：release 无资产') },
    backfillMissingDeps: async () => [],
  }
  const resFail = await tryCandidateChannels({
    job: jobFail, ch: chFail, name: PRESET_NAME, profileDir: PROFILE, registries: ['http://127.0.0.1:1'],
    repoChannelAllowed: false, budget: { release: 3 }, expanded: true,
    sourceDeps: { sizeDeps: { probe: async () => ({ state: 'known', sizeKb: 1334 }) }, fetchDeps: { cloneOpts: { archive: null, reuseLanded: false } }, presetsRoot: join(HOME, 'presets-fail') },
  })
  check('★④ 预设通道失败时 lastError 是**具体原因**（点名候选 + 说明哪一步失败），不是笼统"失败"',
    resFail.installedName === null && /预设型子包 dsh-router-standard/u.test(String(resFail.lastError?.message))
    && /稀疏取源码失败|clone/u.test(String(resFail.lastError?.message)),
    String(resFail.lastError?.message).slice(0, 260))
  check('★④ 失败原因也写进 channelNotes（面板可见，下一步有路可走）',
    jobFail.channelNotes.some((n) => n.includes('预设型子包') && n.includes('源码装配失败')), JSON.stringify(jobFail.channelNotes))
}

// ── 收尾 ────────────────────────────────────────────────────────────────────────────────
if (savedHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = savedHome
try { disposeDir(HOME) } catch {}
assert.ok(pass > 0)
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
