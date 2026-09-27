// 「按 registry 可解析性决定写回形态」的专项验证（2026-09-27 改错 + 加法；任务 B 的五条逐条钉死）
//
// 真问题（用户在真机上量到的状态，不是推测）：
//   desktop profile 的清单里写着 `@dsh-external/dsh-graded-mode: 0.0.1-rc1`，而 npmmirror 与 npmjs
//   **双双 404** —— 下次任何 pnpm 操作都是 ERR_PNPM_FETCH_404；同时面板在安装完成时却报了
//   「已按 link: 形式记录依赖」（文案硬编码，没读回真实值）。本用例把修复钉成五条：
//   ① 非 registry 包 → 清单写 link:（不是会 404 的裸版本号）
//   ② 写清单后**自动做一次 lock 对账**，lock 里真有这条 link 条目
//   ③ 随后 `pnpm install --lockfile-only` 退出码 0、不再报 404（**真 pnpm**，link: 不走 registry）
//   ④ 文案按**实际写入形态**生成：写回没生效时绝不出现"已按 link: 形式记录依赖"
//   ⑤ registry 可解析的包行为不变（回归：仍写 <name>@<版本>）
//
// 分组与门槛（缺环境要**响亮跳过**，绝不假装 PASS）：
//   组 1/2/4  离线：桩探测 + 桩 pnpm（形态、对账调用、文案）与**真 pnpm**（本地 link:，不出外网）—— 进 CI 硬门槛
//   组 3      真 registry：走产品路径（真探测 + 真 pnpm 对账）；DSH_TEST_SKIP_NETWORK=1 或镜像不可达时 SKIP
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { declareProfileDependency, specOf } from '../lib/server/domain/manifest.js'
import { reconcileLockfile, lockVersion } from '../lib/server/domain/selfupdate.js'
import { repairArgsFor } from '../lib/server/domain/lockfile-health.js'
import { probeFailureKind } from '../lib/server/domain/dep-source.js'
import { runPnpmWithFallback } from '../lib/server/infra/exec.js'
import { removeDirVerifiedAsync } from '../lib/server/infra/fsx.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REGISTRY = 'https://registry.npmmirror.com'
const HOME = join(ROOT, '.testdir', 'dep-pin-home')
const PROFILE = join(HOME, 'profiles', 'web')
process.env.DSH_HOME = HOME

// 只存在于"本地/release"的包名（registry 上不可能有它；组 1/2/4 全程用桩，组 3 真探它）
const FAKE = '@dsh-probe/release-only-9f3a2b'
const FAKE_VERSION = '0.0.1-rc1'
// registry 上确实存在的包（回归用）
const REAL = 'left-pad'
const REAL_VERSION = '1.3.0'

let failed = 0
let skipped = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const skip = (label, reason) => { skipped += 1; console.log(`SKIP ${label} —— ${reason}`) }

const manifestPath = join(PROFILE, 'package.json')
const lockPath = join(PROFILE, 'pnpm-lock.yaml')
const pluginSrc = join(HOME, 'plugin-src', ...FAKE.split('/'))
const writeManifest = (deps) => writeFileSync(manifestPath, `${JSON.stringify({ name: 'dsh-profile-dep-pin', private: true, dependencies: deps }, null, 2)}\n`, 'utf8')
const readDeps = () => JSON.parse(readFileSync(manifestPath, 'utf8')).dependencies ?? {}
const writeLock = (text) => writeFileSync(lockPath, text, 'utf8')

// 桩：registry 探测（三种结论）+ pnpm add（记录 argv；可选模拟 pnpm 真写了清单）
// 两种注入缝要分清（混用会让"404"与"网络失败"走到同一个出口，测试就失去分辨力）：
//   · `probe:`     —— 直接替换**探针函数**，返回探针形状 { resolvable, hasVersion, tried }
//   · `fetchJson:` —— 替换的是探针内部的**取包元数据**那一步，返回值必须是 packument
//     （探针只认 `versions` / `dist-tags`；返回别的形状会被判成"返回体没有 versions 字段"→ 网络类失败）
const probe404 = async () => ({ resolvable: false, hasVersion: false, latest: null, registry: null, tried: [`${REGISTRY}：HTTP 404 Not Found`] })
const probeDown = async () => ({ resolvable: false, hasVersion: false, latest: null, registry: null, tried: ['stub：fetch failed（网络不可达）'] })
const probeOk = async (name, registries, options = {}) => ({ resolvable: true, hasVersion: true, latest: options.version ?? null, registry: 'stub', tries: [] })
const fetch404 = async () => { throw new Error(`GET ${REGISTRY}/x：HTTP 404 Not Found`) }
const fetchDown = async () => { throw new Error('fetch failed（网络不可达）') }
const fetchOk = async () => ({ 'dist-tags': { latest: REAL_VERSION }, versions: { [REAL_VERSION]: { name: REAL, version: REAL_VERSION } } })

rmSync(HOME, { recursive: true, force: true })
// 夹具：包已装在 node_modules（含 package.json + 入口），plugin-src 里**没有**副本（要由物化步骤造出来）
const fakeDir = join(PROFILE, 'node_modules', ...FAKE.split('/'))
mkdirSync(fakeDir, { recursive: true })
writeFileSync(join(fakeDir, 'package.json'), JSON.stringify({ name: FAKE, version: FAKE_VERSION, main: 'index.js' }, null, 2), 'utf8')
writeFileSync(join(fakeDir, 'index.js'), 'export const ok = true\n', 'utf8')
// 回归用的真包也"已装在磁盘上"（对账只处理读得到版本的包；读不到的包本就不该被动）
const realDir = join(PROFILE, 'node_modules', REAL)
mkdirSync(realDir, { recursive: true })
writeFileSync(join(realDir, 'package.json'), JSON.stringify({ name: REAL, version: REAL_VERSION, main: 'index.js' }, null, 2), 'utf8')
writeManifest({ [FAKE]: FAKE_VERSION })

console.log('=== 组 ①②④ 离线：写回形态 / lock 对账调用 / 文案一致性（桩） ===')
{
  // ── ④ 负例：pnpm add 什么都没做成（pnpm 静默失败/被别处覆盖）→ 文案**必须**如实说"未生效"
  const argvLog = []
  const stubNoop = async (profileDir, spec) => { argvLog.push(spec) }
  writeManifest({ [FAKE]: FAKE_VERSION })
  writeLock("lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n")
  const plan = await reconcileLockfile({ profileDir: PROFILE, packages: [{ name: FAKE }], registries: [REGISTRY], fetchJson: fetch404, pnpmAdd: stubNoop })
  check('★ ④ pnpm add 没生效时：文案不出现"已按 link: 形式记录依赖"（谎报修复）',
    typeof plan.depNote === 'string' && !plan.depNote.includes('已按 link: 形式记录依赖') && plan.depNote.includes('未生效'),
    String(plan.depNote).slice(0, 150))
  check('★ ④ 未生效时如实带上"清单里实际是什么" + 探测结论是"查无此包"（不是网络类）',
    plan.depNote.includes(FAKE_VERSION) && plan.depNote.includes('查无此包'), String(plan.depNote).slice(0, 150))
  check('★ ④ 未生效时下发结构化「钉住」动作（面板可一键执行；payload 里没有任何命令字符串）',
    Array.isArray(plan.suggestedActions) && plan.suggestedActions[0]?.kind === 'pin-dependency'
    && plan.suggestedActions[0]?.payload?.action === 'pin-dependency' && plan.suggestedActions[0]?.payload?.packageName === FAKE,
    JSON.stringify(plan.suggestedActions?.[0]?.payload))
  check('★ ④ 未生效时 lockUpdated=false（不假装成功）', plan.lockUpdated === false && typeof plan.lockNote === 'string', `lockUpdated=${plan.lockUpdated}`)
  check('★ ② 对账确实调了 pnpm add，且参数是 link: 形式（不是会 404 的裸版本号）',
    argvLog.length === 1 && String(argvLog[0]).startsWith(`link:`) && String(argvLog[0]).endsWith(FAKE.replace('/', '/')), JSON.stringify(argvLog))
  check('★ ① 物化发生了：<DSH_HOME>/plugin-src/<包名> 里有真包（link 目标存在，不是悬空链接）',
    existsSync(join(pluginSrc, 'package.json')) && JSON.parse(readFileSync(join(pluginSrc, 'package.json'), 'utf8')).version === FAKE_VERSION,
    pluginSrc)
  check('① 探测结论判据：HTTP 404 → fetch-404（写回走 link: 的唯一依据）',
    probeFailureKind({ tried: [`${REGISTRY}：HTTP 404 Not Found`] }) === 'fetch-404'
    && probeFailureKind({ tried: ['fetch failed'] }) === 'network-timeout')

  // ── ④ 正例：模拟 pnpm 真的把 link 写进了清单 → 这时才允许出现"已按 link: 形式记录依赖"
  // 桩必须**照真 pnpm 的行为**模拟（本机实测，nodeLinker: hoisted）：`pnpm add link:<绝对路径>` 会
  // ① 清单原样保留 link:<绝对路径> ② 把 node_modules/<包名> 从真实目录换成**Junction** ③ 写 lock。
  // 少了 ③ 的这一环，linkSpecIsIntact 会判为"链接被打断"，lockUpdated 就永远是 false（与真机不符）。
  const stubReal = async (profileDir, spec) => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dependencies[FAKE] = spec
    writeManifest(manifest.dependencies)
    writeLock(`lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      '${FAKE}':\n        specifier: ${spec}\n        version: link:../../plugin-src/${FAKE}\n`)
    const target = join(profileDir, 'node_modules', ...FAKE.split('/'))
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(join(HOME, 'plugin-src', ...FAKE.split('/')), target, 'junction')
  }
  writeManifest({ [FAKE]: FAKE_VERSION })
  const planOk = await reconcileLockfile({ profileDir: PROFILE, packages: [{ name: FAKE }], registries: [REGISTRY], fetchJson: fetch404, pnpmAdd: stubReal })
  const actual = readDeps()[FAKE]
  check('★ ② 写回生效后：清单是 link:、lock 有条目、lockUpdated=true',
    String(actual).startsWith('link:') && String(lockVersion(PROFILE, FAKE)).startsWith('link:') && planOk.lockUpdated === true,
    `spec=${actual} lock=${lockVersion(PROFILE, FAKE)} updated=${planOk.lockUpdated}`)
  check('★ ④ 写回生效后才出现"已按 link: 形式记录依赖"，且文案里的路径与清单**当前值**一致',
    typeof planOk.depNote === 'string' && planOk.depNote.includes('已按 link: 形式记录依赖') && planOk.depNote.includes(actual),
    String(planOk.depNote).slice(0, 160))
  check('★ ④ 生效时不再下发建议动作（不需要用户再做什么）',
    Array.isArray(planOk.suggestedActions) && planOk.suggestedActions.length === 0, JSON.stringify(planOk.suggestedActions))

  // ── ⑤ 回归：registry 可解析的包 → 仍写 <name>@<版本>，绝不改成 link:
  const versionArgs = []
  writeManifest({ [REAL]: REAL_VERSION })
  writeLock("lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n")
  const planVersion = await reconcileLockfile({
    profileDir: PROFILE, packages: [{ name: REAL }], registries: [REGISTRY], fetchJson: fetchOk,
    pnpmAdd: async (profileDir, specs) => { versionArgs.push(specs) },
  })
  check('★ ⑤ 回归：registry 可解析的包写的是 <name>@<版本>（不是 link:）',
    versionArgs.length === 1 && versionArgs[0] === `${REAL}@${REAL_VERSION}`, JSON.stringify(versionArgs))

  // ── 网络探测没成功（不是 404）时：不猜、也不谎报，写版本号 + 如实记 note + 给建议动作
  writeManifest({ [FAKE]: FAKE_VERSION })
  const unknown = await declareProfileDependency(PROFILE, FAKE, null, { syncLock: false, probe: probeDown })
  check('★ 探测不到（网络）时 form=unknown、清单仍是版本号、note 里不出现"已按 link: 形式记录"',
    unknown.form === 'unknown' && readDeps()[FAKE] === FAKE_VERSION
    && !String(unknown.depNote).includes('已按 link: 形式记录') && unknown.suggested?.kind === 'pin-dependency',
    JSON.stringify({ form: unknown.form, spec: readDeps()[FAKE] }))
}

console.log('\n=== 组 ②③ 真 pnpm（本地 link:，不出外网）：lock 有条目 + --lockfile-only 退出码 0 ===')
// 先用产品路径（桩探测）把清单写成 link:（物化 + 写清单 + lock 对账用桩 pnpm 关掉，交给真 pnpm）
let pnpmUsable = true
let pnpmError = null
try {
  await runPnpmWithFallback(['--version'], { execOpts: { cwd: PROFILE, timeout: 60000, windowsHide: true } })
} catch (error) {
  pnpmUsable = false
  pnpmError = String(error?.message ?? error).slice(0, 400)
}
if (!pnpmUsable) {
  skip('真 pnpm 组（lock 条目 + --lockfile-only 退出码 0 + 裸版本号复现 404）', `真 pnpm 通道不可用：${pnpmError}`)
} else {
  rmSync(lockPath, { force: true })
  const declared = await declareProfileDependency(PROFILE, FAKE, null, { syncLock: false, probe: probe404 })
  check('★ ① 产品路径：404 依赖在清单里就是 link:（form=link）',
    declared.form === 'link' && String(readDeps()[FAKE]).startsWith('link:'), `${declared.form}/${readDeps()[FAKE]}`)

  // ③ 真 pnpm：只重写 lock（argv 由产品自己唯一产出 —— 顺带断言它**不带**任何绕过供应链闸的开关）
  const args = repairArgsFor(REGISTRY)
  check('③ 重建 argv 由 repairArgsFor 唯一产出，且不含 minimumReleaseAge 之类的绕过开关',
    args.join(' ') === `install --lockfile-only --no-frozen-lockfile --registry ${REGISTRY}` && !args.some((a) => /minimumReleaseAge/u.test(a)), args.join(' '))
  let firstError = null
  try {
    await runPnpmWithFallback(args, { execOpts: { cwd: PROFILE, timeout: 180000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 } })
  } catch (error) { firstError = String(error?.message ?? error).slice(-500) }
  const lockText = readFileSync(lockPath, 'utf8')
  check('★ ③ 真 pnpm：pnpm install --lockfile-only 退出码 0（link: 不经 registry 解析，没有 404）',
    firstError === null, firstError ?? '（无异常）')
  check('★ ② lock 里真有这条 link 条目（specifier 与 version 都是 link:）',
    new RegExp(`'?${FAKE.replace(/[/\\^$*+?.()|[\]{}]/gu, '\\$&')}'?:\\n\\s+specifier: link:[^\\n]+\\n\\s+version: link:[^\\n]+`, 'u').test(lockText)
    && String(lockVersion(PROFILE, FAKE)).startsWith('link:'),
    lockText.split('\n').filter((l) => l.includes('release-only') || l.includes('link:')).slice(0, 4).join(' | '))
  // 幂等：再跑一次也必须 0（这是"之后任何 pnpm 操作都不再炸"的直接证据）
  let secondError = null
  try {
    await runPnpmWithFallback(args, { execOpts: { cwd: PROFILE, timeout: 180000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 } })
  } catch (error) { secondError = String(error?.message ?? error).slice(-500) }
  check('★ ③ 再跑一次仍退出码 0（幂等；清单/lock 不再互相打架）', secondError === null, secondError ?? '（无异常）')
  check('★ ③ lock 只被 pnpm 改过、清单里的 link 一字未动（对账不会把来源降级成版本号）',
    String(readDeps()[FAKE]).startsWith('link:'), readDeps()[FAKE])

  // 反证：把清单改回**裸版本号**（改错前的形态）→ 同一个命令立刻失败（这就是用户担心的"下一次 404"）
  writeManifest({ [FAKE]: FAKE_VERSION })
  writeLock("lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n")
  let bugError = null
  try {
    await runPnpmWithFallback(args, { execOpts: { cwd: PROFILE, timeout: 180000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 } })
  } catch (error) { bugError = String(error?.message ?? error) }
  const bugText = bugError ?? ''
  // pnpm 的真实文案有两代：`ERR_PNPM_FETCH_404` 与 `… is not in the npm registry, or you have no permission to fetch it.`
  const saw404 = /FETCH_404|404|is not in the npm registry/iu.test(bugText)
  check('★ 反证：裸版本号形态下同一条命令**必然失败**（改错前的现场）', bugError !== null, bugText.slice(-200))
  if (process.env.DSH_TEST_SKIP_NETWORK === '1') {
    skip('反证里的 404 细节（pnpm 报 ERR_PNPM_FETCH_404）', 'DSH_TEST_SKIP_NETWORK=1：不依赖外网细节，只断言"必然失败"')
  } else if (saw404) {
    check('★ 反证：失败原因就是 registry 404（ERR_PNPM_FETCH_404 —— 与真机现象一致）', true, bugText.slice(-120))
  } else {
    skip('反证里的 404 细节（pnpm 报 ERR_PNPM_FETCH_404）', `本次失败不是 404（网络/镜像问题）：${bugText.slice(-160)}`)
  }
  // 复原成 link: 形态，留给组 3（以及收尾清理）
  await declareProfileDependency(PROFILE, FAKE, null, { syncLock: false, probe: probe404 })
}

console.log('\n=== 组 ③ 真 registry：产品路径（真探测 npmmirror + 真 pnpm 对账）===')
const networkOff = process.env.DSH_TEST_SKIP_NETWORK === '1'
if (networkOff) {
  skip('真 registry 组（真探测 404 → link: → 真 pnpm 把 link 写进 lock）', 'DSH_TEST_SKIP_NETWORK=1（CI 模式）')
} else if (!pnpmUsable) {
  skip('真 registry 组（真探测 404 → link: → 真 pnpm 把 link 写进 lock）', '真 pnpm 不可用')
} else {
  writeManifest({ [FAKE]: FAKE_VERSION })
  rmSync(lockPath, { force: true })
  const viaProduct = await declareProfileDependency(PROFILE, FAKE, null, { syncLock: true, registries: [REGISTRY] })
  const probeSawDown = typeof viaProduct.depNote === 'string' && viaProduct.depNote.includes('网络/镜像不可达')
  if (probeSawDown || viaProduct.form === 'unknown') {
    skip('真 registry 组（真探测 404 → link: → 真 pnpm 把 link 写进 lock）', `registry 不可达（不是 404）：${String(viaProduct.depNote).slice(0, 160)}`)
  } else {
    check('★ ① 真探测：npmmirror 上确实没有这个包 → 清单写成 link:',
      viaProduct.form === 'link' && String(readDeps()[FAKE]).startsWith('link:'), `${viaProduct.form}/${readDeps()[FAKE]}`)
    check('★ ② 真 pnpm 对账：lock 里出现这条 link 条目，lockSynced=true',
      viaProduct.lockSynced === true && String(lockVersion(PROFILE, FAKE)).startsWith('link:'),
      `lockSynced=${viaProduct.lockSynced} lock=${lockVersion(PROFILE, FAKE)} lockNote=${viaProduct.lockNote ?? '-'}`)
    check('★ ③ 随后 pnpm install --lockfile-only 退出码 0（真 pnpm；不再有 404）', await (async () => {
      try {
        await runPnpmWithFallback(repairArgsFor(REGISTRY), { execOpts: { cwd: PROFILE, timeout: 180000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 } })
        return true
      } catch { return false }
    })())
    check('★ ④ 文案与实际一致：depNote 里出现的 link 路径就是清单当前值',
      typeof viaProduct.depNote === 'string' && viaProduct.depNote.includes(readDeps()[FAKE]),
      String(viaProduct.depNote).slice(0, 160))
  }
}

// ── 收尾：隔离目录清掉（不留测试残留；.trash-* 由仓库自己的删除助手负责）──────────
const cleaned = await removeDirVerifiedAsync(HOME, { attempts: 2, pollMs: 400 })
check('隔离目录已清掉（不留残留）', cleaned.ok === true || !existsSync(HOME), JSON.stringify(cleaned))
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}（真实环境：${skipped} 组 SKIP）`)
process.exit(failed === 0 ? 0 : 1)
