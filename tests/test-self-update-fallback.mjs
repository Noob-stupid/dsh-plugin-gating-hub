// 自更新**手铺兜底**的判据测试（2026-11-04 加法，纯离线）
//
// 现场（真机 2026-11-04 实测采样，用户提供的原始时间线）：
//   0.5.102 的自更新是「包管理器优先」：`pnpm update` → `pnpm add` → 才轮到手铺。pnpm 一启动就**先清空目标目录**，
//   在 profile 里重算整棵依赖树要几分钟：
//       `14:45:46 pkg=True files=160` → `14:45:56 pkg=False files=1` → 之后 9 分钟一直空着
//   ⇒ 撞 90s/180s 超时被杀，目录停在"空了"的状态；手铺兜底（第三步）压根还没轮到。
//   用户要的：pnpm 卡住/失败时**立刻**手铺，并把 `pnpm-lock.yaml` 一起补上（不补就重演"下次 pnpm 操作把版本还原"）。
//
// 本套钉死的判据（每条都要能失败；变异验证见报告）：
//   ① pnpm 成功 ⇒ **不**手铺（负控）：不覆盖、不补 lock、预下载的临时目录被清掉，且预下载发生在 pnpm **之前**
//   ② pnpm 超时 ⇒ **立刻**用手铺 tarball 铺进去（不再联网、不走"先删再铺"的 curl 通道），落地版本 = 目标版本
//   ③ 手铺之后 lock 的版本/完整性真的更新了（importer + packages + snapshots 三处，且旧版本号不再出现）
//   ④ 补 lock 失败 ⇒ 如实 `lockNote`（三种失败形态各钉一条：写不进 / 只读校验明确不通过 / 校验无法确认）
//   ⑤ 手铺也失败 ⇒ 走既有自愈路径（守卫用更新前备份恢复）+ 如实失败 + 绝对路径可运行命令，绝不报成功
//   ⑥ 手铺**不清空目录**：tarball 里没有的原有文件必须还在、内容不变；覆盖只发生在 tarball 覆盖到的文件上
//   ⑦ 非自更新包零影响：新模块只被 selfupdate.js 引用；装别的包这条路一个字节都不碰新代码
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = join(HERE, '.testdir', 'self-update-fallback')
// 隔离数据根（作业层/守卫会碰 DSH_HOME 下的东西 —— 绝不落到真实用户目录）
process.env.DSH_HOME = join(BASE, 'home')

const url = (rel) => pathToFileURL(join(HERE, '..', rel)).href
const { selfUpdateToLatest } = await import(url('lib/server/domain/selfupdate.js'))
const { tryCandidateChannels } = await import(url('lib/server/domain/install-channels.js'))

const SELF = '@noob-stupid/dsh-plugin-console'
const OLD = '0.5.100'
const TARGET = '0.5.101'
const OTHER = 'pkg-not-self-update'

let pass = 0
let fail = 0
const check = (name, ok, info = '') => {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}
const skip = (name, why) => console.log(`SKIP ${name} — ${why}`)

rmSync(BASE, { recursive: true, force: true })
mkdirSync(BASE, { recursive: true })

// ── 夹具写盘的唯一入口：路径必须先是绝对路径，否则直接抛（真事故：join('', …) 把仓库 lib/index.js 写坏了）──
function writeFixture(absPath, content) {
  const target = String(absPath ?? '')
  if (target === '' || isAbsolute(target) !== true) throw new Error(`夹具拒绝写非绝对路径：${target}`)
  if (target.startsWith(join(HERE, '..', 'lib')) && target.endsWith(join('lib', 'index.js'))) throw new Error(`夹具拒绝写插件入口：${target}`)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
}
const readOrNull = (path) => { try { return readFileSync(path, 'utf8') } catch { return null } }
const installedVersionOf = (pkgDir) => { try { return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version ?? null } catch { return null } }
const manifestVersionOf = (profileDir) => { try { return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dependencies?.[SELF] ?? null } catch { return null } }

/** 能不能用系统 tar 造/解 tarball（生产代码的手铺兜底本身就依赖 tar；没有就响亮 SKIP，不假装 PASS）。 */
function hasTar() {
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const TAR_OK = hasTar()

/** 造一个 npm 形态的 tarball：`package/package.json` + `package/lib/index.js` + 一个**只有新版才有**的文件。 */
function makeTarball(tag, { version = TARGET } = {}) {
  const work = join(BASE, 'tgz-src', tag)
  const pkgDir = join(work, 'package')
  writeFixture(join(pkgDir, 'package.json'), `${JSON.stringify({ name: SELF, version, main: './lib/index.js' }, null, 2)}\n`)
  writeFixture(join(pkgDir, 'lib', 'index.js'), 'export const ok = 2\n')
  writeFixture(join(pkgDir, 'NEWONLY.md'), '# 只有新版才有的文件\n')
  const tgz = join(BASE, 'tgz', `${tag}.tgz`)
  mkdirSync(dirname(tgz), { recursive: true })
  execFileSync('tar', ['-czf', tgz, '-C', work, 'package'], { stdio: 'ignore' })
  return { tgz, version, integrity: `sha512-${tag.toUpperCase()}NEW==` }
}

/** 真机 lock 的形态（importer + packages + snapshots 三段；键加引号才是合法 YAML —— 不带引号的 `@…` 开头会让 pnpm 报 BROKEN_LOCKFILE）。 */
function lockYaml(version, { integrity = 'sha512-OLD==' } = {}) {
  return [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    `      '${SELF}':`,
    '        specifier: ^0.5.100',
    `        version: ${version}`,
    '',
    'packages:',
    '',
    `  '${SELF}@${version}':`,
    `    resolution: {integrity: ${integrity}}`,
    '',
    'snapshots:',
    '',
    `  '${SELF}@${version}': {}`,
    '',
  ].join('\n')
}

/** 一个"已经装好旧版、宿主正在跑"的 profile：node_modules 里那份带 SECURITY.md / 哨兵文件（都不在 tarball 里）。 */
function makeProfile(tag, { selfVersion = OLD, lockVersion = OLD, spec = '^0.5.100', withSelf = true } = {}) {
  const profileDir = join(BASE, tag, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  writeFixture(join(profileDir, 'cordis.patch.yml'), '# fixture\n')
  writeFixture(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-desktop', private: true, dependencies: { [SELF]: spec } }, null, 2)}\n`)
  writeFixture(join(profileDir, 'pnpm-lock.yaml'), lockYaml(lockVersion))
  const pkgDir = join(profileDir, 'node_modules', SELF)
  if (withSelf) {
    writeFixture(join(pkgDir, 'package.json'), `${JSON.stringify({ name: SELF, version: selfVersion, main: './lib/index.js' }, null, 2)}\n`)
    writeFixture(join(pkgDir, 'lib', 'index.js'), 'export const ok = 1\n')
    writeFixture(join(pkgDir, 'SECURITY.md'), '# 旧版就有、tarball 里没有\n')
    writeFixture(join(pkgDir, 'EXTRA.sentinel'), `哨兵：${tag}\n`)
  }
  return { profileDir, pkgDir, lockFile: join(profileDir, 'pnpm-lock.yaml') }
}

/**
 * `/self-update` 的四个注入点（三条既有通道 + 新的 copyDeps）+ 一个事件序列（用来证明**先后顺序**）。
 * `copyDeps.env = {}`：本套全程离线，靠桩；不读进程里的 DSH_TEST_SKIP_NETWORK。
 */
function makeHarness({ tarball = null, meta = null, verdict = { verified: true, reason: null }, prepFails = false, downloadFails = false, junkTarball = false } = {}) {
  const events = []
  const calls = []
  const copyDeps = {
    env: {},
    tmpDir: () => {
      const dir = join(BASE, 'work')
      mkdirSync(dir, { recursive: true })
      return dir
    },
    fetchJson: async (u) => {
      events.push('meta')
      if (prepFails) throw new Error('桩：registry 不可达（ENOTFOUND registry.fake）')
      return meta ?? { 'dist-tags': { latest: TARGET }, versions: { [TARGET]: { dist: { tarball: `https://registry.fake/${tarball?.tgz ?? 'x.tgz'}`, integrity: tarball?.integrity ?? null } } } }
    },
    download: async (u, dest) => {
      events.push('download')
      if (downloadFails) throw new Error('桩：curl 超时')
      if (junkTarball) { writeFileSync(dest, '这不是一个 tar 包'); return }
      copyFileSync(tarball.tgz, dest)
    },
    extract: async (tgz, dir) => {
      events.push('extract')
      execFileSync('tar', ['-xzf', tgz, '-C', dir], { stdio: 'ignore' })
    },
    verifyLock: async () => { events.push('verify'); return verdict },
  }
  const steps = {
    events,
    calls,
    copyDeps,
    deps: {
      runPnpm: async (argv) => { events.push('pnpm-update'); calls.push(`pnpm-update:${argv.join(' ')}`) },
      pnpmAdd: async () => { events.push('pnpm-add'); calls.push('pnpm-add') },
      curlManualInstall: async () => { events.push('curl'); calls.push('curl'); throw new Error('桩：curl 通道不该被走到') },
    },
  }
  return steps
}

const runSelfUpdate = async ({ profileDir, steps, latest = TARGET, selfUpdateDeps = {} }) => selfUpdateToLatest({
  profileDir, latest, registries: ['https://registry.fake'],
  curlManualInstall: steps.deps.curlManualInstall,
  runPnpm: steps.deps.runPnpm,
  pnpmAdd: steps.deps.pnpmAdd,
  profileName: 'desktop',
  selfUpdateDeps,
  copyDeps: steps.copyDeps,
})

/** 真机那种"超时被杀"的错误形态（infra/exec.js#execFileWithKillTree 抛出来的就是这种）。 */
const timeoutError = () => {
  const error = new Error('Command failed: pnpm add @x@1.0.0\n（超时 180000ms：已终止整棵进程树 pid=4242，等待 120ms 后确认已退出）')
  error.timedOut = true
  error.killed = true
  error.timeoutMs = 180000
  return error
}
/** 让 `/self-update` 走"pnpm 那两步都失败"的现场。 */
function failingPnpmSteps(h, { landOnPnpmUpdate = null } = {}) {
  h.deps.runPnpm = async (argv) => {
    h.events.push('pnpm-update')
    h.calls.push(`pnpm-update:${argv.join(' ')}`)
    if (typeof landOnPnpmUpdate === 'function') return landOnPnpmUpdate()
    throw timeoutError()
  }
  h.deps.pnpmAdd = async () => { h.events.push('pnpm-add'); h.calls.push('pnpm-add'); throw timeoutError() }
  return h
}

if (TAR_OK !== true) skip('整套手铺断言', '系统里没有 tar（生产代码的手铺兜底同样依赖它）')

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ① pnpm 成功 ⇒ **不**手铺（负控）：不覆盖、不补 lock、临时目录清掉；预下载发生在 pnpm **之前**
// ══════════════════════════════════════════════════════════════════════════════════════════════
if (TAR_OK) {
  const { profileDir, pkgDir, lockFile } = makeProfile('su1-pnpm-ok')
  const tar = makeTarball('su1')
  const h = makeHarness({ tarball: tar })
  // pnpm update 真的把两处都装/写到目标版本（模拟包管理器正常工作）
  h.deps.runPnpm = async (argv) => {
    h.events.push('pnpm-update')
    h.calls.push(`pnpm-update:${argv.join(' ')}`)
    writeFixture(join(pkgDir, 'package.json'), `${JSON.stringify({ name: SELF, version: TARGET, main: './lib/index.js' }, null, 2)}\n`)
    writeFixture(lockFile, lockYaml(TARGET))
  }
  const before = readOrNull(join(pkgDir, 'EXTRA.sentinel'))
  const res = await runSelfUpdate({ profileDir, steps: h })
  check('① 负控：pnpm 成功时**没有**手铺（method 只有 pnpm-update，copy/lockPatch 都是 null）',
    res.method === 'pnpm-update' && res.copy === null && res.lockPatch === null,
    JSON.stringify({ method: res.method, copy: res.copy, lockPatch: res.lockPatch }))
  check('① 负控：没有解包/覆盖动作（extract 一次都没发生），目录里 tarball 以外的东西原封不动',
    h.events.includes('extract') === false && readOrNull(join(pkgDir, 'EXTRA.sentinel')) === before
    && readOrNull(join(pkgDir, 'NEWONLY.md')) === null,
    `events=${h.events.join(',')}`)
  check('① 负控：没有补 lock 的动作（verify 一次都没发生）', h.events.includes('verify') === false, h.events.join(','))
  check('① 预下载发生在 pnpm **之前**（先 meta → download，再 pnpm-update）',
    h.events.indexOf('meta') === 0 && h.events.indexOf('download') === 1 && h.events.indexOf('pnpm-update') === 2,
    h.events.join(','))
  const workLeft = existsSync(join(BASE, 'work')) ? readdirSync(join(BASE, 'work')) : []
  check('① 预下载的临时工作目录被收尾清掉（不留垃圾）', workLeft.length === 0, JSON.stringify(workLeft))
  check('① 既有字段语义不变：lockUpdated=true、lockNote=null、installedVersion=目标版本',
    res.lockUpdated === true && res.lockNote === null && res.installedVersion === TARGET && res.ok === true,
    JSON.stringify({ lockUpdated: res.lockUpdated, installed: res.installedVersion, ok: res.ok }))
  check('① tarball 现场如实上报（拿到了哪个版本、integrity 是什么）',
    res.tarball?.ok === true && res.tarball?.version === TARGET && res.tarball?.integrity === tar.integrity,
    JSON.stringify(res.tarball))
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ②③⑥ pnpm 超时 ⇒ **立刻**手铺（不再联网 / 不走先删再铺）→ 版本对 → lock 补上 → 目录没被清空
// ══════════════════════════════════════════════════════════════════════════════════════════════
if (TAR_OK) {
  const { profileDir, pkgDir, lockFile } = makeProfile('su2-timeout')
  const tar = makeTarball('su2')
  const h = failingPnpmSteps(makeHarness({ tarball: tar }))
  const sentinelBefore = readOrNull(join(pkgDir, 'EXTRA.sentinel'))
  const securityBefore = readOrNull(join(pkgDir, 'SECURITY.md'))
  const res = await runSelfUpdate({ profileDir, steps: h })

  check('② pnpm 超时后 method 记的是手铺（manual-overlay），不是 pnpm 通道',
    res.method === 'manual-overlay', String(res.method))
  check('② 落地版本 = 目标版本（读磁盘核实，不看通道自报）', installedVersionOf(pkgDir) === TARGET, String(installedVersionOf(pkgDir)))
  check('② 走的是"只覆盖文件"的那条腿（copy.channel=overlay、noClear=true），**没有**回落到先删再铺的 curl 通道',
    res.copy?.channel === 'overlay' && res.copy?.noClear === true && h.events.includes('curl') === false,
    JSON.stringify({ copy: res.copy, events: h.events }))
  check('② "立刻"：手铺发生在 pnpm 失败之后、且**没有**重新联网/重新下载（extract 前没有第二次 meta/download）',
    (() => {
      const afterAdd = h.events.slice(h.events.indexOf('pnpm-add') + 1)
      return afterAdd[0] === 'extract' && afterAdd.includes('meta') === false && afterAdd.includes('download') === false
    })(), h.events.join(','))
  check('② 守卫的 step 记录仍是既有三步（pnpm-update / pnpm-add / manual-copy），手铺那步校验通过',
    JSON.stringify((res.selfUpdate?.steps ?? []).map((row) => [row.step, row.verified]))
      === JSON.stringify([['pnpm-update', false], ['pnpm-add', false], ['manual-copy', true]]),
    JSON.stringify((res.selfUpdate?.steps ?? []).map((row) => [row.step, row.verified])))
  check('② 自更新守卫认可这次落地（verified=true / ok=true / healed=false）',
    res.selfUpdate?.verified === true && res.ok === true && res.selfUpdate?.healed === false,
    JSON.stringify({ verified: res.selfUpdate?.verified, ok: res.ok, healed: res.selfUpdate?.healed }))

  // ⑥ 手铺不清空目录：tarball 里没有的、目录里原有的文件必须还在且内容不变
  check('⑥ 手铺**没有清空目录**：原有 SECURITY.md / EXTRA.sentinel 都还在、内容逐字未变',
    readOrNull(join(pkgDir, 'SECURITY.md')) === securityBefore && readOrNull(join(pkgDir, 'EXTRA.sentinel')) === sentinelBefore,
    JSON.stringify({ security: readOrNull(join(pkgDir, 'SECURITY.md')) === securityBefore, sentinel: readOrNull(join(pkgDir, 'EXTRA.sentinel')) === sentinelBefore }))
  check('⑥ 覆盖确实发生了：tarball 里的入口文件被换成新版内容、新版独有文件出现了',
    readOrNull(join(pkgDir, 'lib', 'index.js')) === 'export const ok = 2\n' && readOrNull(join(pkgDir, 'NEWONLY.md')) !== null,
    String(readOrNull(join(pkgDir, 'lib', 'index.js'))))
  check('⑥ 如实报出"铺了几个文件、原地保留了几个"（preserved ≥ 2 是没清空目录的量化证据）',
    res.copy?.files >= 3 && res.copy?.preserved >= 2, JSON.stringify({ files: res.copy?.files, preserved: res.copy?.preserved }))

  // ③ 手铺之后 lock 必须被补到目标版本（版本 + 完整性）
  const lockText = readFileSync(lockFile, 'utf8')
  check('③ lock 的 importer 条目已到目标版本（版本 + specifier 两行都换了）',
    lockText.includes(`'${SELF}':`) && lockText.includes(`version: ${TARGET}`) && lockText.includes(`specifier: ${TARGET}`),
    lockText.split('\n').filter((l) => /specifier|version:/.test(l)).join(' | '))
  check('③ lock 的 packages 段键名与 integrity 都换到目标版本（旧 integrity 绝不能被挂到新版本号下）',
    lockText.includes(`'${SELF}@${TARGET}':`) && lockText.includes(`resolution: {integrity: ${tar.integrity}}`) && lockText.includes('sha512-OLD==') === false,
    lockText.split('\n').filter((l) => /resolution/.test(l)).join(' | '))
  check('③ lock 的 snapshots 段键名也到目标版本（三段一起走，不留半改）',
    lockText.includes(`'${SELF}@${TARGET}': {}`) && lockText.includes(`${SELF}@${OLD}:`) === false,
    lockText.split('\n').filter((l) => l.includes(SELF)).join(' | '))
  check('③ 回的既有字段：lockUpdated=true / lockVersion=目标版本 / lockNote=null',
    res.lockUpdated === true && res.lockVersion === TARGET && res.lockNote === null,
    JSON.stringify({ lockUpdated: res.lockUpdated, lockVersion: res.lockVersion, lockNote: res.lockNote }))
  check('③ 新增字段 lockPatch 如实报出改了什么 + 只读校验通过',
    res.lockPatch?.changed === true && res.lockPatch?.integrityWritten === true && res.lockPatch?.verified === true
    && res.lockPatch?.renamed?.packages === true && res.lockPatch?.renamed?.snapshots === true,
    JSON.stringify(res.lockPatch))
  check('③ 清单 spec 也跟到目标版本（否则下一次 pnpm 操作会按清单降级）', manifestVersionOf(profileDir) === TARGET, String(manifestVersionOf(profileDir)))
  check('③ note 里说清了"只覆盖没清空"和"lock 已补齐"，用户看得见', String(res.note).includes('没有清空目录') && String(res.note).includes('pnpm-lock.yaml 已补齐'),
    String(res.note))
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ④ 补 lock 失败 ⇒ 如实 lockNote（三种形态：写不进 / 只读校验明确不通过 ⇒ 回滚 / 校验无法确认）
// ══════════════════════════════════════════════════════════════════════════════════════════════
if (TAR_OK) {
  // ④a 写入器报"写不进"
  {
    const { profileDir, pkgDir } = makeProfile('su4a-write-fail')
    const tar = makeTarball('su4a')
    const h = failingPnpmSteps(makeHarness({ tarball: tar }))
    h.copyDeps.writeLock = async () => ({ changed: false, unchanged: false, reason: '桩：lock 形态不认识（没有 importers 段），已跳过定点写入' })
    const res = await runSelfUpdate({ profileDir, steps: h })
    check('④a 写入器拒绝 ⇒ lockUpdated=false 且 lockNote 如实说"未写入 pnpm-lock.yaml"',
      installedVersionOf(pkgDir) === TARGET && res.lockUpdated === false
      && typeof res.lockNote === 'string' && res.lockNote.includes('未写入 pnpm-lock.yaml') && res.lockNote.includes(OLD),
      String(res.lockNote).slice(0, 160))
    check('④a 把"补 lock 未成功"的原始原因同时写进 lockPatch.reason 与 errors（不静默）',
      typeof res.lockPatch?.reason === 'string' && res.lockPatch.reason.includes('lock 形态不认识')
      && res.errors.some((e) => String(e).includes('补 pnpm-lock.yaml 未成功')),
      JSON.stringify({ reason: res.lockPatch?.reason, errors: res.errors }))
    check('④a 但**没有谎报**更新成功到 lock 那一步（note 里带的是"未写入"口径）',
      String(res.note).includes('未写入 pnpm-lock.yaml') || String(res.note).includes('未补齐'),
      String(res.note).slice(0, 160))
  }
  // ④b 只读校验明确不通过 ⇒ 把 lock 还原成改动前，按未补上处理
  {
    const { profileDir, pkgDir, lockFile } = makeProfile('su4b-verify-false')
    const tar = makeTarball('su4b')
    const h = failingPnpmSteps(makeHarness({ tarball: tar, verdict: { verified: false, reason: '桩：ERR_PNPM_BROKEN_LOCKFILE（bad indentation）' } }))
    const lockBefore = readOrNull(lockFile)
    const res = await runSelfUpdate({ profileDir, steps: h })
    check('④b pnpm 只读校验明确不通过 ⇒ lock 被**逐字还原**成改动前（绝不留下 pnpm 会拒绝的 lock）',
      readOrNull(lockFile) === lockBefore && res.lockPatch?.rolledBack === true,
      JSON.stringify({ rolledBack: res.lockPatch?.rolledBack, same: readOrNull(lockFile) === lockBefore }))
    check('④b 如实报"未补上"（lockUpdated=false + lockNote 给出原因与可复制命令）',
      res.lockUpdated === false && typeof res.lockNote === 'string' && res.lockNote.includes('未写入 pnpm-lock.yaml')
      && res.lockNote.includes('dsh plugin --profile'),
      String(res.lockNote).slice(0, 200))
    check('④b 校验结论进了 lockPatch.verified=false（不假装确认过）', res.lockPatch?.verified === false && String(res.lockPatch?.verifyNote).includes('BROKEN_LOCKFILE'),
      JSON.stringify({ verified: res.lockPatch?.verified, note: res.lockPatch?.verifyNote }))
  }
  // ④c 只读校验**无法确认**（pnpm 跑不起来）⇒ 不回滚，但 note 里必须写"无法确认"
  {
    const { profileDir, pkgDir, lockFile } = makeProfile('su4c-verify-null')
    const tar = makeTarball('su4c')
    const h = failingPnpmSteps(makeHarness({ tarball: tar, verdict: { verified: null, reason: '桩：pnpm 执行方式不可用（无法确认）' } }))
    const res = await runSelfUpdate({ profileDir, steps: h })
    check('④c 无法确认时**不回滚**（lock 文本已按目标版本写好，rollback 不触发）',
      res.lockPatch?.rolledBack === false && readFileSync(lockFile, 'utf8').includes(`version: ${TARGET}`),
      JSON.stringify({ rolledBack: res.lockPatch?.rolledBack }))
    check('④c 但 note 明说"无法确认"，lockPatch.verified=null（绝不把无法确认说成通过）',
      res.lockPatch?.verified === null && String(res.note).includes('无法确认'),
      JSON.stringify({ verified: res.lockPatch?.verified, note: res.note }))
    check('④c lockUpdated 仍按"lock 文本真的到目标版本"如实为 true（不是靠校验结论冒充）',
      res.lockUpdated === true && res.lockVersion === TARGET && res.lockPatch?.integrityWritten === true,
      JSON.stringify({ lockUpdated: res.lockUpdated, lockVersion: res.lockVersion }))
  }
  // ④d 没有目标版本的完整性摘要（registry 元数据缺 dist.integrity）⇒ 只补 importer，packages/snapshots 一个字节都不动
  {
    const { profileDir, pkgDir, lockFile } = makeProfile('su4d-no-integrity')
    const tar = makeTarball('su4d')
    const h = failingPnpmSteps(makeHarness({
      tarball: tar,
      meta: { 'dist-tags': { latest: TARGET }, versions: { [TARGET]: { dist: { tarball: `https://registry.fake/${tar.tgz}` } } } },
    }))
    const res = await runSelfUpdate({ profileDir, steps: h })
    const lockText = readFileSync(lockFile, 'utf8')
    check('④d 没有完整性摘要 ⇒ 只补 importer（版本落地），**不**把旧 integrity 挂到新版本号上',
      lockText.includes(`version: ${TARGET}`) && lockText.includes(`'${SELF}@${OLD}':`) && lockText.includes('sha512-OLD==') === true
      && res.lockPatch?.integrityWritten === false && res.lockPatch?.renamed?.packages === false,
      lockText.split('\n').filter((l) => /@0\.5\.10|integrity|version:/.test(l)).join(' | '))
    check('④d 如实说明"那两段为什么没改"（lockPatch.note），且不把它当成失败（reason=null / lockUpdated=true）',
      /没有该版本的完整性摘要/.test(String(res.lockPatch?.note ?? '')) && res.lockPatch?.reason === null && res.lockUpdated === true,
      JSON.stringify({ note: res.lockPatch?.note, reason: res.lockPatch?.reason, lockUpdated: res.lockUpdated }))
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ⑤ 手铺也失败 ⇒ 走既有自愈（更新前备份恢复）+ 如实失败 + 绝对路径命令，绝不报成功
// ══════════════════════════════════════════════════════════════════════════════════════════════
if (TAR_OK) {
  // ⑤a 预下载的 tarball 是垃圾（解包失败）+ 既有 curl 通道也失败 ⇒ 两条腿都断
  {
    const { profileDir, pkgDir } = makeProfile('su5a-no-copy')
    const tar = makeTarball('su5a')
    const h = failingPnpmSteps(makeHarness({ tarball: tar, junkTarball: true }))
    const before = readOrNull(join(pkgDir, 'SECURITY.md'))
    const res = await runSelfUpdate({ profileDir, steps: h })
    check('⑤a 手铺也失败 ⇒ 绝不报成功（ok=false + reason 说清"自更新没有完成"）',
      res.ok === false && String(res.reason).includes('自更新没有完成'), JSON.stringify({ ok: res.ok, reason: String(res.reason).slice(0, 120) }))
    check('⑤a 走既有自愈路径：守卫从更新前的备份恢复（healed=true / selfHeal.restored=true），版本回到旧版',
      res.selfUpdate?.healed === true && res.selfUpdate?.selfHeal?.restored === true && installedVersionOf(pkgDir) === OLD,
      JSON.stringify({ healed: res.selfUpdate?.healed, version: installedVersionOf(pkgDir) }))
    check('⑤a 目录内容也恢复成更新前那一份（SECURITY.md 逐字相同）', readOrNull(join(pkgDir, 'SECURITY.md')) === before)
    check('⑤a 给出的是**绝对路径**、可直接复制运行的手动命令',
      typeof res.selfUpdate?.manualCommand === 'string' && res.selfUpdate.manualCommand.includes(profileDir),
      String(res.selfUpdate?.manualCommand))
    check('⑤a copy.channel=null 且 reason 如实说覆盖失败（不伪装成"走过了手铺"）',
      res.copy?.channel === null && typeof res.copy?.reason === 'string' && res.copy.reason.includes('覆盖文件失败'),
      JSON.stringify(res.copy))
    check('⑤a 没写到 lock（自愈后 lock 仍是旧版本，没有半改的痕迹）',
      res.lockUpdated === false && readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8') === lockYaml(OLD),
      String(res.lockUpdated))
  }
  // ⑤b 预下载就没成（registry 不可达）+ 既有 curl 通道也失败 ⇒ 与 0.5.102 的失败路径一致，只是多了 tarball 现场
  {
    const { profileDir, pkgDir } = makeProfile('su5b-no-tarball')
    const tar = makeTarball('su5b')
    const h = failingPnpmSteps(makeHarness({ tarball: tar, prepFails: true }))
    const res = await runSelfUpdate({ profileDir, steps: h })
    check('⑤b 预下载失败 ⇒ tarball.ok=false 且 reason 如实（"只记下来"，不影响后续通道）',
      res.tarball?.ok === false && typeof res.tarball?.reason === 'string' && res.tarball.reason.includes('registry'),
      JSON.stringify(res.tarball))
    check('⑤b 覆盖没得可用 ⇒ copy.channel=null、方法里没有 manual-overlay（回落到既有 curl 通道且失败了）',
      res.copy?.channel === null && String(res.method ?? '').includes('manual-overlay') === false,
      JSON.stringify({ method: res.method, copy: res.copy }))
    check('⑤b 仍然如实失败 + 自愈（ok=false / healed=true）', res.ok === false && res.selfUpdate?.healed === true,
      JSON.stringify({ ok: res.ok, healed: res.selfUpdate?.healed }))
    check('⑤b 预下载失败**不**污染成功路径的 errors 之外的东西（既有字段语义不变：lockUpdated=false）',
      res.lockUpdated === false && installedVersionOf(pkgDir) === OLD, JSON.stringify({ lockUpdated: res.lockUpdated, version: installedVersionOf(pkgDir) }))
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ⑦ 非自更新包零影响：新模块只被 selfupdate.js 引用；装别的包这条路一个字节都不碰新代码
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const serverFiles = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) serverFiles.push(full)
    }
  }
  walk(join(HERE, '..', 'lib', 'server'))
  const importersOf = (needle) => serverFiles.filter((p) => readFileSync(p, 'utf8').includes(needle)).map((p) => p.replace(join(HERE, '..'), '').replace(/\\/gu, '/'))
  const copyImporters = importersOf("selfupdate-copy.js'")
  const readImporters = importersOf("selfupdate-read.js'")
  check('⑦ 静态接线：新模块 selfupdate-copy.js 只被 domain/selfupdate.js 引用（别的通道一个字节都不经过它）',
    copyImporters.length === 1 && copyImporters[0] === '/lib/server/domain/selfupdate.js', JSON.stringify(copyImporters))
  check('⑦ 静态接线：selfupdate-read.js 只被 selfupdate.js（+ 自身、lock-importer 无关）引用',
    readImporters.length === 1 && readImporters[0] === '/lib/server/domain/selfupdate.js', JSON.stringify(readImporters))
  const callSites = serverFiles.filter((p) => readFileSync(p, 'utf8').includes('await prepareSelfUpdateTarball(')).map((p) => p.replace(join(HERE, '..'), '').replace(/\\/gu, '/'))
  check('⑦ 静态接线：预下载 tarball 只在 selfupdate.js 里被调用（不是通用安装通道的一部分）',
    callSites.length === 1 && callSites[0] === '/lib/server/domain/selfupdate.js', JSON.stringify(callSites))

  // 运行时：装**别的包**这条路照旧（pnpm 腿成功即收工），profile 的 lock / 清单一个字节都不动
  const profileDir = join(BASE, 'other-pkg', 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  writeFixture(join(profileDir, 'cordis.patch.yml'), '# fixture\n')
  writeFixture(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-desktop', private: true, dependencies: { [OTHER]: '^1.0.0' } }, null, 2)}\n`)
  writeFixture(join(profileDir, 'pnpm-lock.yaml'), lockYaml(OLD))
  const lockBefore = readOrNull(join(profileDir, 'pnpm-lock.yaml'))
  const manifestBefore = readOrNull(join(profileDir, 'package.json'))
  const touched = []
  const ch = {
    raceInstallChannels: async () => null,
    pnpmInstall: async (dir, spec) => { touched.push(`pnpm:${spec}`); return undefined },
    curlManualInstall: async () => { touched.push('curl'); throw new Error('桩：不该走到 curl') },
    githubReleaseInstall: async () => { touched.push('release'); throw new Error('桩：不该走到 release') },
    backfillMissingDeps: async () => [],
  }
  const job = { id: 'job-other', repo: '', packageName: OTHER, source: 'github', update: true, version: null }
  const result = await tryCandidateChannels({
    job, ch, name: OTHER, profileDir, registries: ['https://registry.fake'],
    repoChannelAllowed: false, budget: { release: 0 }, expanded: true, deadline: null,
  })
  check('⑦ 运行时：装别的包仍由 pnpm 腿装上（通道顺序与判据不变）',
    result?.installedName === OTHER && touched.some((t) => t === `pnpm:${OTHER}`), JSON.stringify({ result: result?.installedName, touched }))
  check('⑦ 运行时：别的包这条路没有产生自更新专属现场（copy / tarball / lockPatch 都不出现）',
    job.copy === undefined && job.tarball === undefined && job.lockPatch === undefined,
    JSON.stringify({ copy: job.copy, tarball: job.tarball, lockPatch: job.lockPatch }))
  check('⑦ 运行时：profile 的 lock 与清单一个字节都没被碰', readOrNull(join(profileDir, 'pnpm-lock.yaml')) === lockBefore && readOrNull(join(profileDir, 'package.json')) === manifestBefore)
}

const summary = `\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`
// 用写入回调把最后一屏刷出去再退出（直接 process.exit 在 Windows 上会截断重定向的最后几行）
process.stdout.write(`${summary}\n`, () => process.exit(fail === 0 ? 0 : 1))
