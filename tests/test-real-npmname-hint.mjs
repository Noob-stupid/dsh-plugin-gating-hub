// 批次 C-⑪（2026-09-27）：市场索引的 npmName 字段 —— hub 侧当**首选候选**直接走 registry。
//
// 真机动机：装 zhu1090093659/dsh-web（★8032 全家桶）时，旧流程要先读仓库根 package.json（private）、
// 再展开子包，才能找到真正该装的 @linxin666/dsh-web-all（5.97 MB）—— 而本机 api.github.com 不可达，
// 这两步都做不了，最后掉进 git 通道去 clone 429 MB 的仓库（ghproxy git 协议 0 B/s）。
// 索引里带上 npmName 之后：**一个 GitHub 请求都不用发**，直接按包名从 npmmirror 装。
//
// 两段：
//   ① 离线：runInstallJob 走 hint 路径时不得调用任何 GitHub 探测（省掉"探测 + 展开"），且禁 git；
//   ② 真网络：用 hub 自己的 curl 通道真装 @linxin666/dsh-web-all（走 npmmirror），
//      落地体积与 registry 元数据的 dist.unpackedSize 对得上（≈5.97 MiB）。
import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInstallJob } from '../lib/server/domain/install-job.js'
import { curlManualInstall } from '../lib/server/domain/install.js'
import { npmNameHintForRepo } from '../lib/server/domain/market.js'
import { measureDirBytes } from '../lib/server/domain/repoland.js'
import { disposeDir } from '../lib/server/infra/fsx.js'
import { fetchJsonUrl } from '../lib/server/infra/http.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const REPO = 'zhu1090093659/dsh-web'
const AGG = '@linxin666/dsh-web-all'
const HOME = join(tmpdir(), `dsh-npmname-${process.pid}`)
const PROFILE = join(HOME, 'profiles', 'web')
disposeDir(HOME)
mkdirSync(PROFILE, { recursive: true })
writeFileSync(join(PROFILE, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }, null, 2), 'utf8')
writeFileSync(join(PROFILE, 'cordis.patch.yml'), '# npmname\n', 'utf8')
writeFileSync(join(PROFILE, 'cordis.yml'), 'plugins: []\n', 'utf8')
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })

// 把仓库里真实的 marketplace/index.json 当作 hub 拉到的索引写进落盘缓存（与 routes/market.js 落盘同形）
const indexJson = JSON.parse(readFileSync(fileURLToPath(new URL('../marketplace/index.json', import.meta.url)), 'utf8'))
const entry = indexJson.items.find((it) => it.fullName === REPO)
check('★ 仓库里的 marketplace/index.json 已带 npmName（索引生成侧已补）',
  entry !== undefined && entry.npmName === AGG, JSON.stringify(entry?.npmName ?? null))
writeFileSync(join(HOME, 'plugin-console-market-index-cache.json'), JSON.stringify({ at: Date.now(), sourceName: 'jsDelivr CDN', data: indexJson }), 'utf8')

// ── ① npmNameHintForRepo：读落盘索引缓存（老索引无该字段 → null，行为不变）──────────────
{
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = HOME
  try {
    check('★ 命中：zhu1090093659/dsh-web → @linxin666/dsh-web-all',
      npmNameHintForRepo(REPO) === AGG, String(npmNameHintForRepo(REPO)))
    check('大小写不敏感、容忍 .git 后缀', npmNameHintForRepo('Zhu1090093659/DSH-Web.git') === AGG)
    check('没收录的仓库 → null（不猜）', npmNameHintForRepo('octocat/Hello-World') === null)
    check('老索引（无 npmName 字段）→ null（行为与改动前完全一致）',
      npmNameHintForRepo(REPO, { readFile: () => JSON.stringify({ data: { items: [{ fullName: REPO }] } }) }) === null)
    check('缓存文件缺失/损坏 → null（不抛）',
      npmNameHintForRepo(REPO, { cacheFile: join(HOME, 'nope.json') }) === null
      && npmNameHintForRepo(REPO, { readFile: () => '{ bad json' }) === null)
    check('★ 索引里 npmName 非法（外部数据）→ 拒绝，不拿它去拼命令',
      npmNameHintForRepo(REPO, { readFile: () => JSON.stringify({ data: { items: [{ fullName: REPO, npmName: '@linxin666/dsh-web-all; rm -rf /' }] } }) }) === null)
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
  }
}

// ── ② runInstallJob 走 hint 路径：不调用任何 GitHub 探测、不试 git ────────────────────
{
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = HOME
  const probeCalls = []
  const channelCalls = []
  const installChannels = {
    raceInstallChannels: async () => { channelCalls.push('race'); return null },
    pnpmInstall: async (dir, spec, registry, timeoutMs) => {
      if (String(spec).startsWith('git+') || String(spec).startsWith('github:')) { channelCalls.push(`git:${spec}`); throw new Error('桩：git 不该被调用') }
      channelCalls.push(`pnpm:${spec}:${timeoutMs ?? 'default'}`)
      throw new Error('桩：registry 404（本段只验证候选选择与"不碰 GitHub"）')
    },
    curlManualInstall: async () => { channelCalls.push('curl'); throw new Error('桩：curl 404') },
    githubReleaseInstall: async () => { channelCalls.push('release'); throw new Error('桩：release 没命中') },
    backfillMissingDeps: async () => [],
  }
  const ports = {
    baseUrl: pathToFileURL(join(PROFILE, 'cordis.yml')).href,
    loader: { entries: () => [{ id: 'include', options: { name: 'cordis:include', group: true, config: { path: pathToFileURL(join(PROFILE, 'cordis.yml')).href } } }] },
    get: (n) => (n === 'installChannels' ? installChannels : undefined),
  }
  const job = {
    id: 'job-npmname', repo: REPO, source: 'github', packageName: null, status: 'installing', stage: 'preparing',
    error: null, startedAt: Date.now(), finishedAt: null, entryId: null, bundle: false, ai: false, aiNote: null,
    subpackages: null, lastError: null, update: false, kind: 'plugin',
  }
  try {
    await runInstallJob(job, ports, {
      jobBudgetMs: 20000,
      aiConsentTimeoutMs: 300,
      marketProbes: {
        // 任何 GitHub 探测被调用都要记账（下面断言"一次都没有"）
        fetchRepoPackage: async () => { probeCalls.push('fetchRepoPackage'); return null },
        fetchRepoPackageEx: async () => { probeCalls.push('fetchRepoPackageEx'); return { pkg: null, reason: 'not-found' } },
        fetchSubpackageNames: async () => { probeCalls.push('fetchSubpackageNames'); return [] },
        subpackageCandidates: async () => { probeCalls.push('subpackageCandidates'); return [] },
        expandSubpackages: async () => { probeCalls.push('expandSubpackages'); return [] },
      },
    })
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
  }
  console.log(`INFO 通道调用顺序：${channelCalls.join(' → ')}`)
  console.log(`INFO GitHub 探测调用：${probeCalls.length === 0 ? '（一次都没有）' : probeCalls.join('、')}`)
  check('★ npmName 被当作首选候选（job.npmNameHint / job.packageName）',
    job.npmNameHint === AGG && job.packageName === AGG, `${job.npmNameHint} / ${job.packageName}`)
  check('★ 第一跳的 pnpm 就是聚合包本身（race 之后直接按名装，不再先探测再展开）',
    channelCalls.find((c) => c.startsWith('pnpm:'))?.startsWith(`pnpm:${AGG}`) === true, channelCalls.join(' → '))
  check('★ 全程没有调用任何 GitHub 探测（省掉"探测根包 + 展开子包"，本机 api.github.com 不可达也能走通）',
    probeCalls.length === 0, probeCalls.join('、'))
  check('★ 没有一次 git 调用（真机 429 MB 巨仓不会被碰）',
    !channelCalls.some((c) => c.startsWith('git:')), channelCalls.filter((c) => c.startsWith('git:')).join(' | '))
  check('面板可见的说明：索引给出首选候选 / 已跳过 git 通道',
    (job.channelNotes ?? []).some((n) => n.includes('市场索引给出首选候选') && n.includes(AGG))
    && (job.channelNotes ?? []).some((n) => n.includes('已跳过 git 克隆通道')),
    JSON.stringify(job.channelNotes ?? []))
}

// ── ③ 真网络：用 hub 自己的 curl 通道真装 @linxin666/dsh-web-all（走 npmmirror）────────
if (process.env.DSH_TEST_SKIP_NETWORK === '1') {
  console.log('SKIP ③ 真网络安装（DSH_TEST_SKIP_NETWORK=1）')
} else {
  const registries = ['https://registry.npmmirror.com']
  let meta = null
  try { meta = await fetchJsonUrl(`${registries[0]}/@linxin666%2Fdsh-web-all`, 20000) } catch {}
  const latest = meta?.['dist-tags']?.latest ?? null
  const expectedBytes = latest === null ? null : meta?.versions?.[latest]?.dist?.unpackedSize ?? null
  check('③ registry 元数据可达（npmmirror）', latest !== null, `latest=${latest} unpackedSize=${expectedBytes}`)
  if (latest !== null) {
    const t = Date.now()
    let info = null
    let err = null
    try { info = await curlManualInstall(PROFILE, AGG, registries) } catch (error) { err = error }
    const ms = Date.now() - t
    const installedDir = join(PROFILE, 'node_modules', '@linxin666', 'dsh-web-all')
    const installedBytes = existsSync(installedDir) ? measureDirBytes(installedDir) : 0
    console.log(`INFO 真装 ${AGG}@${info?.version ?? '?'}：${(ms / 1000).toFixed(1)} 秒，落地 ${installedBytes} B（registry 声明 ${expectedBytes} B ≈ ${(Number(expectedBytes) / 1048576).toFixed(2)} MiB）`)
    check('★ 真装成功（走 npmmirror，hub 的 curl 通道）', info !== null && info.version === latest, err === null ? `v${info?.version}` : String(err?.message).slice(0, 160))
    check('★ 落地体积与 registry 的 unpackedSize 对得上（≈5.97 MiB，不是 429 MB 的巨仓）',
      expectedBytes !== null && Math.abs(installedBytes - expectedBytes) / expectedBytes < 0.05, `${installedBytes} vs ${expectedBytes}`)
    check('★ 下载摘要校验有结论（verifyTarballDigest：拿到摘要就比对）',
      info?.integrity !== undefined && info.integrity !== null, JSON.stringify(info?.integrity ?? null))
    check('安装耗时在可接受范围（<120 秒，5.97 MiB 走国内镜像）', ms < 120000, `${(ms / 1000).toFixed(1)} 秒`)
  }
}

disposeDir(HOME)
assert.ok(pass > 0)
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
