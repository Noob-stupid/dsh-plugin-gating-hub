// 超时/中断**不许把目录留在清空状态**（复核 + 恢复）的判据测试（2026-11-04 加法，纯离线）
//
// 现场（真机 2026-11-04，用户提供的原始日志）：pnpm 被 180s 超时杀整棵进程树之后没人收尾 ——
//   pnpm 的安装是"先把正式目录改名成 `_tmp_`、再解包新内容"，杀在中途就留下：
//       node_modules/@noob-stupid/dsh-plugin-console/ 只剩 1 个文件、package.json 没了
//   ⇒ 宿主解析不出这个包 ⇒ 面板「异常 / 包不可用」。同一次里 `.ignored` 已堆到 118 项 / 335 MB，
//   其中 workbuddy-connect 的 `_tmp_` 六十多个 ⇒ 这个失败模式**长期存在**，且**不止本插件**受影响。
//
// 本套钉死的判据（每条都要能失败）：
//   ① 备份在、目录被清空 ⇒ 收尾复核发现坏了 ⇒ 从**更新前的备份**恢复；并且**绝不报装上**
//   ①b 正控：安装真的落地了（目录完整）⇒ 校验通过、不动手、本次备份被清理（恢复那一层不会误伤成功）
//   ② 没有备份（备份失败）但 pnpm 留了 `_tmp_` 暂存目录 ⇒ 从**暂存目录**恢复
//   ③ 备份与暂存都没有 ⇒ 如实失败 + 一条**全绝对路径、可直接复制运行**的修复命令（绝不报成功）
//   ④ 「杀进程后**立刻**复核」：通道抛"被杀/超时"类错误时，**下一次通道调用看到的目录已经是完整的**
//   ⑤ 负控：普通失败（如 404）**不触发**即时恢复（只在收尾统一复核）
//   ⑥ 首次安装（安装前目录就不存在）⇒ 完全不接管：零备份、作业上无 installRecovery 字段、通道调用逐字不变
//   ⑦ link:/junction 安装（目标是开发树）⇒ 不接管（边界③，宁可不动手也不把开发树变成真目录副本）
//   ⑧ 体积上限：注入超上限的目录体积 ⇒ 跳过备份并**如实记原因**，且不阻断后续恢复路径
//   ⑨ 作业层接线：AI 授权被拒之后的清场**不许删掉刚恢复回来的那一份**（真机"目录被清空且回不来"的最后一刀）
//   ⑩ 契约：installJobView 只增 installRecovery（默认 null）；非自更新作业的 selfUpdate 恒 null
import { strict as assert } from 'node:assert'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = join(HERE, '.testdir', 'install-recovery')
process.env.DSH_HOME = join(BASE, 'home')

const url = (rel) => pathToFileURL(join(HERE, '..', rel)).href
const { tryCandidateChannels } = await import(url('lib/server/domain/install-channels.js'))
const { runInstallJob } = await import(url('lib/server/domain/install-job.js'))
const { installJobView } = await import(url('lib/server/domain/install.js'))
const recovery = await import(url('lib/server/domain/install-recovery.js'))
const { cleanupAttemptedCandidates, aiConsentFailureText } = await import(url('lib/server/domain/install-job.js'))

let pass = 0
let fail = 0
const check = (name, ok, info = '') => {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

rmSync(BASE, { recursive: true, force: true })

// ── 夹具写盘的唯一入口：非绝对路径直接抛（真事故：join('', …) 把仓库 lib/index.js 写坏了）
function writeFixture(absPath, content) {
  const target = String(absPath ?? '')
  if (target === '' || isAbsolute(target) !== true) throw new Error(`夹具拒绝写非绝对路径：${target}`)
  if (target.startsWith(join(HERE, '..', 'lib')) && target.endsWith(join('lib', 'index.js'))) throw new Error(`夹具拒绝写插件入口：${target}`)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

const PKG = '@demo/plugged'
const OLD = '1.2.0'
const TARGET = '1.3.0'

function makeProfile(tag, { version = OLD, withPkg = true } = {}) {
  const profileDir = join(BASE, tag, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  writeFixture(join(profileDir, 'cordis.patch.yml'), '# fixture\n')
  writeFixture(join(profileDir, 'package.json'), `${JSON.stringify({ name: `dsh-profile-${tag}`, private: true, dependencies: { [PKG]: `^${OLD}` } }, null, 2)}\n`)
  const pkgDir = join(profileDir, 'node_modules', ...PKG.split('/'))
  if (withPkg) {
    writeFixture(join(pkgDir, 'package.json'), `${JSON.stringify({ name: PKG, version, main: './lib/index.js' }, null, 2)}\n`)
    writeFixture(join(pkgDir, 'lib', 'index.js'), 'export const ok = 1\n')
    writeFixture(join(pkgDir, 'README.md'), `# ${PKG}\n`)
  }
  return { profileDir, pkgDir }
}

const versionOf = (pkgDir) => {
  try { return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version ?? null } catch { return null }
}
const siblingsOf = (pkgDir, suffix) => {
  try { return readdirSync(dirname(pkgDir)).filter((n) => n.startsWith(`${basename(pkgDir)}${suffix}`)).sort() } catch { return [] }
}
const backupsOf = (pkgDir) => siblingsOf(pkgDir, '.pre-update-')
const brokensOf = (pkgDir) => siblingsOf(pkgDir, '.broken-')

/** 真机那一刀：pnpm 删掉旧的那一棵、新的还没解开 ⇒ 只剩几个无关文件。 */
function emptyLikePnpm(pkgDir) {
  rmSync(join(pkgDir, 'package.json'), { force: true })
  rmSync(join(pkgDir, 'lib'), { recursive: true, force: true })
}

/** 通道桩：`onPnpm` 决定"这次安装造成什么后果"；`before` 在安装前执行（看现场）。 */
function makeChannels(record, { onPnpm = () => {}, onPnpmThrow = null, before = null, onRace = null } = {}) {
  return {
    raceInstallChannels: async (dir, spec) => {
      record.push(`race:${spec}`)
      if (typeof onRace === 'function') return onRace({ dir, spec })
      return null
    },
    pnpmInstall: async (dir, spec) => {
      record.push(`pnpm:${spec}`)
      if (typeof before === 'function') before({ dir, spec })
      if (onPnpmThrow !== null) throw onPnpmThrow
      return onPnpm({ dir, spec })
    },
    curlManualInstall: async () => { record.push('curl'); throw new Error('桩：curl 不该被走到') },
    githubReleaseInstall: async () => { record.push('release'); throw new Error('桩：release 不该被走到') },
    backfillMissingDeps: async () => [],
  }
}

const runChannels = async ({ profileDir, ch, job, name = PKG, recoveryDeps = undefined }) => tryCandidateChannels({
  job, ch, name, profileDir, registries: ['https://registry.fake'],
  repoChannelAllowed: false, budget: { release: 0 }, expanded: true, deadline: null,
  ...(recoveryDeps === undefined ? {} : { recoveryDeps }),
})
const jobOf = (id, extra = {}) => ({ id, repo: '', packageName: PKG, source: 'github', update: true, version: null, ...extra })

// ── ① 备份在、目录被清空 ⇒ 从备份恢复，且绝不报装上 ─────────────────────────────────
{
  const { profileDir, pkgDir } = makeProfile('heal-from-backup')
  const record = []
  const ch = makeChannels(record, { onPnpm: () => emptyLikePnpm(pkgDir) })
  const job = jobOf('r1')
  const res = await runChannels({ profileDir, ch, job })
  const report = job.installRecovery ?? {}
  check('① ★ 收尾复核发现目录坏了 ⇒ healed=true / restoredFrom=backup',
    report.healed === true && report.restoredFrom === 'backup', JSON.stringify({ healed: report.healed, from: report.restoredFrom }))
  check('① ★ 旧版本真的回来了（package.json + 版本都在盘上）',
    existsSync(join(pkgDir, 'package.json')) && versionOf(pkgDir) === OLD, String(versionOf(pkgDir)))
  check('① ★ 绝不报"装上了"（通道 stub 是 resolve 的，但目录被弄坏了）', res?.installedName === null, String(res?.installedName))
  check('① 文案说清"没有生效"（不是更新成功）', /没有生效/u.test(String(res?.lastError?.message ?? '')), String(res?.lastError?.message ?? '').slice(0, 140))
  check('① 残缺的那棵树被**改名保留**（不删，可事后核对）', brokensOf(pkgDir).length === 1, JSON.stringify(brokensOf(pkgDir)))
  check('① 报告里记着"安装前是什么/安装后是什么"（杀进程前先记录的关键事实）',
    report.before?.version === OLD && report.before?.ok === true && report.after?.ok === true, JSON.stringify({ before: report.before, after: report.after }))
  check('① 失败/恢复之后备份**留着**（那是唯一能回退的旧版）', backupsOf(pkgDir).length === 1, JSON.stringify(backupsOf(pkgDir)))
}

// ── ①b 正控：安装真的落地 ⇒ 校验通过、不动手、本次备份被清理 ─────────────────────────
{
  const { profileDir, pkgDir } = makeProfile('healthy-landing')
  const record = []
  const ch = makeChannels(record, {
    onPnpm: () => {
      writeFixture(join(pkgDir, 'package.json'), `${JSON.stringify({ name: PKG, version: TARGET, main: './lib/index.js' })}\n`)
      writeFixture(join(pkgDir, 'lib', 'index.js'), 'export const ok = 2\n')
    },
  })
  const job = jobOf('r1b', { version: TARGET })
  const res = await runChannels({ profileDir, ch, job })
  const report = job.installRecovery ?? {}
  check('①b ★ 落地完整 ⇒ verified=true、healed=false（恢复那一层不误伤成功）',
    report.verified === true && report.healed === false, JSON.stringify({ verified: report.verified, healed: report.healed }))
  check('①b ★ 照旧报装上（既有成功语义不变）', res?.installedName === PKG, String(res?.installedName))
  check('①b 本次备份被清理（不留垃圾）', backupsOf(pkgDir).length === 0, JSON.stringify(backupsOf(pkgDir)))
  check('①b 版本记录如实（before=旧、after=新）', report.before?.version === OLD && report.after?.version === TARGET,
    JSON.stringify({ before: report.before?.version, after: report.after?.version }))
  check('①b 通过时不挂失败文案、不给手动命令',
    report.reason === null && report.manualCommand === null, JSON.stringify({ reason: report.reason, command: report.manualCommand }))
}

// ── ② 没有备份，但有 pnpm 暂存目录（`_tmp_`）⇒ 从暂存目录恢复 ────────────────────────
{
  const { profileDir, pkgDir } = makeProfile('heal-from-staging')
  // 真机日志里的形状：pnpm 把正式目录改名成 `<pkg>_tmp_<pid>_<n>`
  const staging = join(dirname(pkgDir), `${basename(pkgDir)}_tmp_13796_2`)
  writeFixture(join(staging, 'package.json'), `${JSON.stringify({ name: PKG, version: OLD, main: './lib/index.js' })}\n`)
  writeFixture(join(staging, 'lib', 'index.js'), 'export const ok = 1\n')
  const record = []
  const ch = makeChannels(record, { onPnpm: () => emptyLikePnpm(pkgDir) })
  const job = jobOf('r2')
  const res = await runChannels({
    profileDir, ch, job,
    recoveryDeps: { copy: () => { const error = new Error('EACCES: 桩：备份目录被占用'); error.code = 'EACCES'; throw error } },
  })
  const report = job.installRecovery ?? {}
  check('② ★ 备份失败也**不阻断**（走到校验这一步，backedUp=false）', report.backedUp === false, JSON.stringify({ backedUp: report.backedUp }))
  check('② ★ 没有备份时改用 **pnpm 暂存目录** 恢复（restoredFrom=staging）',
    report.healed === true && report.restoredFrom === 'staging', JSON.stringify({ healed: report.healed, from: report.restoredFrom }))
  check('② 恢复后盘上是完整的一份（package.json + 版本）', versionOf(pkgDir) === OLD, String(versionOf(pkgDir)))
  check('② 仍不报装上', res?.installedName === null, String(res?.installedName))
}

// ── ③ 备份与暂存都没有 ⇒ 如实失败 + 可直接运行的手动命令 ─────────────────────────────
{
  const { profileDir, pkgDir } = makeProfile('no-rescue')
  const record = []
  const ch = makeChannels(record, { onPnpm: () => emptyLikePkg(profileDir, pkgDir) })
  function emptyLikePkg(_dir, dir) { rmSync(dir, { recursive: true, force: true }) }
  const job = jobOf('r3')
  const res = await runChannels({
    profileDir, ch, job,
    recoveryDeps: { copy: () => { throw new Error('桩：备份写不出去') } },
  })
  const report = job.installRecovery ?? {}
  const command = String(report.manualCommand ?? '')
  const quoted = [...command.matchAll(/"([^"]+)"/gu)].map((m) => m[1]).filter((p) => !/^https?:/u.test(p))
  check('③ ★ 恢复不了就如实报（verified=false / healed=false）', report.verified === false && report.healed === false,
    JSON.stringify({ verified: report.verified, healed: report.healed }))
  check('③ ★ 绝不报成功（installedName=null + 有原因）',
    res?.installedName === null && /没有落地/u.test(String(res?.lastError?.message ?? '')), String(res?.lastError?.message ?? '').slice(0, 120))
  check('③ ★ manualCommand 是**真能跑**的命令（curl/tar 起头 + registry tarball）',
    /^(curl\.exe|curl)\s/u.test(command) && command.includes(`/${PKG}/-/`) && command.includes(`plugged-${OLD}.tgz`), command.slice(0, 160))
  check('③ manualCommand 里的路径全是**绝对路径**，且落在插件目录',
    quoted.length >= 3 && quoted.every((p) => /^[A-Za-z]:[\\/]/u.test(p) || p.startsWith('/')) && quoted.includes(pkgDir), JSON.stringify(quoted))
  check('③ 报告里说清"没有可用备份/暂存"的原因', typeof report.selfHeal?.reason === 'string' && report.selfHeal.reason !== '',
    String(report.selfHeal?.reason ?? '').slice(0, 120))
}

// ── ④ 「杀进程后**立刻**复核」：下一次通道调用看到的目录已经恢复 ────────────────────────
{
  const { profileDir, pkgDir } = makeProfile('kill-then-check')
  const record = []
  let sawHealthyOnNextCall = null
  const killedError = new Error('Command failed: pnpm add x\n（超时 180000ms：已终止整棵进程树 pid=25340，等待 2000ms 后确认已退出）')
  killedError.killed = true
  killedError.timedOut = true
  const ch = makeChannels(record, {
    // 第一次：模拟 pnpm 删掉旧目录后被超时杀掉
    onPnpmThrow: killedError,
    before: ({ dir }) => { if (dir !== '' && existsSync(join(dir, 'node_modules', ...PKG.split('/'), 'package.json'))) sawHealthyOnNextCall = true },
    onPnpm: () => {},
  })
  const job = jobOf('r4')
  // 第一次 pnpm 调用会抛（且抛之前已经把目录清空）：用一个包装的通道把"清空"和"抛错"排在一起
  const realPnpm = ch.pnpmInstall
  let pnpmCalls = 0
  ch.pnpmInstall = async (dir, spec, ...rest) => {
    pnpmCalls += 1
    if (pnpmCalls === 1) emptyLikePnpm(pkgDir) // 先清空（pnpm 删旧目录），再被超时杀掉
    return await realPnpm(dir, spec, ...rest)
  }
  await runChannels({ profileDir, ch, job })
  const report = job.installRecovery ?? {}
  const channelRows = (report.timeline ?? []).filter((row) => String(row.trigger ?? '').startsWith('channel:'))
  check('④ ★ 通道抛"被杀/超时"之后**立刻**记了一条复核（timeline 里有 channel 记录）',
    channelRows.length >= 1, JSON.stringify(report.timeline ?? []).slice(0, 200))
  check('④ ★ 那一条记录显示恢复成功（restored=true / from=backup）',
    channelRows[0]?.restored === true && channelRows[0]?.restoredFrom === 'backup', JSON.stringify(channelRows[0] ?? null))
  check('④ ★ 恢复发生在**序列结束之前**（后面那条通道看到的是完整目录）', sawHealthyOnNextCall === true, String(sawHealthyOnNextCall))
}

// ── ④b 不接管：包已装好且不是"更新"请求（通道会短路"跳过重复下载"）⇒ 不备份、零接管 ─────────
// 省掉一次整目录复制（大包可能是几十 MB），判据与 install-verify.js#alreadyInstalledTarget 同一把尺子。
{
  const { profileDir, pkgDir } = makeProfile('not-an-update')
  const record = []
  const ch = makeChannels(record, { onPnpm: () => { throw new Error('桩：这条路上 pnpm 不该被走到') } })
  const job = jobOf('r4b', { update: false })
  const res = await runChannels({ profileDir, ch, job })
  check('④b ★ 已装好 + 非更新请求 ⇒ 不接管（零备份、无 installRecovery 字段）',
    backupsOf(pkgDir).length === 0 && !('installRecovery' in job), JSON.stringify(Object.keys(job)))
  check('④b 既有语义不变：直接报"已检测到本地已安装，跳过重复下载"并算装上',
    res?.installedName === PKG && /跳过重复下载/u.test(String(job.curlNote ?? '')), `${res?.installedName} / ${String(job.curlNote ?? '').slice(0, 60)}`)
}

// ── ④c 恢复之后**还有通道真的装上了** ⇒ 那是成功，不能报失败（否则是"假红"）─────────────
{
  const { profileDir, pkgDir } = makeProfile('heal-then-land')
  const record = []
  const killedError = new Error('Command failed: pnpm add x\n（超时 90000ms：已终止整棵进程树 pid=4242，等待 2000ms 后确认已退出）')
  killedError.killed = true
  const ch = makeChannels(record, {
    // 竞速那一步被超时杀掉，且它已经把旧目录清空了
    onRace: () => { emptyLikePnpm(pkgDir); throw killedError },
    // 之后的串行 pnpm 真的把新版本装上了
    onPnpm: () => {
      writeFixture(join(pkgDir, 'package.json'), `${JSON.stringify({ name: PKG, version: TARGET, main: './lib/index.js' })}\n`)
      writeFixture(join(pkgDir, 'lib', 'index.js'), 'export const ok = 2\n')
    },
  })
  const job = jobOf('r4c', { version: TARGET })
  const res = await runChannels({ profileDir, ch, job })
  const report = job.installRecovery ?? {}
  check('④c ★ 中途恢复过、但后面真的装上了 ⇒ landed=true（不把成功判成失败）',
    report.healed === true && report.landed === true, JSON.stringify({ healed: report.healed, landed: report.landed, verified: report.verified }))
  check('④c ★ 照旧报装上，盘上是新版本', res?.installedName === PKG && versionOf(pkgDir) === TARGET, `${res?.installedName} / ${versionOf(pkgDir)}`)
  check('④c 恢复动作仍留在 timeline 里（事后能查"中途被杀过一次"）',
    (report.timeline ?? []).some((row) => String(row.trigger ?? '').startsWith('channel:')), JSON.stringify(report.timeline ?? []).length > 0)
}

// ── ⑤ 负控：普通失败（404）不触发即时恢复 ────────────────────────────────────────────
{
  const { profileDir, pkgDir } = makeProfile('plain-failure')
  const record = []
  const ch = makeChannels(record, { onPnpmThrow: new Error('404 Not Found - GET https://registry.fake/@demo%2fplugged') })
  const job = jobOf('r5')
  await runChannels({ profileDir, ch, job })
  const report = job.installRecovery ?? {}
  const channelRows = (report.timeline ?? []).filter((row) => String(row.trigger ?? '').startsWith('channel:'))
  check('⑤ ★ 普通失败不触发"被杀即恢复"（timeline 里没有 channel 记录）', channelRows.length === 0, JSON.stringify(report.timeline ?? []))
  check('⑤ 收尾仍然复核了一次（目录本来就是好的 ⇒ verified=true）', report.verified === true, JSON.stringify({ verified: report.verified }))
  check('⑤ 目录一个字没被动（版本仍是旧的那版）', versionOf(pkgDir) === OLD, String(versionOf(pkgDir)))
}

// ── ⑥ 首次安装：完全不接管（零备份、无字段、通道调用逐字不变）─────────────────────────
{
  const runOne = async (tag, withPkg) => {
    const { profileDir, pkgDir } = makeProfile(tag, { withPkg })
    const record = []
    const ch = makeChannels(record, {
      onPnpm: () => {
        writeFixture(join(pkgDir, 'package.json'), `${JSON.stringify({ name: PKG, version: TARGET, main: './lib/index.js' })}\n`)
        writeFixture(join(pkgDir, 'lib', 'index.js'), 'export const ok = 2\n')
      },
    })
    const job = jobOf(`r6-${tag}`)
    const res = await runChannels({ profileDir, ch, job })
    return { record, job, res, pkgDir }
  }
  const first = await runOne('first-install', false)
  check('⑥ ★ 首次安装不接管：没有备份、作业上不出现 installRecovery 字段',
    backupsOf(first.pkgDir).length === 0 && !('installRecovery' in first.job), JSON.stringify({ backups: backupsOf(first.pkgDir).length, keys: Object.keys(first.job) }))
  check('⑥ 首次安装照旧按原语义报装上', first.res?.installedName === PKG, String(first.res?.installedName))
  check('⑥ 通道调用序列与"原来那条路"逐字一致（竞速一次 + pnpm 一次，顺序不变）',
    JSON.stringify(first.record) === JSON.stringify([`race:${PKG}`, `pnpm:${PKG}`]), JSON.stringify(first.record))
}

// ── ⑦ link:/junction 安装（开发树）⇒ 不接管 ──────────────────────────────────────────
{
  const { profileDir, pkgDir } = makeProfile('linked', { withPkg: false })
  const source = join(BASE, 'linked', 'dev-tree')
  writeFixture(join(source, 'package.json'), `${JSON.stringify({ name: PKG, version: OLD, main: './lib/index.js' })}\n`)
  writeFixture(join(source, 'lib', 'index.js'), 'export const ok = 1\n')
  mkdirSync(dirname(pkgDir), { recursive: true })
  let linked = true
  try { symlinkSync(source, pkgDir, 'junction') } catch { linked = false }
  if (linked !== true) {
    check('⑦ 跳过（本机建不了 junction）', true, 'skipped')
  } else {
    check('⑦ 夹具确实是链接（边界③的前提）', lstatSync(pkgDir).isSymbolicLink() === true)
    const record = []
    const ch = makeChannels(record, { onPnpm: () => {} })
    const job = jobOf('r7')
    const res = await runChannels({ profileDir, ch, job })
    check('⑦ ★ 链接安装**不接管**（作业上没有 installRecovery、零备份）',
      !('installRecovery' in job) && backupsOf(pkgDir).length === 0, JSON.stringify(Object.keys(job)))
    check('⑦ 源码树没被改成真目录副本（仍是链接）', lstatSync(pkgDir).isSymbolicLink() === true)
    check('⑦ 通道照旧跑完（既有行为不变）', res?.installedName === PKG, String(res?.installedName))
  }
}

// ── ⑧ 体积上限：跳过备份并如实记原因（不阻断，也不假装有备份）─────────────────────────
{
  const { profileDir, pkgDir } = makeProfile('size-cap')
  const record = []
  const ch = makeChannels(record, { onPnpm: () => emptyLikePnpm(pkgDir) })
  const job = jobOf('r8')
  const res = await runChannels({ profileDir, ch, job, recoveryDeps: { sizeOf: () => 999 * 1024 * 1024 } })
  const report = job.installRecovery ?? {}
  check('⑧ ★ 超体积上限 ⇒ backupSkipped=true、backedUp=false', report.backupSkipped === true && report.backedUp === false,
    JSON.stringify({ skipped: report.backupSkipped, backedUp: report.backedUp }))
  check('⑧ 原因里写清"超过上限/没有建备份"', /备份上限|没有.*建备份/u.test(String(report.backupNote ?? '')), String(report.backupNote ?? '').slice(0, 120))
  check('⑧ 盘上确实没有备份目录（不假装备份过）', backupsOf(pkgDir).length === 0, JSON.stringify(backupsOf(pkgDir)))
  check('⑧ 没有备份时仍如实失败（不报装上）', res?.installedName === null, String(res?.installedName))
}

// ── ⑨ 作业层接线：AI 授权被拒后的清场**不许删掉**刚恢复回来的那一份 ────────────────────
{
  const { profileDir, pkgDir } = makeProfile('job-protect')
  const record = []
  const ch = makeChannels(record, { onPnpm: () => emptyLikePnpm(pkgDir) })
  const ports = {
    baseUrl: 'file:///',
    get: (key) => (key === 'installChannels' ? ch : null),
    loader: { entries: () => [{ id: 'include', options: { name: 'cordis:include', group: true, config: { path: pathToFileURL(join(profileDir, 'cordis.yml')).href } } }] },
  }
  const job = {
    id: 'r9', repo: '', source: 'github', packageName: PKG, status: 'installing', stage: 'preparing',
    update: true, version: null, kind: 'plugin', candidateTotal: 1,
  }
  await runInstallJob(job, ports, { aiConsentTimeoutMs: 30 })
  check('⑨ ★ 作业如实失败（不是 done）', job.status === 'failed', `${job.status}/${job.stage}`)
  check('⑨ ★ 恢复回来的那一份**还在盘上**（清场没有把它删掉）',
    existsSync(join(pkgDir, 'package.json')) && versionOf(pkgDir) === OLD, String(versionOf(pkgDir)))
  check('⑨ ★ 清场报告里把它标成 protected（不是"清了"也不是"漏了"）',
    Array.isArray(job.leftovers?.protected) && job.leftovers.protected.includes(PKG), JSON.stringify(job.leftovers?.protected ?? null))
  check('⑨ ★ 错误文案明说"已保留 … 不清场"（用户不会以为我们忘了清场）',
    String(job.error ?? '').includes('已保留') && String(job.error ?? '').includes(PKG), String(job.error ?? '').slice(0, 200))
  check('⑨ 错误文案里带"没有落地/没有生效"的如实结论（不是"安装失败"了事）',
    /没有落地|没有生效/u.test(String(job.error ?? '')), String(job.error ?? '').slice(0, 200))
}

// ── ⑩ 契约：视图只增 installRecovery；非自更新作业的 selfUpdate 恒 null ──────────────────
{
  const view = installJobView({ id: 'v', status: 'failed', packageName: PKG })
  check('⑩ 未触发恢复时 installRecovery 恒 null', view.installRecovery === null, JSON.stringify(view.installRecovery))
  check('⑩ 非自更新包的 selfUpdate 仍是 null（既有契约不变）', view.selfUpdate === null, JSON.stringify(view.selfUpdate))
  const { profileDir, pkgDir } = makeProfile('view-field')
  const ch = makeChannels([], { onPnpm: () => emptyLikePnpm(pkgDir) })
  const job = jobOf('r10')
  await runChannels({ profileDir, ch, job })
  check('⑩ 触发恢复时视图里带 installRecovery（healed 可见）', installJobView(job).installRecovery?.healed === true,
    JSON.stringify(installJobView(job).installRecovery?.healed ?? null))
}

// ── ⑪ 负控：清场的保护名单真的生效（不传 protect 时照旧清场 —— 既有行为不变）───────────
{
  const { profileDir, pkgDir } = makeProfile('cleanup-control', { withPkg: true })
  const kept = cleanupAttemptedCandidates(profileDir, [PKG], { protect: [PKG] })
  check('⑪ ★ 传 protect ⇒ 目录不动、单独汇报在 protected 里',
    existsSync(join(pkgDir, 'package.json')) && kept.protected.includes(PKG) && !kept.cleaned.includes(PKG), JSON.stringify(kept))
  const removed = cleanupAttemptedCandidates(profileDir, [PKG])
  check('⑪ ★ 不传 protect ⇒ 照旧清场（老调用点行为一个字都没变）',
    existsSync(join(pkgDir, 'package.json')) === false && removed.cleaned.includes(PKG) && (removed.protected ?? []).length === 0, JSON.stringify(removed))
  const text = aiConsentFailureText({ approved: false, timeout: true }, { cleaned: ['@a/b'], protected: ['@a/c'] })
  check('⑪ 文案把"已保留"说出来（与"已清理"并列，不混）', text.includes('已保留 @a/c') && text.includes('已清理本次落盘残留：@a/b'), text)
}

const summary = `\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`
process.stdout.write(`${summary}\n`, () => process.exit(fail === 0 ? 0 : 1))
