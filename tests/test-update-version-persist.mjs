// 0.5.87 回归钉子：**带版本的更新必须真的落到那个版本**（全离线，桩通道 + 临时 DSH_HOME）
//
// 真机缺陷（2026-10-18，用户实测 + 父任务确认的现场）：
//   点「更新并适配」`@deepseek-ai/dsh-experimental-auto-review`（0.1.6-alpha.1 → 0.2.1-rc.2），
//   请求体显式带 `version: "0.2.1-rc.2"`；作业跑完**报 done / version=0.2.1-rc.2 / error=null**，
//   而 `node_modules/<包>/package.json` 与 profile `dependencies` **都还是 0.1.6-alpha.1**。
//   根因（两半，缺一不可）：
//     ① 按名下载的那条通道（curl）**从来没拿到版本号** —— 它按 `dist-tags.latest` 下载，
//        而该包在镜像上的 latest 恰好就是旧版（rc 版从不打 latest）⇒ 旧版被原样铺回去；
//     ② 通道说"装上了"之后**没人核对落地版本**是否等于请求点名的版本 ⇒ 旧版被当成更新成功。
//
// 本套断言（★ = 缺了就会让真机缺陷复发的那几条）：
//   ① ★ 正控（通道层）：点名版本时，curl 拿到的是**裸包名 + 目标版本**（不是 `pkg@version`、也不是不传）；
//      竞速里的 pnpm 腿拿到带版本规格、curl 腿拿到裸包名 + 目标版本；pnpm 每次调用都是 `pkg@version`。
//   ② ★ 正控（整条作业 runInstallJob）：更新成功后**三处一致** —— 磁盘版本=目标、清单 dependencies
//      =目标版本号、lock 里也是目标版本；且 `job.version=目标` 与 `job.installedVersion=目标` 不再混为一谈。
//   ③ ★ 负控（红线）：正常 registry 下载安装/更新的整条流水线**绝不产出 `link:` / `file:`**
//      （清单、lock、`<DSH_HOME>/plugin-src` 三处都扫）；镜像元数据滞后（探测 404）也不许把
//      "我们刚从 registry 下载成功的那一版"改写成 link:（registryProven）。
//   ④ ★ 负控（不许谎报）：通道装回来的**不是**目标版本时 —— 作业必须 failed、错误里点名"目标版本/实际版本"、
//      清单与磁盘**一个字节都不许动**（不清场、不改清单），且绝无 `persisted:true`。
//   ⑤ 源码级防回退：三条回归点的写法在源码里确实存在（改回去就红）。
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SANDBOX = join(ROOT, '.testdir', 'update-version-persist')
rmSync(SANDBOX, { recursive: true, force: true })
const HOME = join(SANDBOX, 'home')
const PROFILE = join(HOME, 'profiles', 'desktop')
mkdirSync(PROFILE, { recursive: true })
// 私有 DSH_HOME：本套只碰这个沙箱，绝不读写用户真实 profile（硬规矩⑩）
process.env.DSH_HOME = HOME

const PKG = '@deepseek-ai/dsh-experimental-auto-review'
const OLD = '0.1.6-alpha.1'
const TARGET = '0.2.1-rc.2'
const tarballFor = (v) => `https://registry.npmmirror.com/${PKG}/-/${PKG.split('/')[1]}-${v}.tgz`

const { installJobView, raceInstallChannels } = await import('../lib/server/domain/install.js')
const { tryCandidateChannels, RELEASE_CHANNEL_BUDGET } = await import('../lib/server/domain/install-channels.js')
const { runInstallJob } = await import('../lib/server/domain/install-job.js')
const { targetVersionOf, versionMissOf, versionMissText } = await import('../lib/server/domain/install-version.js')
const { planDependencySpec, declareProfileDependency } = await import('../lib/server/domain/manifest.js')
const { finalizeInstallPersistence } = await import('../lib/server/domain/install-finalize.js')
const { lockVersion } = await import('../lib/server/domain/selfupdate.js')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

// ── 夹具：一个像真 profile 的最小现场（清单 / lock / 补丁行 / 已装副本）────────────────
function pkgDir(dir = PROFILE) { return join(dir, 'node_modules', ...PKG.split('/')) }
function seedInstalled(version, dir = PROFILE) {
  const target = pkgDir(dir)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), `${JSON.stringify({ name: PKG, version, main: 'index.js' }, null, 2)}\n`, 'utf8')
  writeFileSync(join(target, 'index.js'), 'export default {}\n', 'utf8')
}
function lockText(version) {
  return 'lockfileVersion: \'9.0\'\n\nimporters:\n\n  .:\n    dependencies:\n'
    + `      '${PKG}':\n        specifier: ${version}\n        version: ${version}\n`
}
function writeProfile(version) {
  rmSync(PROFILE, { recursive: true, force: true })
  mkdirSync(PROFILE, { recursive: true })
  writeFileSync(join(PROFILE, 'package.json'), `${JSON.stringify({
    name: 'persist-fixture-profile', private: true, dependencies: { [PKG]: version },
  }, null, 2)}\n`, 'utf8')
  // 挂载行（③）：补丁里有它的 insert 行 —— 收口这一步不该再写第二行
  writeFileSync(join(PROFILE, 'cordis.patch.yml'),
    `- insert:\n    - id: experimental-auto-review\n      name: '${PKG}'\n`, 'utf8')
  writeFileSync(join(PROFILE, 'pnpm-lock.yaml'), lockText(version), 'utf8')
  seedInstalled(version)
}
const depsOf = (dir = PROFILE) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies ?? {}
const installedOf = (dir = PROFILE) => JSON.parse(readFileSync(join(pkgDir(dir), 'package.json'), 'utf8')).version

// ── 桩通道：真实通道的**契约**照抄（curl 按 exactVersion ?? latest 下载并铺盘）──────────
function makeChannels({ curlDelivers = TARGET, record }) {
  return {
    // 竞速：pnpm 腿与 curl 腿都失败（真机现场：pnpm 卡到 120 秒封顶、curl 腿拿到带版本的规格必然 404）
    raceInstallChannels: async (dir, spec, registries, impls, opts) => {
      record.push({ ch: 'race', spec, opts })
      return null
    },
    pnpmInstall: async (dir, spec) => {
      record.push({ ch: 'pnpm', spec })
      throw new Error('桩：pnpm add 超时/404（真机现场 90 秒×2 都失败）')
    },
    curlManualInstall: async (dir, name, registries, signal, exactVersion) => {
      record.push({ ch: 'curl', name, exactVersion })
      // 真通道语义：给了 exactVersion 就下载那一版，否则取 dist-tags.latest（本例 latest 仍是旧版）
      const version = typeof exactVersion === 'string' && exactVersion !== '' ? exactVersion : OLD
      const delivered = curlDelivers === 'exactVersion' ? version : curlDelivers
      seedInstalled(delivered, dir)
      return { version: delivered, missingDeps: [], sourceSpec: tarballFor(delivered), integrity: { ok: true }, boxNote: null }
    },
    githubReleaseInstall: async () => {
      record.push({ ch: 'release' })
      throw new Error('桩：release 通道不该被走到（前面已经"装上了"）')
    },
    backfillMissingDeps: async () => [],
  }
}

/** 桩 ports：只提供 domain 层真正用到的那三样（profileDir 由 loader 的 include 行推导）。 */
function makePorts(channels) {
  return {
    baseUrl: 'file:///',
    get: (key) => (key === 'installChannels' ? channels : null),
    loader: {
      entries: () => [{
        id: 'include',
        options: { name: 'cordis:include', group: true, config: { path: pathToFileURL(join(PROFILE, 'cordis.yml')).href } },
      }],
    },
  }
}

/** 离线 persist 注入：registry 探测桩（可解析/404）+ lock 写入桩（写进夹具的 lock 文本）。 */
const probeOk = async (name, registries, options = {}) => ({ resolvable: true, hasVersion: true, latest: options.version ?? null, registry: 'stub', tried: [] })
const probe404 = async () => ({ resolvable: false, hasVersion: false, latest: null, registry: null, tried: ['桩：HTTP 404 Not Found'] })
function makePersistDeps({ probe = probeOk, lockWrites = true } = {}) {
  return {
    // 真实写入器 + 只替换"registry 可解析性探测"（离线）
    declare: (dir, name, version, opts = {}) => declareProfileDependency(dir, name, version, { ...opts, probe, syncLock: false }),
    // lock 写入桩：真 pnpm 才会写 lock；这里只钉"收口确实把 lock 对齐这一步走了一遍 + 结果被读回"
    reconcile: async ({ profileDir, packages = [] }) => {
      const row = packages[0] ?? { name: PKG }
      const version = depsOf(profileDir)[row.name] ?? installedOf(profileDir)
      if (lockWrites) writeFileSync(join(profileDir, 'pnpm-lock.yaml'), lockText(version), 'utf8')
      return { lockUpdated: true, lockVersion: version, method: 'stub', packages, lockNote: null, depNote: null, lockVerified: true }
    },
    installSource: async () => ({ ok: false, spec: tarballFor(TARGET), error: '桩：不发起真装' }),
  }
}

// ── ① 通道层：版本号一路传到底（★ 真机根因的那一行）────────────────────────────────
{
  const record = []
  writeProfile(OLD)
  const ch = makeChannels({ record })
  const job = { id: 'u1', repo: '', packageName: PKG, source: 'github', update: true, version: TARGET }
  const res = await tryCandidateChannels({
    job, ch, name: PKG, profileDir: PROFILE, registries: ['https://registry.fake'],
    repoChannelAllowed: true, budget: { release: RELEASE_CHANNEL_BUDGET }, expanded: true, deadline: null,
  })
  const pnpmCalls = record.filter((r) => r.ch === 'pnpm')
  const race = record.find((r) => r.ch === 'race')
  const curl = record.find((r) => r.ch === 'curl')
  check('① ★ curl 通道拿到的是**裸包名**（不是 `pkg@版本` —— 对 curl 那是非法包名）',
    curl !== undefined && curl.name === PKG, JSON.stringify(curl))
  check('① ★ curl 通道拿到了**目标版本** exactVersion（旧代码这里是 undefined ⇒ 按 latest 下旧版）',
    curl !== undefined && curl.exactVersion === TARGET, JSON.stringify(curl))
  check('① 竞速通道的 pnpm 腿拿到带版本规格、curl 腿拿到裸包名+目标版本',
    race !== undefined && race.spec === `${PKG}@${TARGET}` && race.opts?.packageName === PKG && race.opts?.exactVersion === TARGET,
    JSON.stringify(race))
  check('① 每一次 pnpm 都是 `pkg@version`（重试/清场重试都不得退回裸包名）',
    pnpmCalls.length > 0 && pnpmCalls.every((c) => c.spec === `${PKG}@${TARGET}`),
    JSON.stringify(pnpmCalls.map((c) => c.spec)))
  check('① 通道层结果：装上了，且没有版本闸告警',
    res.installedName === PKG && job.versionMiss === undefined && installedOf() === TARGET,
    JSON.stringify({ installedName: res.installedName, versionMiss: job.versionMiss ?? null, disk: installedOf() }))
}

// ── ② 整条作业：更新成功后**三处一致**（磁盘 / 清单 / lock）──────────────────────────
{
  const record = []
  writeProfile(OLD)
  const ch = makeChannels({ record, curlDelivers: 'exactVersion' })
  const job = { id: 'u2', repo: '', source: 'github', packageName: PKG, status: 'installing', stage: 'preparing', update: true, version: TARGET }
  await runInstallJob(job, makePorts(ch), { persistDeps: makePersistDeps() })
  const view = installJobView(job)
  check('② ★ 作业成功', job.status === 'done', `${job.status} / ${String(job.error ?? '').slice(0, 160)}`)
  check('② ★ 磁盘版本 = 目标版本', installedOf() === TARGET, installedOf())
  check('② ★ 清单 dependencies = 目标版本号（不是 link:/file:、也不是旧版）',
    depsOf()[PKG] === TARGET, JSON.stringify(depsOf()))
  check('② ★ lock 里有对应条目且是目标版本', lockVersion(PROFILE, PKG) === TARGET, String(lockVersion(PROFILE, PKG)))
  check('② 持久化判据通过（三处齐备）', job.persisted === true && job.persist?.missing?.length === 0,
    JSON.stringify({ persisted: job.persisted, missing: job.persist?.missing }))
  check('② 目标版本与落地版本分开下发：version=目标、installedVersion=目标、versionMiss 为空',
    view.version === TARGET && view.installedVersion === TARGET && view.versionMiss === null,
    JSON.stringify({ version: view.version, installedVersion: view.installedVersion, versionMiss: view.versionMiss }))
  // ③ 红线（正向那一半）：正常 registry 下载安装/更新**不产出** link: / file:
  const manifestText = readFileSync(join(PROFILE, 'package.json'), 'utf8')
  const lockTextNow = readFileSync(join(PROFILE, 'pnpm-lock.yaml'), 'utf8')
  const srcDir = join(HOME, 'plugin-src')
  check('③ ★ 负控（红线）：清单里没有 link:/file:', !/"(?:link|file):/u.test(manifestText), depsOf()[PKG])
  // 只认**依赖规格位置**上的 link:/file:（pnpm 自己会写 `excludeLinksFromLockfile: false` —— 那是设置项，不是规格）
  check('③ ★ 负控（红线）：lock 里没有 link:/file: 规格',
    !/(?:specifier|version):\s*(?:link|file):/u.test(lockTextNow), lockTextNow.split(/\r?\n/u).filter((l) => /link:|file:/u.test(l)).slice(0, 2).join(' | '))
  check('③ ★ 负控（红线）：没有把包物化到 plugin-src（link: 路径的伴生物）',
    !existsSync(srcDir) || !existsSync(join(srcDir, ...PKG.split('/'))), srcDir)
}

// ── ③-c lock 对账**不许谎报**「写回未生效」（真机 E2E 2026-10-18 抓到的那条）───────────────
// 现象：更新真的写对了（清单 = lock = 目标版本），面板却提示「写回**未生效**，请执行「钉住」动作」，
// 还挂上一个 pin 动作 —— 因为对账拿 `name@版本`（给 pnpm 的完整规格）去比清单里的**版本号**。
{
  writeProfile(TARGET)
  writeFileSync(join(PROFILE, 'pnpm-lock.yaml'), lockText(OLD), 'utf8') // lock 陈旧 ⇒ 必须真的对账一次
  const { reconcileLockfile } = await import('../lib/server/domain/selfupdate.js')
  const lock = await reconcileLockfile({
    profileDir: PROFILE,
    packages: [{ name: PKG }],
    registries: ['https://registry.fake'],
    // 桩：pnpm add 的**唯一**可观察结果就是 lock 被写成目标版本（真 pnpm 由 test-real-* 那一组覆盖）
    pnpmAdd: async () => { writeFileSync(join(PROFILE, 'pnpm-lock.yaml'), lockText(TARGET), 'utf8') },
    // 桩：registry 元数据（目标版本确实存在 ⇒ 写版本号，而不是来源型/link:）
    fetchJson: async () => ({ versions: { [OLD]: {}, [TARGET]: {} }, 'dist-tags': { latest: TARGET } }),
  })
  check('③-c 对账真的跑了一次（method=pnpm-add、lock 已更新）',
    lock.lockUpdated === true && lock.method === 'pnpm-add' && lockVersion(PROFILE, PKG) === TARGET,
    JSON.stringify({ lockUpdated: lock.lockUpdated, method: lock.method, lock: lockVersion(PROFILE, PKG) }))
  check('③-c ★ 清单写对了就**不许**说"写回未生效"（旧代码在这里谎报并给出多余动作）',
    !/写回\*\*未生效/u.test(String(lock.depNote ?? '')) && (lock.suggestedActions ?? []).length === 0,
    JSON.stringify({ depNote: String(lock.depNote ?? '').slice(0, 200), suggested: lock.suggestedActions ?? [] }))
  check('③-c 收口判据仍是"已持久化"（三处齐备）',
    (await import('../lib/server/domain/persist.js')).persistReport({ profileDir: PROFILE, patchPath: join(PROFILE, 'cordis.patch.yml'), packageName: PKG, entries: [] }).persisted === true)
}

// ── ③-b 负控（红线）的尖牙：镜像元数据滞后（探测 404）也不许写成 link: ──────────────────
{
  writeProfile(TARGET)
  // 同一个场景两种判据：不带 registryProven（旧行为）⇒ 计划里是**来源型规格**；
  // 带 registryProven（我们从 registry 下载成功）⇒ 计划里是**版本号**。
  const url = tarballFor(TARGET)
  const before = await planDependencySpec({ profileDir: PROFILE, packageName: PKG, version: TARGET, probe: probe404, sourceSpec: url })
  const after = await planDependencySpec({ profileDir: PROFILE, packageName: PKG, version: TARGET, probe: probe404, sourceSpec: url, registryProven: true })
  check('③-b 旧判据（无 registryProven）确实会把"下载成功的版本"写成来源型规格（这条是钉子成立的前提）',
    before.form === 'source', JSON.stringify({ form: before.form, spec: before.spec }))
  check('③-b ★ registry 下载成功的包：探测 404 也按**版本号**写回（绝不 link:/本地副本）',
    after.form === 'version' && after.spec === TARGET, JSON.stringify({ form: after.form, spec: after.spec }))
  check('③-b 该判据同时说清理由（面板可见，不静默）',
    typeof after.note === 'string' && after.note.includes('从 registry 实际下载成功') && !/link:/u.test(after.spec ?? ''),
    String(after.note))
  // 收口层接线：sourceKind==='registry-tarball' ⇒ 自动置位 registryProven（端到端走一遍真写入器）
  const job = { id: 'u3', packageName: PKG, source: 'github', version: TARGET }
  const persistDeps = makePersistDeps({ probe: probe404 })
  // 把清单改回旧版，让收口必须重写一次（磁盘是新版）
  writeFileSync(join(PROFILE, 'package.json'), `${JSON.stringify({ name: 'persist-fixture-profile', private: true, dependencies: { [PKG]: OLD } }, null, 2)}\n`, 'utf8')
  await finalizeInstallPersistence({
    job, profileDir: PROFILE, patchPath: join(PROFILE, 'cordis.patch.yml'), packageName: PKG, mode: 'insert',
    taken: new Set(), entries: [], registries: ['https://registry.fake'],
    source: { spec: url, origin: 'sampled', kind: 'registry-tarball' }, deps: persistDeps,
  })
  check('③-b ★ 收口层把 registryProven 传下去了：清单写成版本号（探测 404 也没写 link:/URL）',
    depsOf()[PKG] === TARGET, JSON.stringify({ manifest: depsOf()[PKG] ?? null }))
  check('③-b 三处仍齐备（清单/lock/挂载行）', job.persisted === true, JSON.stringify({ persisted: job.persisted, missing: job.persist?.missing }))
}

// ── ④ 负控：通道装回来的不是目标版本 ⇒ 如实失败，清单与磁盘一个字节都不许动 ────────────────
{
  const record = []
  writeProfile(OLD)
  const manifestBefore = readFileSync(join(PROFILE, 'package.json'), 'utf8')
  const lockBefore = readFileSync(join(PROFILE, 'pnpm-lock.yaml'), 'utf8')
  // 真机现场的重演：curl 装了 dist-tags.latest（=旧版）回来，且它**自己认为成功了**
  const ch = makeChannels({ record, curlDelivers: OLD })
  const job = { id: 'u4', repo: '', source: 'github', packageName: PKG, status: 'installing', stage: 'preparing', update: true, version: TARGET }
  await runInstallJob(job, makePorts(ch), { persistDeps: makePersistDeps(), aiConsentTimeoutMs: 30 })
  const view = installJobView(job)
  check('④ ★ 不许谎报成功：作业必须是 failed（旧代码在这里报 done）', job.status === 'failed', `${job.status}`)
  check('④ ★ 错误里点名目标版本与真实落地的版本',
    typeof job.error === 'string' && job.error.includes(TARGET) && job.error.includes(OLD), String(job.error).slice(0, 400))
  check('④ ★ 版本闸的结构化结论：expected=目标、actual=旧版、channel=curl',
    job.versionMiss?.expected === TARGET && job.versionMiss?.actual === OLD && job.versionMiss?.channel === 'curl',
    JSON.stringify(job.versionMiss))
  check('④ ★ 清单一个字节都没动（不写坏、不改旧版声明）',
    readFileSync(join(PROFILE, 'package.json'), 'utf8') === manifestBefore, depsOf()[PKG])
  check('④ lock 一个字节都没动', readFileSync(join(PROFILE, 'pnpm-lock.yaml'), 'utf8') === lockBefore)
  check('④ ★ 盘上旧版被原样保留（失败路径清场会把它删掉 —— 那才是真损失）',
    existsSync(pkgDir()) && installedOf() === OLD, String(existsSync(pkgDir()) ? installedOf() : 'missing'))
  check('④ 绝不谎报持久化（persisted 不得为 true）', job.persisted !== true, JSON.stringify(job.persisted ?? null))
  check('④ 面板可见：installedVersion=旧版、versionMiss 一并下发（老客户端忽略新字段即可）',
    view.installedVersion === OLD && view.versionMiss?.expected === TARGET, JSON.stringify({ installedVersion: view.installedVersion }))
  check('④ 这次失败不走 AI 兜底（不是"哪一步坏了"，而是这一版现在拿不到）',
    job.aiPending === null || job.aiPending === undefined, JSON.stringify(job.aiPending ?? null))
  check('④ 通道备注里如实写了这条结论（channelNotes 里能查到）',
    Array.isArray(job.channelNotes) && job.channelNotes.some((n) => typeof n === 'string' && n.includes(TARGET) && n.includes(OLD)),
    JSON.stringify(job.channelNotes ?? []))
}

// ── ⑤ 判据自身：targetVersionOf / versionMissOf 的边界（纯函数，离线）────────────────
{
  check('⑤ 没点名版本 ⇒ 恒 null（按 latest 装的请求行为一字不变）',
    targetVersionOf({ packageName: PKG }, PKG) === null && versionMissOf(PROFILE, PKG, { packageName: PKG }) === null)
  check('⑤ 点了名的**别的包** ⇒ null（不许把父候选的版本套到展开出的子包上）',
    targetVersionOf({ packageName: PKG, version: TARGET }, '@scope/other') === null)
  check('⑤ 磁盘就是目标版本 ⇒ null（不误报）',
    versionMissOf(PROFILE, PKG, { packageName: PKG, version: OLD }) === null) // 现在盘上是 OLD
  check('⑤ 磁盘不是目标版本 ⇒ 结构化 miss，且文案点名两版',
    versionMissOf(PROFILE, PKG, { packageName: PKG, version: TARGET })?.actual === OLD
    && versionMissText(versionMissOf(PROFILE, PKG, { packageName: PKG, version: TARGET })).includes(OLD))
  check('⑤ 包根本不在盘上 ⇒ actual=null（如实说"读不到版本"，绝不编一个）',
    versionMissOf(PROFILE, '@noob-stupid/definitely-not-installed', { packageName: '@noob-stupid/definitely-not-installed', version: TARGET })?.actual === null)
}

// ── ⑥ 源码级防回退（改回旧写法就红）──────────────────────────────────────────────
{
  const channelsSrc = readFileSync(join(ROOT, 'lib', 'server', 'domain', 'install-channels.js'), 'utf8')
  const installSrc = readFileSync(join(ROOT, 'lib', 'server', 'domain', 'install.js'), 'utf8')
  const persistSrc = readFileSync(join(ROOT, 'lib', 'server', 'domain', 'persist.js'), 'utf8')
  check('⑥ ★ curl 通道带上了 exactVersion（串行腿）',
    channelsSrc.includes('ch.curlManualInstall(profileDir, name, registries, null, exactVersion)'))
  check('⑥ ★ 竞速里的 curl 腿不再吃带版本的规格（pnpm 腿吃规格、curl 腿吃包名+版本）',
    installSrc.includes('runCurl(profileDir, curlName, registries, signal, curlVersion)')
    && channelsSrc.includes('ch.raceInstallChannels(profileDir, installSpec, registries, {}, { packageName: name, exactVersion })')
    && !installSrc.includes('runCurl(profileDir, name, registries, signal)'))
  check('⑥ ★ 版本闸在位：通道声称成功之后要核对落地版本（且唯一执行点只有一处）',
    channelsSrc.includes('const missText = gateVersion(job, profileDir, installedName, lastChannel)')
    && channelsSrc.includes('function gateVersion(job, profileDir, name, channel)')
    && (channelsSrc.match(/versionMissOf\(/gu) ?? []).length === 1)
  check('⑥ ★ 失败不清场：版本没装上时作业直接如实失败（不调 cleanupAttemptedCandidates）',
    /if \(installedName === null && job\.versionMiss != null\)[\s\S]{0,900}?return/u.test(readFileSync(join(ROOT, 'lib', 'server', 'domain', 'install-job.js'), 'utf8')))
  check('⑥ ★ 收口层：registry 下载成功的包置位 registryProven',
    persistSrc.includes("sourceKind === 'registry-tarball' ? { registryProven: true }"))
}

// ── 收尾 ───────────────────────────────────────────────────────────────────
try { rmSync(SANDBOX, { recursive: true, force: true }) } catch {}
console.log(failed === 0 ? '\nALL PASS（带版本的更新必须落到那个版本；正常下载安装绝不产出 link:/file:）' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
