// 依赖锁体检 / 重建的**真实环境**验证（隔离 profile，真 registry + 真 pnpm；2026-09-27 加法）
//
// 复现的是 live web profile 的真实形状（stale lock + 一个 registry 上 404 的依赖），但**全程在隔离目录**
// （仓库内 .testdir/lockfile-repair-home，DSH_HOME 也指过去）—— 绝不动用户的真实 profile。
//
// 三条必须被真实证伪/证实的结论：
//   ① 体检能**点名** 404 依赖（`packages404`）；
//   ② 重建动作在 404 依赖上**明确失败并给出包名**（action=blocked），绝不静默删依赖、绝不改文件；
//   ③ 把假依赖修掉之后，重建 lock 成功，且随后 **plugin add / remove 能跑通**（走产品自己的 pnpm 通道）。
//
// 环境依赖与"响亮的跳过"：真实 registry / 真 pnpm 缺一不可。缺了会打印 **SKIP + 具体原因**（绝不静默，
// 也绝不假装 PASS）；`DSH_TEST_SKIP_NETWORK=1`（CI 模式）时同样打印 SKIP 原因。
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runLockfileCheck, runLockfileRepair } from '../lib/server/domain/lockfile-health.js'
import { pnpmInstall } from '../lib/server/domain/install.js'
import { pnpmRemove } from '../lib/server/domain/install-job.js'
import { removeDirVerifiedAsync } from '../lib/server/infra/fsx.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REGISTRY = 'https://registry.npmmirror.com'
const HOME = join(ROOT, '.testdir', 'lockfile-repair-home')
const PROFILE = join(HOME, 'profiles', 'web')
process.env.DSH_HOME = HOME

const GOOD_DEP = 'left-pad'
const GOOD_SPEC = '1.3.0'
const FAKE_DEP = '@dsh-probe/definitely-missing-9f3a2b'
const ADD_DEP_SPEC = 'is-odd@3.0.1'
const ADD_DEP = 'is-odd'

let failed = 0
let skipped = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const skip = (label, reason) => { skipped += 1; console.log(`SKIP ${label} —— ${reason}`) }

const pkgPath = join(PROFILE, 'package.json')
const lockPath = join(PROFILE, 'pnpm-lock.yaml')
const writeManifest = (deps) => writeFileSync(pkgPath, JSON.stringify({ name: 'dsh-profile-lockfix', private: true, dependencies: deps }, null, 2) + '\n', 'utf8')
// 故意陈旧残缺的 lock：只有 left-pad，且钉在不满足清单的旧版本与旧 specifier 上
const STALE_LOCK = [
  "lockfileVersion: '9.0'", '',
  'importers:', '',
  '  .:', '    dependencies:',
  '      left-pad:', '        specifier: ^1.1.0', '        version: 1.1.3',
  '', 'packages:', '',
  '  left-pad@1.1.3:', '    resolution: {integrity: sha512-x}', '',
].join('\n')

rmSync(HOME, { recursive: true, force: true })
mkdirSync(PROFILE, { recursive: true })
writeManifest({ [GOOD_DEP]: GOOD_SPEC, [FAKE_DEP]: '1.0.0' })
writeFileSync(lockPath, STALE_LOCK, 'utf8')
const manifestBefore = readFileSync(pkgPath, 'utf8')

// ── 环境门：网络 / pnpm 不可用时**响亮跳过**（打印原因，不假装 PASS）──────────────
// 注意：这里只用 `pnpm --version` 探活，**不能**用一次真安装来探活 ——
// 夹具的 lock 故意是陈旧的，而控制台的 pnpm env 带 CI=true（frozen-lockfile），
// 拿"装一次"当探活必然撞上 ERR_PNPM_OUTDATED_LOCKFILE，把"环境不可用"和"待修的现场"混为一谈。
const networkOff = process.env.DSH_TEST_SKIP_NETWORK === '1'
let pnpmUsable = true
let pnpmError = null
if (!networkOff) {
  try {
    const { runPnpmWithFallback } = await import('../lib/server/infra/exec.js')
    await runPnpmWithFallback(['--version'], { execOpts: { cwd: PROFILE, timeout: 60000, windowsHide: true } })
  } catch (error) {
    pnpmUsable = false
    pnpmError = String(error?.message ?? error).slice(0, 600)
  }
}
if (networkOff || !pnpmUsable) {
  skip('真实的「体检点名 + 重建 + add/remove」端到端验证',
    networkOff ? 'DSH_TEST_SKIP_NETWORK=1（CI 模式：真实 registry / 真 pnpm 不参与门禁）' : `真 pnpm 通道不可用：${pnpmError}`)
  console.log('\nALL PASS（**真实环境 1 组未验证** —— 见上面的 SKIP 原因）')
  try { await removeDirVerifiedAsync(HOME, { attempts: 1, pollMs: 300 }) } catch {}
  process.exit(failed === 0 ? 0 : 1)
}

const manifestBeforeCheck = readFileSync(pkgPath, 'utf8')
const lockBeforeCheck = readFileSync(lockPath, 'utf8')

// ── ① 只读体检：点名 404 依赖 + 指出 lock 陈旧，且不改文件 ──────────────────────
const view = await runLockfileCheck({ profileDir: PROFILE, registries: [REGISTRY] })
console.log(`体检：ok=${view.ok} problems=${view.problems.map((p) => p.kind).join(',')} packages404=${JSON.stringify(view.packages404)}`)
if (view.problems.some((p) => p.kind === 'network-timeout')) {
  skip('真实的「体检点名 + 重建 + add/remove」端到端验证',
    `registry 不可达（${JSON.stringify(view.problems.find((p) => p.kind === 'network-timeout').packages)}）——本机网络/镜像问题，不是逻辑问题`)
  console.log(`\nALL PASS（**真实环境 ${skipped} 组未验证** —— 见上面的 SKIP 原因）`)
  try { await removeDirVerifiedAsync(HOME, { attempts: 1, pollMs: 300 }) } catch {}
  process.exit(failed === 0 ? 0 : 1)
}
check('★ ① 体检点名 registry 上 404 的依赖（真 registry：npmmirror 返回 404）',
  view.packages404.includes(FAKE_DEP), JSON.stringify(view.packages404))
check('★ ① 体检同时报出陈旧的 lock（重复声明 + 缺项）',
  view.problems.some((p) => p.kind === 'lockfile-outdated') && view.outdated.missing.includes(FAKE_DEP),
  JSON.stringify(view.outdated))
check('★ ① 有 404 依赖时体检明确说"不能重建"（applicable=false, blockedBy=fetch-404）',
  view.repair.applicable === false && view.repair.blockedBy.includes('fetch-404'), JSON.stringify(view.repair))
check('★ ① 体检是只读的：清单与 lock 逐字节未变',
  readFileSync(pkgPath, 'utf8') === manifestBeforeCheck && readFileSync(lockPath, 'utf8') === lockBeforeCheck)

// ── ② 重建动作：在 404 依赖上明确失败并给出包名，不静默删依赖、不改文件 ──────────
const blocked = await runLockfileRepair({ profileDir: PROFILE, registries: [REGISTRY] })
console.log(`重建（有 404 依赖）：action=${blocked.action} kind=${blocked.kind} packages=${JSON.stringify(blocked.packages)}`)
check('★ ② 重建在 404 依赖上明确失败（action=blocked，不是"成功"也不是"部分成功"）',
  blocked.ok === false && blocked.action === 'blocked' && blocked.kind === 'fetch-404', `${blocked.action}/${blocked.kind}`)
check('★ ② 失败信息里给出具体包名（用户知道该去修哪个依赖）',
  blocked.packages.includes(FAKE_DEP) && blocked.hint.includes(FAKE_DEP), JSON.stringify(blocked.packages))
check('★ ② 阻塞时一个文件都没改（清单与 lock 逐字节未变），也没有把依赖从清单里删掉',
  readFileSync(pkgPath, 'utf8') === manifestBeforeCheck && readFileSync(lockPath, 'utf8') === lockBeforeCheck
  && JSON.parse(readFileSync(pkgPath, 'utf8')).dependencies[FAKE_DEP] === '1.0.0')
check('★ ② 阻塞发生在启动 pnpm 之前（响应里没有 pnpm 原始输出尾巴，且 lock 仍是原样）',
  blocked.stderrTail === null && blocked.reason.includes('未改任何文件'),
  `stderrTail=${blocked.stderrTail === null ? 'null' : '有'} reason=${blocked.reason}`)

// ── ③ 修掉假依赖 → 重建成功，lock 与清单对齐 ────────────────────────────────────
writeManifest({ [GOOD_DEP]: GOOD_SPEC })
const manifestAfterDrop = readFileSync(pkgPath, 'utf8')
const repaired = await runLockfileRepair({ profileDir: PROFILE, registries: [REGISTRY] })
console.log(`重建（依赖都可达）：action=${repaired.action} ok=${repaired.ok} before.missing=${JSON.stringify(repaired.before?.missing)} after.missing=${JSON.stringify(repaired.after?.missing)}`)
check('★ ③ 去掉 404 依赖后重建成功（action=repaired, ok=true）',
  repaired.ok === true && repaired.action === 'repaired', `${repaired.action}/${repaired.kind ?? '-'}`)
check('★ ③ 重建后 lock 与清单对齐：不再缺项、不再有 specifier/版本漂移',
  repaired.after.missing.length === 0 && repaired.after.specifierMismatch.length === 0 && repaired.after.versionMismatch.length === 0,
  JSON.stringify(repaired.after))
check('★ ③ 重建只改 pnpm-lock.yaml：package.json 逐字节未变（依赖没被 pnpm 顺手动过）',
  readFileSync(pkgPath, 'utf8') === manifestAfterDrop)
const lockNow = readFileSync(lockPath, 'utf8')
check('★ ③ 重建后的 lock 里 left-pad 钉在 1.3.0 且 specifier 与清单一致',
  /left-pad:[\s\S]{0,80}specifier: 1\.3\.0[\s\S]{0,40}version: 1\.3\.0/u.test(lockNow), lockNow.split('\n').filter((l) => l.includes('left-pad')).join(' | '))
const recheck = await runLockfileCheck({ profileDir: PROFILE, registries: [REGISTRY] })
check('★ ③ 复检：同一个体检接口现在报 ok=true（修好了就是修好了）',
  recheck.ok === true && recheck.outdated.missing.length === 0, JSON.stringify(recheck.problems.map((p) => p.kind)))

// ── ④ 重建之后，产品自己的 pnpm 通道（plugin add / remove）能跑通 ────────────────
let addOk = false
let addError = null
try {
  await pnpmInstall(PROFILE, ADD_DEP_SPEC, REGISTRY, 120000)
  addOk = true
} catch (error) {
  addError = String(error?.message ?? error).slice(0, 300)
}
const addInstalled = existsSync(join(PROFILE, 'node_modules', ADD_DEP, 'package.json'))
const lockAfterAdd = readFileSync(lockPath, 'utf8')
check('★ ④ plugin add（控制台 pnpm 通道）跑通：包真落到磁盘', addOk && addInstalled, addError ?? '')
check('★ ④ add 之后 lock 里也记下了这个依赖（否则下次 pnpm 操作会把它还原）',
  new RegExp(`\\n\\s+${ADD_DEP}:\\n\\s+specifier:`, 'u').test(lockAfterAdd), lockAfterAdd.split('\n').filter((l) => l.includes(ADD_DEP)).join(' | '))
let removeOk = false
let removeError = null
try {
  await pnpmRemove(PROFILE, ADD_DEP)
  removeOk = true
} catch (error) {
  removeError = String(error?.message ?? error).slice(0, 300)
}
check('★ ④ plugin remove 跑通：包目录已删、清单里也不再有它',
  removeOk && !existsSync(join(PROFILE, 'node_modules', ADD_DEP))
  && !(ADD_DEP in (JSON.parse(readFileSync(pkgPath, 'utf8')).dependencies ?? {})),
  removeError ?? `exists=${existsSync(join(PROFILE, 'node_modules', ADD_DEP))}`)

// ── 收尾：隔离目录清掉（用仓库自己的"删除+核实"助手）─────────────────────────────
const cleaned = await removeDirVerifiedAsync(HOME, { attempts: 2, pollMs: 400 })
check('隔离 profile 目录已清掉（不留测试残留）', cleaned.ok === true || !existsSync(HOME), JSON.stringify(cleaned))
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}（真实环境：${skipped} 组 SKIP）`)
process.exit(failed === 0 ? 0 : 1)
