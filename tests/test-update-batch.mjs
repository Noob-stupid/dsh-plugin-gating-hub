// issue #22 ①：已安装列表的「一键检测全部更新」—— 批量更新检测的唯一实现（全离线）
//
// 用户的正式建议（issue #22 ①）：`familyCheckUpdate` 只覆盖全家桶内部，单独装的第三方插件要逐个点卡片上的
// 「检测更新」；市场 tab 的批量版本比对只在市场页生效，已安装列表看不到汇总。
//
// 这一套钉四件事（每件都对应一个**已经发生过**的失败形状）：
//   ① **判据不分叉**：批量入口不许自己比版本，必须走单卡那条唯一实现（probePackageUpdate →
//      dropStaleUpdateCandidates + pickUpdateTarget → infra/semver.js 的 `<<<update-pick>>>` 块）。
//      付过代价：0.5.37「反向更新/降级按钮」（tests/test-update-version-pick.mjs 是那颗钉子）。
//   ② **并发有上限**：0.5.84 市场富化并发 100 把网络打满、安装作业被拖死 —— 批量检测绝不能重演。
//      而且上限必须是**进程一份**（不是每个调用点各写一份，否则连点两次 = 两倍并发）。
//   ③ **不谎报**：单包失败只影响它自己，且如实标 status:'unknown'（未检测到）——"没查到"≠"已最新"。
//   ④ **同结论**：同一份 registry 元数据下，单卡 /check-update 与批量 /check-updates 对同一个包给出
//      同一个 target；镜像 latest 低于已装时两边都**不提示降级**（真机 2026-10-03 的现场）。
//
// 另含一颗本轮**改错**的钉子（⑤-b）：`probePackageUpdate` 的 migrate（换名检测）过去必抛
// `ReferenceError: profileDir is not defined`，被 `catch {}` 吞掉 ⇒ `migrate` 恒为 null。这里用正控钉住。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HERE = dirname(fileURLToPath(import.meta.url))
// 隔离的 DSH_HOME + 桩 profile：不碰真实 profile、不依赖本机装了什么
const HOME = join(ROOT, '.testdir', 'update-batch-home')
process.env.DSH_HOME = HOME
rmSync(HOME, { recursive: true, force: true })
const PROFILE = join(HOME, 'profiles', 'web')
mkdirSync(PROFILE, { recursive: true })
writeFileSync(join(PROFILE, 'cordis.patch.yml'), '# fixture\n', 'utf8')
const cordisUrl = pathToFileURL(join(PROFILE, 'cordis.yml')).href

const packageDir = (name) => join(PROFILE, 'node_modules', ...(name.startsWith('@') ? name.split('/') : [name]))
function installFakePackage(name, manifest) {
  const dir = packageDir(name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, ...manifest }, null, 2)}\n`, 'utf8')
}

const ctx = {
  baseUrl: cordisUrl,
  loader: { entries: () => [{ id: 'include', options: { name: 'cordis:include', group: true, config: { path: cordisUrl } } }] },
  webServer: { register: () => () => {} },
  effect: (fn) => { try { fn() } catch {} return () => {} },
}

const { BATCH_UPDATE_CONCURRENCY, batchStatusOf, createBatchUpdater } = await import('../lib/server/domain/update-batch.js')
const { routeCheckUpdates } = await import('../lib/server/routes/update-batch.js')
const { routeCheckUpdate, probePackageUpdate } = await import('../lib/server/routes/framework.js')
const { pickUpdateTarget } = await import('../lib/server/domain/update-candidates.js')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

// ── 通用桩：registry 元数据（离线）─────────────────────────────────────────────
/** table: { '包名': { tags: {latest,next,beta}, versions: {ver: pkg} } | 'throw' } —— 其余 URL 一律抛错 */
function makeRegistryStub(table) {
  const calls = []
  const fetchJson = async (url) => {
    calls.push(String(url))
    const text = String(url)
    if (text.startsWith('https://registry.npmmirror.com/')) {
      const name = decodeURIComponent(text.slice('https://registry.npmmirror.com/'.length))
      const entry = table[name]
      if (entry === 'throw' || entry === undefined) throw new Error(`stub: registry 404（${name}）`)
      return { 'dist-tags': entry.tags ?? {}, versions: entry.versions ?? {} }
    }
    // GitHub release / jsDelivr 通道：这一套不测它们（抛错 = 回退不可用，路径照旧）
    throw new Error(`stub: 通道不可用（${text}）`)
  }
  return { fetchJson, calls }
}
const depsOf = (stub) => ({ fetchJson: stub.fetchJson, currentFrameworkVersion: () => '0.2.1-rc.2' })

const fakeRes = () => {
  const res = { status: 0, body: null }
  res.writeHead = (status) => { res.status = status }
  res.end = (payload) => { res.body = payload }
  return res
}
const callRoute = async (handler, body, deps) => {
  const res = fakeRes()
  await handler({ method: 'POST', url: '/x', headers: {} }, res, { ctx, deps, body, url: new URL('http://x/x'), pathname: '/x', method: 'POST' })
  return { status: res.status, json: res.body === null ? null : JSON.parse(res.body) }
}

// ── ① 判据不分叉（静态：谁都不许再写一份版本比较）─────────────────────────────────
console.log('\n=== ① 判据不分叉：批量入口只调用唯一实现，自己不比版本 ===')
{
  const domainSrc = readFileSync(join(HERE, '..', 'lib', 'server', 'domain', 'update-batch.js'), 'utf8')
  const routeSrc = readFileSync(join(HERE, '..', 'lib', 'server', 'routes', 'update-batch.js'), 'utf8')
  const frameworkSrc = readFileSync(join(HERE, '..', 'lib', 'server', 'routes', 'framework.js'), 'utf8')
  const semverSrc = readFileSync(join(HERE, '..', 'lib', 'server', 'infra', 'semver.js'), 'utf8')
  const codeOf = (src) => src.replace(/\/\/[^\n]*/gu, '').replace(/\/\*[\s\S]*?\*\//gu, '')

  check('① 批量执行器（domain）里没有任何版本比较（无 parseInt / split(\'.\') / localeCompare）',
    !/parseInt|split\('\.'\)|localeCompare|major|minor/u.test(codeOf(domainSrc)),
    codeOf(domainSrc).match(/parseInt|split\('\.'\)|localeCompare|major|minor/u)?.[0] ?? undefined)
  check('① 批量路由**没有**自己算 target（只调 pickUpdateTarget 这个既有出口）',
    routeSrc.includes("import { installedVersionOf, pickUpdateTarget } from '../domain/update-candidates.js'")
    && routeSrc.includes('pickUpdateTarget({ latest: r.latest, next: r.next, beta: r.beta })'),
  )
  check('① 批量路由的每个包都走**单卡那条唯一实现**（import probePackageUpdate from ./framework.js）',
    /import \{ probePackageUpdate \} from '\.\/framework\.js'/u.test(routeSrc)
    && routeSrc.includes('probePackageUpdate(packageName, rc, { fetchJson: rc.deps.fetchJson })'),
  )
  check('① ★ 单卡 /check-update 与批量共用同一个探针（旧实现是就地写在 handler 里）',
    /async function probePackageUpdate\(packageName, rc, options = \{\}\)/u.test(frameworkSrc)
    && frameworkSrc.includes('const { latest, next, beta, depsOutdated, error, source, migrate } = await probePackageUpdate(packageName, rc, { fetchJson: rc.deps.fetchJson })'),
  )
  check('① 探针内部仍是唯一判据：先净化陈旧候选、再由调用方取 target（字段名一个没变）',
    frameworkSrc.includes(";({ latest, next, beta } = dropStaleUpdateCandidates({ latest, next, beta }, packageName, ctx.baseUrl ?? 'file:///', profileDirOf(ctx)))")
    && frameworkSrc.includes('sendJson(res, 200, { ok: true, packageName, latest, next, beta, target: pickUpdateTarget({ latest, next, beta }), depsOutdated, error, source, migrate })'),
  )
  check('① 唯一判据块仍只有一份（infra/semver.js 里 pickNewerSemver 单一定义）',
    (semverSrc.match(/function pickNewerSemver\(/gu) ?? []).length === 1)
  check('① 批量领域模块复用既有计数限流器（makeLimiter），不另造一个',
    /import \{ makeLimiter \} from '\.\/enrich-throttle\.js'/u.test(domainSrc)
    && !/function makeLimiter|class .*Limiter/u.test(domainSrc))
  // ★ 变异验证抓到的一条**假绿**（本轮自查）：最初这里只断言"路由调用了唯一实现"，
  //   于是把 probe 调用换成"自己写一段 latest 比大小"时，⑤ 的运行期断言虽红、却没有一条**判据性**的
  //   源码断言指出"路由里不该有版本数学"。补上这条（与 domain 那条同口径）。
  check('① 批量**路由**里也没有版本数学（无 parseInt / split(\'.\') / localeCompare / major / minor）',
    !/parseInt|split\('\.'\)|localeCompare|major|minor/u.test(codeOf(routeSrc)),
    codeOf(routeSrc).match(/parseInt|split\('\.'\)|localeCompare|major|minor/u)?.[0] ?? undefined)
}

// ── ② 并发上限是**绝对值 4**（不是"不超过常量"这种自指断言）────────────────────────
console.log('\n=== ② 并发上限：钉死 4（0.5.84 富化打满网络之后的实测结论）===')
{
  // ★ 变异验证抓到的第二条**假绿**：最初断言写成 `peak <= BATCH_UPDATE_CONCURRENCY`，
  //   把常量从 4 改成 20 时测试**照样绿**（自己跟自己比）。上限必须作为**绝对事实**钉住。
  check('② 并发上限常量就是 4（把它调大 ⇒ 这条红）', BATCH_UPDATE_CONCURRENCY === 4, String(BATCH_UPDATE_CONCURRENCY))
}

// ── ② 并发上限（真跑：峰值不得超过上限，且所有包都必须被查到）───────────────────
console.log('\n=== ② 并发上限：4 条封顶、不丢包 ===')
{
  const TOTAL = 20
  const LIMIT = 4 // ★ 绝对上限（不引用被测常量：引用它就成了"自己跟自己比"的假绿）
  let active = 0
  let peak = 0
  const seen = []
  const updater = createBatchUpdater({ concurrency: LIMIT, ttlMs: 0 })
  const names = Array.from({ length: TOTAL }, (_, i) => `batch-pkg-${i}`)
  const result = await updater.run(names, {
    probe: async (name) => {
      active += 1
      if (active > peak) peak = active
      seen.push(name)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return { latest: '1.0.1', next: null, beta: null, target: '1.0.1', error: null, source: 'npm' }
    },
  })
  check(`② 并发峰值 ≤ 上限（实测峰值 ${peak}，上限 ${LIMIT}）`, peak <= LIMIT, `peak=${peak}`)
  check('② 并发真的跑起来了（峰值 > 1；否则"没超上限"是串行的假绿）', peak > 1, `peak=${peak}`)
  check('② 峰值确实顶到了上限（4 —— 证明限流器在跑，而不是碰巧只有 1 条）', peak === LIMIT, `peak=${peak}`)
  check(`② 一个包都没漏（${TOTAL} 个全查到，且不重复）`,
    result.checked === TOTAL && seen.length === TOTAL && new Set(seen).size === TOTAL,
    `checked=${result.checked} seen=${seen.length}`)
  check('② 结果顺序 = 请求顺序（前端可以按序号对卡片）',
    result.items.every((item, i) => item.packageName === names[i]))
  check('② 全部可更新 ⇒ updatable 计数正确、unknown=0',
    result.updatable === TOTAL && result.unknown === 0)
}

// ── ②-b 上限是"进程一份"：连点两次不许变成两倍并发 ───────────────────────────────
console.log('\n=== ②-b 闸门是共享的：两个 run 同时跑，峰值仍不超上限 ===')
{
  let active = 0
  let peak = 0
  const updater = createBatchUpdater({ concurrency: 4, ttlMs: 0 })
  const probeOf = (tag) => async () => {
    active += 1
    if (active > peak) peak = active
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    return { latest: null, next: null, beta: null, target: null, error: null, source: 'npm', tag }
  }
  const namesA = Array.from({ length: 8 }, (_, i) => `share-a-${i}`)
  const namesB = Array.from({ length: 8 }, (_, i) => `share-b-${i}`)
  await Promise.all([updater.run(namesA, { probe: probeOf('a') }), updater.run(namesB, { probe: probeOf('b') })])
  check('②-b ★ 两个并发 run 共用同一个闸门（峰值 ≤ 4 —— "每个调用点各写一份"就会变 8）',
    peak <= 4, `peak=${peak}`)
}

// ── ③ 结论缓存（60s）+ force 越过缓存 ─────────────────────────────────────────
console.log('\n=== ③ 缓存：TTL 内复用、过期重查、force 越过 ===')
{
  let clock = 1000
  let probes = 0
  const updater = createBatchUpdater({ concurrency: 2, ttlMs: 60000, now: () => clock })
  const io = { probe: async () => { probes += 1; return { latest: '2.0.0', next: null, beta: null, target: '2.0.0', error: null, source: 'npm' } } }
  const first = await updater.run(['cache-pkg'], io)
  const second = await updater.run(['cache-pkg'], io)
  check('③ 第一次真查（cached:false）', first.items[0].cached === false && probes === 1, `probes=${probes}`)
  check('③ TTL 内第二次**不发请求**（cached:true，探针计数不变）',
    second.items[0].cached === true && probes === 1, `probes=${probes}`)
  clock += 61000
  const third = await updater.run(['cache-pkg'], io)
  check('③ 过期后重新查（cached:false，探针计数 +1）', third.items[0].cached === false && probes === 2, `probes=${probes}`)
  const forced = await updater.run(['cache-pkg'], { ...io, force: true })
  check('③ force:true 越过缓存（刚查过也重查）', forced.items[0].cached === false && probes === 3, `probes=${probes}`)
}

// ── ④ 三态判据 + 单包失败隔离 ─────────────────────────────────────────────────
console.log('\n=== ④ 三态（update/current/unknown）与失败隔离 ===')
{
  check('④ 有 target ⇒ update', batchStatusOf({ target: '1.2.0', error: null }) === 'update')
  check('④ 有候选但无更高版本 ⇒ current', batchStatusOf({ latest: '1.0.0', target: null, error: null }) === 'current')
  check('④ 无候选且无错误 ⇒ current（真的查过、没有新版）', batchStatusOf({ latest: null, next: null, beta: null, error: null }) === 'current')
  check('④ ★ 无候选且有错误 ⇒ unknown（没查到 ≠ 已最新）', batchStatusOf({ latest: null, error: 'ECONNRESET' }) === 'unknown')
  check('④ 空值/垃圾输入不抛（null ⇒ current 而不是崩）', batchStatusOf(null) === 'current' && batchStatusOf(undefined) === 'current')

  const updater = createBatchUpdater({ concurrency: 4, ttlMs: 0 })
  const result = await updater.run(['ok-pkg', 'boom-pkg', 'flat-pkg'], {
    probe: async (name) => {
      if (name === 'boom-pkg') throw new Error('registry 挂了')
      if (name === 'flat-pkg') return { latest: '1.0.0', next: null, beta: null, target: null, error: null, source: 'npm' }
      return { latest: '1.0.1', next: null, beta: null, target: '1.0.1', error: null, source: 'npm' }
    },
  })
  const byName = Object.fromEntries(result.items.map((i) => [i.packageName, i]))
  check('④ 一个包抛错不拖垮其余（三个都回来了）', result.items.length === 3, `got=${result.items.length}`)
  check('④ 抛错的包 ⇒ unknown + 带原因（不静默、不冒充已最新）',
    byName['boom-pkg'].status === 'unknown' && String(byName['boom-pkg'].error).includes('registry 挂了'))
  check('④ 其余两包结论正确（update / current）',
    byName['ok-pkg'].status === 'update' && byName['flat-pkg'].status === 'current')
  check('④ updatable / unknown 汇总与逐项一致',
    result.updatable === 1 && result.unknown === 1, `updatable=${result.updatable} unknown=${result.unknown}`)
}

// ── ⑤ 路由层：入参校验 + 真跑一次（桩 registry）+ 与单卡同结论 ────────────────────
console.log('\n=== ⑤ 路由 /check-updates：校验、结论、与单卡一致 ===')
installFakePackage('@fake/updatable', { version: '1.0.0' })
installFakePackage('@fake/stale-mirror', { version: '2.0.0-rc.2' })   // 镜像 latest 更低 = 真机 0.5.37 现场
installFakePackage('@fake/broken', { version: '1.0.0' })
const stub = makeRegistryStub({
  '@fake/updatable': { tags: { latest: '1.2.0' }, versions: { '1.2.0': {} } },
  '@fake/stale-mirror': { tags: { latest: '1.1.0-rc.1' }, versions: { '1.1.0-rc.1': {} } },
  '@fake/broken': 'throw',
})
const deps = depsOf(stub)

{
  const noBody = await callRoute(routeCheckUpdates, {}, deps)
  check('⑤ 不传 packageNames ⇒ 400 且带可读原因（不是 500）',
    noBody.status === 400 && String(noBody.json?.error).includes('packageNames'), JSON.stringify(noBody.json)?.slice(0, 120))
  const badName = await callRoute(routeCheckUpdates, { packageNames: ['ok-pkg', 'not a package!'] }, deps)
  check('⑤ 非法包名 ⇒ 400 且点名是哪个',
    badName.status === 400 && String(badName.json?.error).includes('not a package!'), JSON.stringify(badName.json)?.slice(0, 140))
  const empty = await callRoute(routeCheckUpdates, { packageNames: [] }, deps)
  check('⑤ 空数组 ⇒ 200 + 明说"没有需要检测的插件"（绝不造一个"全部已最新"）',
    empty.status === 200 && empty.json?.checked === 0 && typeof empty.json?.note === 'string', JSON.stringify(empty.json)?.slice(0, 120))
  const tooMany = await callRoute(routeCheckUpdates, { packageNames: Array.from({ length: 201 }, (_, i) => `p${i}`) }, deps)
  check('⑤ 超过上限 ⇒ 400（不许一次把 registry 拉一遍）', tooMany.status === 400, `status=${tooMany.status}`)

  const ok = await callRoute(routeCheckUpdates, { packageNames: ['@fake/updatable', '@fake/stale-mirror', '@fake/broken'], force: true }, deps)
  const byName = Object.fromEntries((ok.json?.items ?? []).map((i) => [i.packageName, i]))
  check('⑤ 正常批量 ⇒ 200，三项都在，顺序 = 请求顺序',
    ok.status === 200 && ok.json.ok === true && (ok.json.items ?? []).length === 3
    && ok.json.items[0].packageName === '@fake/updatable',
    `status=${ok.status} items=${(ok.json?.items ?? []).length}`)
  check('⑤ ★ 有新版 ⇒ status=update 且 target=1.2.0（target 来自唯一判据）',
    byName['@fake/updatable']?.status === 'update' && byName['@fake/updatable']?.target === '1.2.0',
    JSON.stringify(byName['@fake/updatable']))
  check('⑤ ★ 镜像 latest 低于已装（2.0.0-rc.2 vs 1.1.0-rc.1）⇒ 不给 target、status=current（不提示降级）',
    byName['@fake/stale-mirror']?.target === null && byName['@fake/stale-mirror']?.status === 'current',
    JSON.stringify(byName['@fake/stale-mirror']))
  check('⑤ registry 抛错 ⇒ status=unknown 且 error 非空（"没查到"不冒充"已最新"）',
    byName['@fake/broken']?.status === 'unknown' && String(byName['@fake/broken']?.error ?? '') !== '',
    JSON.stringify(byName['@fake/broken'])?.slice(0, 160))
  check('⑤ installedVersion 如实下发（来自 profile 里真实的 package.json）',
    byName['@fake/updatable']?.installedVersion === '1.0.0' && byName['@fake/stale-mirror']?.installedVersion === '2.0.0-rc.2',
    `${byName['@fake/updatable']?.installedVersion} / ${byName['@fake/stale-mirror']?.installedVersion}`)
  check('⑤ 汇总字段与逐项一致（checked/updatable/unknown）',
    ok.json.checked === 3 && ok.json.updatable === 1 && ok.json.unknown === 1,
    `checked=${ok.json.checked} updatable=${ok.json.updatable} unknown=${ok.json.unknown}`)
  check('⑤ 每项都带 cached 标记（前端能说清这是新查的还是复用的）',
    (ok.json.items ?? []).every((i) => typeof i.cached === 'boolean'))
  check('⑤ stats 里能读出并发上限与单次包数上限（诊断留痕，两个上限不撞名）',
    ok.json.stats?.concurrencyLimit === BATCH_UPDATE_CONCURRENCY && ok.json.stats?.maxPackages === 200
    && ok.json.stats?.max === undefined,
    JSON.stringify(ok.json.stats)?.slice(0, 160))

  // ★ 同结论对拍：同一份元数据，单卡 /check-update 与批量给**同一个 target**
  const single = await callRoute(routeCheckUpdate, { packageName: '@fake/updatable' }, deps)
  check('⑤ ★ 单卡与批量对同一个包给出同一个 target（判据只有一份）',
    single.json?.target === byName['@fake/updatable']?.target && single.json?.target === '1.2.0',
    `single=${single.json?.target} batch=${byName['@fake/updatable']?.target}`)
  const singleStale = await callRoute(routeCheckUpdate, { packageName: '@fake/stale-mirror' }, deps)
  check('⑤ ★ 单卡同样不提示降级（latest 更低 ⇒ 净化成 null、target=null）',
    singleStale.json?.latest === null && singleStale.json?.target === null && singleStale.json?.ok === true,
    JSON.stringify(singleStale.json)?.slice(0, 160))
}

// ── ⑤-b 改错钉子：migrate（换名检测）真的回得来（旧代码恒 null）────────────────────
console.log('\n=== ⑤-b 换名检测（migrate）：旧代码必抛 ReferenceError ⇒ 恒 null ===')
{
  installFakePackage('@fake/renamed-old', { version: '0.1.0', dsh: { migrate: { to: '@fake/renamed-new' } } })
  const migrateStub = makeRegistryStub({
    '@fake/renamed-old': { tags: { latest: '0.1.0' }, versions: { '0.1.0': {} } },
    '@fake/renamed-new': { tags: { latest: '1.0.0' }, versions: { '1.0.0': { engines: { dsh: '>=0.2.0' } } } },
  })
  const r = await probePackageUpdate('@fake/renamed-old', { ctx, deps: depsOf(migrateStub) }, { fetchJson: migrateStub.fetchJson })
  check('⑤-b ★ 声明了 dsh.migrate.to 的包必须真的回 migrate（旧实现因 profileDir 出作用域恒为 null）',
    r.migrate !== null && r.migrate.to === '@fake/renamed-new' && r.migrate.latest === '1.0.0',
    JSON.stringify(r.migrate))
  check('⑤-b migrate.engine 与 compatible 如实（框架 0.2.1-rc.2 按宽松匹配满足 >=0.2.0）',
    r.migrate?.engine === '>=0.2.0' && r.migrate?.compatible === true, JSON.stringify(r.migrate))
  const noMigrate = await probePackageUpdate('@fake/updatable', { ctx, deps }, { fetchJson: stub.fetchJson })
  check('⑤-b 没声明迁移的包 migrate 仍为 null（负控：不凭空造）', noMigrate.migrate === null, JSON.stringify(noMigrate.migrate))
}

// ── ⑥ 本机化纪律：本轮新增/改动文件里 0 处本机绝对路径 / 用户名 ────────────────────
console.log('\n=== ⑥ 本机化纪律 ===')
{
  const CHANGED = [
    'tests/test-update-batch.mjs',
    'lib/server/domain/update-batch.js',
    'lib/server/routes/update-batch.js',
  ]
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const userName = home === '' ? '' : home.split(/[\\/]/u).pop()
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const asPath = (s) => new RegExp(`(?:[\\\\/]|[A-Za-z]:|\\$HOME[\\\\/]|~[\\\\/])${esc(s)}`, 'u')
  const BANNED = [
    { name: '本机用户名（路径位置，原样）', re: userName.length < 2 ? null : asPath(userName) },
    { name: '本机家目录明文', re: home === '' ? null : new RegExp(home.replace(/[\\/]/gu, '[\\\\/]').replace(/[.*+?^${}()|[\]\\]/gu, (m) => (m === '\\' || m === '/' ? m : `\\${m}`)), 'u') },
    { name: '本次工作副本绝对路径', re: new RegExp(ROOT.replace(/[\\/]/gu, '[\\\\/]').replace(/[.*+?^${}()|[\]\\]/gu, (m) => (m === '\\' || m === '/' ? m : `\\${m}`)), 'u') },
  ].filter((b) => b.re !== null)
  const hits = []
  for (const rel of CHANGED) {
    readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/u).forEach((line, i) => {
      for (const b of BANNED) if (b.re.test(line)) hits.push(`${rel}:${i + 1} ${b.name}`)
    })
  }
  check(`⑥ ★ 本轮文件里本机绝对路径 / 用户名 0 出现（扫 ${CHANGED.length} 个文件）`,
    hits.length === 0, hits.slice(0, 5).join(' | ') || undefined)
}

console.log(failed === 0 ? '\nALL PASS（批量更新检测：并发封顶 / 判据一份 / 不谎报 / 与单卡同结论）' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
