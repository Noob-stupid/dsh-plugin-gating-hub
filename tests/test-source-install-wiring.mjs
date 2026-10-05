// 「来源型安装的**接线**」验收（0.5.41；全离线：私有 DSH_HOME + 注入桩 pnpm，零外网）
//
// 接线缺口背景（本轮要证的东西）：0.5.40 把能力做进了写入层 —— `declareProfileDependency({sourceSpec})`
// 把**真实来源规格**写回清单，并由 `installSourceDependency` 走 `pnpm add <spec>` 真装（依赖与 peer
// 交给包管理器，与官方 `dsh plugin add` 同一条通道）。但生产路径上**没有一个调用方传过 sourceSpec**：
// curl / GitHub release 这些"取样通道"把包铺进 node_modules 之后，收口只知道"磁盘上有个真实目录"，
// 于是按 registry 404 判据写成 `link:`（复制到 plugin-src + 链接）——依赖仍然没人管。
// 本套把"来源 → 规格 → 真装"这条线钉死，四组：
//   ① 正控：GitHub release 通道成功 ⇒ 真实下载 URL 一路传到收口 ⇒ `pnpm add <url>` 被**真的调用**
//      ⇒ 清单写的是该规格（不是 link:）＋ 记录里也是它（**交叉验证**：交给 pnpm 的 === 清单里的 === 记录的）
//   ② 不倒退：registry 通道照旧写**版本号**，一次真装都不发起；本地目录照旧 `link:` + 自足（零真装）
//   ③ 负控 A（包管理器安装失败）：物已在盘上 ⇒ 回落既有 link: 路径 + 文案含
//      「已装上（link 方式）· 真装失败：<原因> · 可一键真装」+ 结构化 real-install 动作（payload 里没有 spec）
//   ④ 负控 B（取样/下载失败）：物不在盘上 ⇒ **只有如实失败 + 原因**，全文不得出现
//      「已安装 / 已启用 / 回落成功 / link 方式 / 已完整安装」；面板侧的重试动作（静态接线）另钉一条
//   ⑤ 动作品质：real-install 的规格**只从服务端记录读**（客户端塞 spec 一律无效）+ 缺记录 400 + 拒绝非本 profile 包
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { installJobView } from '../lib/server/domain/install.js'
import { runInstallJob, tryCandidateChannels } from '../lib/server/domain/install-job.js'
import { declareProfileDependency } from '../lib/server/domain/manifest.js'
import { planDependencySpec } from '../lib/server/domain/manifest.js'
import { ensurePersisted } from '../lib/server/domain/persist.js'
import { runSuggestedAction } from '../lib/server/domain/plugin-actions.js'
import { readSourceSpec, sourceSpecRecordPath } from '../lib/server/domain/source-spec.js'
import { reconcileLockfile } from '../lib/server/domain/selfupdate.js'
import { disposeDir } from '../lib/server/infra/fsx.js'

const ROOT = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'))
let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const HOME = join(tmpdir(), `dsh-source-wiring-${process.pid}`)
const PROFILE = join(HOME, 'profiles', 'web')
try { rmSync(HOME, { recursive: true, force: true }) } catch {}
mkdirSync(PROFILE, { recursive: true })
writeFileSync(join(PROFILE, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {} }, null, 2)}\n`, 'utf8')
writeFileSync(join(PROFILE, 'cordis.patch.yml'), '# source-wiring fixture\n', 'utf8')
writeFileSync(join(PROFILE, 'cordis.yml'), 'plugins: []\n', 'utf8')
// 一切网络探测都指向死源：任何"偷偷出网"的路径都会**立刻失败**而不是拖慢/假绿
writeFileSync(join(HOME, 'plugin-console-sources.json'), `${JSON.stringify({
  registries: [{ id: 'dead', name: '死源', url: 'http://127.0.0.1:1', primary: true }],
  gitSources: [], archiveSources: [], indexSources: [],
}, null, 2)}\n`, 'utf8')
const savedHome = process.env.DSH_HOME
process.env.DSH_HOME = HOME
process.env.DSH_TEST_SKIP_NETWORK = '1'

const ports = {
  baseUrl: pathToFileURL(join(PROFILE, 'cordis.yml')).href,
  loader: { entries: () => [{ id: 'include', options: { name: 'cordis:include', group: true, config: { path: pathToFileURL(join(PROFILE, 'cordis.yml')).href } } }] },
  get: () => undefined,
}
const REGISTRY = 'http://127.0.0.1:1'
const RELEASE_URL = 'https://github.com/probe-org/probe-plugin/releases/download/v1.0.0/probe-plugin-1.0.0.tgz'
const TGZ_URL = 'https://example.invalid/acme/sampled-a-2.0.0.tgz'
const probe404 = async () => ({ resolvable: false, hasVersion: false, latest: null, registry: null, tried: ['stub：HTTP 404 Not Found'] })
const probeDown = async () => ({ resolvable: false, hasVersion: false, latest: null, registry: null, tried: ['stub：网络不可达（ETIMEDOUT）'] })

/** 在 profile 里造一份"取样通道铺好的"真实目录（= curl 解压 / release 落盘的形态）。 */
function sampledPackage(packageName, version = '1.0.0', deps = {}) {
  const dir = join(PROFILE, 'node_modules', ...packageName.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: packageName, version, main: 'index.js', dependencies: deps }, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, 'index.js'), 'export default {}\n', 'utf8')
  return dir
}
const manifestDeps = () => {
  try { return JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8')).dependencies ?? {} } catch { return {} }
}
/** 收口的离线注入缝：lock 与挂载行都不碰真 pnpm/真补丁（接线本身才是本套的被测对象）。 */
const persistDeps = (extra = {}) => ({
  reconcile: async () => ({ lockUpdated: true, lockVerified: true, lockNote: null, depNote: null, suggestedActions: [] }),
  insert: async () => ({ changed: true }),
  ...extra,
})
const baseJob = (over) => ({
  id: 'job-wiring', repo: '', source: 'github', packageName: null,
  status: 'installing', stage: 'preparing', error: null, startedAt: Date.now(), finishedAt: null,
  entryId: null, bundle: false, ai: false, aiNote: null, subpackages: null, lastError: null, update: false, kind: 'plugin',
  ...over,
})

// ── ① 正控：GitHub release 通道 ⇒ 真实下载 URL ⇒ `pnpm add <url>` 真装 ⇒ 清单写真实规格 ─────────
console.log('\n── ① 正控：来源规格一路传到收口（GitHub release 资产 URL）─────────────────')
{
  const PKG = '@probe/release-wired'
  const job = baseJob({ packageName: PKG })
  const ch = {
    raceInstallChannels: async () => null,
    pnpmInstall: async () => { throw new Error('桩：registry 404（该包只在 GitHub release）') },
    curlManualInstall: async () => { throw new Error('桩：curl 404') },
    // 真实现的形态：下载资产 → 盒子验证 → copyTree 进 profile；这里只做最后一步，另外**如实带回下载地址**
    githubReleaseInstall: async (profileDir, repo, name) => {
      sampledPackage(name, '1.0.0', { ms: '2.1.3' })
      return { version: '1.0.0', missingDeps: ['ms'], boxNote: null, source: 'github', sourceNote: 'probe-org 的 release v1.0.0 的资产 probe-plugin-1.0.0.tgz', sourceSpec: RELEASE_URL }
    },
    backfillMissingDeps: async () => [],
  }
  // 通道层：必须把来源如实带出来（spec / origin / kind 三件齐备）
  const attempt = await tryCandidateChannels({
    job: baseJob({ packageName: PKG }), ch, name: PKG, profileDir: PROFILE, registries: [REGISTRY],
    repoChannelAllowed: false, budget: { release: 3 }, expanded: true, deadline: null, sourceDeps: {},
  })
  check('① 通道层带回来源：{ spec: 下载地址, origin: sampled, kind: github-release }',
    attempt.installedName === PKG && attempt.source?.spec === RELEASE_URL
    && attempt.source?.origin === 'sampled' && attempt.source?.kind === 'github-release',
    JSON.stringify(attempt))

  // 收口层（全链路接线）：`ensurePersisted` 收到的来源规格 → 真装那一步必须被**真的调用**且拿到同一个规格。
  // 注入桩只替换"网络那一步"（probe 给 404、pnpm add 给桩、lock 不跑真 pnpm）——**被测的是接线本身**：
  // 通道 → ensurePersisted → declareProfileDependency → installSourceDependency。
  const addCalls = []
  const patchPath = join(PROFILE, 'cordis.patch.yml')
  const persist = await ensurePersisted({
    profileDir: PROFILE, patchPath, packageName: PKG, mode: 'insert', taken: new Set(), entries: [],
    registries: [REGISTRY], sourceSpec: RELEASE_URL, sourceOrigin: 'sampled', sourceKind: 'github-release',
    deps: {
      syncLock: false,
      declare: (profileDir, name, version, options) => declareProfileDependency(profileDir, name, version, {
        ...options, probe: probe404, installSource: async ({ spec }) => { addCalls.push(spec) },
      }),
      reconcile: async () => ({ lockUpdated: true, lockVerified: true, lockNote: null, depNote: null, suggestedActions: [] }),
      insert: async () => ({ changed: true }),
    },
  })
  check('★① 收口层：包管理器那一步被**真的调用**，拿到的是真实下载地址（不是 link:、不是版本号）',
    addCalls.length === 1 && addCalls[0] === RELEASE_URL, JSON.stringify(addCalls))
  check('★① 清单里写的是**真实来源规格**（form=source，不是 link:）',
    manifestDeps()[PKG] === RELEASE_URL && persist.declared?.form === 'source', JSON.stringify({ deps: manifestDeps(), form: persist.declared?.form }))
  check('① 文案如实说"已按真实来源规格真装"（不谎报、也不多话）',
    String(persist.declared?.depNote ?? '').includes('已按真实来源规格真装') && !/真装失败/u.test(String(persist.declared?.depNote ?? '')),
    String(persist.declared?.depNote ?? '').slice(0, 200))

  // 作业级接线：runInstallJob 必须把通道带回的来源**原样**交给收口（三件齐备）。
  // 刻意换一个包名：同名的话清单里已经有条目 ⇒ 收口第 ① 步直接判"已就位"而跳过，测不到这条线。
  const JOB_PKG = '@probe/release-job'
  const seenOptions = []
  const preReconciles = []
  let declareCalls = 0
  const job2 = baseJob({ packageName: JOB_PKG, id: 'job-wiring-full' })
  await runInstallJob(job2, { ...ports, get: (key) => (key === 'installChannels' ? ch : undefined) }, {
    jobBudgetMs: 30000,
    aiConsentTimeoutMs: 300,
    marketProbes: { expandSubpackages: async () => [] },
    persistDeps: persistDeps({
      // 对账在这个作业里会被调用两处：装完那一刻的"预对账"与收口第 ② 步。用 declare 的调用次数区分相位。
      // 预对账对来源型包必须**让开**，否则它会按老判据把这个包写成 link:（+ plugin-src 副本 + 一句
      // "已按 link: 形式记录"），与紧接着收口的真实来源规格打架。
      reconcile: async (options) => {
        preReconciles.push({
          phase: declareCalls === 0 ? 'pre' : 'persist',
          names: (options.packages ?? []).map((p) => p.name),
          keepUrlSpecs: options.keepUrlSpecs ?? null,
        })
        return { lockUpdated: true, lockVerified: true, lockNote: null, depNote: null, suggestedActions: [] }
      },
      declare: async (profileDir, name, version, options) => {
        declareCalls += 1
        seenOptions.push({ name, version, sourceSpec: options.sourceSpec ?? null, sourceOrigin: options.sourceOrigin ?? null, sourceKind: options.sourceKind ?? null })
        return { changed: true, version, spec: options.sourceSpec ?? version, form: options.sourceSpec ? 'source' : 'version', depNote: null, suggested: null, sourceInstall: null, selfSufficiency: null, lockSynced: null, lockNote: null }
      },
    }),
  })
  check('① runInstallJob 走到 done', job2.status === 'done', JSON.stringify({ status: job2.status, error: job2.error }))
  check('★① runInstallJob → 收口：来源规格/origin/kind **原样**传到写入层（接线成立的直接证据）',
    seenOptions.length === 1 && seenOptions[0].name === JOB_PKG && seenOptions[0].sourceSpec === RELEASE_URL
    && seenOptions[0].sourceOrigin === 'sampled' && seenOptions[0].sourceKind === 'github-release',
    JSON.stringify(seenOptions))
  check('★① 预对账**让开**了来源型包（不按老判据写 link:，交给收口用真实来源规格声明）',
    preReconciles.filter((r) => r.phase === 'pre').every((r) => !r.names.includes(JOB_PKG)), JSON.stringify(preReconciles))
  check('★① 收口第 ② 步的对账带上 keepUrlSpecs（真装出来的 URL 不会被规整回 link:）',
    preReconciles.some((r) => r.phase === 'persist' && Array.isArray(r.keepUrlSpecs) && r.keepUrlSpecs.includes(JOB_PKG)),
    JSON.stringify(preReconciles))

  // 交叉验证：我们计划的写回规格 === 交给 pnpm 的规格 === 清单里的规格 === 记录里的规格
  const planned = await planDependencySpec({ profileDir: PROFILE, packageName: PKG, version: '1.0.0', probe: probe404, sourceSpec: RELEASE_URL })
  const record = readSourceSpec({ packageName: PKG, home: HOME })
  check('★① 交叉验证：planDependencySpec 计划的 === 交给 pnpm 的 === 清单里的 === 记录里的',
    planned.form === 'source' && planned.spec === addCalls[0] && planned.spec === manifestDeps()[PKG] && record?.spec === RELEASE_URL,
    JSON.stringify({ planned: planned.spec, pnpm: addCalls[0], manifest: manifestDeps()[PKG], record: record?.spec ?? null }))
  check('① 来源规格记录落在私有 DSH_HOME 里（一键真装据此取规格）',
    existsSync(sourceSpecRecordPath(HOME, PKG)), sourceSpecRecordPath(HOME, PKG))
}

// ── ② 不倒退：registry 照旧写版本号（零真装）；本地目录照旧 link: + 自足（零真装）─────────────
console.log('\n── ② 不倒退：registry 写版本号；本地目录 link: + 自足 ────────────────────')
{
  const PKG = '@probe/registry-untouched'
  const job = baseJob({ packageName: PKG, id: 'job-registry' })
  const ch = {
    raceInstallChannels: async () => null,
    pnpmInstall: async (profileDir, name) => { sampledPackage(name, '3.1.4') }, // registry 通道（真 pnpm 的等价形态）
    curlManualInstall: async () => { throw new Error('不该走到 curl') },
    githubReleaseInstall: async () => { throw new Error('不该走到 release') },
    backfillMissingDeps: async () => [],
  }
  const addCalls = []
  await runInstallJob(job, { ...ports, get: (key) => (key === 'installChannels' ? ch : undefined) }, {
    jobBudgetMs: 30000,
    aiConsentTimeoutMs: 300,
    marketProbes: { expandSubpackages: async () => [] },
    persistDeps: persistDeps({
      syncLock: false,
      // registry 可解析（既有判据）⇒ 写版本号；这里注入"可解析"的探测 + 真装桩（两者都只在测试里替换）
      declare: (profileDir, packageName, version, options) => declareProfileDependency(profileDir, packageName, version, {
        ...options,
        probe: async () => ({ resolvable: true, hasVersion: true, latest: version, registry: 'stub', tried: [] }),
        installSource: async ({ spec }) => { addCalls.push(spec) },
      }),
    }),
  })
  check('② registry 通道：status=done', job.status === 'done', JSON.stringify({ status: job.status, error: job.error }))
  check('★② registry 路径一字不改：清单写的是**版本号**', manifestDeps()[PKG] === '3.1.4', JSON.stringify(manifestDeps()))
  check('★② registry 路径**一次真装都不发起**（不倒退：没有多出任何 pnpm add 来源规格）', addCalls.length === 0, JSON.stringify(addCalls))

  // 本地目录：`link:` 是它的正常路径（判据 C：不涉及下载）—— 不真装、写 link:、自足补齐
  const LOCAL_PKG = '@probe/local-dir'
  const localDir = join(HOME, 'dev', 'local-dir')
  mkdirSync(localDir, { recursive: true })
  writeFileSync(join(localDir, 'package.json'), `${JSON.stringify({ name: LOCAL_PKG, version: '0.1.0', main: 'index.js' }, null, 2)}\n`, 'utf8')
  writeFileSync(join(localDir, 'index.js'), 'export default {}\n', 'utf8')
  const localCalls = []
  const declared = await declareProfileDependency(PROFILE, LOCAL_PKG, '0.1.0', {
    syncLock: false, home: HOME, probe: probe404,
    sourceSpec: `link:${localDir.replace(/\\/gu, '/')}`,
    installSource: async ({ spec }) => { localCalls.push(spec) },
  })
  check('★② 本地目录：仍按 link: 记录（显式开发式安装，不真装）',
    declared.form === 'link' && String(declared.spec).startsWith('link:') && localCalls.length === 0,
    JSON.stringify({ form: declared.form, spec: declared.spec, calls: localCalls }))
  check('★② 本地目录：自足性照旧补齐（自足 ⇒ ready=true 且零写盘）',
    declared.selfSufficiency?.applies === true && declared.selfSufficiency?.ready === true,
    JSON.stringify({ applies: declared.selfSufficiency?.applies, ready: declared.selfSufficiency?.ready, note: declared.selfSufficiency?.note }))
  check('② 本地目录写回后清单里就是那条 link:（与磁盘形态一致）',
    String(manifestDeps()[LOCAL_PKG] ?? '').startsWith('link:'), JSON.stringify(manifestDeps()[LOCAL_PKG] ?? null))
}

// ── ②b 收口最后一步的 lock 对账**不许**把刚真装的 tarball URL 规整回 link: ─────────────────────
console.log('\n── ②b 真装出来的 URL 是对账的例外（keepUrlSpecs）────────────────────────')
{
  const PKG = '@probe/url-kept'
  sampledPackage(PKG, '1.0.0')
  const url = 'https://example.invalid/acme/url-kept-1.0.0.tgz'
  // 前置：清单里已经是这条 URL（= 真装成功后的形态），lock 里是本沙箱里 pnpm 会写的那种条目
  const manifest = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))
  manifest.dependencies = { ...(manifest.dependencies ?? {}), [PKG]: url }
  writeFileSync(join(PROFILE, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const manifestBytes = readFileSync(join(PROFILE, 'package.json'), 'utf8')
  const kept = await reconcileLockfile({ profileDir: PROFILE, packages: [{ name: PKG }], registries: [REGISTRY], keepUrlSpecs: [PKG], home: HOME })
  check('★②b 点名 keepUrlSpecs ⇒ 该包**不算漂移**（对账判"已对齐"、没跑 pnpm、零写盘、没物化副本）',
    kept.lockUpdated === true && kept.method === null && (kept.lockImporterWrites ?? []).length === 0
    && !existsSync(join(HOME, 'plugin-src', ...PKG.split('/'))),
    JSON.stringify({ lockUpdated: kept.lockUpdated, method: kept.method, writes: kept.lockImporterWrites, depNote: kept.depNote, materialized: existsSync(join(HOME, 'plugin-src', ...PKG.split('/'))) }))
  check('★②b 清单里的真实来源规格**一个字都没被改**（不会被规整回 link:）',
    readFileSync(join(PROFILE, 'package.json'), 'utf8') === manifestBytes && manifestDeps()[PKG] === url,
    JSON.stringify(manifestDeps()[PKG] ?? null))
  // 反证：不点名时（老行为）它**会**规划成 link: —— 判据是它顺手物化出的 plugin-src 副本
  // （这一步先物化再写回，见 selfupdate.js#linkPlan；物化本身就证明"URL→link:"这条路仍活着）。
  try { rmSync(join(HOME, 'plugin-src', ...PKG.split('/')), { recursive: true, force: true }) } catch {}
  const legacy = await reconcileLockfile({ profileDir: PROFILE, packages: [{ name: PKG }], registries: [REGISTRY], home: HOME })
  check('★②b 反证：不点名时仍按老保护走"URL → link:"（物化了 plugin-src 副本 —— 正是本例外要避免的）',
    existsSync(join(HOME, 'plugin-src', ...PKG.split('/'))) && /tarball URL/u.test(String(legacy.depNote ?? '')),
    JSON.stringify({ lockUpdated: legacy.lockUpdated, depNote: String(legacy.depNote ?? '').slice(0, 200), materialized: existsSync(join(HOME, 'plugin-src', ...PKG.split('/'))) }))
}

// ── ③ 负控 A：包管理器安装失败 ⇒ 回落 link: + 如实文案 + 一键真装动作 ─────────────────────────
console.log('\n── ③ 负控 A：真装失败（物已在盘上）⇒ link: 回落 + 一键真装 ──────────────')
{
  const PKG = '@probe/sampled-a'
  sampledPackage(PKG, '2.0.0')
  const addCalls = []
  const declared = await declareProfileDependency(PROFILE, PKG, '2.0.0', {
    syncLock: false, home: HOME, probe: probe404, sourceOrigin: 'sampled', sourceSpec: TGZ_URL,
    installSource: async ({ spec }) => { addCalls.push(spec); throw new Error('桩：ERR_PNPM_FETCH_404 该 tarball 形态不被接受') },
  })
  const note = String(declared.depNote ?? '')
  check('③ 真装那一步确实被调用了（失败路径不是"跳过真装"）', addCalls.length === 1 && addCalls[0] === TGZ_URL, JSON.stringify(addCalls))
  check('★③ 真装失败 ⇒ 回落既有 link: 路径（插件至少能加载）', declared.form === 'link' && String(declared.spec).startsWith('link:'), JSON.stringify({ form: declared.form, spec: declared.spec }))
  check('★③ 文案含「已装上（link 方式）」', note.includes('已装上（link 方式）'), note.slice(0, 200))
  check('★③ 文案含真装失败原因（点名原因原文）', note.includes('真装失败：') && note.includes('该 tarball 形态不被接受'), note.slice(0, 260))
  check('★③ 文案含「可一键真装」', note.includes('可一键真装'), note.slice(0, 260))
  check('★③ **不得**出现"已完整安装"之类说法', !/已完整安装/u.test(note), note.slice(0, 200))
  check('★③ 下发结构化「一键真装」动作（payload 里**没有** spec/命令位置）',
    declared.suggested?.kind === 'real-install' && declared.suggested?.payload?.action === 'real-install'
    && declared.suggested?.payload?.packageName === PKG && !('spec' in (declared.suggested?.payload ?? {}))
    && !/command|argv|shell/u.test(Object.keys(declared.suggested?.payload ?? {}).join(',')),
    JSON.stringify(declared.suggested))
  check('③ 失败也要留记录（一键真装要能取到规格）', readSourceSpec({ packageName: PKG, home: HOME })?.spec === TGZ_URL, JSON.stringify(readSourceSpec({ packageName: PKG, home: HOME })))
  check('③ 回落后的清单 = link: 且物化副本真的在 plugin-src 里',
    String(manifestDeps()[PKG] ?? '').startsWith('link:')
    && existsSync(join(HOME, 'plugin-src', ...PKG.split('/'), 'package.json')),
    JSON.stringify({ spec: manifestDeps()[PKG] ?? null }))
}

// ── ④ 负控 B：取样/下载失败 ⇒ 只有如实失败（物不在盘上，没有任何东西可挂）────────────────────
console.log('\n── ④ 负控 B：下载/取样失败 ⇒ 如实失败，绝不回落 ──────────────────────')
{
  const PKG = '@probe/never-landed'
  const before = readFileSync(join(PROFILE, 'package.json'), 'utf8')
  const declared = await declareProfileDependency(PROFILE, PKG, null, {
    syncLock: false, home: HOME, probe: probeDown, sourceOrigin: 'sampled', sourceSpec: TGZ_URL,
    installSource: async () => { throw new Error('桩：网络不可达（ETIMEDOUT proxy 10.0.0.1:8080）') },
  })
  const text = `${declared.reason ?? ''}｜${declared.depNote ?? ''}`
  check('★④ 物不在盘上 ⇒ 没有写回（changed=false / spec=null）', declared.changed === false && declared.spec === null, JSON.stringify({ changed: declared.changed, spec: declared.spec }))
  check('★④ 如实说明"磁盘上没有任何副本 —— 无可挂载"', /磁盘上没有任何副本/u.test(text) && /无可挂载/u.test(text), text.slice(0, 240))
  check('★④ 原因原文带出来（网络不可达 / ETIMEDOUT）', /ETIMEDOUT/u.test(text), text.slice(0, 240))
  check('★④ **不得**出现「已安装 / 已启用 / 已装上 / 回落 / link 方式」',
    !/已安装|已启用|已装上|回落|link 方式/u.test(text), text.slice(0, 240))
  check('④ 清单逐字节未动（没给不存在的包写任何 spec）', readFileSync(join(PROFILE, 'package.json'), 'utf8') === before)

  // 作业级：所有通道都失败（下载失败）⇒ 面板只报失败 + 原因；诊断给出可重试的说法
  const job = baseJob({ packageName: PKG, id: 'job-download-fail' })
  const ch = {
    raceInstallChannels: async () => null,
    pnpmInstall: async () => { throw new Error('桩：registry 404') },
    curlManualInstall: async () => { throw new Error('桩：curl 下载失败（网络不可达）') },
    githubReleaseInstall: async () => { throw new Error('桩：release 资产下载失败（网络不可达）') },
    backfillMissingDeps: async () => [],
  }
  await runInstallJob(job, { ...ports, get: (key) => (key === 'installChannels' ? ch : undefined) }, {
    jobBudgetMs: 5000,
    aiConsentTimeoutMs: 200,
    marketProbes: { expandSubpackages: async () => [] },
    persistDeps: persistDeps(),
  })
  const view = installJobView(job)
  const viewText = JSON.stringify(view)
  check('★④ 作业如实失败（status=failed，且没有 persisted 结论）',
    job.status === 'failed' && (view.persisted === null || view.persisted === undefined), JSON.stringify({ status: job.status, persisted: view.persisted }))
  check('★④ 失败文案带**具体原因**（最后一次失败原因 = 作业记下的那条真实错误）',
    /最后一次失败原因：/u.test(String(view.error ?? ''))
    && String(job.lastError ?? '') !== ''
    && String(view.error ?? '').includes(String(job.lastError ?? '')),
    `error=${String(view.error ?? '').slice(0, 160)} lastError=${String(job.lastError ?? '').slice(0, 120)}`)
  check('★④ 下发可重试的失败分类（面板据此显示"重试"指引）', typeof view.diagnosis?.kind === 'string' && typeof view.diagnosis?.hint === 'string', JSON.stringify(view.diagnosis ?? null))
  check('★④ 整个作业视图**不得**出现「已安装 / 已启用 / 回落成功 / link 方式 / 已完整安装」',
    !/已安装|已启用|回落成功|link 方式|已完整安装/u.test(viewText), viewText.slice(0, 240))
  // 面板侧的可重试动作（静态接线，与既有"最近失败 + 重试按钮"同一处）：失败卡片必须带重试入口
  const clientSrc = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')
  check('★④ 面板侧：失败卡片的「重试」按钮真的重新发起安装（t("retry") + startJob(同一 repo/包名)）',
    /t\("retry"\)/u.test(clientSrc) && /startJob\(job\.repo, job\.packageName/u.test(clientSrc), 'lib/client.js')
}

// ── ⑤ 动作品质：real-install 的规格只从服务端记录读（客户端塞 spec 无效）────────────────────
console.log('\n── ⑤ real-install 动作：规格只认服务端记录 ──────────────────────────')
{
  const PKG = '@probe/sampled-a' // ③ 里已留下记录（TGZ_URL）
  const seen = []
  const runAdd = async (args) => {
    seen.push(args.join(' '))
    // 模拟 pnpm 真装成功：把规格写进清单（真 pnpm 就是这么写的）
    const manifest = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))
    manifest.dependencies = { ...(manifest.dependencies ?? {}), [PKG]: TGZ_URL }
    writeFileSync(join(PROFILE, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    return { stdout: 'done', stderr: '' }
  }
  const hacked = await runSuggestedAction({
    // 客户端**额外塞** spec/URL 字段：不属于白名单动作参数，必须被彻底忽略（规格只从记录读）
    body: { action: 'real-install', packageName: PKG, profile: 'web', spec: 'https://evil.invalid/x.tgz', url: 'https://evil.invalid/y.tgz' },
    profileDir: PROFILE, registries: [REGISTRY], deps: { home: HOME, runAdd },
  })
  check('★⑤ 动作跑的是**记录里的规格**，客户端塞的 spec/url 一律没进命令行',
    hacked.ok === true && seen.length === 1 && seen[0].includes(TGZ_URL) && !seen[0].includes('evil.invalid'),
    JSON.stringify({ ok: hacked.ok, seen }))
  check('⑤ 动作如实报"已按真实来源规格真装"（并给出清单：before → after）',
    /已按真实来源规格真装/u.test(String(hacked.reason ?? '')) && hacked.manifest?.after === TGZ_URL,
    JSON.stringify({ reason: hacked.reason, manifest: hacked.manifest }))
  const noRecord = await runSuggestedAction({
    body: { action: 'real-install', packageName: '@probe/registry-untouched', profile: 'web' },
    profileDir: PROFILE, registries: [REGISTRY], deps: { home: HOME, runAdd },
  })
  check('⑤ 没有来源规格记录 ⇒ 400 且**一次都没执行**（绝不凭空猜一个来源）',
    noRecord.ok === false && noRecord.status === 400 && seen.length === 1, JSON.stringify({ status: noRecord.status, error: String(noRecord.error).slice(0, 120) }))
  const notMine = await runSuggestedAction({
    body: { action: 'real-install', packageName: '@probe/not-in-profile', profile: 'web' },
    profileDir: PROFILE, registries: [REGISTRY], deps: { home: HOME, runAdd },
  })
  check('⑤ 不在本 profile 清单里的包 ⇒ 400（与 pin/persist 同一道边界）',
    notMine.ok === false && notMine.status === 400 && seen.length === 1, JSON.stringify({ status: notMine.status, error: String(notMine.error).slice(0, 120) }))
}

// ── 收尾：私有沙箱清掉（不留残留；走仓库既有的 disposeDir —— Windows 上 rmSync 对链接/占用会静默落空）──
const disposed = disposeDir(HOME)
if (savedHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = savedHome
check('收尾：私有沙箱已清掉（不留残留）', !existsSync(HOME), `${HOME} ${JSON.stringify(disposed)}`)

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
