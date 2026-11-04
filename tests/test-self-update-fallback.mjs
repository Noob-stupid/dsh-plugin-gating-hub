// 自更新**不走包管理器**的判据测试（2026-11-04 重写，纯离线）
//
// 现场（真机 2026-11-04 采样，8 秒粒度；用户原话「全面修复这个，不行就把这个插件更新改为之前的版本」）：
//   18:31:26  pkg=True  ver=0.5.103  files=165  bak=0
//   18:32:31  pkg=False files=1      bak=1  pnpm=1   ← 备份刚建好，pnpm 一启动就把目标目录清空了
//   18:32:39  pkg=False files=1      bak=0           ← 备份 8 秒后被收尾段删掉（它以为更新成功了）
//   18:37:30 / 18:38:11 / 18:41:25   pnpm 两轮，每轮 3~9 分钟，都被超时杀
//   18:43:48  仍是空壳（1 文件）                       ← 排在 pnpm 后面的"手铺兜底"一次都没轮到
//   ⇒ 只要 pnpm 参与自更新，它就**先清空目标目录**；本机 pnpm 必被超时杀 ⇒ 目录一直空着。
//   结论（用户拍板）：自更新**彻底不走 pnpm**，改回"下载 tarball + 覆盖解包"。
//
// 本套钉死的判据（每条都要能失败；变异验证见报告）：
//   Ⓐ ★ 自更新全程**不启动任何 pnpm**（运行时计数 === 0 + 静态调用点 === 0；这条是本轮最重要的断言）
//   Ⓑ 正常路径：下载 → 只覆盖 → 版本回读 === 目标 → lock 补上 → ok:true，且 method=manual-overlay
//   Ⓒ 覆盖前目录里已有、**不在 tarball 里**的文件必须还在（preserved 计数 + 逐字内容）
//   Ⓓ 下载失败 ⇒ 如实失败 + 从更新前备份恢复 + 绝对路径可运行命令（绝不报成功）
//   Ⓔ 覆盖失败（垃圾 tarball）⇒ 同样自愈 + 如实报 reason
//   Ⓕ lock 补不上 ⇒ 如实 lockNote，**不谎报**；且默认**不启动 pnpm** 做只读校验（verified=null + 说明）
//   Ⓖ 只读校验是"显式注入才跑"：注入 verified=false 仍能把 lock 逐字还原（既有安全网没丢）
//   Ⓗ 负控：装**别的包**这条 `/install` 通道与改动前一致（照旧走 pnpm），profile 的 lock/清单一个字节不动
//   Ⓘ 已经是最新 ⇒ 如实说"没改动任何文件"，不假装更新过
//   Ⓚ 真机那个"空壳目录（1 文件）"能被覆盖修复回来（不需要 pnpm）
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = join(HERE, '.testdir', 'self-update-fallback')
// 隔离数据根（守卫/作业层会碰 DSH_HOME 下的东西 —— 绝不落到真实用户目录）
process.env.DSH_HOME = join(BASE, 'home')
// 本套全程离线（靠桩）；顺手把 CI 的同一口径打开，防止哪条夹具漏打桩时偷偷出网
process.env.DSH_TEST_SKIP_NETWORK = '1'

const url = (rel) => pathToFileURL(join(HERE, '..', rel)).href
const { selfUpdateToLatest } = await import(url('lib/server/domain/selfupdate.js'))
const { tryCandidateChannels } = await import(url('lib/server/domain/install-channels.js'))

const SELF = '@noob-stupid/dsh-plugin-console'
const OLD = '0.5.100'
const TARGET = '0.5.101'
const OTHER = 'pkg-not-self-update'
const SELF_SRC = join(HERE, '..', 'lib', 'server', 'domain', 'selfupdate.js')

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
const backupsOf = (pkgDir) => {
  try { return readdirSync(dirname(pkgDir)).filter((n) => n.startsWith(`${SELF.split('/').pop()}.pre-update-`)).sort() } catch { return [] }
}

/** 能不能用系统 tar 造/解 tarball（生产代码的覆盖解包本身就依赖 tar；没有就响亮 SKIP，不假装 PASS）。 */
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
function makeProfile(tag, { selfVersion = OLD, lockVersion = OLD, spec = '^0.5.100', withSelf = true, shellOnly = false } = {}) {
  const profileDir = join(BASE, tag, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  writeFixture(join(profileDir, 'cordis.patch.yml'), '# fixture\n')
  writeFixture(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-desktop', private: true, dependencies: { [SELF]: spec } }, null, 2)}\n`)
  writeFixture(join(profileDir, 'pnpm-lock.yaml'), lockYaml(lockVersion))
  const pkgDir = join(profileDir, 'node_modules', SELF)
  if (withSelf && !shellOnly) {
    writeFixture(join(pkgDir, 'package.json'), `${JSON.stringify({ name: SELF, version: selfVersion, main: './lib/index.js' }, null, 2)}\n`)
    writeFixture(join(pkgDir, 'lib', 'index.js'), 'export const ok = 1\n')
    writeFixture(join(pkgDir, 'SECURITY.md'), '# 旧版就有、tarball 里没有\n')
    writeFixture(join(pkgDir, 'EXTRA.sentinel'), `哨兵：${tag}\n`)
  }
  if (withSelf && shellOnly) {
    // 真机那个现场：pnpm 清空目录之后剩下的"1 文件空壳"
    writeFixture(join(pkgDir, 'scripts', 'build.sh'), '#!/bin/sh\n')
  }
  return { profileDir, pkgDir, lockFile: join(profileDir, 'pnpm-lock.yaml') }
}

/** 递归列出目录里的相对路径（用来证明"覆盖没删文件"）。 */
function filesUnder(dir) {
  const out = []
  const walk = (current, prefix) => {
    let entries = []
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(join(current, entry.name), rel)
      else out.push(rel)
    }
  }
  if (existsSync(dir)) walk(dir, '')
  return out.sort()
}

/**
 * `/self-update` 的注入点：三个既有通道（runPnpm / pnpmAdd / curlManualInstall）+ copyDeps + 事件序列。
 * `copyDeps.env = {}`：本套全程离线，靠桩；不读进程里的 DSH_TEST_SKIP_NETWORK。
 * ★ `pnpmCalls` 是**最重要**的观测量：自更新路径一轮都不许碰它（下面的断言直接数它）。
 */
function makeHarness({ tarball = null, meta = null, verdict = null, prepFails = false, downloadFails = false, junkTarball = false, landVersion = null, writeLock = null } = {}) {
  const events = []
  const calls = []
  const pnpmCalls = []
  const copyDeps = {
    env: {},
    tmpDir: () => {
      const dir = join(BASE, 'work')
      mkdirSync(dir, { recursive: true })
      return dir
    },
    fetchJson: async () => {
      events.push('meta')
      if (prepFails) throw new Error('桩：registry 不可达（ENOTFOUND registry.fake）')
      return meta ?? { 'dist-tags': { latest: TARGET }, versions: { [TARGET]: { dist: { tarball: 'https://registry.fake/pkg.tgz', integrity: tarball?.integrity ?? null } } } }
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
      // landVersion：让解出来的包"看起来是另一个版本"（模拟铺了一半 / 铺错版本）
      if (typeof landVersion === 'string' && landVersion !== '') {
        const pkg = join(dir, 'package', 'package.json')
        writeFixture(pkg, `${JSON.stringify({ name: SELF, version: landVersion, main: './lib/index.js' }, null, 2)}\n`)
      }
    },
  }
  if (typeof writeLock === 'function') copyDeps.writeLock = writeLock
  if (verdict !== null) copyDeps.verifyLock = async () => { events.push('verify'); return verdict }
  const steps = {
    events,
    calls,
    pnpmCalls,
    copyDeps,
    deps: {
      runPnpm: async (argv) => { events.push('pnpm-update'); pnpmCalls.push('runPnpm'); calls.push(`pnpm-update:${argv.join(' ')}`) },
      pnpmAdd: async () => { events.push('pnpm-add'); pnpmCalls.push('pnpmAdd'); calls.push('pnpm-add') },
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

if (TAR_OK !== true) skip('整套覆盖断言', '系统里没有 tar（生产代码的覆盖解包同样依赖它）')

/** 静态：selfUpdateToLatestLocked 的正文（到下一个顶层 const 为止），避免把 reconcileLockfile 里的 pnpm add 算进来。 */
const selfupdateSrc = readFileSync(SELF_SRC, 'utf8')
const bodyStart = selfupdateSrc.indexOf('async function selfUpdateToLatestLocked')
const bodyEnd = selfupdateSrc.indexOf('const SOURCE_SPEC_RE')
const lockedBody = bodyStart >= 0 && bodyEnd > bodyStart ? selfupdateSrc.slice(bodyStart, bodyEnd) : ''
const PNPM_CALL_RE = /await\s+(runPnpm|pnpmAdd)\s*\(/gu
const pnpmCallSites = [...lockedBody.matchAll(PNPM_CALL_RE)].map((m) => m[1])

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Ⓐ ★ 自更新全程不启动任何 pnpm（运行时计数 + 静态调用点；本轮最重要的断言）
// ══════════════════════════════════════════════════════════════════════════════════════════════
check('Ⓐ 静态接线：正文切片取到了（不然下面的"0 个调用点"是永真的绿灯）',
  lockedBody.includes('prepareSelfUpdateTarball({') && lockedBody.includes('overlaySelfUpdateTarball({') && lockedBody.length > 1200,
  `slice=${lockedBody.length} 字符`)
check('Ⓐ ★ 静态：selfUpdateToLatestLocked 正文里**没有** runPnpm / pnpmAdd 调用点',
  pnpmCallSites.length === 0, JSON.stringify(pnpmCallSites))
check('Ⓐ 静态断言自检：这条正则对历史写法必须命中（否则它是假绿灯）',
  [..."await runPnpm(['update', CONSOLE_PACKAGE], { execOpts: { cwd: profileDir } })".matchAll(PNPM_CALL_RE)].length === 1
  && [...'await pnpmAdd(profileDir, `${CONSOLE_PACKAGE}@${latest}`, registries?.[0])'.matchAll(PNPM_CALL_RE)].length === 1,
  '历史两行都能被命中')

if (TAR_OK) {
  const { profileDir, pkgDir, lockFile } = makeProfile('a-no-pnpm')
  const tar = makeTarball('a')
  const h = makeHarness({ tarball: tar })
  const res = await runSelfUpdate({ profileDir, steps: h })
  check('Ⓐ ★ 运行时：整轮自更新**一次 pnpm 都没启动**（runPnpm / pnpmAdd 计数 === 0）',
    h.pnpmCalls.length === 0 && h.events.includes('pnpm-update') === false && h.events.includes('pnpm-add') === false,
    JSON.stringify({ pnpmCalls: h.pnpmCalls, events: h.events }))
  check('Ⓐ 也没有走先删再铺的 curl 通道（覆盖成功了就不该轮到它）',
    h.events.includes('curl') === false && h.calls.includes('curl') === false, JSON.stringify(h.events))
  check('Ⓐ 动作顺序 = 元数据 → 下载 → 解包（没有任何包管理器夹在中间）',
    JSON.stringify(h.events.filter((e) => e !== 'verify')) === JSON.stringify(['meta', 'download', 'extract']),
    JSON.stringify(h.events))
  check('Ⓐ 落地版本 = 目标版本（读磁盘核实，不看通道自报）', installedVersionOf(pkgDir) === TARGET, String(installedVersionOf(pkgDir)))
  check('Ⓐ 结果里标明走的是 manual-overlay、且 note 明说"没有调用包管理器 pnpm"',
    res.method === 'manual-overlay' && String(res.note).includes('manual-overlay') && String(res.note).includes('没有调用包管理器 pnpm'),
    JSON.stringify({ method: res.method, note: String(res.note).slice(0, 200) }))
  check('Ⓐ ok / updated 同一事实：ok=true', res.ok === true && res.reason === null, JSON.stringify({ ok: res.ok, reason: res.reason }))
  check('Ⓐ 临时工作目录被收尾清掉（下载的 tarball / 解包目录都不留）',
    (existsSync(join(BASE, 'work')) ? readdirSync(join(BASE, 'work')) : []).length === 0,
    JSON.stringify(existsSync(join(BASE, 'work')) ? readdirSync(join(BASE, 'work')) : []))
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Ⓑ 正常路径：下载 → 覆盖 → 版本对 → lock 同步 → ok:true（既有字段语义逐项不变）
// ══════════════════════════════════════════════════════════════════════════════════════════════
if (TAR_OK) {
  const { profileDir, pkgDir, lockFile } = makeProfile('b-happy')
  const tar = makeTarball('b')
  const h = makeHarness({ tarball: tar })
  const res = await runSelfUpdate({ profileDir, steps: h })
  const lockText = readFileSync(lockFile, 'utf8')

  check('Ⓑ copy 现场：channel=overlay、noClear=true、版本=目标版本',
    res.copy?.channel === 'overlay' && res.copy?.noClear === true && res.copy?.version === TARGET && res.copy?.reason === null,
    JSON.stringify(res.copy))
  check('Ⓑ lock 的 importer 条目已到目标版本（version + specifier 两行都换了）',
    lockText.includes(`version: ${TARGET}`) && lockText.includes(`specifier: ${TARGET}`),
    lockText.split('\n').filter((l) => /specifier|version:/.test(l)).join(' | '))
  check('Ⓑ lock 的 packages 段键名与 integrity 都换到目标版本（旧 integrity 绝不挂到新版本号下）',
    lockText.includes(`'${SELF}@${TARGET}':`) && lockText.includes(`resolution: {integrity: ${tar.integrity}}`) && lockText.includes('sha512-OLD==') === false,
    lockText.split('\n').filter((l) => /resolution/.test(l)).join(' | '))
  check('Ⓑ lock 的 snapshots 段键名也到目标版本（三段一起走，不留半改）',
    lockText.includes(`'${SELF}@${TARGET}': {}`) && lockText.includes(`${SELF}@${OLD}:`) === false,
    lockText.split('\n').filter((l) => l.includes(SELF)).join(' | '))
  check('Ⓑ 回的既有字段：method=manual-overlay / lockUpdated=true / lockVersion=目标 / lockNote=null / installedVersion=目标',
    res.method === 'manual-overlay' && res.lockUpdated === true && res.lockVersion === TARGET && res.lockNote === null && res.installedVersion === TARGET,
    JSON.stringify({ method: res.method, lockUpdated: res.lockUpdated, lockVersion: res.lockVersion, lockNote: res.lockNote, installed: res.installedVersion }))
  check('Ⓑ 清单 spec 也跟到目标版本（否则下一次 pnpm 操作会按清单降级）', manifestVersionOf(profileDir) === TARGET, String(manifestVersionOf(profileDir)))
  check('Ⓑ 自更新守卫认可这次落地：verified=true / backedUp=true / healed=false / manualCommand=null',
    res.selfUpdate?.verified === true && res.selfUpdate?.backedUp === true && res.selfUpdate?.healed === false && res.selfUpdate?.manualCommand === null,
    JSON.stringify({ verified: res.selfUpdate?.verified, backedUp: res.selfUpdate?.backedUp, healed: res.selfUpdate?.healed }))
  check('Ⓑ 守卫的 step 记录点名 manual-overlay 且校验通过（哪一步落地看得见）',
    JSON.stringify((res.selfUpdate?.steps ?? []).map((row) => [row.step, row.verified])) === JSON.stringify([['manual-overlay', true]]),
    JSON.stringify(res.selfUpdate?.steps ?? null))
  check('Ⓑ 备份在成功后被清理（不留垃圾）', backupsOf(pkgDir).length === 0, JSON.stringify(backupsOf(pkgDir)))
  check('Ⓑ 新增字段 lockPatch 如实报出改了什么 + 默认不做 pnpm 只读校验（verified=null，不是"通过"）',
    res.lockPatch?.changed === true && res.lockPatch?.integrityWritten === true && res.lockPatch?.verified === null
    && String(res.lockPatch?.verifyNote).includes('不启动 pnpm'),
    JSON.stringify({ changed: res.lockPatch?.changed, integrity: res.lockPatch?.integrityWritten, verified: res.lockPatch?.verified, note: res.lockPatch?.verifyNote }))
  check('Ⓑ note 里同时说清"只覆盖没清空"、"lock 已补齐"、"没做 pnpm 解析层校验"（绝不静默）',
    String(res.note).includes('没有清空目录') && String(res.note).includes('pnpm-lock.yaml 已补齐') && String(res.note).includes('无法确认'),
    String(res.note).slice(0, 260))
  check('Ⓑ note 里点了 lock 的边界（未同步时下一次包管理器操作可能把版本还原）',
    String(res.note).includes('下一次包管理器操作可能把版本还原'), String(res.note).slice(-160))
  check('Ⓑ 全程零 pnpm（与 Ⓐ 同一判据，正常路径再钉一遍）', h.pnpmCalls.length === 0, JSON.stringify(h.pnpmCalls))
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Ⓒ 覆盖前目录里已有、**不在 tarball 里**的文件必须还在（preserved 计数 + 逐字内容 + 不删文件）
// ══════════════════════════════════════════════════════════════════════════════════════════════
if (TAR_OK) {
  const { profileDir, pkgDir } = makeProfile('c-preserved')
  const tar = makeTarball('c')
  const h = makeHarness({ tarball: tar })
  const sentinelBefore = readOrNull(join(pkgDir, 'EXTRA.sentinel'))
  const securityBefore = readOrNull(join(pkgDir, 'SECURITY.md'))
  const filesBefore = filesUnder(pkgDir)
  const res = await runSelfUpdate({ profileDir, steps: h })
  const filesAfter = filesUnder(pkgDir)

  check('Ⓒ 原有、且不在 tarball 里的文件（SECURITY.md / EXTRA.sentinel）逐字未变',
    readOrNull(join(pkgDir, 'SECURITY.md')) === securityBefore && readOrNull(join(pkgDir, 'EXTRA.sentinel')) === sentinelBefore,
    JSON.stringify({ security: readOrNull(join(pkgDir, 'SECURITY.md')) === securityBefore, sentinel: readOrNull(join(pkgDir, 'EXTRA.sentinel')) === sentinelBefore }))
  check('Ⓒ ★ 一个原有文件都没被删（覆盖前的那份清单是覆盖后的子集）',
    filesBefore.every((rel) => filesAfter.includes(rel)),
    JSON.stringify({ before: filesBefore, after: filesAfter }))
  check('Ⓒ 覆盖确实发生了：入口换成新版内容、新版独有文件出现了',
    readOrNull(join(pkgDir, 'lib', 'index.js')) === 'export const ok = 2\n' && readOrNull(join(pkgDir, 'NEWONLY.md')) !== null,
    String(readOrNull(join(pkgDir, 'lib', 'index.js'))))
  check('Ⓒ 如实报出"铺了几个文件、原地保留了几个"（preserved ≥ 2 是没清空目录的量化证据）',
    res.copy?.files >= 3 && res.copy?.preserved >= 2, JSON.stringify({ files: res.copy?.files, preserved: res.copy?.preserved }))
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Ⓓ 下载失败 ⇒ 如实失败 + 从更新前备份恢复 + 绝对路径命令（绝不报成功）
// ══════════════════════════════════════════════════════════════════════════════════════════════
if (TAR_OK) {
  const { profileDir, pkgDir, lockFile } = makeProfile('d-no-tarball')
  const tar = makeTarball('d')
  const h = makeHarness({ tarball: tar, prepFails: true })
  const before = readOrNull(join(pkgDir, 'SECURITY.md'))
  const lockBefore = readOrNull(lockFile)
  const res = await runSelfUpdate({ profileDir, steps: h })

  check('Ⓓ 下载失败 ⇒ tarball.ok=false 且 reason 如实（点名 registry 不可达）',
    res.tarball?.ok === false && String(res.tarball?.reason).includes('registry'), JSON.stringify(res.tarball))
  check('Ⓓ 覆盖没得可用 ⇒ copy.channel=null、method 里没有 manual-overlay（回落 curl 也失败了）',
    res.copy?.channel === null && String(res.method ?? '').includes('manual-overlay') === false,
    JSON.stringify({ method: res.method, copy: res.copy }))
  check('Ⓓ ★ 绝不报成功：ok=false + reason 说清"自更新没有完成"',
    res.ok === false && String(res.reason).includes('自更新没有完成'), JSON.stringify({ ok: res.ok, reason: String(res.reason).slice(0, 120) }))
  check('Ⓓ ★ 走既有自愈路径：从更新前的备份恢复（healed=true / selfHeal.restored=true），版本回到旧版',
    res.selfUpdate?.healed === true && res.selfUpdate?.selfHeal?.restored === true && installedVersionOf(pkgDir) === OLD,
    JSON.stringify({ healed: res.selfUpdate?.healed, version: installedVersionOf(pkgDir) }))
  check('Ⓓ 目录内容恢复成更新前那一份（SECURITY.md 逐字相同）', readOrNull(join(pkgDir, 'SECURITY.md')) === before)
  check('Ⓓ ★ 给出的是**绝对路径**、可直接复制运行的手动命令',
    typeof res.selfUpdate?.manualCommand === 'string' && res.selfUpdate.manualCommand.includes(profileDir) && /^(robocopy|cp)\s/u.test(res.selfUpdate.manualCommand),
    String(res.selfUpdate?.manualCommand).slice(0, 160))
  check('Ⓓ lock 一个字节都没动（自愈之后没有半改的痕迹）', readOrNull(lockFile) === lockBefore && res.lockUpdated === false, String(res.lockUpdated))
  check('Ⓓ 这条失败路径同样零 pnpm', h.pnpmCalls.length === 0, JSON.stringify(h.pnpmCalls))
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Ⓔ 覆盖失败（垃圾 tarball，解包就炸）⇒ 如实失败 + 自愈 + copy.reason 指出覆盖失败
// ══════════════════════════════════════════════════════════════════════════════════════════════
if (TAR_OK) {
  const { profileDir, pkgDir } = makeProfile('e-junk')
  const tar = makeTarball('e')
  const h = makeHarness({ tarball: tar, junkTarball: true })
  const res = await runSelfUpdate({ profileDir, steps: h })
  check('Ⓔ 覆盖失败 ⇒ copy.channel=null 且 reason 如实说"覆盖文件失败"（不伪装成走过了）',
    res.copy?.channel === null && typeof res.copy?.reason === 'string' && res.copy.reason.includes('覆盖文件失败'),
    JSON.stringify(res.copy))
  check('Ⓔ 同样自愈（ok=false / healed=true）+ 版本回到旧版',
    res.ok === false && res.selfUpdate?.healed === true && installedVersionOf(pkgDir) === OLD,
    JSON.stringify({ ok: res.ok, healed: res.selfUpdate?.healed, version: installedVersionOf(pkgDir) }))
  check('Ⓔ 守卫 step 记录点名 manual-overlay 是坏的（哪一步坏的查得到）',
    (res.selfUpdate?.steps ?? []).some((row) => row.step === 'manual-overlay' && row.verified === false),
    JSON.stringify(res.selfUpdate?.steps ?? null))
  check('Ⓔ 这条失败路径同样零 pnpm', h.pnpmCalls.length === 0, JSON.stringify(h.pnpmCalls))
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Ⓕ lock 补不上 ⇒ 如实 lockNote，**不谎报**（并且默认不启动 pnpm 做只读校验）
// ══════════════════════════════════════════════════════════════════════════════════════════════
if (TAR_OK) {
  const { profileDir, pkgDir, lockFile } = makeProfile('f-lock-fail')
  const tar = makeTarball('f')
  const lockBefore = readOrNull(lockFile)
  const h = makeHarness({ tarball: tar, writeLock: async () => ({ changed: false, unchanged: false, reason: '桩：lock 形态不认识（没有 importers 段），已跳过定点写入' }) })
  const res = await runSelfUpdate({ profileDir, steps: h })

  check('Ⓕ 文件确实落地到目标版本（更新本身成功），但 lockUpdated=false（不谎报持久化）',
    installedVersionOf(pkgDir) === TARGET && res.lockUpdated === false, JSON.stringify({ installed: installedVersionOf(pkgDir), lockUpdated: res.lockUpdated }))
  check('Ⓕ lockNote 如实说"未写入 pnpm-lock.yaml"、点名 lock 里仍是旧版本、并给出可复制命令',
    typeof res.lockNote === 'string' && res.lockNote.includes('未写入 pnpm-lock.yaml') && res.lockNote.includes(OLD) && res.lockNote.includes('dsh plugin --profile'),
    String(res.lockNote).slice(0, 220))
  check('Ⓕ 补 lock 的原始原因同时进 lockPatch.reason 与 errors（不静默）',
    typeof res.lockPatch?.reason === 'string' && res.lockPatch.reason.includes('lock 形态不认识')
    && res.errors.some((e) => String(e).includes('补 pnpm-lock.yaml 未成功')),
    JSON.stringify({ reason: res.lockPatch?.reason, errors: res.errors }))
  check('Ⓕ note 里带的是"未写入"口径，而不是"已写入"（措辞不谎报）',
    String(res.note).includes('未写入 pnpm-lock.yaml') && String(res.note).includes('下一次包管理器操作可能把版本还原'),
    String(res.note).slice(0, 260))
  check('Ⓕ lock 文件未被改动（写不进去就一个字节都不留）', readOrNull(lockFile) === lockBefore)
  check('Ⓕ 这条路径同样零 pnpm（连只读校验都不跑）', h.pnpmCalls.length === 0, JSON.stringify(h.pnpmCalls))
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Ⓖ 只读校验是"显式注入才跑"：注入 verified=false 仍把 lock 逐字还原（既有安全网没丢）
// ══════════════════════════════════════════════════════════════════════════════════════════════
if (TAR_OK) {
  const { profileDir, pkgDir, lockFile } = makeProfile('g-verify-false')
  const tar = makeTarball('g')
  const lockBefore = readOrNull(lockFile)
  const h = makeHarness({ tarball: tar, verdict: { verified: false, reason: '桩：ERR_PNPM_BROKEN_LOCKFILE（bad indentation）' } })
  const res = await runSelfUpdate({ profileDir, steps: h })
  check('Ⓖ 注入的只读校验被真的调用了（显式注入才跑，不是彻底失效）',
    h.events.includes('verify') === true, JSON.stringify(h.events))
  check('Ⓖ 校验明确不通过 ⇒ lock 被**逐字还原**成改动前（绝不留下 pnpm 会拒绝的 lock）',
    readOrNull(lockFile) === lockBefore && res.lockPatch?.rolledBack === true,
    JSON.stringify({ rolledBack: res.lockPatch?.rolledBack, same: readOrNull(lockFile) === lockBefore }))
  check('Ⓖ 如实报"未补上"（lockUpdated=false + lockNote 给原因与可复制命令）',
    res.lockUpdated === false && typeof res.lockNote === 'string' && res.lockNote.includes('未写入 pnpm-lock.yaml') && res.lockNote.includes('dsh plugin --profile'),
    String(res.lockNote).slice(0, 200))
  check('Ⓖ 校验结论进 lockPatch.verified=false（不假装确认过）',
    res.lockPatch?.verified === false && String(res.lockPatch?.verifyNote).includes('BROKEN_LOCKFILE'),
    JSON.stringify({ verified: res.lockPatch?.verified, note: res.lockPatch?.verifyNote }))
  check('Ⓖ 文件仍是目标版本（lock 回滚不影响已落地的文件），且这条路径零 pnpm（只调了注入的桩）',
    installedVersionOf(pkgDir) === TARGET && h.pnpmCalls.length === 0, JSON.stringify({ installed: installedVersionOf(pkgDir), pnpmCalls: h.pnpmCalls }))
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Ⓗ 负控：装**别的**包照旧走 pnpm 通道（/install 一个字节都没变）
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  // 静态接线：手铺模块只被 selfupdate.js 引用；预下载/覆盖只在那一条路里被调用
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
  check('Ⓗ 静态接线：selfupdate-copy.js 只被 domain/selfupdate.js 引用（别的通道一个字节都不经过它）',
    copyImporters.length === 1 && copyImporters[0] === '/lib/server/domain/selfupdate.js', JSON.stringify(copyImporters))
  const callSites = serverFiles.filter((p) => readFileSync(p, 'utf8').includes('await overlaySelfUpdateTarball(')).map((p) => p.replace(join(HERE, '..'), '').replace(/\\/gu, '/'))
  check('Ⓗ 静态接线：覆盖解包只在 selfupdate.js 里被调用（不是通用安装通道的一部分）',
    callSites.length === 1 && callSites[0] === '/lib/server/domain/selfupdate.js', JSON.stringify(callSites))

  // 运行时：/install 走别的包 ⇒ pnpm 腿照旧被调用（与改动前一致），profile 的 lock / 清单一个字节都不动
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
  check('Ⓗ 运行时：装别的包仍由 pnpm 腿装上（通道顺序与判据不变 —— 负控）',
    result?.installedName === OTHER && touched.some((t) => t === `pnpm:${OTHER}`), JSON.stringify({ result: result?.installedName, touched }))
  check('Ⓗ 运行时：别的包这条路没有产生自更新专属现场（copy / tarball / lockPatch 都不出现）',
    job.copy === undefined && job.tarball === undefined && job.lockPatch === undefined,
    JSON.stringify({ copy: job.copy, tarball: job.tarball, lockPatch: job.lockPatch }))
  check('Ⓗ 运行时：profile 的 lock 与清单一个字节都没被碰',
    readOrNull(join(profileDir, 'pnpm-lock.yaml')) === lockBefore && readOrNull(join(profileDir, 'package.json')) === manifestBefore)
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Ⓘ 已经是最新（目录里就是目标版本、lock 也是）⇒ 如实说"没改动任何文件"，不假装更新过
// ══════════════════════════════════════════════════════════════════════════════════════════════
if (TAR_OK) {
  const { profileDir, pkgDir, lockFile } = makeProfile('i-already-current', { selfVersion: TARGET, lockVersion: TARGET })
  const tar = makeTarball('i')
  const h = makeHarness({ tarball: tar, prepFails: true })
  const entryBefore = readOrNull(join(pkgDir, 'lib', 'index.js'))
  const res = await runSelfUpdate({ profileDir, steps: h })
  check('Ⓘ 已经是最新 ⇒ method=already-current、copy=null（没有覆盖动作）',
    res.method === 'already-current' && res.copy === null, JSON.stringify({ method: res.method, copy: res.copy }))
  check('Ⓘ 如实说"本轮没有改动任何文件"，且 ok=true / lockUpdated=true（既有字段语义不变）',
    String(res.note).includes('没有改动任何文件') && res.ok === true && res.lockUpdated === true,
    JSON.stringify({ ok: res.ok, lockUpdated: res.lockUpdated, note: String(res.note).slice(0, 200) }))
  check('Ⓘ 目录里的文件真的没被动过（入口内容逐字不变）', readOrNull(join(pkgDir, 'lib', 'index.js')) === entryBefore)
  check('Ⓘ 零 pnpm、零覆盖', h.pnpmCalls.length === 0 && h.events.includes('extract') === false, JSON.stringify(h.events))
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Ⓚ 真机那个"空壳目录（1 文件）"能被覆盖修复回来（不需要 pnpm、不需要先删目录）
// ══════════════════════════════════════════════════════════════════════════════════════════════
if (TAR_OK) {
  const { profileDir, pkgDir } = makeProfile('k-shell', { shellOnly: true })
  const tar = makeTarball('k')
  const h = makeHarness({ tarball: tar })
  const res = await runSelfUpdate({ profileDir, steps: h })
  check('Ⓚ 空壳（只有 scripts/build.sh）也能救回来：package.json 与入口都到位、版本=目标',
    installedVersionOf(pkgDir) === TARGET && existsSync(join(pkgDir, 'lib', 'index.js')) && existsSync(join(pkgDir, 'scripts', 'build.sh')),
    JSON.stringify({ version: installedVersionOf(pkgDir), files: filesUnder(pkgDir) }))
  check('Ⓚ 空壳目录本来就没法备份（守卫不接管），但更新仍然落地并如实报成功',
    res.selfUpdate === null && res.ok === true && res.method === 'manual-overlay',
    JSON.stringify({ selfUpdate: res.selfUpdate, ok: res.ok, method: res.method }))
  check('Ⓚ 零 pnpm', h.pnpmCalls.length === 0, JSON.stringify(h.pnpmCalls))
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Ⓛ 覆盖不能顺着硬链接写回 pnpm 的 store（真机现场：node_modules 里的文件是 store 的硬链接）
//    本机实测：nlink=2 时 copyFileSync 会把**另一份**的内容一起改掉 —— store 一脏就波及别的 profile。
// ══════════════════════════════════════════════════════════════════════════════════════════════
if (TAR_OK) {
  const { profileDir, pkgDir } = makeProfile('l-hardlink')
  const tar = makeTarball('l')
  // 造一个"store 里那一版"的替身，把 pkgDir 里的入口文件改成它的硬链接（与 pnpm 的布局同形）
  const storeDir = join(BASE, 'l-store', 'files')
  mkdirSync(storeDir, { recursive: true })
  const storeFile = join(storeDir, 'index.js')
  writeFixture(storeFile, 'export const ok = 1\n')
  rmSync(join(pkgDir, 'lib', 'index.js'), { force: true })
  let linked = false
  try {
    linkSync(storeFile, join(pkgDir, 'lib', 'index.js'))
    linked = statSync(storeFile).nlink > 1
  } catch (error) {
    skip('Ⓛ 硬链接判据', `本机建不出硬链接（${error.code ?? '未知'}）—— 不假装 PASS`)
  }
  if (linked) {
    const h = makeHarness({ tarball: tar })
    const res = await runSelfUpdate({ profileDir, steps: h })
    check('Ⓛ 覆盖之后 store 里那一份**逐字未变**（没有顺着硬链接写回去）',
      readOrNull(storeFile) === 'export const ok = 1\n', JSON.stringify(readOrNull(storeFile)))
    check('Ⓛ 插件目录里的入口确实换成了新版（该覆盖的还是覆盖了）',
      readOrNull(join(pkgDir, 'lib', 'index.js')) === 'export const ok = 2\n', JSON.stringify(readOrNull(join(pkgDir, 'lib', 'index.js'))))
    check('Ⓛ 如实报出断了几个硬链接（links.broken ≥ 1，failed = 0）',
      res.copy?.links?.broken >= 1 && res.copy?.links?.failed === 0, JSON.stringify(res.copy?.links))
    check('Ⓛ 硬链接断掉之后 nlink = 1（新文件是独立的 inode）',
      statSync(join(pkgDir, 'lib', 'index.js')).nlink === 1, String(statSync(join(pkgDir, 'lib', 'index.js')).nlink))
    check('Ⓛ 这条路径同样零 pnpm', h.pnpmCalls.length === 0, JSON.stringify(h.pnpmCalls))
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Ⓜ 元数据里没有该版本的完整性摘要 ⇒ 只补 importer，**不**把旧 integrity 挂到新版本号上（既有规则）
// ══════════════════════════════════════════════════════════════════════════════════════════════
if (TAR_OK) {
  const { profileDir, pkgDir, lockFile } = makeProfile('m-no-integrity')
  const tar = makeTarball('m')
  const h = makeHarness({
    tarball: tar,
    meta: { versions: { [TARGET]: { dist: { tarball: 'https://registry.fake/pkg.tgz' } } } },
  })
  const res = await runSelfUpdate({ profileDir, steps: h })
  const lockText = readFileSync(lockFile, 'utf8')
  check('Ⓜ 没有完整性摘要 ⇒ 只补 importer（版本落地），**不**把旧 integrity 挂到新版本号上',
    lockText.includes(`version: ${TARGET}`) && lockText.includes(`'${SELF}@${OLD}':`) && lockText.includes('sha512-OLD==') === true
    && res.lockPatch?.integrityWritten === false && res.lockPatch?.renamed?.packages === false,
    lockText.split('\n').filter((l) => /@0\.5\.10|integrity|version:/.test(l)).join(' | '))
  check('Ⓜ 如实说明"那两段为什么没改"（lockPatch.note），且不把它当成失败（reason=null / lockUpdated=true）',
    /没有该版本的完整性摘要/.test(String(res.lockPatch?.note ?? '')) && res.lockPatch?.reason === null && res.lockUpdated === true,
    JSON.stringify({ note: res.lockPatch?.note, reason: res.lockPatch?.reason, lockUpdated: res.lockUpdated }))
  check('Ⓜ 这条路径同样零 pnpm', h.pnpmCalls.length === 0, JSON.stringify(h.pnpmCalls))
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Ⓝ 注入的只读校验"无法确认"（跑不起来）⇒ 不回滚，但 note 必须写"无法确认"（绝不冒充通过）
// ══════════════════════════════════════════════════════════════════════════════════════════════
if (TAR_OK) {
  const { profileDir, pkgDir, lockFile } = makeProfile('n-verify-null')
  const tar = makeTarball('n')
  const h = makeHarness({ tarball: tar, verdict: { verified: null, reason: '桩：pnpm 执行方式不可用（无法确认）' } })
  const res = await runSelfUpdate({ profileDir, steps: h })
  check('Ⓝ 无法确认时**不回滚**（lock 文本已按目标版本写好）',
    res.lockPatch?.rolledBack === false && readFileSync(lockFile, 'utf8').includes(`version: ${TARGET}`),
    JSON.stringify({ rolledBack: res.lockPatch?.rolledBack }))
  check('Ⓝ note 明说"无法确认"，lockPatch.verified=null（绝不把无法确认说成通过）',
    res.lockPatch?.verified === null && String(res.note).includes('无法确认'),
    JSON.stringify({ verified: res.lockPatch?.verified, note: String(res.note).slice(-120) }))
  check('Ⓝ lockUpdated 仍按"lock 文本真的到目标版本"如实为 true（不是靠校验结论冒充）',
    res.lockUpdated === true && res.lockVersion === TARGET && res.lockPatch?.integrityWritten === true,
    JSON.stringify({ lockUpdated: res.lockUpdated, lockVersion: res.lockVersion }))
}

const summary = `\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`
// 用写入回调把最后一屏刷出去再退出（直接 process.exit 在 Windows 上会截断重定向的最后几行）
process.stdout.write(`${summary}\n`, () => process.exit(fail === 0 ? 0 : 1))
