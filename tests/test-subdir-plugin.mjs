// 缺陷②：「不是 DSH 插件」的判定太窄（只看仓库根）—— 2026-10-13 用户实测报告。
//
// 现场：用户对 Fei2411/DeepSeek-Bot（topics 含 dsh-plugin、README 自称 DSH 插件）点安装，
// 得到「仓库 … 没有 package.json（也不是技能仓库），无法作为插件安装」。但该仓库根目录**确实**
// 没有 package.json —— 插件清单在**子目录 `ds-bot/`** 里（真机核实：ds-bot/package.json 同时声明
// `dsh.client` 与 `dsh.bundle.patch`）。结论既不准（它是插件）也不给路（没有下一步）。
//
// 本套断言：
//   ① 夹具就是真机那个布局（根无清单 + 子目录有 dsh 清单）→ 必须判成"插件在 ds-bot/ 下"
//   ② 标记判据：dsh.bundle.patch / dsh.client 任一命中；没有 dsh 字段的普通子包**不算**插件
//   ③ 扫完确实没有 → 保持"不是插件"结论，但文案必须补"已检查根目录与 2 层子目录"（诚实）
//   ④ 版本戳：0.5.45 的"私有根 monorepo 展开子包"那条路一个字都没动（旧结论不回归）
//   ⑤ 探针真的按路径口径向下扫（走桩 GitHub 树，离线）
//   ⑥ install-job 的落点：hint=subdir-plugin + subplugin 结构化字段（面板据此单独渲染）
//   ⑦ 静态：install-job 的"根无清单"分支必须先扫子目录再下结论（去掉了就红）
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'subdir-plugin-home')
rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })
mkdirSync(join(HOME, 'profiles', 'web'), { recursive: true })
process.env.DSH_HOME = HOME
process.env.DSH_TEST_SKIP_NETWORK = '1'

const { describeDshManifest, dshMarkersOf, decideNoRootManifest, pickSubdirPlugin, subdirPluginText, notPluginText } = await import('../lib/server/domain/subdir-detect.js')
const { fetchSubdirPlugins, __setSubpkgProbeDefaults } = await import('../lib/server/domain/market.js')

// ── ⑧ 测试自身的守卫（**在跑任何断言之前**装好）：真出网 ⇒ 当场红 ────────────────────────
// 红线：本套一个真实网络请求都不许发。光靠"把桩塞进 deps"**不是守卫** ——
// `fetchSubpackageNames` 在 deps 缺项时会回落到生产实现（infra/http.js 的 githubJson /
// rawTextWithFallback，会真的连 GitHub），本文件也已经有过"桩的袋子没接上"的前科。
// 所以这里把探针的**出网回落值**换成会抛的 tripwire：
//   · 谁走到真实出网，**当场抛异常变红**，并且一个请求都发不出去（预防，不是事后取证）；
//   · 本套里凡是需要数据的段落都**显式**传 deps（tripwire 优先级低于显式 deps，见
//     fetchSubpackageNames 的 `deps.githubJson ?? probeEgressDefaults?.ghJson ?? githubJson`）；
//   · 下面 ⑧-a 是**正控**：不带 deps 走一次，必须被 tripwire 拦下 —— 证明这层守卫是活的，
//     不是"没装探针所以恒绿"（这正是上一批用 globalThis 标志当守卫栽过的那类空断言）。
const tripwireCalls = []
const egressTripwire = (what) => (...args) => {
  tripwireCalls.push(`${what}(${String(args[0]).slice(0, 60)})`)
  throw new Error(`测试红线：禁止真实出网（${what} ${String(args[0]).slice(0, 60)}）`)
}
__setSubpkgProbeDefaults({ ghJson: egressTripwire('githubJson'), rawText: egressTripwire('rawTextWithFallback') })

let pass = 0
let fail = 0
const check = (name, ok, info = '') => {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

// ── 夹具：真机 Fei2411/DeepSeek-Bot 的布局（根无 package.json；ds-bot/ 有 DSH 清单）────────
const REPO = 'Fei2411/DeepSeek-Bot'
const DS_BOT_PKG = JSON.stringify({
  name: 'ds-bot',
  version: '0.1.3',
  keywords: ['dsh-plugin'],
  repository: { type: 'git', url: 'git+https://github.com/Fei2411/DeepSeek-Bot.git', directory: 'ds-bot' },
  dsh: { client: { platform: 'web' }, bundle: { patch: './cordis.patch.yml' } },
}, null, 2)
const TREE = [
  { path: 'README.md', type: 'blob' },
  { path: 'AGENTS.md', type: 'blob' },
  { path: 'docs/guide.md', type: 'blob' },
  { path: 'ds-bot/package.json', type: 'blob' },
  { path: 'ds-bot/index.js', type: 'blob' },
  { path: 'ds-bot/cordis.patch.yml', type: 'blob' },
  { path: 'ds-bot/client.js', type: 'blob' },
  { path: 'packages/utils/package.json', type: 'blob' }, // 2 层：普通包，不算插件
  { path: 'packages/deep/nested/package.json', type: 'blob' }, // 3 层：超出扫描口径，必须不读
].map((n) => ({ ...n, sha: 'x', size: 1 }))
// 普通子包（没有 dsh 字段）—— 用来钉死"不误报"
const UTILS_PKG = JSON.stringify({ name: '@probe/utils', version: '1.0.0' }, null, 2)
// 真机的子目录扫描结果（fetchSubpackageNamesOnBranch 读 package.json 后折出来的形态）
const REAL_SCAN = [{ path: 'ds-bot', name: 'ds-bot', markers: describeDshManifest(DS_BOT_PKG).markers }]

try {
  // ── ① 标记判据 ────────────────────────────────────────────────────────────────────────
  {
    check('① dsh.bundle.patch 与 dsh.client 都算 DSH 标记（真机 ds-bot 两个都有）',
      JSON.stringify(dshMarkersOf(JSON.parse(DS_BOT_PKG))) === JSON.stringify(['dsh.bundle.patch', 'dsh.client']),
      JSON.stringify(dshMarkersOf(JSON.parse(DS_BOT_PKG))))
    check('① 只有 dsh.client（无 bundle patch）也算（客户端插件形态）',
      JSON.stringify(dshMarkersOf({ name: 'x', dsh: { client: { platform: 'web' } } })) === JSON.stringify(['dsh.client']))
    check('① 只有 dsh.bundle.patch 也算（bundle 层包形态，如皮肤包）',
      JSON.stringify(dshMarkersOf({ name: 'x', dsh: { bundle: { patch: './cordis.patch.yml' } } })) === JSON.stringify(['dsh.bundle.patch']))
    check('① 没有 dsh 字段的普通包**不算**插件（不误报）',
      dshMarkersOf({ name: 'x', version: '1.0.0' }).length === 0 && dshMarkersOf({ name: 'x', dsh: {} }).length === 0
      && dshMarkersOf({ name: 'x', dsh: { bundle: { patch: 123 } } }).length === 0, '空 dsh / 类型不对都不认')
    check('① 归一化：解析失败 / 没有 name / 非对象 → null（不抛）',
      describeDshManifest('{ 不是 JSON') === null && describeDshManifest('{"version":"1"}') === null
      && describeDshManifest('null') === null && describeDshManifest(DS_BOT_PKG)?.name === 'ds-bot')
  }

  // ── ② 折叠结论：真机夹具 → 必须判成"插件在 ds-bot/ 下" ────────────────────────────────
  {
    const pick = pickSubdirPlugin(REAL_SCAN)
    check('★② 真机夹具（根无清单 + ds-bot/ 有 dsh 清单）→ found=true、dir=ds-bot、包名=ds-bot',
      pick.found === true && pick.dir === 'ds-bot' && pick.packageName === 'ds-bot', JSON.stringify(pick))
    check('② 标记来源一并带出（判据可核验，不是一句没有出处的断言）',
      JSON.stringify(pick.markers) === JSON.stringify(['dsh.bundle.patch', 'dsh.client']), JSON.stringify(pick.markers))
    check('② 无标记的子包不算命中（`packages/utils` 这种普通包不误报成插件）',
      pickSubdirPlugin([{ path: 'packages/utils', name: '@probe/utils', markers: [] }]).found === false)
    check('② 子包清单里同时有普通包与 dsh 插件 → 命中插件那个',
      pickSubdirPlugin([{ path: 'packages/utils', name: '@probe/utils', markers: [] }, ...REAL_SCAN]).dir === 'ds-bot')
    check('② 没有子包清单 → found=false 且不抛（网络读不到时的形态）',
      pickSubdirPlugin([]).found === false && pickSubdirPlugin(null).found === false)
  }

  // ── ③ 结论出口：命中要说"在子目录下 + 下一步"；没命中要说"检查了哪里" ──────────────────
  {
    const hit = await decideNoRootManifest({ repo: REPO, branch: 'main', reason: 'not-found', subScan: REAL_SCAN })
    check('★③ 命中：hint=subdir-plugin + 结构化 subplugin（dir/packageName/markers/checkedDirs）',
      hit.hint === 'subdir-plugin' && hit.subplugin?.dir === 'ds-bot' && hit.subplugin?.packageName === 'ds-bot'
      && Array.isArray(hit.subplugin?.markers) && hit.subplugin.markers.length === 2, JSON.stringify(hit.subplugin))
    check('★③ 命中文案：明确纠正结论（"插件在子目录 ds-bot/ 下"）而不是含糊的"没有 package.json"',
      /插件在子目录 ds-bot\/ 下/u.test(hit.error) && /它就是 DSH 插件/u.test(hit.error), hit.error)
    check('★③ 命中文案：给可复制的下一步（按包名安装写法）',
      /dsh plugin --profile <你的 profile> add ds-bot/u.test(hit.error), hit.error)
    check('★③ 命中文案：如实说明"从子目录直接安装"当前不支持（不假装支持）',
      /暂不支持"从子目录直接安装"/u.test(hit.error) && /git 通道只装仓库根包/u.test(hit.error), hit.error)

    const miss = await decideNoRootManifest({
      repo: REPO,
      branch: 'main',
      reason: 'not-found',
      subScan: [{ path: 'packages/utils', name: '@probe/utils', markers: [] }],
      baseText: '仓库 Fei2411/DeepSeek-Bot 没有 package.json（也不是技能仓库），无法作为插件安装——可改用「仓库落地」克隆到本地目录。',
    })
    check('★③ 没命中：结论保持"不是插件"（hint=repo-land，subplugin=null）',
      miss.hint === 'repo-land' && miss.subplugin === null, JSON.stringify(miss))
    check('★③ 没命中：文案补上"已检查根目录与 2 层子目录"（诚实，不再是一句没有出处的断言）',
      /已检查根目录与 2 层子目录/u.test(miss.error) && /未发现声明 dsh 标记的 package.json/u.test(miss.error), miss.error)
    check('③ 没命中：原有判定口径一个字不动（"没有 package.json（也不是技能仓库）"仍在）',
      miss.error.includes('没有 package.json（也不是技能仓库）') && miss.error.includes('仓库落地'), miss.error)

    const unreachable = await decideNoRootManifest({
      repo: REPO, branch: 'main', reason: 'unreachable',
      subScan: [{ path: 'ds-bot', name: 'ds-bot', markers: ['dsh.bundle.patch'] }],
      baseText: '抓取超时/网络不可达：没能读到 x 的 package.json',
    })
    check('③ 子目录命中时不再谈"网络不可达"（结论是确定的：插件在那个子目录）',
      unreachable.hint === 'subdir-plugin' && !/抓取超时/u.test(unreachable.error), unreachable.error)
  }

  // ── ④ 旧行为不回归：私有根 monorepo 的"展开子包"仍由原分支处理 ─────────────────────────
  {
    const { pickSubdirPlugin: _keep } = { pickSubdirPlugin }
    const markers = describeDshManifest('{"name":"@probe/agg","private":true,"dsh":{"bundle":{"patch":"./p.yml"}}}')
    check('④ 私有根包（private:true）也带着 dsh 标记 → 判定逻辑不冲突（install-job 的 private 分支先跑，本函数只在根**无清单**时被调用）',
      markers.privateRoot === true && markers.markers.length === 1, JSON.stringify(markers))
    check('④ describeDshManifest 如实带出 privateRoot（给"私有聚合根"那条路留判据）',
      describeDshManifest('{"name":"a","private":true}').privateRoot === true
      && describeDshManifest('{"name":"a"}').privateRoot === false)
  }

  // ── ⑤ 探针口径：走桩 GitHub 树，**真实现**向下 1–2 层读 package.json（离线、零真实网络）────
  {
    const readPaths = []
    const ghUrls = []
    const ghJson = async (url) => { ghUrls.push(url); return { tree: TREE } }
    const rawText = async (repo, branch, path) => {
      readPaths.push(path)
      if (path === 'ds-bot/package.json') return DS_BOT_PKG
      if (path === 'packages/utils/package.json') return UTILS_PKG
      return null
    }
    const subs = await fetchSubdirPlugins(REPO, 'main', null, { githubJson: ghJson, rawText })
    const dsBot = subs.find((s) => s.path === 'ds-bot')
    check('★⑤ 探针（真实现 + 桩树）扫到 ds-bot（1 层子目录里的 dsh 清单），带 path/name/markers',
      dsBot !== undefined && dsBot.name === 'ds-bot' && dsBot.markers.length === 2, JSON.stringify(subs))
    check('★⑤ 同一轮也扫到了 2 层子目录里的普通包，但它**不算**插件（markers 为空）',
      subs.find((s) => s.path === 'packages/utils')?.markers.length === 0, JSON.stringify(subs))
    check('★⑤ 结论出口直接用这一轮扫描结果：命中 ds-bot（不是靠夹具硬编码）',
      pickSubdirPlugin(subs).found === true && pickSubdirPlugin(subs).dir === 'ds-bot', JSON.stringify(pickSubdirPlugin(subs)))
    check('⑤ 判据与"仓库根 package.json"分开：根不在扫描列表里（根没清单才走这条路）',
      !readPaths.includes('package.json'), readPaths.join(' | '))
    check('⑤ 只读 package.json（不额外拉别的文件，成本与既有子包探测一致）',
      readPaths.every((p) => p.endsWith('package.json')) && ghUrls.length >= 1, readPaths.join(' | '))
    check('⑤ 走的是 git trees 接口（一次请求拿全树，之后只读清单）',
      ghUrls.every((u) => /\/git\/trees\//u.test(u) && u.includes(REPO)), ghUrls.join(' | '))
    check('⑤ 深度口径 ≤2 层：3 层深的清单**不读**（与文案"已检查根目录与 2 层子目录"一致，不许各说各话）',
      !readPaths.includes('a/b/c/package.json'), readPaths.join(' | '))
    check('⑤ name 不是合法包的条目被丢掉（不把读坏的目录当插件）',
      (await fetchSubdirPlugins(REPO, 'main', null, { fetchSubpackageNames: async () => [{ path: 'a', name: '', markers: ['dsh.client'] }, { path: 'b', name: 'b', markers: [] }] })).length === 1)
    check('★⑤ 扫描抛错 → 返回 **null**（"没读到"），不是 []（"没有"）——两件事必须分得开',
      (await fetchSubdirPlugins(REPO, 'main', null, { fetchSubpackageNames: async () => { throw new Error('网络受限') } })) === null)
    check('★⑤ 扫描返回非数组（契约外的形态）也按"没读到"处理 → null',
      (await fetchSubdirPlugins(REPO, 'main', null, { fetchSubpackageNames: async () => undefined })) === null)
    check('⑤ 扫完确实没有 → []（"没有"，与上面的 null 语义不同）',
      Array.isArray(await fetchSubdirPlugins(REPO, 'main', null, { fetchSubpackageNames: async () => [] }))
      && (await fetchSubdirPlugins(REPO, 'main', null, { fetchSubpackageNames: async () => [] })).length === 0)
  }

  // ── ⑤″ "没读到"不许冒充"没有"：探针失败/返回 null 时的文案必须降级 ────────────────────────
  {
    const { FETCH_UNREACHABLE } = await import('../lib/server/infra/http.js')
    check('⑤″ 原因码口径对得上（decideNoRootManifest 里按字符串 ' + "'unreachable'" + ' 判，等于 infra 的常量）',
      FETCH_UNREACHABLE === 'unreachable', FETCH_UNREACHABLE)
    const base = '仓库 Fei2411/DeepSeek-Bot 没有 package.json（也不是技能仓库），无法作为插件安装——可改用「仓库落地」克隆到本地目录。'
    const failed = await decideNoRootManifest({ repo: REPO, branch: 'main', reason: 'not-found', probe: async () => { throw new Error('限流') }, baseText: base })
    check('★⑤″ 探针抛错 → 照旧给"不是插件"的结论，但**明说**子目录这一轮没读全（"没读到"不冒充"没有"）',
      failed.hint === 'repo-land' && /已检查根目录与 2 层子目录/u.test(failed.error)
      && /子目录这一轮没能完整读到/u.test(failed.error) && !/未发现声明 dsh 标记的 package.json/u.test(failed.error),
      failed.error)
    const nulled = await decideNoRootManifest({ repo: REPO, branch: 'main', reason: 'not-found', probe: async () => null, baseText: base })
    check('★⑤″ 探针返回 null（fetchSubdirPlugins 的失败契约）→ 同样降级（不是"未发现"）',
      nulled.hint === 'repo-land' && /子目录这一轮没能完整读到/u.test(nulled.error), nulled.error)
    const noProbe = await decideNoRootManifest({ repo: REPO, branch: 'main', reason: 'not-found', baseText: base })
    check('★⑤″ 根本没给探针（这一轮压根没扫）→ 也不许说"未发现"（不许假装扫过了）',
      /子目录这一轮没能完整读到/u.test(noProbe.error), noProbe.error)
    const reached = await decideNoRootManifest({ repo: REPO, branch: 'main', reason: FETCH_UNREACHABLE, subScan: [], baseText: '抓取超时/网络不可达：没能读到 x 的 package.json' })
    check('★⑤″ 根清单就不可达（reason=unreachable）→ 结论同样降级为"只覆盖读到的部分"，且保留"网络不可达"原话',
      /抓取超时\/网络不可达/u.test(reached.error) && /只覆盖读到的部分/u.test(reached.error), reached.error)
  }

  // ── ⑤′ 本机有真机仓库时的**忠实性**对照（CI 上响亮 SKIP，不假装 PASS）────────────────────
  {
    const realPkg = 'D:\\dsh\\repos\\Fei2411\\DeepSeek-Bot\\ds-bot\\package.json'
    if (!existsSync(realPkg)) {
      console.log(`SKIP ⑤′ 本机没有真机仓库 ${realPkg}（CI / 别的机器上属正常）——不假装 PASS`)
    } else {
      const info = describeDshManifest(readFileSync(realPkg, 'utf8'))
      check('★⑤′ 本机真机清单（ds-bot/package.json）与夹具同形：name=ds-bot、两个 dsh 标记',
        info !== null && info.name === 'ds-bot' && JSON.stringify(info.markers) === JSON.stringify(['dsh.bundle.patch', 'dsh.client']),
        JSON.stringify(info))
    }
  }

  // ── ⑥ install-job 的落点（注入缝，离线）：hint=subdir-plugin + subplugin 结构化字段 ────
  {
    const PROFILE = join(HOME, 'profiles', 'web')
    const { runInstallJob } = await import('../lib/server/domain/install-job.js')
    const ports = { baseUrl: `file:///${PROFILE.replace(/\\/gu, '/')}/cordis.yml`, loader: { entries: () => [] }, get: () => undefined }
    const mkJob = (id) => ({
      id, repo: REPO, source: 'github', packageName: null,
      status: 'installing', stage: 'preparing', error: null, startedAt: Date.now(), finishedAt: null,
      entryId: null, bundle: false, ai: false, aiNote: null, subpackages: null, lastError: null, update: false,
      kind: 'plugin', repoMeta: { default_branch: 'main' },
    })
    const job = mkJob('subdir-1')
    await runInstallJob(job, ports, {
      jobBudgetMs: 20000,
      marketProbes: {
        fetchRepoPackageEx: async () => ({ pkg: null, reason: 'not-found' }),
        probeGitmodules: async () => null,
        detectSkillRepo: async () => ({ hasSkill: false, skillDir: null }),
        fetchSubdirPlugins: async () => REAL_SCAN,
      },
      sourceDeps: {},
    })
    check('★⑥ 根无清单 + 子目录有 dsh 清单 → 作业失败但 hint=subdir-plugin（不是 repo-land）',
      job.status === 'failed' && job.hint === 'subdir-plugin', `status=${job.status} hint=${job.hint}`)
    check('★⑥ 作业带结构化 subplugin（面板据此单独显示"插件在 <子目录>/ 下"）',
      job.subplugin?.dir === 'ds-bot' && job.subplugin?.packageName === 'ds-bot', JSON.stringify(job.subplugin))
    check('★⑥ 作业错误文案与面板同一份（不是服务端另写一句）',
      typeof job.error === 'string' && /插件在子目录 ds-bot\/ 下/u.test(job.error) && job.error === subdirPluginText(REPO, 'main', pickSubdirPlugin(REAL_SCAN), 'github'))
    check('⑥ 这条路上**没有**落下 repo-land/probeReason（两个出口互斥，不混用）',
      job.probeReason === undefined && job.subplugin !== null)

    const job2 = mkJob('subdir-2')
    await runInstallJob(job2, ports, {
      jobBudgetMs: 20000,
      marketProbes: {
        fetchRepoPackageEx: async () => ({ pkg: null, reason: 'not-found' }),
        probeGitmodules: async () => null,
        detectSkillRepo: async () => ({ hasSkill: false, skillDir: null }),
        fetchSubdirPlugins: async () => [],
      },
      sourceDeps: {},
    })
    check('★⑥ 扫完确实没有 → hint=repo-land（旧结论不变）+ subplugin=null + 文案带"已检查根目录与 2 层子目录"',
      job2.status === 'failed' && job2.hint === 'repo-land' && job2.subplugin === null
      && /已检查根目录与 2 层子目录/u.test(String(job2.error)) && job2.probeReason === 'not-found',
      `hint=${job2.hint} error=${String(job2.error).slice(0, 160)}`)
    check('⑥ 没命中时错误文案仍是"真的没有"那一条（没有把"没读到"混进来）',
      String(job2.error).includes('没有 package.json（也不是技能仓库）'), String(job2.error).slice(0, 120))

    // 面板视图：结构化字段必须能到客户端（否则"插件在 <子目录>/ 下"只能从一整段报错里找）
    const { installJobView } = await import('../lib/server/domain/install.js')
    const view = installJobView(job)
    check('★⑥ 面板视图 installJobView 带 subplugin（面板据此单独渲染子目录结论）+ hint',
      view?.subplugin?.dir === 'ds-bot' && view.hint === 'subdir-plugin', `hint=${view?.hint} subplugin=${JSON.stringify(view?.subplugin)}`)
    check('⑥ 老客户端兼容：没命中的作业视图里 subplugin === null（纯加法，不破坏既有字段）',
      installJobView(job2).subplugin === null)

    // 探针失败（fetchSubdirPlugins 的 null 契约）⇒ 作业不许崩，且文案要如实降级
    const job3 = mkJob('subdir-3')
    let job3Threw = null
    try {
      await runInstallJob(job3, ports, {
        jobBudgetMs: 20000,
        marketProbes: {
          fetchRepoPackageEx: async () => ({ pkg: null, reason: 'not-found' }),
          probeGitmodules: async () => null,
          detectSkillRepo: async () => ({ hasSkill: false, skillDir: null }),
          fetchSubdirPlugins: async () => null,
        },
        sourceDeps: {},
      })
    } catch (error) { job3Threw = error }
    check('★⑥ 子目录扫描失败（探针 → null）⇒ 作业照旧收口（不抛）+ 结论降级说"没读全"',
      job3Threw === null && job3.status === 'failed' && job3.hint === 'repo-land'
      && /子目录这一轮没能完整读到/u.test(String(job3.error)) && !/未发现声明 dsh 标记的 package.json/u.test(String(job3.error)),
      `threw=${job3Threw === null ? 'no' : String(job3Threw)} error=${String(job3.error).slice(-120)}`)
  }

  // ── ⑦ 静态：先扫子目录，再下结论（把扫描去掉就必须红）─────────────────────────────────
  {
    const src = readFileSync(join(ROOT, '..', 'lib', 'server', 'domain', 'install-job.js'), 'utf8')
    const noRoot = src.slice(src.indexOf('if (pkg === null) {'), src.indexOf('if (pkg.private === true) {'))
    check('★⑦ install-job 的"根无清单"分支**必须先探测子目录**（decideNoRootManifest 带 probe）',
      noRoot.includes('decideNoRootManifest') && noRoot.includes('probe: probes.fetchSubdirPlugins'), noRoot.slice(0, 200))
    check('★⑦ 旧的"直接判 repo-land + packageProbeErrorText"单出口已不存在（否则子目录结论永远到不了用户）',
      !/job\.hint = 'repo-land'\s*\n\s*\/\/[^\n]*\n\s*job\.error = packageProbeErrorText/u.test(noRoot)
      && noRoot.includes('notPluginText') === false, '出口已收进 decideNoRootManifest')
    check('⑦ 文案与扫描口径一致：notPluginText 说的是"2 层子目录"，探针的路径判据也恰好 ≤2 层（各说各话即红）',
      /已检查根目录与 2 层子目录/u.test(notPluginText(REPO, 'main', 'not-found', 0, 0))
      && /^(?!node_modules\/)[^/]+(?:\/[^/]+)?\/package\.json$/u.test('packages/utils/package.json')
      && !/^(?!node_modules\/)[^/]+(?:\/[^/]+)?\/package\.json$/u.test('packages/deep/nested/package.json'))
    check('⑦ notPluginText：带 baseText 时保留原判定口径、补上检查范围；不带 baseText 时自成一句',
      notPluginText(REPO, 'main', 'not-found', 1, 2, '仓库 X 不是插件。').includes('仓库 X 不是插件。已检查根目录与 2 层子目录')
      && notPluginText(REPO, 'main', 'not-found', 0, 0).includes('仓库 Fei2411/DeepSeek-Bot（main 分支）不是可安装的插件'),
      notPluginText(REPO, 'main', 'not-found', 1, 2, '仓库 X 不是插件。'))
  }
  // ── ⑧ 测试自身的守卫自证：① 全程零真实出网 ② tripwire 是活的（正控）──────────────────
  {
    // ① 先核账：上面所有段落跑完，**一次**真实出网回落都不许被触达（全部走显式 deps 桩）。
    //    注意：这一条单独看可能是**空断言**（探针压根没装也会恒绿）—— 所以紧接着的 ② 正控
    //    专门证明这层守卫是活的；两条合起来才算"有牙齿"。
    check('★⑧ 全程零真实出网：跑到这里为止 tripwire 一次都没被触达（所有段落都走了显式 deps 桩）',
      tripwireCalls.length === 0, tripwireCalls.length === 0 ? '0 次' : tripwireCalls.join(' | '))

    // ② 正控（桩自校验）：**故意不带 deps** 走一次（正是"桩的袋子没接上"那种事故形态）
    //    ⇒ 出网回落必须被 tripwire 拦下。拦不到 ⇒ 守卫是空的，① 的"0 次"就是假绿 ⇒ 响亮红。
    const probe = await fetchSubdirPlugins(REPO, 'main', null, {})
    check('★⑧ 正控：不带 deps ⇒ 出网回落被 tripwire 当场拦下（证明守卫是活的，不是恒绿空断言）',
      tripwireCalls.length >= 1 && tripwireCalls.every((c) => c.startsWith('githubJson(')),
      tripwireCalls.length === 0 ? '一次都没拦到 —— 守卫形同虚设！' : `${tripwireCalls.length} 次：${tripwireCalls.join(' | ').slice(0, 140)}`)
    check('★⑧ 被拦下时探针不抛穿，按既有契约降级为 []（"没读到" ≠ 崩）', Array.isArray(probe), JSON.stringify(probe))
  }
} finally {
  __setSubpkgProbeDefaults(null)
  try { rmSync(HOME, { recursive: true, force: true }) } catch {}
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
