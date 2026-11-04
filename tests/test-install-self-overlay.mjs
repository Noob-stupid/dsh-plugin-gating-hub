// `/install` 上「目标就是本插件自己 ⇒ 覆盖式安装」的判据测试（2026-11-04 加法，纯离线）
//
// ── 现场（真机 2026-11-04 20:21，8 秒粒度采样）──────────────────────────────────────────────
//   用户点的是「**详情页的更新按钮**」—— 那颗按钮走 `POST /install`（lib/client.js#startJob → routes/install.js），
//   **不是** `POST /self-update`。所以 0.5.105「自更新彻底不走 pnpm」那套改动**一次都没被触发**：
//     20:21:14  目录 = 空壳（1 文件）   pnpm = 有 1 个在跑   备份 = 0
//     20:22:14  目录 = 空壳（1 文件）   pnpm = 仍在跑         备份 = 0
//   ⇒ 本套钉住的就是这条路：目标是自己 ⇒ **整条通道序列一条都不跑**（零 pnpm）、只覆盖不清空、
//     **lock 一个字节都不动**（用户拍板「不按 lock 不就行了」），失败路径**必须留着备份**。
//
// 本套钉死的判据（每条都要能失败；变异验证见交付报告）：
//   ① 目标是自己 ⇒ 全程零 pnpm（运行时计数 === 0 + 静态调用点 === 0），且竞速/curl/release 也一条都没跑
//   ② 覆盖后版本正确、tarball 里没有的既有文件仍在（preserved 计数 + 逐字内容）
//   ③ 失败路径 ⇒ 备份**还在**（旧判据会在这里把备份删掉：通道失败但目录原地没动 ⇒ verified 仍为 true）
//   ④ 负控：装**别的包** ⇒ 通道序列 / pnpm 调用次数 / 清单字节 / lock 字节逐项与改动前相同
//   ⑤ `/self-update` 行为不变：跑既有 tests/test-self-update-fallback.mjs 必须仍全绿
//   ⑥ 夹具不污染仓库（package.json / lib/index.js 逐字未变）
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const BASE = join(HERE, '.testdir', 'install-self-overlay')
// 隔离数据根：作业层会碰 DSH_HOME 下的东西（trash 清理 / 源配置）—— 绝不落到真实用户目录。
process.env.DSH_HOME = join(BASE, 'home')
// 本套全程离线（元数据/下载/解包都是桩 + 本地 tarball）；顺手打开 CI 的同一口径
process.env.DSH_TEST_SKIP_NETWORK = '1'

const url = (rel) => pathToFileURL(join(ROOT, rel)).href
const { tryCandidateChannels } = await import(url('lib/server/domain/install-channels.js'))
const { runInstallJob } = await import(url('lib/server/domain/install-job.js'))
const { installJobView } = await import(url('lib/server/domain/install.js'))
const overlayModule = await import(url('lib/server/domain/install-self-overlay.js'))

const SELF = '@noob-stupid/dsh-plugin-console'
const OTHER = 'probe-third-party-plugin'
const OLD = '0.5.100'
const TARGET = '0.5.101'

let pass = 0
let fail = 0
const check = (name, ok, info = '') => {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}
const skip = (name, why) => console.log(`SKIP ${name} — ${why}`)

rmSync(BASE, { recursive: true, force: true })
mkdirSync(BASE, { recursive: true })

// ── 夹具写盘的**唯一入口**：路径必须先是绝对路径，否则直接抛（真事故：join('', …) 把仓库 lib/index.js 写坏了）──
function writeFixture(absPath, content) {
  const target = String(absPath ?? '')
  if (target === '' || isAbsolute(target) !== true) throw new Error(`夹具拒绝写非绝对路径：${target}`)
  if (target.startsWith(join(ROOT, 'lib')) && target.endsWith(join('lib', 'index.js'))) throw new Error(`夹具拒绝写插件入口：${target}`)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
}
const readOrNull = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }

/** 能不能用系统 tar（生产代码的覆盖解包本身依赖它；没有就响亮 SKIP，不假装 PASS）。 */
function hasTar() {
  try { execFileSync('tar', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
}
const TAR_OK = hasTar()

/** npm 形态的 tarball：`package/` + 清单 + 入口 + 一个**只有新版才有**的文件。 */
function makeTarball(tag, { version = TARGET, name = SELF } = {}) {
  const work = join(BASE, 'tgz-src', tag)
  const pkg = join(work, 'package')
  writeFixture(join(pkg, 'package.json'), `${JSON.stringify({ name, version, main: './lib/index.js' }, null, 2)}\n`)
  writeFixture(join(pkg, 'lib', 'index.js'), 'export const ok = 2\n')
  writeFixture(join(pkg, 'NEWONLY.md'), '# 只有新版才有的文件\n')
  const tgz = join(BASE, 'tgz', `${tag}.tgz`)
  mkdirSync(dirname(tgz), { recursive: true })
  execFileSync('tar', ['-czf', tgz, '-C', work, 'package'], { stdio: 'ignore' })
  return { tgz, version }
}

/** 真机 lock 的形态（importers + packages + snapshots）。 */
function lockYaml(name, version, { integrity = 'sha512-OLD==' } = {}) {
  return [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    `      '${name}':`,
    '        specifier: ^0.5.100',
    `        version: ${version}`,
    '',
    'packages:',
    '',
    `  '${name}@${version}':`,
    `    resolution: {integrity: ${integrity}}`,
    '',
    'snapshots:',
    '',
    `  '${name}@${version}': {}`,
    '',
  ].join('\n')
}

/** 一个"已经装好旧版、宿主正在跑"的 profile（node_modules 里那份带两个**不在 tarball 里**的文件）。 */
function makeProfile(tag, { selfVersion = OLD, withSelf = true } = {}) {
  const profileDir = join(BASE, tag, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFixture(join(profileDir, 'cordis.patch.yml'), '# fixture\n')
  writeFixture(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: { [SELF]: '^0.5.100', [OTHER]: '^1.0.0' } }, null, 2)}\n`)
  writeFixture(join(profileDir, 'pnpm-lock.yaml'), lockYaml(SELF, OLD))
  const pkgDir = join(profileDir, 'node_modules', ...SELF.split('/'))
  if (withSelf) {
    writeFixture(join(pkgDir, 'package.json'), `${JSON.stringify({ name: SELF, version: selfVersion, main: './lib/index.js' }, null, 2)}\n`)
    writeFixture(join(pkgDir, 'lib', 'index.js'), 'export const ok = 1\n')
    writeFixture(join(pkgDir, 'SECURITY.md'), '# sec\n')
    writeFixture(join(pkgDir, 'EXTRA.sentinel'), '只有旧目录才有\n')
  }
  return { profileDir, pkgDir, lockFile: join(profileDir, 'pnpm-lock.yaml'), manifestFile: join(profileDir, 'package.json') }
}

const installedVersionOf = (pkgDir) => { try { return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version ?? null } catch { return null } }
const siblingsOf = (pkgDir, suffix) => { try { return readdirSync(dirname(pkgDir)).filter((n) => n.startsWith(`${SELF.split('/').pop()}${suffix}`)).sort() } catch { return [] } }
const backupsOf = (pkgDir) => siblingsOf(pkgDir, '.pre-update-')
const filesUnder = (dir) => {
  const out = []
  const walk = (cur, prefix) => {
    let entries = []
    try { entries = readdirSync(cur, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const rel = prefix === '' ? e.name : `${prefix}/${e.name}`
      if (e.isDirectory()) walk(join(cur, e.name), rel)
      else if (e.isFile()) out.push(rel)
    }
  }
  if (existsSync(dir)) walk(dir, '')
  return out.sort()
}
/** 文件指纹：SHA256 + mtime（"一个字节都不许动"）= 内容与时间戳都不变。 */
const fingerprintOf = (p) => {
  try {
    return { sha: createHash('sha256').update(readFileSync(p)).digest('hex'), mtime: statSync(p).mtimeMs }
  } catch { return { sha: null, mtime: null } }
}
const sameFingerprint = (a, b) => a.sha !== null && a.sha === b.sha && a.mtime === b.mtime

/** 通道桩：**每个**都计数（零 pnpm 的运行时证据；也证明整条序列没跑）。 */
function makeChannels({ onPnpm = null } = {}) {
  const calls = []
  return {
    calls,
    ch: {
      raceInstallChannels: async (dir, spec) => { calls.push(`race:${spec}`); return null },
      pnpmInstall: async (dir, spec) => { calls.push(`pnpm:${spec}`); if (typeof onPnpm === 'function') return onPnpm({ dir, spec }); return undefined },
      curlManualInstall: async (dir, name) => { calls.push(`curl:${name}`); if (typeof onPnpm === 'function') return onPnpm({ dir, name, channel: 'curl' }); throw new Error('桩：curl 不该被走到') },
      githubReleaseInstall: async () => { calls.push('release'); throw new Error('桩：release 不该被走到') },
      backfillMissingDeps: async () => [],
    },
  }
}

/** 覆盖式安装的替身依赖：元数据（桩）→ 下载（拷本地 tarball）→ 解包（系统 tar）。全离线。 */
function makeOverlayDeps({ tarballPath, onDownload = null } = {}) {
  const events = []
  return {
    events,
    deps: {
      env: {},
      tmpDir: () => { const dir = join(BASE, 'work'); mkdirSync(dir, { recursive: true }); return dir },
      fetchJson: async () => {
        events.push('meta')
        return { 'dist-tags': { latest: TARGET }, versions: { [TARGET]: { dist: { tarball: 'https://registry.fake/pkg.tgz', integrity: 'sha512-OVERLAYNEW==' } } } }
      },
      download: async (u, dest) => {
        events.push('download')
        if (typeof onDownload === 'function') onDownload()
        copyFileSync(tarballPath, dest)
      },
      extract: async (tgz, dir) => { events.push('extract'); execFileSync('tar', ['-xzf', tgz, '-C', dir], { stdio: 'ignore' }) },
    },
  }
}

const runChannels = async ({ profileDir, job, ch, selfOverlayDeps = undefined, name = job.packageName }) => tryCandidateChannels({
  job, ch, name, profileDir, registries: ['https://registry.fake'],
  repoChannelAllowed: false, budget: { release: 0 }, expanded: true, deadline: null,
  ...(selfOverlayDeps === undefined ? {} : { selfOverlayDeps }),
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ① 目标是自己 ⇒ 全程零 pnpm；② 版本正确、既有文件仍在；lock 一个字节都没动
// ══════════════════════════════════════════════════════════════════════════════════════════════
if (TAR_OK) {
  const { profileDir, pkgDir, lockFile, manifestFile } = makeProfile('self-overlay')
  const filesBefore = filesUnder(pkgDir)
  const lockBefore = fingerprintOf(lockFile)
  const manifestBefore = fingerprintOf(manifestFile)
  const tar = makeTarball('self')
  let backupsDuringDownload = []
  const overlay = makeOverlayDeps({
    tarballPath: tar.tgz,
    // 备份必须发生在**任何覆盖动作之前**（下载这一刻备份就该完整躺在盘上）
    onDownload: () => { backupsDuringDownload = backupsOf(pkgDir) },
  })
  const { calls, ch } = makeChannels()
  const job = { id: 'o1', repo: '', packageName: SELF, source: 'github', update: true, version: TARGET }
  const res = await runChannels({ profileDir, job, ch, selfOverlayDeps: overlay.deps })

  check('① 更新前真的先做了备份（自更新守卫照旧接管），且早于任何覆盖动作', backupsDuringDownload.length === 1, JSON.stringify(backupsDuringDownload))
  check('① ★★ 全程零 pnpm：通道桩一个都没被调用（竞速 / pnpm / curl / release 全 0）',
    calls.length === 0 && calls.filter((c) => c.startsWith('pnpm:')).length === 0, JSON.stringify(calls))
  check('① 覆盖式安装真的走了：元数据 → 下载 → 解包（三步都在，顺序正确）',
    JSON.stringify(overlay.events) === JSON.stringify(['meta', 'download', 'extract']), JSON.stringify(overlay.events))
  check('① 作业报装上，且 selfOverlay 如实记了现场（channel / files / preserved）',
    res.installedName === SELF && job.selfOverlay?.ok === true && job.selfOverlay?.channel === 'manual-overlay'
    && job.selfOverlay?.files === 3 && job.selfOverlay?.preserved === 2,
    JSON.stringify({ installed: res.installedName, overlay: job.selfOverlay }))
  check('② ★ 落地版本 = 目标版本（读磁盘核实，不看通道自报）', installedVersionOf(pkgDir) === TARGET, String(installedVersionOf(pkgDir)))
  check('② ★ tarball 里没有的既有文件**仍在**（SECURITY.md 逐字未变 + EXTRA.sentinel 还在）',
    readOrNull(join(pkgDir, 'SECURITY.md')) === '# sec\n' && readOrNull(join(pkgDir, 'EXTRA.sentinel')) === '只有旧目录才有\n',
    JSON.stringify(filesUnder(pkgDir)))
  check('② 覆盖确实发生了（入口换成新版内容、新版独有文件出现）',
    readOrNull(join(pkgDir, 'lib', 'index.js')) === 'export const ok = 2\n' && existsSync(join(pkgDir, 'NEWONLY.md')))
  check('② 一个原有文件都没被删（覆盖前的文件清单是覆盖后的子集）',
    filesBefore.every((rel) => filesAfterContains(pkgDir, rel)), JSON.stringify({ before: filesBefore, after: filesUnder(pkgDir) }))
  check('①② ★★ pnpm-lock.yaml 一个字节都没动（SHA + mtime 都不变）',
    sameFingerprint(lockBefore, fingerprintOf(lockFile)), JSON.stringify({ before: lockBefore, after: fingerprintOf(lockFile) }))
  check('①② ★ 清单一个字节都没动（SHA + mtime 都不变）',
    sameFingerprint(manifestBefore, fingerprintOf(manifestFile)), JSON.stringify({ before: manifestBefore, after: fingerprintOf(manifestFile) }))
  check('① 结果里如实写明"lock 没有改"（绝不谎报已同步）',
    job.selfOverlay?.lockTouched === false && String(job.selfOverlay?.lockNote ?? '').includes('本次没有改 pnpm-lock.yaml')
    && String(job.selfOverlay?.lockNote ?? '').includes('再点一次更新'),
    String(job.selfOverlay?.lockNote ?? '').slice(0, 160))
  check('① 守卫的同一判据也认可这次落地（verified=true / backedUp=true / healed=false）',
    job.selfUpdate?.verified === true && job.selfUpdate?.backedUp === true && job.selfUpdate?.healed === false,
    JSON.stringify({ verified: job.selfUpdate?.verified, backedUp: job.selfUpdate?.backedUp }))
  check('① 成功路径上本次备份被清理（不留垃圾）', backupsOf(pkgDir).length === 0, JSON.stringify(backupsOf(pkgDir)))
  check('① 视图里多出 selfOverlay（只增字段；既有 selfUpdate 契约不变）',
    installJobView(job).selfOverlay?.ok === true && installJobView(job).selfUpdate?.verified === true)
}
function filesAfterContains(dir, rel) { return filesUnder(dir).includes(rel) }

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ③ 失败路径：备份**必须还在**（旧判据在这里把它删掉了 —— 真机 `bak=1` → 8 秒后 `bak=0`）
//    场景刻意选"没点名版本"（`job.version = null`）：通道全失败、目录**原地没动** ⇒ 目录当然"完整"，
//    旧判据 `verified === true` 于是把备份当成"更新成功"删掉；随后 pnpm/清场把目录掏空 ⇒「备份目录不存在」。
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  // ③a 通道失败、但**目录原地没动**（非 EPERM ⇒ 不会走 cleanupStalePackageDir）：
  //     这一刻目录当然是"完整的自身副本" ⇒ 旧判据 `verified === true` 会把备份当成"更新成功"删掉。
  const { profileDir, pkgDir } = makeProfile('self-fail-keep-backup')
  const { calls, ch } = makeChannels({ onPnpm: () => { throw new Error('桩：pnpm 腿超时被杀（ETIMEDOUT: 90s 未完成）') } })
  const job = { id: 'o3', repo: '', packageName: SELF, source: 'github', update: true, version: null }
  // 覆盖式安装这条路：没有可用软件源 ⇒ 拿不到目标版本 ⇒ 落回既有通道序列（这一条正是真机那条路）
  const res = await runChannels({ profileDir, job, ch, selfOverlayDeps: { env: {} } })
  const backups = backupsOf(pkgDir)
  check('③ pnpm 腿真的失败了（桩被调用过）', calls.some((c) => c.startsWith('pnpm:')), JSON.stringify(calls))
  check('③ 没报装上（通道失败 ⇒ installedName=null）', res.installedName === null, String(res.installedName))
  check('③a 前置事实：目录**原地没动**（清单还在、版本仍是旧版）—— 这正是旧判据会误判的现场',
    installedVersionOf(pkgDir) === OLD, String(installedVersionOf(pkgDir)))
  check('③a ★★ 失败路径上备份**没有被删**（保留 = 唯一可回退的旧版）',
    backups.length === 1, JSON.stringify(backups))
  check('③a ★ 备份里就是更新前那一份（能恢复：清单 + 入口都在）',
    backups.length === 1 && existsSync(join(dirname(pkgDir), backups[0], 'package.json'))
    && readOrNull(join(dirname(pkgDir), backups[0], 'lib', 'index.js')) === 'export const ok = 1\n',
    JSON.stringify(backups))
  check('③a 守卫如实报的是"目录仍完整"（verified=true，没点名版本时这是它的既有口径）——但这次**并没有落地**',
    job.selfUpdate?.verified === true && job.selfUpdate?.manualCommand === null,
    JSON.stringify({ verified: job.selfUpdate?.verified ?? null, manualCommand: job.selfUpdate?.manualCommand ?? null }))
  check('③a 覆盖没成时如实记了"已回落既有通道"（不静默）',
    (installJobView(job).channelNotes ?? []).some((n) => String(n).includes('覆盖式安装没成功')), JSON.stringify(installJobView(job).channelNotes ?? []))
}

// ③b 通道失败 + 目录被**整个删掉**（EPERM ⇒ 既有 cleanupStalePackageDir 先删正式目录再重试）：
//     备份必须还在，而且守卫要能真的把它放回去（restoreSelfPackageDir 的"目录不存在"分支）。
{
  const { profileDir, pkgDir } = makeProfile('self-fail-dir-gone')
  const { ch } = makeChannels({ onPnpm: () => { throw new Error('桩：pnpm 腿失败（EPERM: operation not permitted）') } })
  const job = { id: 'o3b', repo: '', packageName: SELF, source: 'github', update: true, version: null }
  const res = await runChannels({ profileDir, job, ch, selfOverlayDeps: { env: {} } })
  const backups = backupsOf(pkgDir)
  check('③b 前置事实：既有通道把正式目录删掉了（真机"目录被清空"就是这一刀）',
    existsSync(join(pkgDir, 'package.json')) === false || job.selfUpdate?.healed === true,
    JSON.stringify({ hasManifest: existsSync(join(pkgDir, 'package.json')), healed: job.selfUpdate?.healed ?? null }))
  check('③b ★★ 目录被删的那条路上备份也**还在**', backups.length === 1, JSON.stringify(backups))
  check('③b ★ 守卫从备份把目录放回来了（healed=true 且版本回到更新前）',
    job.selfUpdate?.healed === true && installedVersionOf(pkgDir) === OLD,
    JSON.stringify({ healed: job.selfUpdate?.healed ?? null, version: installedVersionOf(pkgDir) }))
  check('③b 仍不报装上', res.installedName === null, String(res.installedName))
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ④ 负控：装**别的包** ⇒ 通道序列 / pnpm 调用次数 / 清单字节 / lock 字节逐项与改动前相同
//    期望序列是**基线（HEAD 07bcc6d）跑出来的同一串**，这里逐字硬编码（任何一步变了这条就红）。
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const { profileDir, lockFile, manifestFile } = makeProfile('other-pkg')
  const lockBefore = fingerprintOf(lockFile)
  const manifestBefore = fingerprintOf(manifestFile)
  const { calls, ch } = makeChannels()
  const job = { id: 'o4', repo: '', packageName: OTHER, source: 'github', update: true, version: null }
  const res = await runChannels({ profileDir, job, ch })
  check('④ ★ 别的包：通道序列与基线逐字相同（race → pnpm …）',
    JSON.stringify(calls) === JSON.stringify([`race:${OTHER}`, `pnpm:${OTHER}`]), JSON.stringify(calls))
  check('④ ★ 别的包：pnpm 腿照旧只被调用 1 次（多的、少的都算红）',
    calls.filter((c) => c.startsWith('pnpm:')).length === 1, JSON.stringify(calls))
  check('④ 别的包：照旧按原语义报装上', res.installedName === OTHER, String(res.installedName))
  check('④ 别的包：作业上不出现 selfOverlay / selfUpdate（只增字段，别的包恒 null）',
    !('selfOverlay' in job) && !('selfUpdate' in job), JSON.stringify(Object.keys(job)))
  check('④ ★ 别的包：profile 的 lock 一个字节都没动（SHA + mtime）',
    sameFingerprint(lockBefore, fingerprintOf(lockFile)), JSON.stringify({ before: lockBefore, after: fingerprintOf(lockFile) }))
  check('④ ★ 别的包：profile 的清单一个字节都没动（SHA + mtime）',
    sameFingerprint(manifestBefore, fingerprintOf(manifestFile)))
  check('④ 别的包：没有建任何备份（覆盖式这条路只对本插件自己生效）',
    siblingsOf(join(profileDir, 'node_modules', '@noob-stupid', 'dsh-plugin-console'), '.pre-update-').length === 0)
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ⑤ 静态双查：覆盖式这条路里**没有任何 pnpm 调用点**（运行时计数之外的第二个证据）
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const overlaySrc = readFileSync(join(ROOT, 'lib', 'server', 'domain', 'install-self-overlay.js'), 'utf8')
  const channelsSrc = readFileSync(join(ROOT, 'lib', 'server', 'domain', 'install-channels.js'), 'utf8')
  const pnpmCallRe = /\b(?:ch\.)?pnpmInstall\s*\(|\brunPnpmWithFallback\s*\(|\brunPnpm\s*\(|\bpnpmAdd\s*\(|\breconcileLockfile\s*\(/u
  check('⑤ ★ 静态：install-self-overlay.js 里**没有** pnpm / lock 对账的调用点',
    pnpmCallRe.test(overlaySrc) === false, (overlaySrc.match(pnpmCallRe) ?? [null])[0] ?? '（无）')
  check('⑤ 静态断言自检：这条正则对历史写法必须命中（否则它是假绿灯）',
    pnpmCallRe.test("await ch.pnpmInstall(profileDir, spec, reg)") === true && pnpmCallRe.test('await pnpmInstall(dir, spec)') === true)
  check('⑤ ★ 静态：覆盖式安装在通道序列**之前**就被尝试（铺成了就不会有通道被调用）',
    channelsSrc.indexOf('const overlay = await runSelfOverlayInstall(') > 0
    && channelsSrc.indexOf('const overlay = await runSelfOverlayInstall(') < channelsSrc.indexOf('outcome = await inner()'),
    `${channelsSrc.indexOf('runSelfOverlayInstall(')} < ${channelsSrc.indexOf('outcome = await inner()')}`)
  check('⑤ 静态：覆盖式安装模块只导出这一个入口 + 一个文案函数（没有第二套实现）',
    typeof overlayModule.runSelfOverlayInstall === 'function' && typeof overlayModule.selfOverlayNote === 'function'
    && Object.keys(overlayModule).sort().join(',') === 'OVERLAY_CHANNEL,SELF_OVERLAY_LOCK_NOTE,resolveSelfOverlayVersion,runSelfOverlayInstall,selfOverlayNote',
    JSON.stringify(Object.keys(overlayModule).sort()))
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ⑥ 作业层接线：目标是自己 ⇒ 走覆盖式安装、**不进任何 pnpm 收口**（persist / lock 对账一次都不跑）
// ══════════════════════════════════════════════════════════════════════════════════════════════
if (TAR_OK) {
  const { profileDir, pkgDir, lockFile, manifestFile } = makeProfile('job-wiring')
  const lockBefore = fingerprintOf(lockFile)
  const manifestBefore = fingerprintOf(manifestFile)
  const tar = makeTarball('job')
  const overlay = makeOverlayDeps({ tarballPath: tar.tgz })
  const { calls, ch } = makeChannels()
  const persistCalls = []
  const job = {
    id: 'o6', repo: '', source: 'github', packageName: SELF, status: 'installing', stage: 'preparing',
    update: true, version: TARGET, kind: 'plugin',
  }
  const ports = {
    baseUrl: 'file:///',
    get: (key) => (key === 'installChannels' ? ch : null),
    loader: { entries: () => [{ id: 'include', options: { name: 'cordis:include', group: true, config: { path: pathToFileURL(join(profileDir, 'cordis.yml')).href } } }] },
  }
  await runInstallJob(job, ports, {
    aiConsentTimeoutMs: 30,
    selfOverlayDeps: overlay.deps,
    // 收口那两步（lock 对账 / 持久化）**必须一次都不跑**：任何调用都记一笔
    persistDeps: {
      reconcile: async () => { persistCalls.push('reconcile'); throw new Error('桩：自更新不该做 lock 对账') },
      syncLock: false,
      installSource: async () => { persistCalls.push('install-source'); return { changed: false } },
      declare: async () => { persistCalls.push('declare'); return { changed: false, spec: null, depNote: null, lockNote: null, suggested: null } },
      pin: async () => { persistCalls.push('pin'); return { changed: false, after: null } },
    },
  })
  check('⑥ 作业成功（status=done）且落地版本 = 目标版本',
    job.status === 'done' && job.installedVersion === TARGET, `${job.status}/${job.installedVersion}`)
  check('⑥ ★★ 作业层同样零 pnpm：通道桩一次都没被调用',
    calls.length === 0, JSON.stringify(calls))
  check('⑥ ★★ 作业层没有做任何 lock 对账 / 持久化收口（那两步都会去动包管理器）',
    persistCalls.length === 0, JSON.stringify(persistCalls))
  check('⑥ ★★ lock 与清单在作业层这条路上也一个字节都没动',
    sameFingerprint(lockBefore, fingerprintOf(lockFile)) && sameFingerprint(manifestBefore, fingerprintOf(manifestFile)),
    JSON.stringify({ lock: fingerprintOf(lockFile), manifest: fingerprintOf(manifestFile) }))
  check('⑥ 面板会看到的那两句都在（curlNote = 覆盖式说明 / lockNote = lock 没改的后果）',
    String(job.curlNote ?? '').includes('没有清空目录') && String(job.lockNote ?? '').includes('本次没有改 pnpm-lock.yaml'),
    JSON.stringify({ curlNote: String(job.curlNote ?? '').slice(0, 80), lockNote: String(job.lockNote ?? '').slice(0, 80) }))
  check('⑥ 视图带 selfOverlay + installedVersion（面板能说清"是怎么更新的"）',
    installJobView(job).selfOverlay?.files === 3 && installJobView(job).installedVersion === TARGET)
  check('⑥ 目录里没被清空（原有 SECURITY.md / EXTRA.sentinel 都在）',
    existsSync(join(pkgDir, 'SECURITY.md')) && existsSync(join(pkgDir, 'EXTRA.sentinel')), JSON.stringify(filesUnder(pkgDir)))
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ⑥′ 目标是**链接**（link:/junction 安装 = 用户自己的源码树）⇒ 绝不覆盖（否则写进用户的工作区）
//    与 install-recovery 的边界③同一条理由：宁可不动手，也要说清为什么不动手（落回既有通道）。
// ══════════════════════════════════════════════════════════════════════════════════════════════
if (TAR_OK) {
  const { profileDir, pkgDir } = makeProfile('linked-install', { withSelf: false })
  // 用户自己的"源码检出"：node_modules/<包名> 是指向它的 junction
  const devDir = join(BASE, 'linked-install', 'my-dev-checkout')
  writeFixture(join(devDir, 'package.json'), `${JSON.stringify({ name: SELF, version: OLD, main: './lib/index.js' }, null, 2)}\n`)
  writeFixture(join(devDir, 'lib', 'index.js'), 'export const ok = 1\n')
  mkdirSync(dirname(pkgDir), { recursive: true })
  symlinkSync(devDir, pkgDir, 'junction')
  const devEntryBefore = readOrNull(join(devDir, 'lib', 'index.js'))
  const devFilesBefore = filesUnder(devDir)
  const tar = makeTarball('linked')
  const overlay = makeOverlayDeps({ tarballPath: tar.tgz })
  const { calls, ch } = makeChannels()
  const job = { id: 'o6b', repo: '', packageName: SELF, source: 'github', update: true, version: TARGET }
  await runChannels({ profileDir, job, ch, selfOverlayDeps: overlay.deps })
  check('⑥′ ★ 链接安装 ⇒ 不做覆盖式安装（selfOverlay 缺席、覆盖那三步没跑）',
    !('selfOverlay' in job) && overlay.events.includes('extract') === false, JSON.stringify({ keys: Object.keys(job), events: overlay.events }))
  check('⑥′ ★ 用户自己的源码树**一个字节都没被改**（入口内容与文件清单都不变）',
    readOrNull(join(devDir, 'lib', 'index.js')) === devEntryBefore
    && JSON.stringify(filesUnder(devDir)) === JSON.stringify(devFilesBefore),
    JSON.stringify(filesUnder(devDir)))
  check('⑥′ 落回既有通道序列（链路语义不变，行为与改动前一致）',
    calls.length > 0 && calls.some((c) => c.startsWith('pnpm:')), JSON.stringify(calls))
  check('⑥′ 如实记了为什么不覆盖（面板可见）',
    (installJobView(job).channelNotes ?? []).some((n) => String(n).includes('链接')), JSON.stringify(installJobView(job).channelNotes ?? []))
  try { rmSync(pkgDir, { recursive: true, force: true }) } catch {}
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ⑦ `/self-update` 通路行为不变：跑既有套件必须仍全绿（同仓库另一条自更新入口，本轮不许被带坏）
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const child = spawnSync(process.execPath, [join(HERE, 'test-self-update-fallback.mjs')], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, DSH_TEST_SKIP_NETWORK: '1' },
  })
  const out = `${child.stdout ?? ''}${child.stderr ?? ''}`
  const tail = out.trim().split('\n').slice(-1)[0] ?? ''
  check('⑦ ★ `/self-update` 既有套件仍全绿（零 pnpm / lock 行为一个字节都没变）',
    child.status === 0 && /ALL PASS/u.test(out), `exit=${child.status} ${tail.slice(0, 120)}`)
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ⑧ 夹具没污染仓库
// ══════════════════════════════════════════════════════════════════════════════════════════════
{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  check('⑧ ★ 仓库 package.json 没被夹具污染（真包名 / 真版本 0.5.106）',
    pkg.name === SELF && /^\d+\.\d+\.\d+$/u.test(pkg.version) && pkg.version === '0.5.106', `${pkg.name}@${pkg.version}`)
  const indexPath = join(ROOT, 'lib', 'index.js')
  const indexStat = statSync(indexPath)
  check('⑧ ★ 仓库 lib/index.js 没被夹具污染（体积正常、不是几百字节的假入口）',
    indexStat.size > 5000, String(indexStat.size))
}

if (TAR_OK !== true) skip('①②⑥ 覆盖式安装的三组判据', '本机没有可用的 tar（覆盖解包依赖它）')

console.log('')
console.log(fail === 0 ? `ALL PASS（PASS ${pass} / FAIL 0）` : `${fail} FAILED（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
