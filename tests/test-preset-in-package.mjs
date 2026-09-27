// 批次 D-⑥（2026-09-27 真机验证发现的**第三个缺陷**）：**预设随包分发**。
//
// 真机现场（官方桌面端实例、0.5.25，卡片"子包"列表第三件的等价调用）：
//   POST /install {repo:'yjh051108/dsh-routing-suite', packageName:'dsh-router-standard'}
//   → release 通道按包名反查到**它自己的仓库** yjh051108/dsh-router-standard 的 release 资产
//     （dsh-router-standard-0.3.0.tgz）→ 装成 node_modules/dsh-router-standard@0.3.0。
//   那个包体里没有 main/exports、也没有 dsh.bundle，只有 preset/（三个预设目录）+ docs/。旧行为：
//     ① 预设一个字节都没进 ~/.dsh/.agent-presets → 用户依然用不上（预设才是他要的东西）；
//     ② 却照样 appendInsert 一行 `- insert: {id: dsh-router-standard}` → 注册一个加载不了的模块行
//        （2026-09-06「装 dsh-desktop 后服务崩」事故同族）。
//
// 本用例全离线（不联网、真 git 只在 ① 用本机裸仓库，其余用目录夹具）：
//   ① findCarriedPresets：包根/一层/两层里的预设都能找到；普通包返回空
//   ② installPresetsCarriedByPackage 全链路：装配进 .agent-presets（默认**只补不覆盖**）+ job 收口
//   ③ runInstallJob 端到端：release 通道装下来的"带预设的包" → **不写补丁行、不声明依赖**、预设真的落盘
//   ④ 反例（保住既有语义）：普通插件包照旧写补丁行 + 声明依赖（能力一点没少）
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { findCarriedPresets, installPresetsCarriedByPackage, settlePresetOutcome } from '../lib/server/domain/preset-in-package.js'
import { runInstallJob } from '../lib/server/domain/install-job.js'
import { disposeDir } from '../lib/server/infra/fsx.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const HOME = join(tmpdir(), `dsh-preset-in-package-${process.pid}`)
const PROFILE = join(HOME, 'profiles', 'web')
mkdirSync(PROFILE, { recursive: true })
writeFileSync(join(PROFILE, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }, null, 2), 'utf8')
writeFileSync(join(PROFILE, 'cordis.patch.yml'), '# preset-in-package fixture\n', 'utf8')
writeFileSync(join(PROFILE, 'cordis.yml'), 'plugins: []\n', 'utf8')
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })
const savedHome = process.env.DSH_HOME
process.env.DSH_HOME = HOME

const AGENT_YML = '# agent.cordis.yml（夹具）\nplugins:\n  - id: router\n    name: "@probe/router-bootstrap"\n'
const PRESET_YML = 'name: Router Standard\norder: 1\n'

/** 造一个"带预设的包"目录（照真机 dsh-router-standard@0.3.0 的包体形状：没有 main/exports，只有 preset/ + docs/）。 */
function makeCarriedPackage(root, { name = 'dsh-router-standard', presets = ['router-standard', 'router-spec'], nested = true } = {}) {
  const pkgDir = join(root, ...name.split('/'))
  if (nested) {
    for (const p of presets) {
      mkdirSync(join(pkgDir, 'preset', p), { recursive: true })
      writeFileSync(join(pkgDir, 'preset', p, 'agent.cordis.yml'), AGENT_YML, 'utf8')
      writeFileSync(join(pkgDir, 'preset', p, 'preset.yml'), PRESET_YML, 'utf8')
      writeFileSync(join(pkgDir, 'preset', p, 'router-core.mjs'), `export const core = "${p}"\n`, 'utf8')
    }
  } else {
    // 兜底形态：agent.cordis.yml 直接在包根
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'agent.cordis.yml'), AGENT_YML, 'utf8')
    writeFileSync(join(pkgDir, 'preset.yml'), PRESET_YML, 'utf8')
  }
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version: '0.3.0', files: ['preset/'] }, null, 2), 'utf8')
  writeFileSync(join(pkgDir, 'README.md'), '# carried preset package\n', 'utf8')
  return pkgDir
}

// ── ① findCarriedPresets：形状判据 ────────────────────────────────────────────────────
{
  const root = join(HOME, 'shapes')
  const nested = makeCarriedPackage(join(root, 'nested'), { name: 'pkg-nested' })
  const flat = makeCarriedPackage(join(root, 'flat'), { name: 'pkg-flat', presets: ['only'], nested: false })
  const plain = join(root, 'plain', 'pkg-plain')
  mkdirSync(plain, { recursive: true })
  writeFileSync(join(plain, 'package.json'), JSON.stringify({ name: 'pkg-plain', main: 'index.js' }), 'utf8')
  writeFileSync(join(plain, 'index.js'), 'export const ok = 1\n', 'utf8')

  const a = findCarriedPresets(nested, 2)
  check('① 包内一层容器（preset/<name>/agent.cordis.yml）→ 找到两个预设',
    a.length === 2 && a.every((p) => existsSync(join(p, 'agent.cordis.yml'))), JSON.stringify(a.map((p) => p.split(/[\\/]/u).pop())))
  const b = findCarriedPresets(flat, 2)
  check('① 包根自己就是预设（agent.cordis.yml 在包根）→ 兜底命中 1 个',
    b.length === 1 && b[0] === flat, JSON.stringify(b))
  check('① 普通插件包（只有 main/exports）→ 空数组（绝不错判）', findCarriedPresets(plain, 2).length === 0)
  check('① 目录不存在 / 传空 → 空数组（不抛）',
    findCarriedPresets(join(root, 'nope'), 2).length === 0 && findCarriedPresets('', 2).length === 0 && findCarriedPresets(null, 2).length === 0)
}

// ── ② installPresetsCarriedByPackage：装配 + 收口 + 默认只补不覆盖 ─────────────────────────
{
  const presetsRoot = join(HOME, 'presets-carry')
  const nodeModules = join(PROFILE, 'node_modules')
  const pkgDir = makeCarriedPackage(nodeModules, { name: 'dsh-router-standard' })
  const job = { id: 'carry-1', repo: 'yjh051108/dsh-routing-suite', packageName: 'dsh-router-standard', status: 'installing', stage: 'installing', channelNotes: [] }
  const res = await installPresetsCarriedByPackage({ job, name: 'dsh-router-standard', profileDir: PROFILE, repo: 'yjh051108/dsh-router-suite', deps: { presetsRoot, now: () => 11 } })
  check('② handled=true / installed=true（包里带预设 → 按预设装配）', res.handled === true && res.installed === true, JSON.stringify({ h: res.handled, i: res.installed, err: res.error?.message ?? null }))
  check('★② 预设真的落到 <presetsRoot>/router-standard/agent.cordis.yml（字节与源一致）',
    existsSync(join(presetsRoot, 'router-standard', 'agent.cordis.yml'))
    && readFileSync(join(presetsRoot, 'router-standard', 'agent.cordis.yml'), 'utf8').replace(/\r\n/gu, '\n') === AGENT_YML,
    `bytes=${existsSync(join(presetsRoot, 'router-standard', 'agent.cordis.yml')) ? readFileSync(join(presetsRoot, 'router-standard', 'agent.cordis.yml')).length : 0}`)
  check('★② job 收口：status=done / presetDone / packageName=candidate / presetNote 按**声明结果**说话',
    job.status === 'done' && job.presetDone === true && job.packageName === 'dsh-router-standard'
    // 0.5.28 改错：框架 0.1.7-rc.x 起预设改为**声明行**，旧文案"新建会话时选择"对没写成声明行的预设是谎话。
    // 现在必须按实际落盘/声明结果说：声明成功 → "已声明为预设行 … 重启实例后在新会话可选"。
    && /已声明为预设行/u.test(String(job.presetNote))
    && String(job.presetNote).includes('preset-router-standard')
    && /重启实例后/u.test(String(job.presetNote))
    && !/新建会话时选择/u.test(String(job.presetNote)),
    `status=${job.status} presetDone=${job.presetDone} packageName=${job.packageName}`
    + ` noteHasDeclared=${/已声明为预设行/u.test(String(job.presetNote))}`
    + ` noteHasRow=${String(job.presetNote).includes('preset-router-standard')}`
    + ` noteHasRestart=${/重启实例后/u.test(String(job.presetNote))}`
    + ` noteHasOld=${/新建会话时选择/u.test(String(job.presetNote))}`)
  check('★② 声明行真的写进了目标 profile 的 cordis.patch.yml + 结构字段一并下发',
    Array.isArray(job.presetInstalled) && job.presetInstalled.every((p) => p.declaration?.ok === true && /^preset-/u.test(String(p.declaration.rowId)))
    && readFileSync(join(PROFILE, 'cordis.patch.yml'), 'utf8').includes('preset-router-standard'),
    JSON.stringify(job.presetInstalled?.map((p) => p.declaration)))
  check('★② 面板可读明细：presetInstalled 带 carriedBy=包名 与 marker',
    Array.isArray(job.presetInstalled) && job.presetInstalled.length === 2 && job.presetInstalled.every((p) => p.ok === true && p.carriedBy === 'dsh-router-standard' && p.marker === 'agent.cordis.yml'),
    JSON.stringify(job.presetInstalled))
  check('★② channelNotes 说明"按预设装配、不注册为插件"（面板可见，不沉默）',
    job.channelNotes.some((n) => n.includes('带着预设') && n.includes('不注册为插件')), JSON.stringify(job.channelNotes))
  check('② presetSource 记为 in-package（可核验来源形态）', job.presetSource?.mode === 'in-package' && job.presetSource?.packageName === 'dsh-router-standard', JSON.stringify(job.presetSource))
  check('② 来源记录可读（面板「覆盖该预设」要按它重新取源码）',
    existsSync(join(HOME, 'plugin-console', 'preset-sources.json'))
    && JSON.stringify(JSON.parse(readFileSync(join(HOME, 'plugin-console', 'preset-sources.json'), 'utf8'))).includes('dsh-router-suite'),
    readFileSync(join(HOME, 'plugin-console', 'preset-sources.json'), 'utf8').replace(/\s+/gu, ' ').slice(0, 160))

  // 第二次装配：同名预设已存在 → **默认只补不覆盖**（0.5.26 语义），现有文件一个字节都不动
  writeFileSync(join(pkgDir, 'preset', 'router-standard', 'router-core.mjs'), 'export const core = "edited-upstream"\n', 'utf8')
  const userCore = readFileSync(join(presetsRoot, 'router-standard', 'router-core.mjs'), 'utf8')
  const job2 = { id: 'carry-2', repo: 'r/r', packageName: 'dsh-router-standard', status: 'installing', channelNotes: [] }
  await installPresetsCarriedByPackage({ job: job2, name: 'dsh-router-standard', profileDir: PROFILE, repo: 'r/r', deps: { presetsRoot, now: () => 22 } })
  check('★② 默认只补不覆盖：已存在的 router-core.mjs **一个字节都没动**',
    readFileSync(join(presetsRoot, 'router-standard', 'router-core.mjs'), 'utf8') === userCore, userCore.trim())
  check('★② 同名冲突 → 下发**显式**「覆盖该预设」动作（复用既有动作构造器）',
    job2.suggestedAction?.kind === 'overwrite-preset' && job2.suggestedAction?.payload?.action === 'overwrite-preset'
    && job2.suggestedAction?.payload?.presetName === 'router-core.mjs'.replace('router-core.mjs', 'router-standard'),
    JSON.stringify(job2.suggestedAction))
  check('② 冲突也在 presetNote 里说清（用户知道"没覆盖、要覆盖点哪个"）',
    /只补不覆盖/u.test(String(job2.presetNote)) && /覆盖该预设/u.test(String(job2.presetNote)), String(job2.presetNote).slice(0, 260))

  // handled=false 的三种情形
  const plainDir = join(PROFILE, 'node_modules', 'plain-plugin')
  mkdirSync(plainDir, { recursive: true })
  writeFileSync(join(plainDir, 'package.json'), JSON.stringify({ name: 'plain-plugin', main: 'index.js' }), 'utf8')
  const j3 = { id: 'carry-3' }
  const r3 = await installPresetsCarriedByPackage({ job: j3, name: 'plain-plugin', profileDir: PROFILE, deps: { presetsRoot } })
  check('② 普通插件包 → handled=false（调用方照旧按插件收口，行为不变）', r3.handled === false && r3.installed === false && j3.status === undefined)
  const r4 = await installPresetsCarriedByPackage({ job: j3, name: 'never-installed', profileDir: PROFILE, deps: { presetsRoot } })
  check('② 包目录不存在 → handled=false（不是错误）', r4.handled === false && r4.error === null)
  const r5 = await installPresetsCarriedByPackage({ job: j3, name: '', profileDir: PROFILE, deps: { presetsRoot } })
  check('② 包名为空 → handled=false', r5.handled === false)

  // settlePresetOutcome：源码通道已装配（presetDone）时只收口、不再查包
  const j6 = { id: 'carry-6', presetDone: true, candidateName: 'dsh-router-standard', status: 'installing', stage: 'installing' }
  const settled = await settlePresetOutcome({ job: j6, installedName: null, profileDir: PROFILE })
  check('② settlePresetOutcome：presetDone 时收口（status=done + packageName=candidate）',
    settled === true && j6.status === 'done' && j6.stage === 'done' && j6.candidateDone === true && j6.packageName === 'dsh-router-standard')
  check('② settlePresetOutcome：没装成（installedName=null）且非 presetDone → false（不改行为）',
    (await settlePresetOutcome({ job: { id: 'x' }, installedName: null, profileDir: PROFILE })) === false)
}

// ── ③ runInstallJob 端到端：release 通道装下来的"带预设的包" → 不写补丁行、不声明依赖 ────────
{
  const presetsRoot = join(HOME, 'presets-e2e')
  const PROFILE2 = join(HOME, 'profiles', 'e2e')
  mkdirSync(PROFILE2, { recursive: true })
  writeFileSync(join(PROFILE2, 'package.json'), JSON.stringify({ name: 'dsh-profile-e2e', private: true, dependencies: {} }, null, 2), 'utf8')
  writeFileSync(join(PROFILE2, 'cordis.patch.yml'), '# e2e fixture\n', 'utf8')
  writeFileSync(join(PROFILE2, 'cordis.yml'), 'plugins: []\n', 'utf8')
  const patchBefore = readFileSync(join(PROFILE2, 'cordis.patch.yml'), 'utf8')
  const manifestBefore = readFileSync(join(PROFILE2, 'package.json'), 'utf8')
  // release 通道桩：真把"带预设的包"铺进 node_modules（照 githubReleaseInstall 的落盘形状）
  const ch = {
    raceInstallChannels: async () => null,
    pnpmInstall: async () => { throw new Error('桩：registry 404（该包没发布到 npm）') },
    curlManualInstall: async () => { throw new Error('桩：curl 404') },
    githubReleaseInstall: async (dir, repo, name) => {
      makeCarriedPackage(join(dir, 'node_modules'), { name })
      return { version: '0.3.0', missingDeps: [], boxNote: null, source: 'github', sourceNote: `${name} 的 release v0.3.0 资产 ${name}-0.3.0.tgz` }
    },
    backfillMissingDeps: async () => [],
  }
  const ports = {
    baseUrl: pathToFileURL(join(PROFILE2, 'cordis.yml')).href,
    // 必须喂一个 cordis:include 条目，否则 findPatchPath 会兜底到 <DSH_HOME>/profiles/web/cordis.patch.yml
    // ——那样"补丁行没被写"的断言就落在一个**根本没被写过**的文件上，成了假绿。
    loader: { entries: () => [{ id: 'include', options: { name: 'cordis:include', group: true, config: { path: pathToFileURL(join(PROFILE2, 'cordis.yml')).href } } }] },
    get: (key) => (key === 'installChannels' ? ch : undefined),
  }
  const job = {
    id: 'e2e-carry', repo: 'yjh051108/dsh-routing-suite', source: 'github', packageName: 'dsh-router-standard',
    status: 'installing', stage: 'preparing', error: null, startedAt: Date.now(), finishedAt: null,
    entryId: null, bundle: false, ai: false, aiNote: null, subpackages: null, lastError: null, update: false, kind: 'plugin',
  }
  let thrown = null
  try {
    await runInstallJob(job, ports, {
      jobBudgetMs: 60000,
      aiConsentTimeoutMs: 300,
      marketProbes: {
        fetchRepoPackageEx: async () => ({ pkg: { name: 'root-private', private: true }, reason: 'ok' }),
        fetchRepoPackage: async () => ({ name: 'root-private', private: true }),
        subpackageCandidates: async () => ['dsh-router-standard'],
        fetchSubpackageNames: async () => [],
        expandSubpackages: async () => [],
        namePublished: async () => false,
        probeGitmodules: async () => null,
      },
      sourceDeps: { sizeDeps: { probe: async () => ({ state: 'known', sizeKb: 1334 }) }, presetsRoot },
    })
  } catch (error) { thrown = error }
  const patchAfter = readFileSync(join(PROFILE2, 'cordis.patch.yml'), 'utf8')
  const manifestAfter = readFileSync(join(PROFILE2, 'package.json'), 'utf8')
  console.log(`INFO ③ status=${job.status} stage=${job.stage} presetNote=${String(job.presetNote ?? '').slice(0, 160)}`)
  check('③ 作业自己收尾（无异常逃逸）+ status=done', thrown === null && job.status === 'done', thrown === null ? JSON.stringify({ s: job.status, st: job.stage }) : String(thrown?.message).slice(0, 200))
  check('★★③ **绝不写「插件行」**（旧行为会给一个无入口的模块 appendInsert → 启动崩溃）；'
    + '补丁里只允许出现**预设声明行**（0.5.28 的机制迁移要求的那一种）',
    !patchAfter.includes('- id: dsh-router-standard\n') && !/- id: router-standard\b/u.test(patchAfter)
    && patchAfter.includes('- id: preset-router-standard')
    && patchAfter !== patchBefore,
    `hasPresetRow=${patchAfter.includes('- id: preset-router-standard')} changed=${patchAfter !== patchBefore}`)
  check('★★③ **绝不声明依赖**（预设不是 npm 插件，写进清单会让后续 pnpm 操作硬失败）',
    !manifestAfter.includes('dsh-router-standard') && manifestAfter === manifestBefore, manifestAfter.replace(/\s+/gu, ' ').slice(0, 140))
  check('★③ 预设真的落盘（点第三件 → 那个包自带的预设装上了）',
    existsSync(join(presetsRoot, 'router-standard', 'agent.cordis.yml')) && existsSync(join(presetsRoot, 'router-spec', 'agent.cordis.yml')))
  check('③ job.packageName / presetDone / entryId 对齐（面板显示的是真正装上的那一件）',
    job.packageName === 'dsh-router-standard' && job.presetDone === true && (job.entryId === null || job.entryId === undefined),
    JSON.stringify({ p: job.packageName, d: job.presetDone, e: job.entryId ?? null }))
}

// ── ④ 反例（保住既有语义）：普通插件包照旧走补丁行 + 声明依赖 ──────────────────────────────
{
  const PROFILE3 = join(HOME, 'profiles', 'plain')
  mkdirSync(PROFILE3, { recursive: true })
  writeFileSync(join(PROFILE3, 'package.json'), JSON.stringify({ name: 'dsh-profile-plain', private: true, dependencies: {} }, null, 2), 'utf8')
  writeFileSync(join(PROFILE3, 'cordis.patch.yml'), '# plain fixture\n', 'utf8')
  writeFileSync(join(PROFILE3, 'cordis.yml'), 'plugins: []\n', 'utf8')
  const ch = {
    raceInstallChannels: async () => null,
    pnpmInstall: async (dir, spec) => {
      const name = String(spec)
      const d = join(dir, 'node_modules', name)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }), 'utf8')
      writeFileSync(join(d, 'index.js'), 'export const ok = 1\n', 'utf8')
    },
    curlManualInstall: async () => { throw new Error('桩') },
    githubReleaseInstall: async () => { throw new Error('桩') },
    backfillMissingDeps: async () => [],
  }
  const ports = {
    baseUrl: pathToFileURL(join(PROFILE3, 'cordis.yml')).href,
    loader: { entries: () => [{ id: 'include', options: { name: 'cordis:include', group: true, config: { path: pathToFileURL(join(PROFILE3, 'cordis.yml')).href } } }] },
    get: (key) => (key === 'installChannels' ? ch : undefined),
  }
  const job = {
    id: 'e2e-plain', repo: 'probe-org/plain-plugin', source: 'github', packageName: 'plain-plugin',
    status: 'installing', stage: 'preparing', error: null, startedAt: Date.now(), finishedAt: null,
    entryId: null, bundle: false, ai: false, aiNote: null, subpackages: null, lastError: null, update: false, kind: 'plugin',
  }
  await runInstallJob(job, ports, {
    jobBudgetMs: 30000,
    aiConsentTimeoutMs: 300,
    marketProbes: {
      fetchRepoPackageEx: async () => ({ pkg: { name: 'plain-plugin', private: false }, reason: 'ok' }),
      fetchRepoPackage: async () => ({ name: 'plain-plugin', private: false }),
      subpackageCandidates: async () => [],
      fetchSubpackageNames: async () => [],
      expandSubpackages: async () => [],
      namePublished: async () => true,
      probeGitmodules: async () => null,
    },
    sourceDeps: { sizeDeps: { probe: async () => ({ state: 'known', sizeKb: 100 }) }, presetsRoot: join(HOME, 'presets-plain') },
  })
  const patch = readFileSync(join(PROFILE3, 'cordis.patch.yml'), 'utf8')
  check('★④ 反例：普通插件包照旧写补丁行（既有能力一点没少）',
    patch.includes('plain-plugin') && job.status === 'done' && job.entryId !== null,
    `entryId=${job.entryId} status=${job.status} patch=${JSON.stringify(patch.replace(/\s+/gu, ' ').slice(0, 200))}`)
  check('★④ 反例：没有误判成预设（presetDone 未设置、presetNote 为空）',
    job.presetDone === undefined && (job.presetNote === undefined || job.presetNote === null))
  check('★④ 反例：预设目录里没有多出东西', !existsSync(join(HOME, 'presets-plain')) || readdirSync(join(HOME, 'presets-plain')).length === 0)
}

if (savedHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = savedHome
try { disposeDir(HOME) } catch {}
assert.ok(pass > 0)
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
