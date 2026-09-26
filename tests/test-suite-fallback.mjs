// 套装链修复（0.5.19）的真实验收：**克隆失败必须回落普通通道** + **套装判定前先看根包是否已发布**。
//
// 真机事故（2026-09-27，用户点装 zhu1090093659/dsh-web 全家桶 429 MB）：
//   市场卡片点「添加到本地」只带 owner/repo、不带包名 → candidates=[] → 走套装兜底（该仓库根目录确实有
//   .gitmodules）→ 第一步就 clone 整个仓库（ghproxy 的 git 协议 0 B/s，必然失败）→ 而 notASuite
//   （把决定权交回普通通道）**只在"克隆成功但 .gitmodules 为空"时才返回** → 克隆失败等于没有任何回落，
//   用户只看到一个失败的任务。同一批次的 archive 通道（C-⑨）让"克隆必败"不再成立（同一个 ghproxy 域名下
//   压缩包能跑到 7~18 MB/s，实测 429 MB 会被真的拉下来），所以本条同时钉死"先看根包是否已发布"：
//   根包没发布、但有已发布的子包（dsh-web → @linxin666/dsh-web-all）时必须走插件通道，不碰巨仓。
//
// 四段（①②纯离线；③④真跑 git/pnpm，但源与 registry 都在本机 —— 不碰外网、不碰 live profile）：
//   ① 单元：根克隆抛错 → 返回 notASuite（不抛、不置 failed）；克隆成功但 .gitmodules 为空 → 旧回落路径不回归
//   ② 单元：shouldRunSuiteInstall 的四条判据（已发布根包 / 无发布物 / 有已发布子包 / 内容不像 gitmodules）
//   ③ 真实：根目录有 .gitmodules 但克隆必败（死源）→ 真的回落普通通道并按包名装成功（隔离 profile + 真 pnpm）
//   ④ 真实对照：小仓库走 file:// git 克隆成功 → 套装装配照旧（证明"不掉能力"）
//   ⑤（可选，需外网）真 dsh-web：判定必须落到"子包已发布 → 插件通道"，且全程不发一次克隆
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer as createTcpServer } from 'node:net'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { runInstallJob } from '../lib/server/domain/install-job.js'
import { fetchRepoPackageEx as realFetchRepoPackageEx, subpackageCandidates as realSubpackageCandidates } from '../lib/server/domain/market.js'
import { runSuiteInstallJob, shouldRunSuiteInstall } from '../lib/server/domain/suite.js'
import { disposeDir } from '../lib/server/infra/fsx.js'
import { gitBin, runPnpmWithFallback } from '../lib/server/infra/exec.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const HOME = join(tmpdir(), `dsh-suite-fallback-${process.pid}`)
const PROFILE = join(HOME, 'profiles', 'web')
disposeDir(HOME)
mkdirSync(PROFILE, { recursive: true })
writeFileSync(join(PROFILE, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }, null, 2), 'utf8')
writeFileSync(join(PROFILE, 'cordis.patch.yml'), '# suite-fallback\n', 'utf8')
writeFileSync(join(PROFILE, 'cordis.yml'), 'plugins: []\n', 'utf8')
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })

const savedHome = process.env.DSH_HOME
process.env.DSH_HOME = HOME

const ports = {
  baseUrl: pathToFileURL(join(PROFILE, 'cordis.yml')).href,
  loader: { entries: () => [{ id: 'include', options: { name: 'cordis:include', group: true, config: { path: pathToFileURL(join(PROFILE, 'cordis.yml')).href } } }] },
  get: () => undefined,
}
const GM_TEXT = '[submodule "satellites/sub"]\n\tpath = satellites/sub\n\turl = https://github.com/probe-org/suite-sub.git\n'

// ── ① 根克隆失败 → notASuite（旧代码在这里把作业判成 failed，且没有任何回落）────────────────
// 注意：判定阶段必须先判成"真套装"（根包没发布 + 子包也没发布）才会走到克隆 —— 这正是 0.5.19 的预期，
// 所以本段显式喂"同意走套装"的探测（见 ③/③″ 对判据本身的断言）。
const suiteProbes = {
  fetchRepoPackageEx: async () => ({ pkg: { name: 'probe-root', private: true }, reason: 'ok' }),
  probeGitmodules: async () => GM_TEXT,
  subpackageCandidates: async () => [],
  namePublished: async () => false,
}
{
  const job = { id: 'job-clone-fail', repo: 'probe-org/suite-clone-fail', source: 'github', status: 'installing', stage: 'preparing', kind: 'suite' }
  let thrown = null
  let result = null
  try {
    result = await runSuiteInstallJob(job, ports, {
      gitClone: async () => { throw new Error('桩：克隆必败（429 MB 巨仓 / 源 0 B/s）') },
      probes: suiteProbes,
    })
  } catch (error) { thrown = error }
  check('① 根克隆抛错 → 不抛出、返回 notASuite（不再把作业判 failed）',
    thrown === null && result !== null && result.notASuite === true && job.status !== 'failed',
    `thrown=${thrown === null ? 'null' : String(thrown.message).slice(0, 80)} result=${JSON.stringify(result)} status=${job.status}`)
  check('① 回落原因带上了克隆错误原文（面板可见）',
    /克隆失败/u.test(String(result?.reason ?? '')) && /桩：克隆必败/u.test(String(result?.reason ?? '')), String(result?.reason ?? '').slice(0, 140))
  check('① 作业没有被写成 error（旧的 job.error/job.status=failed 分支不再命中）',
    job.status !== 'failed' && (job.error === undefined || job.error === null), `status=${job.status} error=${String(job.error ?? '')}`)
}

// ── ② 克隆成功但 .gitmodules 为空 → 仍走原回落路径（不回归）──────────────────────────────
{
  const job = { id: 'job-empty-gitmodules', repo: 'probe-org/suite-empty', source: 'github', status: 'installing', stage: 'preparing', kind: 'suite' }
  const result = await runSuiteInstallJob(job, ports, { gitClone: async () => {}, probes: suiteProbes })
  check('② 克隆成功 + .gitmodules 为空 → notASuite（原有回落路径不变）',
    result?.notASuite === true && job.status !== 'failed', `notASuite=${result?.notASuite} status=${job.status}`)
}

// ── ③ shouldRunSuiteInstall 的四条判据（纯注入，不联网）─────────────────────────────────
const mkProbes = (over = {}) => ({
  fetchRepoPackageEx: async () => ({ pkg: { name: 'probe-root', private: true }, reason: 'ok' }),
  probeGitmodules: async () => GM_TEXT,
  subpackageCandidates: async () => [],
  namePublished: async () => false,
  ...over,
})
{
  const job = { repo: 'probe-org/x', kind: 'plugin' }
  const suite = await shouldRunSuiteInstall(job, mkProbes({ namePublished: async (n) => n === 'probe-root' }))
  check('③ 根包已发布到 registry → 不进套装分支（优先插件通道）', suite === false, `suite=${suite}`)
  check('③ 已发布的根包名记在 job 上（面板/诊断可见）', job.rootPublished === 'probe-root', String(job.rootPublished))
}
{
  const job = { repo: 'probe-org/x', kind: 'plugin' }
  const suite = await shouldRunSuiteInstall(job, mkProbes())
  check('③ 无发布物 + .gitmodules 像套装 + 子包也没发布 → 仍按 .gitmodules 判（= 套装，能力不变）', suite === true, `suite=${suite}`)
}
{
  const job = { repo: 'probe-org/x', kind: 'plugin' }
  const suite = await shouldRunSuiteInstall(job, mkProbes({
    subpackageCandidates: async () => ['@probe/agg', '@probe/other'],
    namePublished: async (n) => n === '@probe/agg',
  }))
  check('③ 根包没发布但子包已发布 → 不进套装分支（真机 dsh-web：429 MB 套装 vs 5.97 MB 子包）',
    suite === false && job.subpackagePreferred === '@probe/agg', `suite=${suite} preferred=${job.subpackagePreferred}`)
  check('③ 子包探测结果缓存在 job 上（下游候选循环复用，不重复联网）',
    Array.isArray(job.subpackageProbe) && job.subpackageProbe.length === 2, JSON.stringify(job.subpackageProbe))
}
{
  const job = { repo: 'probe-org/x', kind: 'plugin' }
  const suite = await shouldRunSuiteInstall(job, mkProbes({ probeGitmodules: async () => null }))
  check('③ .gitmodules 内容不像套装 → 不判套装（2026-09-19 假阳性事故不回归）', suite === false, `suite=${suite}`)
}
{
  const calls = []
  const job = { repo: 'probe-org/x', kind: 'skill' }
  const suite = await shouldRunSuiteInstall(job, mkProbes({ probeGitmodules: async () => { calls.push('probe'); return GM_TEXT } }))
  check('③ 技能请求不受影响（不判套装、连探都不探）', suite === false && calls.length === 0, `suite=${suite} calls=${calls.join(',')}`)
}

// ── ③″ 显式「安装套装」也走同一道判据（前端 hasSuite=true 的市场卡片就是这条路）────────────
// 为什么必须有这一段：客户端 addLocal() 先判 `item.hasSuite === true` 就 startSuiteJob()（kind=suite），
// 路由 routes/install.js 直接调 runSuiteInstallJob —— 完全不经过 install-job 的候选循环。
// 真机 dsh-web 的根目录确实有 .gitmodules（enrich 的 hasSuite 只看内容），所以市场卡片点的就是这条路。
{
  let cloneCalled = 0
  const job = { id: 'job-explicit-suite', repo: 'probe-org/suite-dead', source: 'github', status: 'installing', stage: 'preparing', kind: 'suite' }
  const result = await runSuiteInstallJob(job, ports, {
    gitClone: async () => { cloneCalled += 1; throw new Error('不该被调用：判定阶段就该回落') },
    probes: {
      fetchRepoPackageEx: async () => ({ pkg: { name: 'probe-root', private: true }, reason: 'ok' }),
      probeGitmodules: async () => GM_TEXT,
      subpackageCandidates: async () => ['@probe/agg'],
      namePublished: async (n) => n === '@probe/agg',
    },
  })
  check('③″ 显式套装 + 根包没发布但子包已发布 → 克隆之前就回落（一次 git 都没碰）',
    result?.notASuite === true && cloneCalled === 0, `notASuite=${result?.notASuite} cloneCalled=${cloneCalled}`)
  check('③″ 回落原因说的是"已发布的子包"（面板可见，不再一律报成"内容不符"）',
    /子包/u.test(String(result?.reason ?? '')) && String(result?.reason ?? '').includes('@probe/agg'), String(result?.reason ?? '').slice(0, 140))
  check('③″ 判定结论缓存在 job 上（install-job 再判一次时零联网）', job.suiteDecision === false, String(job.suiteDecision))
}
{
  let cloneCalled = 0
  const job = { id: 'job-explicit-suite-real', repo: 'probe-org/suite-real', source: 'github', status: 'installing', stage: 'preparing', kind: 'suite' }
  await runSuiteInstallJob(job, ports, {
    gitClone: async () => { cloneCalled += 1 },
    probes: {
      fetchRepoPackageEx: async () => ({ pkg: { name: 'probe-suite-root', private: true }, reason: 'ok' }),
      probeGitmodules: async () => GM_TEXT,
      subpackageCandidates: async () => [],
      namePublished: async () => false,
    },
  })
  check('③″ 真套装（子包都没发布）依旧照原路克隆装配 —— 能力一点没删', cloneCalled === 1, `cloneCalled=${cloneCalled}`)
}

// ── ③′ 真 dsh-web 的判据（需外网，CI 跳）────────────────────────────────────────────────
if (process.env.DSH_TEST_SKIP_NETWORK === '1') {
  console.log('SKIP ③′ 真 dsh-web 判据（DSH_TEST_SKIP_NETWORK=1）')
} else {
  const job = { repo: 'zhu1090093659/dsh-web', kind: 'plugin' }
  const t0 = Date.now()
  // 真实现：仓库探测与子包列表来自市场模块，registry 存在性走真 namePublishedOnRegistry（不注入）
  const suite = await shouldRunSuiteInstall(job, {
    fetchRepoPackageEx: realFetchRepoPackageEx,
    subpackageCandidates: realSubpackageCandidates,
  })
  const ms = Date.now() - t0
  console.log(`INFO 真 dsh-web 判定：suite=${suite} preferred=${job.subpackagePreferred} branch=${job.defaultBranch} 耗时 ${(ms / 1000).toFixed(1)} 秒`)
  check('③′ 真 dsh-web：根包（dsh-web，private）未发布、子包已发布 → 判定为插件通道（不碰 429 MB 巨仓）',
    suite === false && job.subpackagePreferred === '@linxin666/dsh-web-all', `suite=${suite} preferred=${job.subpackagePreferred}`)
  check('③′ 判定在 60 秒内完成（两次 registry 查询 + 一次子包列表）', ms < 60000, `${(ms / 1000).toFixed(1)} 秒`)
}

// ── ④ 真实：根目录有 .gitmodules 但克隆必败 → 真的回落普通通道并按包名装成功 ──────────────
// 本机 npm registry 桩（真 packument + 真 tgz：用 pnpm pack 造，与 hub 自己的工具链一致）
const REG_NAME = '@probe/suite-plugin'
const REG_VERSION = '1.0.0'
const packDir = join(HOME, 'pack-src')
mkdirSync(packDir, { recursive: true })
writeFileSync(join(packDir, 'package.json'), JSON.stringify({ name: REG_NAME, version: REG_VERSION, main: 'index.js' }, null, 2), 'utf8')
writeFileSync(join(packDir, 'index.js'), 'module.exports = "suite-fallback-fixture"\n', 'utf8')
// 真 tgz：用 hub 自己的 pnpm 通道（corepack）打包，和线上安装物同一种格式
await runPnpmWithFallback(['pack'], { execOpts: { cwd: packDir, timeout: 120000, windowsHide: true } })
const tgzPath = join(packDir, 'probe-suite-plugin-1.0.0.tgz')
if (!existsSync(tgzPath)) throw new Error(`夹具缺失：${tgzPath}`)
const tarball = readFileSync(tgzPath)
const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
const shasum = createHash('sha1').update(tarball).digest('hex')
const served = { packument: 0, tarball: 0 }
const regServer = createServer((req, res) => {
  const path = decodeURIComponent(String(req.url ?? '').split('?')[0])
  if (path.endsWith('.tgz')) {
    served.tarball += 1
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(tarball)
    return
  }
  served.packument += 1
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    name: REG_NAME,
    'dist-tags': { latest: REG_VERSION },
    versions: {
      [REG_VERSION]: {
        name: REG_NAME,
        version: REG_VERSION,
        main: 'index.js',
        dist: { tarball: `http://127.0.0.1:${regServer.address().port}/${REG_NAME}-${REG_VERSION}.tgz`, integrity, shasum },
      },
    },
  }))
})
await new Promise((resolve) => regServer.listen(0, '127.0.0.1', resolve))
const regPort = regServer.address().port

// 死源：本机一个"连上就 RST"的端口（accept 后立刻 destroy）。
// 为什么不是"挑一个关掉的端口"：实测关掉的端口会被系统/同批测试回收，curl 的 `--max-time 180` 会整个卡住
// （2026-09-27 本用例首跑卡了 30 分钟，把整套测试拖死）—— 自己持有端口并立刻断链才是确定性的"连不上"。
const deadSockets = []
const deadServer = createTcpServer((socket) => {
  socket.on('error', () => {})
  deadSockets.push(socket)
  socket.destroy()
})
await new Promise((resolve) => deadServer.listen(0, '127.0.0.1', resolve))
const deadPort = deadServer.address().port

writeFileSync(join(HOME, 'plugin-console-sources.json'), JSON.stringify({
  registries: [{ id: 'local', name: '本机 registry 桩', url: `http://127.0.0.1:${regPort}`, primary: true }],
  gitSources: [{ id: 'dead-git', name: '死源（连接被拒）', urlTemplate: `http://127.0.0.1:${deadPort}/{owner}/{repo}.git`, primary: true }],
  archiveSources: [{ id: 'dead-archive', name: '死源 archive', urlTemplate: `http://127.0.0.1:${deadPort}/{owner}/{repo}/archive/refs/heads/{branch}.tar.gz`, primary: true }],
}, null, 2), 'utf8')
{
  const job = {
    id: 'job-real-fallback', repo: 'probe-org/suite-dead', source: 'github', packageName: null,
    status: 'installing', stage: 'preparing', error: null, startedAt: Date.now(), finishedAt: null,
    entryId: null, bundle: false, ai: false, aiNote: null, subpackages: null, lastError: null, update: false, kind: 'plugin',
  }
  const t0 = Date.now()
  let thrown = null
  try {
    await runInstallJob(job, ports, {
      jobBudgetMs: 120000,
      aiConsentTimeoutMs: 300,
      marketProbes: {
        fetchRepoPackageEx: async () => ({ pkg: { name: REG_NAME, private: false }, reason: 'ok' }),
        fetchRepoPackage: async () => ({ name: REG_NAME, private: false }),
        fetchSubpackageNames: async () => [],
        subpackageCandidates: async () => [],
        expandSubpackages: async () => [],
        namePublished: async () => false,          // 根包没发布（真机 dsh-web 是 npm/npmmirror 双 404）
        probeGitmodules: async () => GM_TEXT,      // 根目录 .gitmodules 内容像套装 → 会进套装分支
      },
    })
  } catch (error) { thrown = error }
  const ms = Date.now() - t0
  const installedPkg = join(PROFILE, 'node_modules', ...REG_NAME.split('/'), 'package.json')
  const installed = existsSync(installedPkg) ? JSON.parse(readFileSync(installedPkg, 'utf8')) : null
  const patchText = readFileSync(join(PROFILE, 'cordis.patch.yml'), 'utf8')
  console.log(`INFO ④ 通道调用：suiteNote=${String(job.suiteNote ?? '').slice(0, 100)}`)
  console.log(`INFO ④ 总耗时 ${(ms / 1000).toFixed(1)} 秒；registry 桩命中 packument=${served.packument} tarball=${served.tarball}；job.stage=${job.stage}`)
  check('④ 作业自己收尾（无异常逃逸）', thrown === null, thrown === null ? 'ok' : String(thrown?.message).slice(0, 160))
  check('④ 套装根克隆真的失败了（死源），并如实写进 job.suiteNote',
    /克隆失败/u.test(String(job.suiteNote ?? '')), String(job.suiteNote ?? '').slice(0, 140))
  check('④ 真的回落到普通通道并**按包名装成功**（job.status=done + 磁盘上真的有这个包）',
    job.status === 'done' && installed !== null && installed.version === REG_VERSION,
    `status=${job.status} installed=${installed?.name ?? 'null'}@${installed?.version ?? '?'}`)
  check('④ 装的是根 package.json 里的包名（不是套装子模块）',
    job.packageName === REG_NAME && installed?.name === REG_NAME, `${job.packageName} / ${installed?.name}`)
  check('④ 没有走成套装装配（suiteReport 为空、kind 回落 plugin）',
    job.suiteReport === undefined && job.kind === 'plugin', `suiteReport=${JSON.stringify(job.suiteReport ?? null)} kind=${job.kind}`)
  check('④ 补丁里写入了启用行', patchText.includes(REG_NAME), patchText.replace(/\s+/gu, ' ').slice(0, 120))
  check('④ 真 registry 被用到（桩计数 > 0），耗时在作业预算内',
    served.packument > 0 && served.tarball > 0 && ms < 120000, `packument=${served.packument} tarball=${served.tarball} ${(ms / 1000).toFixed(1)} 秒`)
}

// ── ⑤ 真实对照：小仓库走 file:// git 克隆成功 → 套装装配照旧（不掉能力）──────────────────
{
  const gitRoot = join(HOME, 'gitroot')
  const subWork = join(gitRoot, 'work-sub')
  const subBare = join(gitRoot, 'probe-org', 'suite-sub.git')
  const rootWork = join(gitRoot, 'work-root')
  const rootBare = join(gitRoot, 'probe-org', 'suite-ok.git')
  mkdirSync(subWork, { recursive: true })
  mkdirSync(subBare.replace(/[^\\/]+$/u, ''), { recursive: true })
  mkdirSync(rootWork, { recursive: true })
  writeFileSync(join(subWork, 'package.json'), JSON.stringify({ name: '@probe/suite-comp', version: '0.0.1', main: 'index.js' }, null, 2), 'utf8')
  writeFileSync(join(subWork, 'index.js'), 'module.exports = "suite-component"\n', 'utf8')
  // 根仓库：真 .gitmodules（suite.js 读的是文件内容；子模块 URL 故意用 https 形式，靠本机 file:// 源解析）
  writeFileSync(join(rootWork, '.gitmodules'), GM_TEXT, 'utf8')
  writeFileSync(join(rootWork, 'README.md'), '# suite-ok\n', 'utf8')
  const git = gitBin()
  const run = (cwd, args) => execFileSync(git, args, { cwd, stdio: 'ignore', windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@local', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@local' } })
  run(subWork, ['init', '-q'])
  run(subWork, ['add', '-A'])
  run(subWork, ['commit', '-qm', 'sub'])
  run(subWork, ['clone', '-q', '--bare', subWork, subBare])
  run(rootWork, ['init', '-q'])
  run(rootWork, ['add', '-A'])
  run(rootWork, ['commit', '-qm', 'root'])
  run(rootWork, ['clone', '-q', '--bare', rootWork, rootBare])

  const gitUrlBase = pathToFileURL(gitRoot).href
  writeFileSync(join(HOME, 'plugin-console-sources.json'), JSON.stringify({
    registries: [{ id: 'local', name: '本机 registry 桩', url: `http://127.0.0.1:${regPort}`, primary: true }],
    gitSources: [{ id: 'local-bare', name: '本机裸仓库', urlTemplate: `${gitUrlBase}/{owner}/{repo}.git`, primary: true }],
    archiveSources: [{ id: 'dead-archive', name: '死源 archive', urlTemplate: `http://127.0.0.1:${deadPort}/{owner}/{repo}/archive/refs/heads/{branch}.tar.gz`, primary: true }],
  }, null, 2), 'utf8')

  const job = {
    id: 'job-real-suite-ok', repo: 'probe-org/suite-ok', source: 'github', packageName: null,
    status: 'installing', stage: 'preparing', error: null, startedAt: Date.now(), finishedAt: null,
    entryId: null, bundle: false, ai: false, aiNote: null, subpackages: null, lastError: null, update: false, kind: 'plugin',
  }
  const t0 = Date.now()
  let thrown = null
  try {
    await runInstallJob(job, ports, {
      jobBudgetMs: 120000,
      aiConsentTimeoutMs: 300,
      marketProbes: {
        fetchRepoPackageEx: async () => ({ pkg: { name: 'probe-suite-root', private: true }, reason: 'ok' }),
        fetchRepoPackage: async () => ({ name: 'probe-suite-root', private: true }),
        fetchSubpackageNames: async () => [],
        subpackageCandidates: async () => [],   // 子包没发布 → 仍然走套装（对照组的判据）
        expandSubpackages: async () => [],
        namePublished: async () => false,
        probeGitmodules: async () => GM_TEXT,
      },
    })
  } catch (error) { thrown = error }
  const ms = Date.now() - t0
  const compPkg = join(PROFILE, 'node_modules', '@probe', 'suite-comp', 'package.json')
  const compInstalled = existsSync(compPkg)
  const patchText = readFileSync(join(PROFILE, 'cordis.patch.yml'), 'utf8')
  console.log(`INFO ⑤ 套装报告：${JSON.stringify(job.suiteReport ?? null)}（${(ms / 1000).toFixed(1)} 秒）`)
  check('⑤ 小仓库走 git（file:// 裸仓库）真的克隆成功并完成套装装配（不掉能力）',
    thrown === null && job.status === 'done' && job.kind === 'suite' && Array.isArray(job.suiteReport) && job.suiteReport.some((r) => r.ok === true),
    `status=${job.status} kind=${job.kind} report=${JSON.stringify(job.suiteReport ?? null).slice(0, 160)}`)
  check('⑤ 子模块被真的拉下来并装配进 profile（node_modules 里存在 + 补丁行写入）',
    compInstalled && patchText.includes('@probe/suite-comp'), `installed=${compInstalled} patchHas=${patchText.includes('@probe/suite-comp')}`)
  check('⑤ 套装路径没有误判成 notASuite', job.suiteNote === undefined || !/克隆失败/u.test(String(job.suiteNote)), String(job.suiteNote ?? '').slice(0, 120))
}

// ── 收尾 ────────────────────────────────────────────────────────────────────────────────
await new Promise((resolve) => regServer.close(resolve))
for (const s of deadSockets) { try { s.destroy() } catch {} }
await new Promise((resolve) => deadServer.close(resolve))
if (savedHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = savedHome
disposeDir(HOME)
assert.ok(pass > 0)
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
