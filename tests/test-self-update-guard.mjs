// 自更新兜底的判据测试（2026-11-03 加法，纯离线）
//
// 现场（真机两次，用户报告已确认）：用控制台自带的「更新」把控制台自己更新，pnpm 装包**中途被打断**
// （宿主正在读插件自己的文件 ⇒ EPERM，本次还有外部杀进程干扰）。pnpm 先删旧目录再解包，删到一半失败
// ⇒ 目录只剩 scripts/ 与 SECURITY.md，package.json 没了 ⇒ 宿主报 "cannot resolve profile bundle"
// ⇒ 面板「异常 / 包不可用」⇒ 两次都靠手工把 npm tarball 解回原位。
//
// 本套钉死的判据（每条都要能失败）：
//   ① 正常自更新：备份被创建（内容与更新前一致）→ 校验通过 → 本次备份被清理 → verified=true，
//      且**插件目录一个字节都没被守卫改动**
//   ② 模拟被打断（安装后目录里没有 package.json，通道却认为自己成功了）⇒ 自愈：残缺目录被改名挪开、
//      旧版回来、有 package.json、healed=true；并且**绝不把这次更新报成装上了**
//   ③ 版本不符（落地的是旧版本）⇒ 同样自愈并如实报（点名目标版本与真实落地版本）
//   ④ 备份不可用（注入备份失败）⇒ restored=false + reason + manualCommand 全绝对路径、可直接跑
//   ⑤ 非自更新包（别的包）⇒ **完全不走这套逻辑**：不备份、作业上不出现 selfUpdate 字段、通道调用与改动前逐字一致
//   ⑥ 恢复后再校验仍不过 ⇒ 如实报失败，绝不谎报成功
//   ⑦ 幂等：连跑两次，备份不会无限堆积（最多留 1 份）
//   ⑧ 接线：作业层（runInstallJob）在自更新校验不过时**如实失败**，且不清场、不进 AI 兜底
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { isAbsolute, join, dirname, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = join(HERE, '.testdir', 'self-update-guard')
// 隔离数据根：守卫本身不读 DSH_HOME，但作业层（trash 清理、源配置）会碰它 —— 绝不落到真实用户目录。
process.env.DSH_HOME = join(BASE, 'home')

const url = (rel) => pathToFileURL(join(HERE, '..', rel)).href
const { tryCandidateChannels } = await import(url('lib/server/domain/install-channels.js'))
const { runInstallJob } = await import(url('lib/server/domain/install-job.js'))
const { installJobView } = await import(url('lib/server/domain/install.js'))
const { copyTree } = await import(url('lib/server/infra/fsx.js'))
const guard = await import(url('lib/server/domain/self-update-guard.js'))

const SELF = '@noob-stupid/dsh-plugin-console'
const OLD = '0.5.100'
const TARGET = '0.5.101'

let pass = 0
let fail = 0
const check = (name, ok, info = '') => {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

rmSync(BASE, { recursive: true, force: true })

// ── 夹具写盘的**唯一入口**：路径必须先是绝对路径，否则直接抛 ────────────────────────────────────
// 为什么要有这道闸（真事故，2026-11-03）：`join('', 'lib', 'index.js')` 得到的是**相对路径**，会按 cwd
// 落到仓库根，把插件入口覆盖成 `export const ok = 2` ⇒ `test-route-inventory` / `test-compat-pending-records`
// 当场报 `mod.apply is not a function`。夹具的任何写盘都必须先证明"这是绝对路径里的那份夹具"。
function writeFixture(absPath, content) {
  const target = String(absPath ?? '')
  if (target === '' || isAbsolute(target) !== true) throw new Error(`夹具拒绝写非绝对路径：${target}`)
  if (target.startsWith(join(HERE, '..', 'lib')) && target.endsWith(join('lib', 'index.js'))) throw new Error(`夹具拒绝写插件入口：${target}`)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

// ── 夹具：一份"装好了的"控制台自身副本（profile 的 node_modules 里，与真机现场同一个落点）──────────
function makeProfile(tag, { selfVersion = OLD, withSelf = true } = {}) {
  const profileDir = join(BASE, tag, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  writeFixture(join(profileDir, 'cordis.patch.yml'), '# fixture\n')
  const pkgDir = join(profileDir, 'node_modules', '@noob-stupid', 'dsh-plugin-console')
  if (withSelf) {
    writeFixture(join(pkgDir, 'package.json'), `${JSON.stringify({ name: SELF, version: selfVersion, main: './lib/index.js' }, null, 2)}\n`)
    writeFixture(join(pkgDir, 'lib', 'index.js'), 'export const ok = 1\n')
    writeFixture(join(pkgDir, 'SECURITY.md'), '# sec\n')
    writeFixture(join(pkgDir, 'scripts', 'build.sh'), '#!/bin/sh\n')
  }
  return { profileDir, pkgDir }
}

/** 目录快照（相对路径 → 内容），用来断言"守卫没改动一个字节"。 */
function snapshotDir(dir) {
  const out = {}
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full, rel)
      else out[rel] = readFileSync(full, 'utf8')
    }
  }
  if (existsSync(dir)) walk(dir, '')
  return out
}

const siblingsOf = (pkgDir, suffix) => {
  try { return readdirSync(dirname(pkgDir)).filter((n) => n.startsWith(`${basename(pkgDir)}${suffix}`)).sort() } catch { return [] }
}
const backupsOf = (pkgDir) => siblingsOf(pkgDir, '.pre-update-')
const brokensOf = (pkgDir) => siblingsOf(pkgDir, '.broken-')
const installedVersionOf = (pkgDir) => {
  try { return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version ?? null } catch { return null }
}

/** 通道桩：竞速总是没结果（保证走下面的串行 pnpm），pnpm 里执行"这次安装造成的后果"。 */
function makeChannels(record, onPnpm) {
  return {
    raceInstallChannels: async (dir, spec) => { record.push(`race:${spec}`); return null },
    pnpmInstall: async (dir, spec) => { record.push(`pnpm:${spec}`); return onPnpm({ dir, spec }) },
    curlManualInstall: async () => { record.push('curl'); throw new Error('桩：curl 不该被走到') },
    githubReleaseInstall: async () => { record.push('release'); throw new Error('桩：release 不该被走到') },
    backfillMissingDeps: async () => [],
  }
}

/** 作业层 ports：profileDir 由 loader 的 cordis:include 行推导（与真机同一条路）。 */
function makePorts(profileDir, ch) {
  return {
    baseUrl: 'file:///',
    get: (key) => (key === 'installChannels' ? ch : null),
    loader: { entries: () => [{ id: 'include', options: { name: 'cordis:include', group: true, config: { path: pathToFileURL(join(profileDir, 'cordis.yml')).href } } }] },
  }
}

const runChannels = async ({ profileDir, pkgDir, job, ch, selfUpdateDeps = null }) => tryCandidateChannels({
  job, ch, name: job.packageName, profileDir, registries: ['https://registry.fake'],
  repoChannelAllowed: false, budget: { release: 0 }, expanded: true, deadline: null,
  ...(selfUpdateDeps === null ? {} : { selfUpdateDeps }),
})

// ── ① 正常自更新：备份被创建 → 校验通过 → 备份被清理；插件目录一个字节都没变 ─────────────────
{
  const { profileDir, pkgDir } = makeProfile('normal')
  const before = snapshotDir(pkgDir)
  const record = []
  let backupsDuringInstall = []
  const savedDuringInstall = []
  const ch = makeChannels(record, () => {
    backupsDuringInstall = backupsOf(pkgDir)
    for (const name of backupsDuringInstall) savedDuringInstall.push(snapshotDir(join(dirname(pkgDir), name)))
  })
  const job = { id: 'g1', repo: '', packageName: SELF, source: 'github', update: true, version: null }
  const res = await runChannels({ profileDir, pkgDir, job, ch })
  check('① 安装前真的先做了备份（自更新专属）', backupsDuringInstall.length === 1, JSON.stringify(backupsDuringInstall))
  check('① 备份是**复制**出来的完整副本（内容 = 更新前那棵树）',
    savedDuringInstall.length === 1 && JSON.stringify(savedDuringInstall[0]) === JSON.stringify(before),
    JSON.stringify(Object.keys(savedDuringInstall[0] ?? {})))
  check('① 校验通过：verified=true / backedUp=true / healed=false',
    job.selfUpdate?.verified === true && job.selfUpdate?.backedUp === true && job.selfUpdate?.healed === false,
    JSON.stringify({ verified: job.selfUpdate?.verified, backedUp: job.selfUpdate?.backedUp, healed: job.selfUpdate?.healed }))
  check('① 通道说装上了就算装上了（既有成功语义不变）', res.installedName === SELF, String(res.installedName))
  check('① 本次备份被清理（不留垃圾）', backupsOf(pkgDir).length === 0, JSON.stringify(backupsOf(pkgDir)))
  check('① ★ 守卫没有改动插件目录一个字节', JSON.stringify(snapshotDir(pkgDir)) === JSON.stringify(before))
  check('① 通过时不挂失败文案、不给手动命令',
    guard.selfUpdateFailureText(job.selfUpdate) === null && job.selfUpdate?.manualCommand === null,
    JSON.stringify(job.selfUpdate?.manualCommand ?? null))
}

// ── ② 模拟被打断（目录里没有 package.json，通道却认为自己成功）⇒ 自愈 + 绝不报装上 ─────────────
{
  const { profileDir, pkgDir } = makeProfile('interrupted')
  const record = []
  // 真机现场：pnpm 删了旧的、新的一棵没解开 ⇒ 只剩 scripts/ 与 SECURITY.md
  const ch = makeChannels(record, () => {
    rmSync(join(pkgDir, 'package.json'), { force: true })
    rmSync(join(pkgDir, 'lib'), { recursive: true, force: true })
    writeFixture(join(pkgDir, 'SECURITY.md'), '# sec\n')
  })
  const job = { id: 'g2', repo: '', packageName: SELF, source: 'github', update: true, version: null }
  const res = await runChannels({ profileDir, pkgDir, job, ch })
  const broken = brokensOf(pkgDir)
  check('② ★ 触发自愈：healed=true、selfHeal.restored=true',
    job.selfUpdate?.healed === true && job.selfUpdate?.selfHeal?.restored === true,
    JSON.stringify(job.selfUpdate?.selfHeal ?? null))
  check('② ★ 目录被恢复：package.json 回来了、旧版本正确',
    existsSync(join(pkgDir, 'package.json')) && installedVersionOf(pkgDir) === OLD, String(installedVersionOf(pkgDir)))
  check('② 残缺目录被**改名挪开**（不删）', broken.length === 1 && !existsSync(join(dirname(pkgDir), broken[0], 'package.json')),
    JSON.stringify(broken))
  check('② ★ 校验不过 ⇒ 绝不报"装上了"（通道说成功也要改判）', res.installedName === null, String(res.installedName))
  check('② 失败原因如实写清（含"没有 package.json"这类现场描述）',
    typeof job.selfUpdate?.reason === 'string' && job.selfUpdate.reason.includes('package.json'), String(job.selfUpdate?.reason ?? '').slice(0, 120))
  check('② 通道返回的 lastError 就是那段可见文案（面板原样显示）',
    String(res.lastError?.message ?? '').includes('自更新没有完成') && String(res.lastError?.message ?? '').includes('没有生效'),
    String(res.lastError?.message ?? '').slice(0, 160))
  check('② 恢复用的手动命令指向备份（绝对路径）',
    String(job.selfUpdate?.manualCommand ?? '').includes(String(job.selfUpdate?.backupPath ?? '@@')),
    String(job.selfUpdate?.manualCommand ?? '').slice(0, 200))
}

// ── ③ 版本不符（落地的是旧版本）⇒ 同样自愈并如实报 ──────────────────────────────────────────
{
  const { profileDir, pkgDir } = makeProfile('version-miss')
  const record = []
  const ch = makeChannels(record, () => {
    writeFixture(join(pkgDir, 'package.json'), `${JSON.stringify({ name: SELF, version: '0.5.99', main: './lib/index.js' })}\n`)
  })
  const job = { id: 'g3', repo: '', packageName: SELF, source: 'github', update: true, version: TARGET }
  const res = await runChannels({ profileDir, pkgDir, job, ch })
  check('③ ★ 版本不符也触发自愈，并如实报"落地版本 ≠ 目标版本"',
    job.selfUpdate?.verified === false && job.selfUpdate?.healed === true
    && String(job.selfUpdate?.reason ?? '').includes('0.5.99') && String(job.selfUpdate?.reason ?? '').includes(TARGET),
    JSON.stringify({ verified: job.selfUpdate?.verified, healed: job.selfUpdate?.healed, reason: job.selfUpdate?.reason }))
  check('③ 恢复后盘上是更新前那一版', installedVersionOf(pkgDir) === OLD, String(installedVersionOf(pkgDir)))
  check('③ 仍不报装上', res.installedName === null, String(res.installedName))
}

// ── ④ 备份不可用（注入失败）⇒ restored:false + reason + 可直接运行的手动命令 ─────────────────
{
  const { profileDir, pkgDir } = makeProfile('no-backup')
  const record = []
  const ch = makeChannels(record, () => {
    rmSync(join(pkgDir, 'package.json'), { force: true })
  })
  const job = { id: 'g4', repo: '', packageName: SELF, source: 'github', update: true, version: null }
  const res = await runChannels({
    profileDir, pkgDir, job, ch,
    selfUpdateDeps: { copy: () => { const error = new Error('EACCES: 桩：备份目录被占用'); error.code = 'EACCES'; throw error } },
  })
  const selfUpdate = job.selfUpdate ?? {}
  check('④ ★ backedUp=false 且**不阻断**更新（照样走到了校验这一步）',
    selfUpdate.backedUp === false && selfUpdate.verified === false, JSON.stringify({ backedUp: selfUpdate.backedUp, verified: selfUpdate.verified }))
  check('④ 占用类失败被识别出来（不是普通异常）',
    String(selfUpdate.backupNote ?? '').includes('被占用') && String(selfUpdate.backupNote ?? '').includes('EACCES'),
    String(selfUpdate.backupNote ?? '').slice(0, 160))
  check('④ ★ selfHeal = { attempted:true, restored:false, reason }',
    selfUpdate.selfHeal?.attempted === true && selfUpdate.selfHeal?.restored === false
    && typeof selfUpdate.selfHeal?.reason === 'string' && selfUpdate.selfHeal.reason.includes('没有可用备份'),
    JSON.stringify(selfUpdate.selfHeal ?? null))
  const command = String(selfUpdate.manualCommand ?? '')
  // 只挑**路径**参数来看（命令里还有 registry 的 URL，那当然不是"路径"）
  const quoted = [...command.matchAll(/"([^"]+)"/gu)].map((m) => m[1]).filter((p) => !/^https?:/u.test(p))
  check('④ ★ manualCommand 是一条可真跑的命令（curl/tar 起头、带 registry 地址）',
    /^(curl\.exe|curl)\s/u.test(command) && command.includes('registry.npmmirror.com'), command.slice(0, 160))
  check('④ ★ manualCommand 里所有路径都是**绝对路径**（没有相对路径）',
    quoted.length >= 3 && quoted.every((p) => /^[A-Za-z]:[\\/]/u.test(p) || p.startsWith('/')), JSON.stringify(quoted))
  check('④ manualCommand 指向本插件的落点（用户粘贴即用）', quoted.some((p) => p === pkgDir), JSON.stringify(quoted))
  check('④ 仍然不报装上', res.installedName === null)
}

// ── ⑤ 非自更新包：完全不走这套逻辑（不备份、无字段、通道调用与改动前逐字一致）──────────────────
{
  const PKG = 'probe-pkg'
  const runOne = async (tag, { withSelf }) => {
    const { profileDir, pkgDir } = makeProfile(tag, { withSelf })
    const record = []
    const ch = makeChannels(record, () => {})
    const job = { id: `g5-${tag}`, repo: '', packageName: PKG, source: 'github', update: true, version: null }
    const res = await runChannels({ profileDir, pkgDir, job, ch })
    return { record, job, res, profileDir, pkgDir }
  }
  const withSelf = await runOne('other-with-self', { withSelf: true })
  const withoutSelf = await runOne('other-without-self', { withSelf: false })
  check('⑤ ★ 别的包：作业上根本不出现 selfUpdate 字段',
    !('selfUpdate' in withSelf.job) && !('selfUpdate' in withoutSelf.job),
    JSON.stringify(Object.keys(withSelf.job)))
  check('⑤ ★ 别的包：一个备份都不建（即使 profile 里就装着控制台自己）',
    backupsOf(withSelf.pkgDir).length === 0 && withSelf.pkgDir.includes('@noob-stupid'),
    JSON.stringify(backupsOf(withSelf.pkgDir)))
  check('⑤ ★ 别的包：通道调用顺序与"profile 里没有控制台"时逐字相同（行为不变）',
    JSON.stringify(withSelf.record) === JSON.stringify(withoutSelf.record),
    `${JSON.stringify(withSelf.record)} vs ${JSON.stringify(withoutSelf.record)}`)
  check('⑤ 别的包照旧按原语义报装上', withSelf.res.installedName === PKG && withoutSelf.res.installedName === PKG)
  check('⑤ 作业视图里 selfUpdate 恒为 null（只增字段，不改变既有契约）',
    installJobView(withSelf.job).selfUpdate === null && installJobView(withSelf.job).packageName === PKG)
  check('⑤ 判据不按前缀匹配（同名后缀的包不算自更新）',
    guard.isSelfUpdate(`${SELF}-extra`) === false && guard.isSelfUpdate(SELF) === true,
    `${guard.isSelfUpdate(`${SELF}-extra`)} / ${guard.isSelfUpdate(SELF)}`)
}

// ── ⑥ 恢复后再校验仍不过 ⇒ 如实报失败，绝不谎报成功 ──────────────────────────────────────────
{
  const { profileDir, pkgDir } = makeProfile('bad-restore')
  const record = []
  const ch = makeChannels(record, () => { rmSync(join(pkgDir, 'package.json'), { force: true }) })
  const job = { id: 'g6', repo: '', packageName: SELF, source: 'github', update: true, version: null }
  const res = await runChannels({
    profileDir, pkgDir, job, ch,
    // 只坏"备份"那一次：备份里放一份版本不对的清单 ⇒ 恢复得回来，但同一判据复核仍不过
    selfUpdateDeps: {
      copy: (src, dest) => {
        if (String(dest).includes('.pre-update-')) {
          mkdirSync(dest, { recursive: true })
          writeFixture(join(dest, 'package.json'), `${JSON.stringify({ name: SELF, version: '0.0.0-bad', main: './lib/index.js' })}\n`)
          return
        }
        copyTree(src, dest)
      },
    },
  })
  const selfUpdate = job.selfUpdate ?? {}
  check('⑥ ★ 恢复后仍不过 ⇒ healed=false、selfHeal.restored=false、reason 说清"恢复后仍不过校验"',
    selfUpdate.verified === false && selfUpdate.healed === false && selfUpdate.selfHeal?.restored === false
    && String(selfUpdate.selfHeal?.reason ?? '').includes('恢复后仍不过校验'),
    JSON.stringify(selfUpdate.selfHeal ?? null))
  check('⑥ ★ 不谎报成功：作业拿到的仍是失败（installedName=null）', res.installedName === null, String(res.installedName))
  check('⑥ 文案里带"自动恢复也失败了"与手动命令',
    String(res.lastError?.message ?? '').includes('自动恢复也失败了') && String(selfUpdate.manualCommand ?? '').length > 0,
    String(res.lastError?.message ?? '').slice(0, 200))
  check('⑥ 盘上确实不是目标版本（如实：坏的备份被搬回来了）', installedVersionOf(pkgDir) === '0.0.0-bad', String(installedVersionOf(pkgDir)))
}

// ── ⑦ 幂等：连跑两次，备份不会无限堆积（最多留 1 份）──────────────────────────────────────────
{
  const { profileDir, pkgDir } = makeProfile('idempotent')
  let tick = 1700000000000
  const selfUpdateDeps = { now: () => (tick += 1000) }
  const runOnce = async (tag, { breakIt }) => {
    const record = []
    const ch = makeChannels(record, () => {
      if (breakIt) rmSync(join(pkgDir, 'package.json'), { force: true })
      else writeFixture(join(pkgDir, 'package.json'), `${JSON.stringify({ name: SELF, version: TARGET, main: './lib/index.js' })}\n`)
    })
    const job = { id: `g7-${tag}`, repo: '', packageName: SELF, source: 'github', update: true, version: breakIt ? null : TARGET }
    await runChannels({ profileDir, pkgDir, job, ch, selfUpdateDeps })
    return { job, backups: backupsOf(pkgDir).length }
  }
  const ok1 = await runOnce('ok-1', { breakIt: false })
  const ok2 = await runOnce('ok-2', { breakIt: false })
  check('⑦ 连续两次正常自更新 ⇒ 备份都被清掉（0 份）', ok1.backups === 0 && ok2.backups === 0, `${ok1.backups}/${ok2.backups}`)
  const bad1 = await runOnce('bad-1', { breakIt: true })
  const bad2 = await runOnce('bad-2', { breakIt: true })
  check('⑦ 连续两次失败 ⇒ 最多留 1 份备份（不无限堆）', bad1.backups <= 1 && bad2.backups <= 1, `${bad1.backups}/${bad2.backups}`)
  check('⑦ 失败那两次的备份确实留着（继续更新前的那一版可回退）', bad2.backups >= 1, String(bad2.backups))
}

// ── ⑧ 接线：作业层在自更新校验不过时**如实失败**（不清场、不进 AI 兜底）──────────────────────
{
  const { profileDir, pkgDir } = makeProfile('job-wiring')
  const record = []
  const ch = makeChannels(record, () => { rmSync(join(pkgDir, 'package.json'), { force: true }) })
  const job = {
    id: 'g8', repo: '', source: 'github', packageName: SELF, status: 'installing', stage: 'preparing',
    update: true, version: null, kind: 'plugin',
  }
  await runInstallJob(job, makePorts(profileDir, ch), { aiConsentTimeoutMs: 30 })
  check('⑧ ★ 作业如实失败（status=failed，stage=self-update-check）',
    job.status === 'failed' && job.stage === 'self-update-check', `${job.status}/${job.stage}`)
  check('⑧ ★ 错误文案可见（含原因 + 已恢复 + 手动命令）',
    String(job.error ?? '').includes('自更新没有完成') && String(job.error ?? '').includes('已从更新前的备份自动恢复'),
    String(job.error ?? '').slice(0, 200))
  check('⑧ ★ 不进 AI 兜底（不是"哪一步坏了"，而是这次更新没落地）',
    job.aiPending === null || job.aiPending === undefined, JSON.stringify(job.aiPending ?? null))
  check('⑧ ★ 不清场：恢复回来的那份还在盘上', existsSync(join(pkgDir, 'package.json')) && installedVersionOf(pkgDir) === OLD, String(installedVersionOf(pkgDir)))
  check('⑧ 视图里带 selfUpdate（面板/诊断能拿到结构化结论）',
    installJobView(job).selfUpdate?.verified === false && installJobView(job).selfUpdate?.healed === true,
    JSON.stringify({ verified: installJobView(job).selfUpdate?.verified, healed: installJobView(job).selfUpdate?.healed }))
  check('⑧ 残留目录没有被删（改名保留，可事后核对）', brokensOf(pkgDir).length === 1, JSON.stringify(brokensOf(pkgDir)))
}

// ── ⑨ 首次安装（磁盘上没有自身副本）⇒ 守卫不接管，既有行为原样保留 ────────────────────────────
{
  const { profileDir, pkgDir } = makeProfile('first-install', { withSelf: false })
  const record = []
  const ch = makeChannels(record, () => {
    mkdirSync(join(pkgDir, 'lib'), { recursive: true })
    writeFixture(join(pkgDir, 'package.json'), `${JSON.stringify({ name: SELF, version: TARGET, main: './lib/index.js' })}\n`)
    writeFixture(join(pkgDir, 'lib', 'index.js'), 'export const ok = 1\n')
  })
  const job = { id: 'g9', repo: '', packageName: SELF, source: 'github', update: true, version: TARGET }
  const res = await runChannels({ profileDir, pkgDir, job, ch })
  check('⑨ 首次安装不接管（没有备份、作业上不出现 selfUpdate）',
    backupsOf(pkgDir).length === 0 && !('selfUpdate' in job), JSON.stringify({ backups: backupsOf(pkgDir), keys: Object.keys(job) }))
  check('⑨ 首次安装照旧按原语义报装上', res.installedName === SELF, String(res.installedName))
  assert.ok(record.length > 0)
}

// ── ⑩ 源码检出 / 仓库根不算"自更新"（Node 包自引用能解析到它，守卫必须拒绝动手）──────────────
// 真机实测：`resolve('<本包>/package.json')` 在**包自己内部**的路径上会命中 Node 的包自引用 ⇒ 解析到仓库根。
// 没有这道闸时守卫会把整棵源码树当成"安装副本"去做备份（几十万个文件、几分钟，还在仓库旁边留一堆
// `<repo>.pre-update-*`）。判据：只认"父目录叫 node_modules"或"父目录是 @scope 且祖父叫 node_modules"。
{
  const repoRoot = join(HERE, '..')
  const notInstalled = join(BASE, 'source-checkout', 'dsh-plugin-console')
  mkdirSync(notInstalled, { recursive: true })
  writeFixture(join(notInstalled, 'package.json'), `${JSON.stringify({ name: SELF, version: OLD })}\n`)
  check('⑩ ★ looksInstalled：仓库根/源码检出为 false，node_modules 里的两种布局为 true',
    guard.looksInstalled(repoRoot) === false && guard.looksInstalled(notInstalled) === false
    && guard.looksInstalled(join(BASE, 'x', 'node_modules', 'dsh-plugin-console')) === true
    && guard.looksInstalled(join(BASE, 'x', 'node_modules', '@noob-stupid', 'dsh-plugin-console')) === true,
    JSON.stringify({ repo: guard.looksInstalled(repoRoot), checkout: guard.looksInstalled(notInstalled) }))
  const session = guard.beginSelfUpdateGuard({ packageName: SELF, packageDir: notInstalled })
  check('⑩ ★ 源码检出目录 ⇒ 守卫直接不接管（session=null，绝不建备份）',
    session === null && siblingsOf(notInstalled, '.pre-update-').length === 0,
    JSON.stringify({ session, siblings: siblingsOf(notInstalled, '.pre-update-') }))
  check('⑩ 本仓库根旁边没有留下任何 pre-update 副本（负控：真的没动手）',
    readdirSync(dirname(repoRoot)).filter((n) => n.startsWith(`${basename(repoRoot)}.pre-update-`)).length === 0,
    JSON.stringify(readdirSync(dirname(repoRoot)).filter((n) => n.startsWith(`${basename(repoRoot)}.pre-update-`))))
}

// ── ⑪ 通道**抛异常**（不是"报成功"）时校验照跑：自愈照做，仍不报装上 ──────────────────────────
// 需求原文："更新结束后校验（无论 pnpm 报成功还是失败都要跑）"。这条钉住"报失败"那一半：
// 通道抛错被通道层按既有语义吞成"没装成"（不改既有行为），而校验/自愈照样在收尾时跑完。
{
  const { profileDir, pkgDir } = makeProfile('channel-throw')
  const record = []
  const ch = makeChannels(record, () => {
    rmSync(join(pkgDir, 'package.json'), { force: true })
    throw new Error('桩：pnpm 中途被打断（EPERM: operation not permitted）')
  })
  const job = { id: 'g11', repo: '', packageName: SELF, source: 'github', update: true, version: null }
  let thrown = null
  let res = null
  try {
    res = await runChannels({ profileDir, pkgDir, job, ch })
  } catch (error) {
    thrown = error
  }
  check('⑪ 通道异常没有逃出通道层（既有语义：通道失败被吞成"没装成"，不改行为）',
    thrown === null && res !== null, String(thrown?.message ?? '').slice(0, 120))
  check('⑪ ★ 抛异常这条路也跑了校验与自愈（目录已恢复到旧版）',
    job.selfUpdate?.verified === false && job.selfUpdate?.healed === true && installedVersionOf(pkgDir) === OLD,
    JSON.stringify({ verified: job.selfUpdate?.verified, healed: job.selfUpdate?.healed, version: installedVersionOf(pkgDir) }))
  check('⑪ ★ 仍不报装上，且给的是自更新那段可见文案',
    res?.installedName === null && String(res?.lastError?.message ?? '').includes('自更新没有完成'),
    `${res?.installedName} / ${String(res?.lastError?.message ?? '').slice(0, 100)}`)
  check('⑪ 残缺目录被挪开保留（不删）', brokensOf(pkgDir).length === 1, JSON.stringify(brokensOf(pkgDir)))
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// `/self-update` 通路（市场页那颗「⬇ 更新可用」pill → POST /plugin-console/self-update →
// domain/selfupdate.js#selfUpdateToLatest：pnpm update → pnpm add → curl 手铺**三步**）
// ══════════════════════════════════════════════════════════════════════════════════════════════
// 为什么还要钉这条路：真机那两次更新坏掉的现场**无法确认**走的是哪条通路（插件卡片的「更新」= /install 作业，
// 市场页那颗 pill = /self-update），所以两条都要护住，而且必须用**同一套**判据（domain/self-update-guard.js）。
// 这一段钉的是"接线真的接上了、三步每一步都过校验、全部走完仍不过才自愈、返回结构只增字段"。
const { selfUpdateToLatest } = await import(url('lib/server/domain/selfupdate.js'))

/** pnpm-lock.yaml 的 importer 形态（真机 lock 就是这个形状；lockVersion() 认这种键行）。 */
const lockYamlOf = (version) => [
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
].join('\n')

/** `/self-update` 的夹具 = 装好的自身副本 + profile 清单（依赖 spec）+ pnpm-lock.yaml。 */
function makeSelfUpdateProfile(tag, { selfVersion = OLD, lockVersion = OLD, spec = '^0.5.100', withSelf = true } = {}) {
  const { profileDir, pkgDir } = makeProfile(tag, { selfVersion, withSelf })
  const deps = spec === null ? {} : { [SELF]: spec }
  writeFixture(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-desktop', private: true, dependencies: deps }, null, 2)}\n`)
  writeFixture(join(profileDir, 'pnpm-lock.yaml'), lockYamlOf(lockVersion))
  return { profileDir, pkgDir }
}

const writeProfileLock = (profileDir, version) => writeFixture(join(profileDir, 'pnpm-lock.yaml'), lockYamlOf(version))

/** 把 node_modules 里那份换成目标版本（模拟"某一步真的装上了"）。 */
function landSelfVersion(pkgDir, version) {
  const dir = String(pkgDir ?? '')
  if (dir === '') throw new Error('夹具：pkgDir 为空，拒绝写相对路径（会把文件写进工作目录）')
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFixture(join(dir, 'package.json'), `${JSON.stringify({ name: SELF, version, main: './lib/index.js' }, null, 2)}\n`)
  writeFixture(join(dir, 'lib', 'index.js'), 'export const ok = 2\n')
}

/** 目录替身：`<profileDir>/node_modules/<包名>`（夹具落点固定）；**空路径直接抛** ——
 *  绝不能让 `join('', 'package.json')` 把文件写进当前工作目录（真踩过：把仓库自己的清单写坏了）。 */
function pkgDirOf(profileDir) {
  const dir = String(profileDir ?? '')
  if (dir === '') throw new Error('夹具：profileDir 为空，拒绝写相对路径')
  return join(dir, 'node_modules', ...SELF.split('/'))
}

/** 三步的桩（真机分别是 runPnpmWithFallback / pnpmInstall / curlManualInstall）；每个回调自己决定"这一步造成什么后果"。
 *  profileDir 从**桩真实收到的参数**里取（pnpm/curl 拿到的就是 profile 目录；runPnpm 从 execOpts.cwd 取），
 *  再推出 `pkgDir` —— 这样调用点不必额外传路径，也不可能写错位置。 */
function makeSelfUpdateSteps({ onPnpmUpdate = () => {}, onPnpmAdd = () => {}, onManualCopy = () => {} } = {}) {
  const calls = []
  return {
    calls,
    deps: {
      runPnpm: async (argv, opts = {}) => {
        calls.push(`pnpm-update:${argv.join(' ')}`)
        const profileRedirect = String(opts?.execOpts?.cwd ?? '')
        return onPnpmUpdate({ argv, profileDir: profileRedirect, pkgDir: profileRedirect === '' ? '' : pkgDirOf(profileRedirect) })
      },
      pnpmAdd: async (dir, spec) => { calls.push(`pnpm-add:${spec}`); return onPnpmAdd({ dir, spec, profileDir: dir, pkgDir: pkgDirOf(dir) }) },
      curlManualInstall: async (dir, name, registries, extra, version) => {
        calls.push(`manual-copy:${name}@${version}`)
        return onManualCopy({ dir, name, version, profileDir: dir, pkgDir: pkgDirOf(dir) })
      },
    },
  }
}

const runSelfUpdate = async ({ profileDir, latest = TARGET, steps, selfUpdateDeps = {} }) => selfUpdateToLatest({
  profileDir, latest, registries: ['https://registry.fake'], curlManualInstall: steps.deps.curlManualInstall,
  runPnpm: steps.deps.runPnpm, pnpmAdd: steps.deps.pnpmAdd, profileName: 'desktop', selfUpdateDeps,
})

const stepRowOf = (selfUpdate, step) => (Array.isArray(selfUpdate?.steps) ? selfUpdate.steps.find((row) => row.step === step) : undefined)

// ── ⑫ 正常三步：备份 → 每步各校验一次 → 通过 → 备份清理；返回结构逐项 ──────────────────────────
{
  const { profileDir, pkgDir } = makeSelfUpdateProfile('su-normal')
  const before = snapshotDir(pkgDir)
  let backupsDuringStep = []
  let savedDuringStep = null
  const steps = makeSelfUpdateSteps({
    // ① pnpm update 这一步"没装成"（真机被中断就是这个干法），由 ② 真的落地版本
    onPnpmUpdate: () => {
      backupsDuringStep = backupsOf(pkgDir)
      savedDuringStep = backupsDuringStep.length === 1 ? snapshotDir(join(dirname(pkgDir), backupsDuringStep[0])) : null
    },
    onPnpmAdd: ({ pkgDir: dir }) => landSelfVersion(dir, TARGET),
    // ③ curl 顺手把 lock 也写到目标版本（真机 lockUpdated 就是这么成立的）
    onManualCopy: ({ pkgDir: dir }) => { landSelfVersion(dir, TARGET); writeProfileLock(profileDir, TARGET) },
  })
  const res = await runSelfUpdate({ profileDir, steps })
  check('⑫ 更新前真的先做了备份（/self-update 通路也接管）', backupsDuringStep.length === 1, JSON.stringify(backupsDuringStep))
  check('⑫ 备份是**复制**出来的完整副本（内容 = 更新前那棵树）',
    savedDuringStep !== null && JSON.stringify(savedDuringStep) === JSON.stringify(before), JSON.stringify(Object.keys(savedDuringStep ?? {})))
  check('⑫ 三步都按既有条件跑到了（pnpm update → pnpm add → curl 手铺）',
    steps.calls.length === 3 && steps.calls[0].startsWith('pnpm-update:') && steps.calls[1].startsWith('pnpm-add:') && steps.calls[2].startsWith('manual-copy:'),
    JSON.stringify(steps.calls))
  check('⑫ ★ 每一步结束后都各校验一次（steps 三条，且点名是哪一步 / 哪一步之后目录是好的）',
    JSON.stringify((res.selfUpdate?.steps ?? []).map((row) => [row.step, row.verified])) === JSON.stringify([['pnpm-update', false], ['pnpm-add', true], ['manual-copy', true]]),
    JSON.stringify(res.selfUpdate?.steps ?? null))
  check('⑫ 校验通过：verified=true / backedUp=true / healed=false',
    res.selfUpdate?.verified === true && res.selfUpdate?.backedUp === true && res.selfUpdate?.healed === false,
    JSON.stringify({ verified: res.selfUpdate?.verified, backedUp: res.selfUpdate?.backedUp, healed: res.selfUpdate?.healed }))
  check('⑫ 通过时 ok=true、没有失败文案、不给手动命令',
    res.ok === true && res.reason === null && res.selfUpdate?.manualCommand === null,
    JSON.stringify({ ok: res.ok, reason: res.reason }))
  check('⑫ 本次备份被清理（不留垃圾）', backupsOf(pkgDir).length === 0, JSON.stringify(backupsOf(pkgDir)))
  check('⑫ 守卫没有改动插件目录（内容 = 三步跑完的那个状态：目标版本 + 新入口）',
    installedVersionOf(pkgDir) === TARGET && readFileSync(join(pkgDir, 'lib', 'index.js'), 'utf8') === 'export const ok = 2\n',
    String(installedVersionOf(pkgDir)))
  check('⑫ 既有字段的值语义不变（method / spec 跟随落地版本 / lock / lockNote / errors）',
    res.method === 'pnpm-update+pnpm-add+manual-copy' && res.spec === TARGET && res.installedVersion === TARGET
    && res.lockVersion === TARGET && res.lockUpdated === true && res.lockNote === null && Array.isArray(res.errors) && res.errors.length === 0,
    JSON.stringify({ method: res.method, spec: res.spec, installed: res.installedVersion, lock: res.lockVersion, lockUpdated: res.lockUpdated }))
}

// ── ⑬ pnpm 那步把目录掏空（真机现场）⇒ 后两步也救不回来 ⇒ 收尾自愈，绝不报成功 ────────────────
{
  const { profileDir, pkgDir } = makeSelfUpdateProfile('su-gutted')
  const steps = makeSelfUpdateSteps({
    // 现场：pnpm 先删旧目录再解包，删到一半被打断 ⇒ 只剩 scripts/ 与 SECURITY.md
    onPnpmUpdate: () => {
      rmSync(join(pkgDir, 'package.json'), { force: true })
      rmSync(join(pkgDir, 'lib'), { recursive: true, force: true })
    },
    onPnpmAdd: () => { throw new Error('桩：pnpm add 拒绝（EPERM: operation not permitted）') },
    onManualCopy: () => { throw new Error('桩：curl 也拿不到 tarball（404）') },
  })
  const res = await runSelfUpdate({ profileDir, steps })
  check('⑬ ★ 触发自愈：verified=false / healed=true / selfHeal.restored=true',
    res.selfUpdate?.verified === false && res.selfUpdate?.healed === true && res.selfUpdate?.selfHeal?.restored === true,
    JSON.stringify({ verified: res.selfUpdate?.verified, healed: res.selfUpdate?.healed }))
  check('⑬ ★ 目录被恢复：package.json 回来了、版本回到更新前那一版',
    existsSync(join(pkgDir, 'package.json')) && installedVersionOf(pkgDir) === OLD, String(installedVersionOf(pkgDir)))
  check('⑬ 残缺目录被**改名挪开**（不删，可事后核对）',
    brokensOf(pkgDir).length === 1 && !existsSync(join(dirname(pkgDir), brokensOf(pkgDir)[0], 'package.json')), JSON.stringify(brokensOf(pkgDir)))
  check('⑬ ★ 绝不报成功：ok=false、reason 说清"没有 package.json"这类现场',
    res.ok === false && String(res.reason ?? '').includes('自更新没有完成') && String(res.reason ?? '').includes('package.json'),
    String(res.reason ?? '').slice(0, 160))
  check('⑬ step 记录里哪一步坏的查得到（pnpm-update / pnpm-add / manual-copy 全 false）',
    (res.selfUpdate?.steps ?? []).length === 3 && (res.selfUpdate?.steps ?? []).every((row) => row.verified === false),
    JSON.stringify(res.selfUpdate?.steps ?? null))
  check('⑬ 失败那次的备份**留着**（唯一的旧版，别一起清掉）',
    backupsOf(pkgDir).length === 1 && res.selfUpdate?.backupPath === join(dirname(pkgDir), backupsOf(pkgDir)[0]), JSON.stringify(backupsOf(pkgDir)))
  check('⑬ 报出去的 installedVersion 是**盘上真实那一版**（自愈后 = 更新前），不是 null',
    res.installedVersion === OLD, String(res.installedVersion))
  check('⑬ 失败文案在 errors 与 note 里都看得见（面板/接口任一路径都读不成"成功"）',
    (res.errors ?? []).some((e) => String(e).includes('自更新没有完成')) && String(res.note ?? '').includes('自更新没有完成'),
    JSON.stringify(res.errors)?.slice(0, 120))
}

// ── ⑭ curl 手铺只铺一半 ⇒ 校验不过 ⇒ 自愈（step 记录指出坏在 manual-copy）─────────────────────
{
  const { profileDir, pkgDir } = makeSelfUpdateProfile('su-curl-half')
  const steps = makeSelfUpdateSteps({
    // ① 真的把版本装上了（这一步之后目录可用且版本对 ⇒ 该 step ok=true）
    onPnpmUpdate: () => landSelfVersion(pkgDir, TARGET),
    // ② 不会跑：readInstalledVersion === latest ⇒ 既有条件跳过（既有行为一字未改，这里也钉住）
    onPnpmAdd: () => { throw new Error('桩：pnpm add 不该被走到（版本已是 latest）') },
    // ③ lock 还是旧的 ⇒ 走手铺；手铺"只铺了一半"：清单丢了 version、入口文件也没了
    onManualCopy: () => {
      writeFixture(join(pkgDir, 'package.json'), `${JSON.stringify({ name: SELF, main: './lib/index.js' })}\n`)
      rmSync(join(pkgDir, 'lib'), { recursive: true, force: true })
    },
  })
  const res = await runSelfUpdate({ profileDir, steps })
  check('⑭ ★ step 记录指出坏在 manual-copy 那一步（前一步是好的）',
    stepRowOf(res.selfUpdate, 'pnpm-update')?.verified === true && stepRowOf(res.selfUpdate, 'manual-copy')?.verified === false
    && String(stepRowOf(res.selfUpdate, 'manual-copy')?.reason ?? '').includes('version'),
    JSON.stringify(res.selfUpdate?.steps ?? null))
  check('⑭ 既有步骤条件不变：版本已是 latest 时 pnpm add 那一步照旧被跳过',
    !steps.calls.some((c) => c.startsWith('pnpm-add:')), JSON.stringify(steps.calls))
  check('⑭ ★ 校验不过 ⇒ 自愈：healed=true、版本回到更新前',
    res.selfUpdate?.healed === true && installedVersionOf(pkgDir) === OLD,
    JSON.stringify({ healed: res.selfUpdate?.healed, version: installedVersionOf(pkgDir) }))
  check('⑭ 不报成功（ok=false + 非空 reason）', res.ok === false && typeof res.reason === 'string' && res.reason !== '')
  check('⑭ 残缺目录被改名保留（可核对半棵树长什么样）', brokensOf(pkgDir).length === 1, JSON.stringify(brokensOf(pkgDir)))
}

// ── ⑮ 三步全失败 ⇒ 如实报 + manualCommand 是真能跑的绝对路径命令 ────────────────────────────────
{
  // ⑮a 有备份 ⇒ 命令是"把备份整棵复制回来"（robocopy/cp），且那个备份真的还在盘上
  const { profileDir, pkgDir } = makeSelfUpdateProfile('su-all-fail')
  const steps = makeSelfUpdateSteps({
    onPnpmUpdate: () => { throw new Error('桩：pnpm update 失败（corepack 不可用）') },
    onPnpmAdd: () => { throw new Error('桩：pnpm add 失败（EPERM）') },
    onManualCopy: () => { throw new Error('桩：curl 失败（网络不可达）') },
  })
  const res = await runSelfUpdate({ profileDir, steps })
  const selfUpdate = res.selfUpdate ?? {}
  const command = String(selfUpdate.manualCommand ?? '')
  const quoted = [...command.matchAll(/"([^"]+)"/gu)].map((m) => m[1]).filter((p) => !/^https?:/u.test(p))
  check('⑮a ★ 三步全失败 ⇒ 如实报失败（ok=false + reason 点名目标版本）',
    res.ok === false && String(res.reason ?? '').includes('自更新没有完成') && String(res.reason ?? '').includes(TARGET),
    String(res.reason ?? '').slice(0, 180))
  check('⑮a 通道错误一条不少地留着（既有 errors 语义不变）',
    (res.errors ?? []).filter((e) => /失败/u.test(String(e))).length >= 3, JSON.stringify(res.errors)?.slice(0, 160))
  check('⑮a ★ manualCommand 是"备份 → 插件落点"的恢复命令，路径全绝对，且备份真的还在盘上（粘贴即用）',
    /^(robocopy|cp)\s/u.test(command) && quoted.length >= 2 && quoted.every((p) => /^[A-Za-z]:[\\/]/u.test(p) || p.startsWith('/'))
    && quoted.includes(pkgDir) && typeof selfUpdate.backupPath === 'string' && quoted.includes(selfUpdate.backupPath)
    && existsSync(selfUpdate.backupPath) === true,
    command.slice(0, 200))
  check('⑮a 自愈成功但如实说"没有生效"（healed=true 不等于更新成功）',
    selfUpdate.healed === true && String(res.reason ?? '').includes('没有生效'), String(res.reason ?? '').slice(-80))

  // ⑮b 没有备份（注入备份失败）⇒ 命令换成"从 registry 取一份解回原位"，同样全绝对路径
  const fragile = makeSelfUpdateProfile('su-all-fail-nobackup')
  const fragileSteps = makeSelfUpdateSteps({
    onPnpmUpdate: () => { throw new Error('桩：pnpm update 失败') },
    onPnpmAdd: () => { const error = new Error('EACCES: 桩：pnpm add 被拒'); error.code = 'EACCES'; throw error },
    onManualCopy: () => { throw new Error('桩：curl 失败') },
  })
  const fragileRes = await runSelfUpdate({
    profileDir: fragile.profileDir, steps: fragileSteps,
    selfUpdateDeps: { copy: () => { const error = new Error('EACCES: 桩：备份目录被占用'); error.code = 'EACCES'; throw error } },
  })
  const fragileCommand = String(fragileRes.selfUpdate?.manualCommand ?? '')
  const fragileQuoted = [...fragileCommand.matchAll(/"([^"]+)"/gu)].map((m) => m[1]).filter((p) => !/^https?:/u.test(p))
  check('⑮b ★ 没有备份 ⇒ 如实报"无法自动恢复"，命令换成 curl+tar 取一份回原位（全绝对路径）',
    fragileRes.ok === false && fragileRes.selfUpdate?.backedUp === false && fragileRes.selfUpdate?.selfHeal?.restored === false
    && /^(curl\.exe|curl)\s/u.test(fragileCommand) && fragileCommand.includes('registry.npmmirror.com')
    && fragileQuoted.length >= 3 && fragileQuoted.every((p) => /^[A-Za-z]:[\\/]/u.test(p) || p.startsWith('/')),
    fragileCommand.slice(0, 160))
  check('⑮b 占用类失败被认出来（不是普通异常），且仍不报成功',
    String(fragileRes.selfUpdate?.backupNote ?? '').includes('被占用') && fragileRes.ok === false,
    String(fragileRes.selfUpdate?.backupNote ?? '').slice(0, 120))
}

// ── ⑯ /self-update 通路的"不接管"：首次安装 / 别的包名 / 源码检出 ⇒ 零备份、selfUpdate 恒 null ──
{
  // ⑯a 本插件，但 profile 里根本没有它（首次安装）⇒ begin 直接 null
  const first = makeSelfUpdateProfile('su-first-install', { withSelf: false })
  const firstSteps = makeSelfUpdateSteps({
    onPnpmUpdate: () => { throw new Error('桩：pnpm update 失败') },
    onPnpmAdd: ({ pkgDir: dir }) => landSelfVersion(dir, TARGET),
    onManualCopy: ({ pkgDir: dir }) => { landSelfVersion(dir, TARGET); writeProfileLock(first.profileDir, TARGET) },
  })
  const firstRes = await runSelfUpdate({ profileDir: first.profileDir, steps: firstSteps })
  check('⑯a ★ 首次安装不接管：零备份、selfUpdate 恒 null、照旧按原语义报成功',
    backupsOf(first.pkgDir).length === 0 && firstRes.selfUpdate === null && firstRes.ok === true && firstRes.reason === null
    && firstRes.installedVersion === TARGET,
    JSON.stringify({ backups: backupsOf(first.pkgDir).length, selfUpdate: firstRes.selfUpdate, ok: firstRes.ok, installed: firstRes.installedVersion }))

  // ⑯b 别的包名（注入 selfName）⇒ 不接管；同一 profile 里就装着控制台自己也不为所动
  const other = makeSelfUpdateProfile('su-other-name')
  const otherSteps = makeSelfUpdateSteps({
    onPnpmUpdate: () => landSelfVersion(other.pkgDir, TARGET),
    onManualCopy: () => writeProfileLock(other.profileDir, TARGET),
  })
  const otherRes = await runSelfUpdate({ profileDir: other.profileDir, steps: otherSteps, selfUpdateDeps: { selfName: 'probe-pkg' } })
  check('⑯b ★ 别的包名 ⇒ 不接管（零备份 + selfUpdate=null），判据不按前缀匹配',
    backupsOf(other.pkgDir).length === 0 && otherRes.selfUpdate === null && otherRes.ok === true
    && guard.isSelfUpdate(`${SELF}-extra`) === false,
    JSON.stringify({ backups: backupsOf(other.pkgDir).length, selfUpdate: otherRes.selfUpdate }))

  // ⑯c 源码检出（父目录不是 node_modules）⇒ 守卫绝不动手（真机踩过：把整棵源码树当安装副本备份）
  const checkout = join(BASE, 'su-source-checkout', 'dsh-plugin-console')
  mkdirSync(checkout, { recursive: true })
  writeFixture(join(checkout, 'package.json'), `${JSON.stringify({ name: SELF, version: OLD, main: 'index.js' })}\n`)
  check('⑯c 源码检出 ⇒ beginSelfUpdateGuard 返回 null，且旁边没有任何 pre-update 副本',
    guard.beginSelfUpdateGuard({ packageName: SELF, packageDir: checkout }) === null && siblingsOf(checkout, '.pre-update-').length === 0,
    JSON.stringify(siblingsOf(checkout, '.pre-update-')))
  check('⑯c noteGuardStep 在"没接管"时是空操作（不会自己造 session / 造记录）',
    guard.noteGuardStep(null, 'pnpm-update') === null && guard.noteGuardStep(undefined, 'pnpm-add') === null)
}

// ── ⑰ 正控：既有 /self-update 响应字段逐项不变（静态解析视图 + 域层返回值 + 路由接线三侧都查）──────
// 视图（14 个旧字段 + 只许新增 selfUpdate/reason）已搬进 domain/self-update-guard.js#selfUpdateView ——
// 搬移是为了给 routes/plugins.js 腾出 600 行棘轮的余量，字段表达式逐字未改；这里同时钉住"路由确实调它"。
{
  const viewSrc = readFileSync(join(HERE, '..', 'lib', 'server', 'domain', 'self-update-guard.js'), 'utf8')
  const fnStart = viewSrc.indexOf('function selfUpdateView(')
  const bodyStart = viewSrc.indexOf('return {', fnStart)
  const bodyEnd = viewSrc.indexOf('\n  }', bodyStart)
  const block = viewSrc.slice(bodyStart, bodyEnd).replace(/\/\/[^\n]*/gu, '').replace(/\/\*[\s\S]*?\*\//gu, '')
  const keys = [
    ...block.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*:/gu).map((m) => m[1]),
    // `latest,` 这种**简写属性**没有冒号 —— 漏了它会把一个真在的字段误判成"缺"（另一份实现就踩过这颗雷）
    ...block.matchAll(/^\s*([A-Za-z_$][\w$]*),\s*$/gmu).map((m) => m[1]),
  ]
  const LEGACY = ['ok', 'current', 'latest', 'updated', 'version', 'method', 'spec', 'installedVersion', 'lockVersion', 'lockUpdated', 'lockNote', 'command', 'note', 'errors']
  const ADDED = ['selfUpdate', 'reason']
  const missing = LEGACY.filter((k) => !keys.includes(k))
  const unexpected = keys.filter((k) => !LEGACY.includes(k) && !ADDED.includes(k))
  check('⑰ ★ 既有 /self-update 返回字段一个都没少（14 项逐项对照）',
    missing.length === 0, missing.length === 0 ? `14 个旧字段全在：${LEGACY.join(', ')}` : `缺：${missing.join(', ')}`)
  check('⑰ ★ 只增了 selfUpdate / reason 两个字段（没有别的意外字段）',
    unexpected.length === 0, unexpected.length === 0 ? `新增：${ADDED.join(', ')}` : `意外字段：${unexpected.join(', ')}`)
  check('⑰ ★ ok / updated 同一事实（旧代码 updated 恒 true ⇒ 失败时会 {ok:false,updated:true} 自相矛盾）',
    block.includes('updated: ok') && !/updated:\s*true/u.test(block) && viewSrc.slice(fnStart, bodyEnd).includes('const ok = result?.ok !== false'),
    (block.match(/updated:[^\n,]*/u) ?? [''])[0])
  check('⑰ 路由真的调 selfUpdateView（视图搬走后接线没断，且不再内联一份字段表）',
    readFileSync(join(HERE, '..', 'lib', 'server', 'routes', 'plugins.js'), 'utf8').includes('sendJson(res, 200, selfUpdateView({ result, current: selfVersion, latest }))'))

  // 域层返回值的字段齐全性（undefined 会让路由下发时丢字段）
  const { profileDir, pkgDir } = makeSelfUpdateProfile('su-field-parity')
  const steps = makeSelfUpdateSteps({
    onPnpmUpdate: () => landSelfVersion(pkgDir, TARGET),
    onManualCopy: () => { landSelfVersion(pkgDir, TARGET); writeProfileLock(profileDir, TARGET) },
  })
  const res = await runSelfUpdate({ profileDir, steps })
  const DOMAIN_FIELDS = ['method', 'spec', 'installedVersion', 'lockVersion', 'lockUpdated', 'lockNote', 'command', 'note', 'errors', 'ok', 'reason', 'selfUpdate']
  const undef = DOMAIN_FIELDS.filter((k) => res[k] === undefined)
  check('⑰ ★ 域层返回的既有字段逐项都有值（undefined 等于下发时丢字段）', undef.length === 0,
    undef.length === 0 ? `${DOMAIN_FIELDS.join(', ')} 全有值` : `缺值：${undef.join(', ')}`)
  check('⑰ 既有字段的值语义不变（method / spec 跟随落地版本 / lock / command / note）',
    res.method === 'pnpm-update+manual-copy' && res.spec === TARGET && res.installedVersion === TARGET
    && res.lockUpdated === true && String(res.command).includes(`add ${SELF}@`) && typeof res.note === 'string' && res.note !== '',
    JSON.stringify({ method: res.method, spec: res.spec, installed: res.installedVersion, command: String(res.command).slice(0, 60) }))
}

// ── ⑱ 收尾自检：夹具绝不能污染仓库自身（真事故：pkgDir 为空时 join('') 变相对路径，写坏插件入口）──────
// 现场（2026-11-03）：`landSelfVersion('', …)` 把 `package.json` / `lib/index.js` 写进了**仓库根**，
// 于是 `test-route-inventory` / `test-compat-pending-records` 报 `mod.apply is not a function`。
// 现在：夹具写盘统一走 writeFixture（非绝对路径直接抛），这条再兜一层 —— 跑完必须还是真清单、真入口。
{
  const repoPkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'))
  const repoEntry = join(HERE, '..', 'lib', 'index.js')
  const entryMod = await import(url('lib/index.js'))
  check('⑱ ★ 仓库 package.json 没被夹具污染（真清单：包名/exports/files/dsh.bundle 都在，版本仍 0.5.100 未 bump）',
    repoPkg.name === SELF && repoPkg.version === '0.5.100' && repoPkg.exports?.['.'] === './lib/index.js'
    && Array.isArray(repoPkg.files) && repoPkg.dsh?.bundle?.patch === './cordis.patch.yml' && typeof repoPkg.repository?.url === 'string',
    `${repoPkg.name}@${repoPkg.version} files=${Array.isArray(repoPkg.files) ? repoPkg.files.length : 'none'}`)
  check('⑱ ★ 仓库 lib/index.js 没被夹具污染（能 import、导出 apply、体积正常）',
    typeof entryMod.apply === 'function' && statSync(repoEntry).size > 2000,
    `apply=${typeof entryMod.apply} size=${statSync(repoEntry).size}`)
  check('⑱ 夹具写盘入口对非绝对路径直接抛（负控：`join(\'\', …)` 这种相对路径写不出去）',
    (() => { try { writeFixture('lib/index.js', 'export const ok = 2\n'); return false } catch { return true } })())
}

const summary = `\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`
// 用写入回调把最后一屏刷出去再退出（直接 process.exit 在 Windows 上会截断重定向的最后几行）
process.stdout.write(`${summary}\n`, () => process.exit(fail === 0 ? 0 : 1))
