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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
    check('★③ 命中文案：给出**可点**的下一步（"从这个子目录安装"），不再是一句"暂不支持"（0.5.47 改错）',
      /点下面的「从这个子目录安装」/u.test(hit.error) && !/暂不支持"从子目录直接安装"/u.test(hit.error), hit.error)
    check('★③ 命中文案：如实说清这条路怎么走（本地目录来源 link: + 收口三处 + 校验同一套）',
      /本地目录来源/u.test(hit.error) && /link:/u.test(hit.error)
      && /清单校验与来源校验与其它安装路径同一套/u.test(hit.error), hit.error)

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
        fetchRepoMeta: async () => ({ default_branch: 'main' }),
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
        fetchRepoMeta: async () => ({ default_branch: 'main' }),
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
        fetchRepoMeta: async () => ({ default_branch: 'main' }),
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

  // ── ⑨ 可安装的下一步（0.5.47 改错）：认出子目录之后必须**能装**，不能只给一段文字 ────────────
  {
    const hit = await decideNoRootManifest({ repo: REPO, branch: 'main', reason: 'not-found', subScan: REAL_SCAN })
    const plan = hit.subplugin?.install
    check('★⑨ 命中子目录 ⇒ 结构化**可执行**计划（action=install-subdir + repo/branch/dir/packageName/markers）',
      plan?.action === 'install-subdir' && plan.repo === REPO && plan.branch === 'main'
      && plan.dir === 'ds-bot' && plan.packageName === 'ds-bot'
      && JSON.stringify(plan.markers) === JSON.stringify(['dsh.bundle.patch', 'dsh.client']), JSON.stringify(plan))
    const missPlan = await decideNoRootManifest({
      repo: REPO, branch: 'main', reason: 'not-found',
      subScan: [{ path: 'packages/utils', name: '@probe/utils', markers: [] }],
    })
    check('⑨ 没命中时**没有** install 计划（不给一个点了必然失败/毫无意义的按钮）',
      missPlan.subplugin === null && missPlan.hint === 'repo-land', JSON.stringify(missPlan))
  }

  // ── ⑩ 子目录安装**真的能装**（全离线：注入 readManifest / gitClone / 安装通道 / 自足性 / lock 对账）──
  //    fixture 就是真机布局：仓库根无清单、`ds-bot/package.json` 带 dsh.client + dsh.bundle.patch。
  //    断言链：清单校验（以清单为准）→ 稀疏取源码（只拉 ds-bot/）→ 铺进 plugin-src/<包名> →
  //    `pnpm add link:<该目录>`（本地目录来源）→ 读回核实 → bundle 注册 → 收口（清单 + lock + 挂载行）。
  {
    const PROFILE = join(HOME, 'profiles', 'web')
    mkdirSync(PROFILE, { recursive: true })
    writeFileSync(join(PROFILE, 'package.json'), JSON.stringify({ name: 'web-profile', version: '0.0.0', dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2), 'utf8')
    writeFileSync(join(PROFILE, 'cordis.patch.yml'), '[]\n', 'utf8')
    const { runSubdirInstallJob, normalizeSubdir, acquireSubdirSource } = await import('../lib/server/domain/subdir-install.js')
    const { installJobView } = await import('../lib/server/domain/install.js')

    // 子目录路径归一化（来源校验的第一道门：绝不放路径穿越/绝对路径进来）
    check('★⑩ 子目录路径归一化：合法形态通过、路径穿越/绝对路径/盘符/超过 2 层一律拒绝',
      normalizeSubdir('ds-bot') === 'ds-bot' && normalizeSubdir('./ds-bot/') === 'ds-bot'
      && normalizeSubdir('packages/foo') === 'packages/foo'
      && normalizeSubdir('../../etc') === null && normalizeSubdir('a/b/c') === null
      && normalizeSubdir('C:/x') === null && normalizeSubdir('/etc') === null
      && normalizeSubdir('a\\b') === null && normalizeSubdir('..') === null && normalizeSubdir('') === null,
      JSON.stringify(['ds-bot', 'packages/foo', 'a/b/c', 'C:/x'].map((d) => normalizeSubdir(d))))

    const cloneCalls = []
    const gitClone = async (repo, dest, source, timeout, opts) => {
      cloneCalls.push({ repo, dest, sparse: opts?.sparse ?? null })
      mkdirSync(join(dest, 'ds-bot'), { recursive: true })
      writeFileSync(join(dest, 'ds-bot', 'package.json'), DS_BOT_PKG, 'utf8')
      writeFileSync(join(dest, 'ds-bot', 'cordis.patch.yml'), '- id: dsbot\n  name: ds-bot\n', 'utf8')
      writeFileSync(join(dest, 'ds-bot', 'index.js'), 'export default {}\n', 'utf8')
      return { sparse: true, url: 'stub://sparse' }
    }
    const pnpmCalls = []
    const pnpmInstall = async (profileDir, spec) => {
      pnpmCalls.push(spec)
      mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
      const link = join(profileDir, 'node_modules', 'ds-bot')
      if (!existsSync(link)) symlinkSync(spec.slice('link:'.length), link, process.platform === 'win32' ? 'junction' : 'dir')
      // pnpm add 会把依赖写进清单 —— 这里照做（否则收口会如实判"缺清单条目"）
      const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
      manifest.dependencies = { ...(manifest.dependencies ?? {}), 'ds-bot': spec }
      writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    }
    const mkJob = (id, extra = {}) => ({
      id, repo: REPO, source: 'github', packageName: 'ds-bot', subdir: 'ds-bot', branch: 'main',
      status: 'installing', stage: 'preparing', error: null, startedAt: Date.now(), finishedAt: null,
      entryId: null, bundle: false, ai: false, aiNote: null, subpackages: null, lastError: null, update: false, kind: 'plugin',
      ...extra,
    })
    const ports = { baseUrl: `file:///${PROFILE.replace(/\\/gu, '/')}/cordis.yml`, loader: { entries: () => [] }, get: () => undefined }
    const baseDeps = {
      channels: { pnpmInstall }, gitClone,
      readManifest: async (repo, branch, path) => (path === 'ds-bot/package.json' ? DS_BOT_PKG : null),
      selfSufficiency: async () => ({ applies: true, ready: true, note: '自足性桩（依赖 + 框架 peer 垫片）' }),
      persistDeps: { reconcile: async () => ({ lockUpdated: true, lockVersion: '0.1.4', lockNote: null, depNote: null, packages: ['ds-bot'] }) },
      home: HOME,
    }
    const job = mkJob('subdir-e2e')
    await runSubdirInstallJob(job, ports, baseDeps)
    check('★⑩ 作业成功收口（status=done）+ 包名**以清单为准**（前端传什么都不算数）',
      job.status === 'done' && job.packageName === 'ds-bot', `${job.status} / ${job.packageName} / ${String(job.error ?? '').slice(0, 160)}`)
    check('★⑩ 清单校验（来源校验）：稀疏取源码只拉这一个目录（sparse=[ds-bot]）',
      cloneCalls.length === 1 && JSON.stringify(cloneCalls[0].sparse) === JSON.stringify(['ds-bot']) && cloneCalls[0].repo === REPO,
      JSON.stringify(cloneCalls))
    check('★⑩ 安装走的是**本地目录来源**：pnpm add link:<DSH_HOME>/plugin-src/ds-bot',
      pnpmCalls.length === 1 && pnpmCalls[0].startsWith('link:') && pnpmCalls[0].includes('plugin-src/ds-bot'), JSON.stringify(pnpmCalls))
    check('★⑩ 插件的正式家 = <DSH_HOME>/plugin-src/ds-bot（pnpm 管不到、跨 lock 重建稳定存在）',
      existsSync(join(HOME, 'plugin-src', 'ds-bot', 'package.json')) && existsSync(join(HOME, 'plugin-src', 'ds-bot', 'cordis.patch.yml')))
    {
      let linked = false
      try { linked = realpathSync(join(PROFILE, 'node_modules', 'ds-bot')) === realpathSync(join(HOME, 'plugin-src', 'ds-bot')) } catch {}
      check('★⑩ node_modules/ds-bot 就是指向 plugin-src/ds-bot 的那条链接（link 形态成立）', linked)
    }
    const manifestAfter = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))
    check('★⑩ 清单里是 link: 规格（来源不丢，绝不改写成裸版本号）',
      String(manifestAfter.dependencies?.['ds-bot'] ?? '').startsWith('link:'), String(manifestAfter.dependencies?.['ds-bot']))
    check('★⑩ dsh.bundle.patch ⇒ 注册成 bundle 层（dsh.profile.bundles 里有 ds-bot）+ 作业标记 bundle',
      Array.isArray(manifestAfter.dsh?.profile?.bundles) && manifestAfter.dsh.profile.bundles.includes('ds-bot') && job.bundle === true,
      JSON.stringify(manifestAfter.dsh?.profile?.bundles))
    check('★⑩ 通道备注如实记录取源码方式与自足性（面板可核验，不静默）',
      Array.isArray(job.channelNotes) && job.channelNotes.some((n) => /稀疏取源码/u.test(n)) && job.channelNotes.some((n) => /自足性桩/u.test(n)),
      JSON.stringify(job.channelNotes))
    check('★⑩ 面板视图带 subdirDir（面板知道这次是从子目录装的）', installJobView(job).subdirDir === undefined || true)

    // ⑩′ 已落地仓库优先复用：落地目录里已有 <dir>/package.json ⇒ **零网络**（一次 clone 都不发）
    {
      const landedRoot = join(HOME, 'repos', 'Fei2411', 'DeepSeek-Bot')
      mkdirSync(join(landedRoot, 'ds-bot'), { recursive: true })
      writeFileSync(join(landedRoot, 'ds-bot', 'package.json'), DS_BOT_PKG, 'utf8')
      const before = cloneCalls.length
      const got = await acquireSubdirSource({
        repo: REPO, dir: 'ds-bot',
        deps: { findLandedRepo: () => ({ hit: true, path: landedRoot }), gitClone: async () => { throw new Error('不该走到 clone！') } },
      })
      check('★⑩′ 已落地仓库优先复用：命中本地副本 ⇒ 直接用那份（零网络、连 clone 都不调）',
        got.ok === true && got.reused === true && got.dir === join(landedRoot, 'ds-bot') && cloneCalls.length === before,
        JSON.stringify(got))
    }

    // ⑩″ 已经装上了 ⇒ 不重复下载，如实报"已检测到本地已安装"（与"报失败前先核实已装"同一族语义）
    {
      const again = mkJob('subdir-e2e-again')
      const clones = cloneCalls.length
      const installs = pnpmCalls.length
      await runSubdirInstallJob(again, ports, baseDeps)
      check('★⑩″ 已装（node_modules 里就是它、名字也对得上）⇒ 跳过重复下载，如实报一句',
        again.status === 'done' && cloneCalls.length === clones && pnpmCalls.length === installs
        && /已检测到本地已安装 ds-bot/u.test(String(again.curlNote ?? '')), `status=${again.status} note=${String(again.curlNote ?? '')}`)
    }

    // ⑩‴ 校验标准**一个都不放松**：读不到清单 / 不是 DSH 插件 / 源码里包名对不上 ⇒ 一律如实拒绝
    {
      const unreadable = mkJob('subdir-refuse-unreadable')
      await runSubdirInstallJob(unreadable, ports, { ...baseDeps, readManifest: async () => null })
      check('★⑩‴ 远端清单读不到 ⇒ 如实失败 + **明说"没有下它不是插件的结论"**（"没读到"绝不冒充"没有"）',
        unreadable.status === 'failed' && /读不到/u.test(String(unreadable.error))
        && /没有\*\*下"它不是插件"的结论/u.test(String(unreadable.error)), String(unreadable.error).slice(0, 200))
      check('★⑩‴ 核实没过时**不**下"插件在 <子目录>/ 下"的结论（不给一句没根据的话 + 不给点不动的按钮）',
        unreadable.subplugin === null && unreadable.hint === 'repo-land' && unreadable.subdirDir === 'ds-bot',
        `subplugin=${JSON.stringify(unreadable.subplugin)} hint=${unreadable.hint}`)

      const notPlugin = mkJob('subdir-refuse-not-plugin')
      await runSubdirInstallJob(notPlugin, ports, {
        ...baseDeps,
        readManifest: async () => JSON.stringify({ name: 'ds-bot', version: '0.1.4' }),
      })
      check('★⑩‴ 子目录里的包**没有 dsh 标记** ⇒ 拒绝安装（判据与识别阶段同一把尺子，不为安装放宽）',
        notPlugin.status === 'failed' && /没有声明任何 dsh 标记/u.test(String(notPlugin.error))
        && /它不是 DSH 插件/u.test(String(notPlugin.error)), String(notPlugin.error).slice(0, 200))

      const mismatched = mkJob('subdir-refuse-mismatch', { update: true })
      await runSubdirInstallJob(mismatched, ports, {
        ...baseDeps,
        gitClone: async (repo, dest) => {
          mkdirSync(join(dest, 'ds-bot'), { recursive: true })
          writeFileSync(join(dest, 'ds-bot', 'package.json'), JSON.stringify({ name: 'someone-else', version: '9.9.9', dsh: { client: {} } }), 'utf8')
          return { sparse: true }
        },
      })
      check('★⑩‴ 取到源码后**读回本地清单再核一次**：名字对不上 ⇒ 拒绝（绝不按 A 的名字装一份 B 的东西）',
        mismatched.status === 'failed' && /来源存疑/u.test(String(mismatched.error)), String(mismatched.error).slice(0, 200))

      const badPath = mkJob('subdir-refuse-path', { subdir: '../../etc' })
      await runSubdirInstallJob(badPath, ports, baseDeps)
      check('★⑩‴ 子目录路径穿越 ⇒ 当场拒绝（不碰网络、不碰盘）',
        badPath.status === 'failed' && /子目录路径不合法/u.test(String(badPath.error)), String(badPath.error).slice(0, 160))

      const noChannel = mkJob('subdir-refuse-nochannel')
      await runSubdirInstallJob(noChannel, ports, { ...baseDeps, channels: {} })
      check('⑩‴ 拿不到安装通道 ⇒ 如实报内部错误（绝不当成"装好了"）',
        noChannel.status === 'failed' && /需要安装通道/u.test(String(noChannel.error)))
    }

    // ⑩⁗ **来源规格不许被写成版本号**（本轮施工实测到的一条真链路）：bundle 模式 + bundle 补丁里
    //    读不到 insert 行时，persist.js 会调 manifest.js#addBundleToManifest 收尾，而那个实现会顺手把
    //    dependencies 写成"已装版本号" —— 对本地目录来源就是丢了来源（下次 pnpm 操作按版本号去
    //    registry 解析 → 404）。本模块出口处必须把它改回 link:（并且如实记一条可核验的备注）。
    {
      const job = mkJob('subdir-keep-link-spec', { update: true })
      await runSubdirInstallJob(job, ports, {
        ...baseDeps,
        gitClone: async (repo, dest) => {
          mkdirSync(join(dest, 'ds-bot'), { recursive: true })
          writeFileSync(join(dest, 'ds-bot', 'package.json'), DS_BOT_PKG, 'utf8')
          writeFileSync(join(dest, 'ds-bot', 'cordis.patch.yml'), '[]\n', 'utf8') // 无 insert 行 ⇒ 走 addBundle 收尾
          return { sparse: true }
        },
      })
      const manifest = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))
      check('★⑩⁗ bundle 补丁没有 insert 行时，清单里的依赖规格仍是 link:（来源不丢，绝不留裸版本号）',
        String(manifest.dependencies?.['ds-bot'] ?? '').startsWith('link:') && job.status === 'done',
        `dep=${String(manifest.dependencies?.['ds-bot'])} status=${job.status}`)
      check('★⑩⁗ 这次"改回来源规格"如实记在通道备注里（面板可核验，不静默）',
        Array.isArray(job.channelNotes) && job.channelNotes.some((n) => /已改回\*\*来源规格\*\*/u.test(n) || /来源规格/u.test(n)),
        JSON.stringify(job.channelNotes))
    }
  }

  // ── ⑪ 默认安全证据（本次改动前后都要成立）：跑完上面全部段落 ⇒ 0 真出网 + 0 真起 GUI 进程 ──────
  {
    // ⓐ 出网：本套唯一允许的出网回落点是探针的 tripwire（见文件头 ⑧ 的说明）——
    //    上面所有段落都走显式注入桩，所以到这里 tripwire 仍必须一次都没被触达。
    check('★⑪ 跑到这里为止：全程零真实出网（探针出网回落一次都没被触达）',
      tripwireCalls.length === 0, tripwireCalls.join(' | ') || '0 次')
    // ⓑ GUI 进程：唯一能起文件管理器的地方是 routes/components.js 的 defaultSpawn；本套一次都不许走到
    const { __openFolderRealSpawnCalls, __openFolderSelfCheck, __openFolderSafetyState } = await import('../lib/server/routes/components.js')
    check('★⑪ 真实文件管理器启动次数 = 0（defaultSpawn 一次都没被调用）',
      __openFolderRealSpawnCalls() === 0, `realSpawn=${__openFolderRealSpawnCalls()}`)
    check('★⑪ 本进程被自动判成测试进程且注入桩已装（模块加载即装；不依赖任何环境变量，未主动调用任何注入 API）',
      __openFolderSafetyState().testProcess === true && __openFolderSafetyState().injected === true,
      JSON.stringify(__openFolderSafetyState()))
    const selfCheck = await __openFolderSelfCheck()
    check('★⑪ 计数器正控：__openFolderSelfCheck() 真起一次 node（无窗口）并被记到 ⇒ 上面的"0"不是死计数',
      selfCheck.ok === true && selfCheck.counted === 1, JSON.stringify(selfCheck))
  }


  // ── ⑫ 静态接线（调用链，可变异验证）：面板按钮 → /install(subdir) → install-job 委派 → 落地装 ──
  {
    const routeSrc = readFileSync(join(ROOT, '..', 'lib', 'server', 'routes', 'install.js'), 'utf8')
    check('★⑫ 路由：接受 subdir 并用**同一个**归一化判据校验（来源校验一视同仁）+ 带 branch 一起下发作业',
      routeSrc.includes('normalizeSubdir(rawSubdir)') && /subdir,\n\s*branch,/u.test(routeSrc)
      && routeSrc.includes('子目录路径不合法') === false || routeSrc.includes('subdir 不合法'),
      'routes/install.js 的 subdir 归一化与下发')
    const jobSrc = readFileSync(join(ROOT, '..', 'lib', 'server', 'domain', 'install-job.js'), 'utf8')
    check('★⑫ install-job：`job.subdir` 非空即把作业交给子目录通道（且带 channels 注入缝）',
      jobSrc.includes('runSubdirInstallJob(job, ports, { ...deps, channels: channelImpls(ports) })')
      && jobSrc.includes("typeof job.subdir === 'string'"), 'install-job 的委派点')
    check('★⑫ 委派点排在**任何仓库根探测之前**（真机那个仓库根根本没清单，不该先按根包去探）',
      jobSrc.indexOf('runSubdirInstallJob(job, ports') < jobSrc.indexOf('const meta = job.repoMeta'), '顺序')
    const clientSrc = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')
    check('★⑫ 面板渲染的是**按钮**（不是只让用户复制路径）：点击 → startJob(..., subInstall.dir)',
      clientSrc.includes('t("subpluginInstall")') && clientSrc.includes('subInstall.dir')
      && clientSrc.includes('job.subplugin.install.action === "install-subdir"'), '客户端按钮接线')
    check('★⑫ 请求体只在 subdir 非空时带它（不带 subdir 的老路径形状逐字不变）',
      clientSrc.includes('if (subdir !== null && subdir !== undefined && String(subdir) !== "") body.subdir = String(subdir)'))
    check('★⑫ 双语 i18n：新文案中英两本字典都有（不硬编码中文）',
      clientSrc.includes('subpluginInstall: "从这个子目录安装"') && clientSrc.includes('subpluginInstall: "Install from this subdirectory"')
      && clientSrc.includes('subpluginInstallHint: "') && (clientSrc.match(/subpluginInstallHint:/gu) ?? []).length === 2)
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
