// 「框架安装根」判据放宽（2026-11-06 真机）——门闸抽到 domain + 扁平（hoisted）布局放行。
//
// ── 真机现场（用户点「框架升级」直接失败，零副作用）────────────────────────────────
//   「无法定位框架安装根（期望含 .pnpm 与 @deepseek-ai/dsh 的顶层 node_modules，实际：未找到）
//      —— 已取消升级，请修复框架安装后重试」
//   实测四个候选目录（`node -e` 逐个探，不是推测）：
//     D:\node_cache\_npx\<hash>\node_modules     .pnpm=**无**  @deepseek-ai/dsh=有（0.2.1-rc.5，含 lib/bin.js）
//     ~\.dsh\profiles\node_modules               .pnpm=无      @deepseek-ai/dsh=有
//     ~\.dsh\profiles\desktop\node_modules       .pnpm=有      @deepseek-ai/dsh=无
//     ~\.dsh\profiles\web\node_modules           .pnpm=有      @deepseek-ai/dsh=无
//   ⇒ 没有任何目录同时满足「有 .pnpm」+「有 @deepseek-ai/dsh」⇒ 旧门闸永远过不去。
//     框架其实装好了（0.2.1-rc.5）、确实有新版（0.2.2-rc.1），用户却只看到"请修复框架安装"。
//
// ── 本次**有意**放宽的产品判据，及其边界（写在测试里钉死，不许顺手再松）──────────────
//   放宽的：`.pnpm` 从「必要条件」降级为「布局标签」。无 `.pnpm` 但有
//           `@deepseek-ai/dsh/lib/bin.js` ⇒ 放行，layout='hoisted'（npm/npx 扁平安装就是这样）。
//   没放宽（**这三条仍然是墙**，本套逐条钉住）：
//     ① 缺 `@deepseek-ai/dsh/lib/bin.js` ⇒ 一律拒绝（reason='bin-missing'）—— 那是服务入口，
//        缺了根本拉不起来；「有 .pnpm 但没 dsh」的 profile 树（真机上 profiles/web、profiles/desktop
//        就是这形状）**绝不能**被当成可用框架根；
//     ② 一个候选 node_modules 都找不到 ⇒ 拒绝（reason='root-not-found'）；
//     ③ 拒绝必须**如实**分因：两种 reason 的文案/原因码不同，扁平布局下文案不再提 `.pnpm`。
//
// ── 本套钉死的 6 段（全离线：私有临时目录 + 注入 exists + 私有 DSH_HOME；不联网、不真升级）──
//   ① 纯判据 judgeFrameworkRoot：扁平 ⇒ hoisted / pnpm ⇒ pnpm / 缺 bin ⇒ bin-missing / null ⇒ root-not-found
//      —— 且判据**只用注入的 exists**（注入说"有"就算有，说明没绕过注入去直接读盘）
//   ② 真磁盘夹具同结论（绝对路径写入）
//   ③ 文案如实（两种 reason 的 error/details 各不同；扁平布局下不甩锅 `.pnpm`；布局步骤写清 pnpm/hoisted）
//   ④ 下游兼容：无 `.pnpm` 的夹具上 repairStaleRenameResidue / checkpointFrameworkTree **不抛错**、
//      返回可读结果，并把「跳过 store 镜像」写进步骤（不静默）
//   ⑤ 路由层（子进程探针）：扁平树夹具 ⇒ 升级**不再**因 `.pnpm` 被拒（走到后续步骤并写出布局）；
//      对照：有 `.pnpm` 但缺 bin.js ⇒ 500 framework-bin-missing；什么都没有 ⇒ 500 framework-root-not-found
//      —— 探针把脚本落盘挡掉（同名目录 ⇒ writeFile EISDIR），**绝不真跑升级**
//   ⑥ 静态接线：路由确实调用 domain 判据、旧文案已消失、步骤里推了布局、文件行数没涨（699 / ≤700）
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(ROOT, '..')
// 夹具与 DSH_HOME 全部落在仓库内的 .testdir（**绝对路径**；系统 tmpdir 在部分环境下 rmSync 静默失败）
const SANDBOX = join(ROOT, '.testdir', 'fw-root-gate')
process.env.DSH_HOME = join(SANDBOX, 'home')
const HOME = process.env.DSH_HOME
rmSync(SANDBOX, { recursive: true, force: true })
mkdirSync(HOME, { recursive: true })

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const skip = (label, reason) => { console.log(`SKIP ${label} — ${reason}`) }

const { frameworkBinPath, frameworkRootLayoutStep, frameworkRootRefusal, hasFrameworkBin, judgeFrameworkRoot } =
  await import('../lib/server/domain/framework-root-gate.js')
const { checkpointFrameworkTree } = await import('../lib/server/domain/framework.js')
const { repairStaleRenameResidue } = await import('../lib/server/domain/framework-stale-repair.js')

// ══ ① 纯判据（注入 exists，不碰 fs）═══════════════════════════════════════════════
{
  const FLAT = join('X:', 'cache', '_npx', 'hash', 'node_modules')
  const PNPM = join('X:', 'profiles', 'web', 'node_modules')
  /** 注入一个"只有这些路径存在"的探测器：判据若绕过注入去直接读盘，结论就会与这里不符。 */
  const existsOf = (present) => (p) => present.has(resolve(p).toLowerCase())

  const flatVerdict = judgeFrameworkRoot(FLAT, { exists: existsOf(new Set([resolve(FLAT, '@deepseek-ai', 'dsh', 'lib', 'bin.js').toLowerCase()])) })
  check('① 扁平树（有 bin.js、无 .pnpm）⇒ ok:true + layout:"hoisted"（**本次核心**）',
    flatVerdict.ok === true && flatVerdict.layout === 'hoisted', JSON.stringify(flatVerdict))

  const pnpmVerdict = judgeFrameworkRoot(PNPM, {
    exists: existsOf(new Set([resolve(PNPM, '@deepseek-ai', 'dsh', 'lib', 'bin.js').toLowerCase(), resolve(PNPM, '.pnpm').toLowerCase()])),
  })
  check('① pnpm 树（bin.js + .pnpm 都有）⇒ ok:true + layout:"pnpm"（既有布局不变）',
    pnpmVerdict.ok === true && pnpmVerdict.layout === 'pnpm', JSON.stringify(pnpmVerdict))

  // 边界①：`.pnpm` 在但缺 bin.js（= 真机 profiles/web、profiles/desktop 的形状）⇒ **必须**拒绝
  const storeOnly = judgeFrameworkRoot(PNPM, { exists: existsOf(new Set([resolve(PNPM, '.pnpm').toLowerCase()])) })
  check('① 边界：有 .pnpm、缺 lib/bin.js（真机 profiles/web 的形状）⇒ ok:false + reason:"bin-missing"（安全网没松）',
    storeOnly.ok === false && storeOnly.reason === 'bin-missing' && storeOnly.layout === null, JSON.stringify(storeOnly))

  const noBinFlat = judgeFrameworkRoot(FLAT, { exists: existsOf(new Set()) })
  check('① 扁平树但缺 bin.js ⇒ ok:false + reason:"bin-missing"（比 .pnpm 更硬的那条判据）',
    noBinFlat.ok === false && noBinFlat.reason === 'bin-missing', JSON.stringify(noBinFlat))

  // 边界②：没找到候选 ⇒ root-not-found（null / 空串 / 非字符串都算）
  for (const bad of [null, undefined, '', 42, {}]) {
    const v = judgeFrameworkRoot(bad, { exists: existsOf(new Set()) })
    check(`① fwRoot=${JSON.stringify(bad) ?? String(bad)} ⇒ ok:false + reason:"root-not-found"`,
      v.ok === false && v.reason === 'root-not-found' && v.layout === null, JSON.stringify(v))
  }
  check('① 注入的 exists 抛错 ⇒ 判据不抛（投成"不存在"）',
    (() => { try { return judgeFrameworkRoot(FLAT, { exists: () => { throw new Error('EACCES') } }).reason === 'bin-missing' } catch { return false } })())
  check('① 默认 exists 走真实 fs：不存在的路径 ⇒ bin-missing（不假装通过）',
    judgeFrameworkRoot(join(SANDBOX, 'no-such-tree')).reason === 'bin-missing')
  check('① hasFrameworkBin / frameworkBinPath 与判据同源',
    frameworkBinPath(FLAT) === join(FLAT, '@deepseek-ai', 'dsh', 'lib', 'bin.js') && hasFrameworkBin(FLAT) === false)
}

// ══ ② 真磁盘夹具（绝对路径写入）════════════════════════════════════════════════════
/** 在绝对路径 baseDir 下造一棵树：bin=true 写 @deepseek-ai/dsh/lib/bin.js；store=true 建 .pnpm。 */
const makeTreeAt = (baseDir, { bin = true, store = false, version = '0.2.1-rc.5' } = {}) => {
  const nm = join(baseDir, 'node_modules')
  mkdirSync(join(nm, '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  writeFileSync(join(nm, '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version, main: 'index.js' }), 'utf8')
  writeFileSync(join(nm, '@deepseek-ai', 'dsh', 'index.js'), 'export const ok = true\n', 'utf8')
  if (bin) writeFileSync(join(nm, '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// framework entry\n', 'utf8')
  if (store) mkdirSync(join(nm, '.pnpm'), { recursive: true })
  return nm
}
/** 夹具树（放在 SANDBOX 下；第一参数是相对 SANDBOX 的目录名）。 */
const makeTree = (name, opts) => makeTreeAt(join(SANDBOX, name), opts)
{
  const flat = makeTree('disk-flat', { bin: true, store: false })
  const pnpm = makeTree('disk-pnpm', { bin: true, store: true })
  const noBin = makeTree('disk-store-only', { bin: false, store: true })
  check('② 真磁盘：扁平树 ⇒ hoisted', judgeFrameworkRoot(flat).layout === 'hoisted', JSON.stringify(judgeFrameworkRoot(flat)))
  check('② 真磁盘：pnpm 树 ⇒ pnpm', judgeFrameworkRoot(pnpm).layout === 'pnpm', JSON.stringify(judgeFrameworkRoot(pnpm)))
  check('② 真磁盘：有 .pnpm 缺 bin.js ⇒ bin-missing', judgeFrameworkRoot(noBin).reason === 'bin-missing', JSON.stringify(judgeFrameworkRoot(noBin)))
  // 夹具自校验：扁平树**真的**没有 .pnpm（否则"跳过 store"那段就测不到）
  check('② 夹具自校验：disk-flat 里没有 .pnpm（否则④的"跳过"是假的）',
    !existsSync(join(flat, '.pnpm')) && existsSync(join(flat, '@deepseek-ai', 'dsh', 'lib', 'bin.js')), flat)
}

// ══ ③ 文案与步骤：如实分因、扁平布局不甩锅 .pnpm、布局必须写出来 ════════════════════
{
  const flat = join(SANDBOX, 'disk-flat', 'node_modules')
  const pnpm = join(SANDBOX, 'disk-pnpm', 'node_modules')
  const noBin = join(SANDBOX, 'disk-store-only', 'node_modules')

  const notFound = frameworkRootRefusal(judgeFrameworkRoot(null), null)
  const binMissing = frameworkRootRefusal(judgeFrameworkRoot(noBin), noBin)
  check('③ 「找不到根」文案点明要找的是 bin.js、且**不再**把 `.pnpm` 说成必要条件',
    typeof notFound.error === 'string' && notFound.error.includes('bin.js') && !notFound.error.includes('期望含 .pnpm')
    && notFound.details.code === 'framework-root-not-found' && notFound.details.reason === 'root-not-found',
    notFound.error)
  check('③ 「缺 bin.js」文案点名缺失文件与框架根（可判因，不是"请修复框架安装"一句糊上去）',
    binMissing.error.includes(frameworkBinPath(noBin)) && binMissing.error.includes(noBin)
    && binMissing.details.code === 'framework-bin-missing' && binMissing.details.missing === frameworkBinPath(noBin),
    binMissing.error)
  check('③ 两种失败文案不同（用户/排查者能一眼分出"没找到"与"没装全"）', notFound.error !== binMissing.error)

  const flatStep = frameworkRootLayoutStep(judgeFrameworkRoot(flat), flat)
  const pnpmStep = frameworkRootLayoutStep(judgeFrameworkRoot(pnpm), pnpm)
  check('③ 布局步骤：扁平 ⇒ 写 hoisted 并说明"无 .pnpm store"', flatStep.includes('hoisted') && flatStep.includes(flat) && flatStep.includes('.pnpm'), flatStep)
  check('③ 布局步骤：pnpm ⇒ 写 pnpm', pnpmStep.includes('pnpm') && pnpmStep.includes(pnpm) && !pnpmStep.includes('hoisted'), pnpmStep)
}

// ══ ④ 下游兼容：扁平树上不抛错、优雅跳过，并把"跳过"说出来 ══════════════════════════
{
  const flat = join(SANDBOX, 'disk-flat', 'node_modules')
  // 真磁盘上造一条「改名残留」：真名缺失、内容在 <name>.stale-<ver>-<ts>
  const staleDir = join(flat, '@deepseek-ai', 'cordis.stale-4.0.4-1793185607671')
  mkdirSync(join(staleDir, 'lib'), { recursive: true })
  writeFileSync(join(staleDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis', version: '4.0.4' }), 'utf8')

  let repair = null
  let repairError = null
  try { repair = repairStaleRenameResidue({ fwRoot: flat }) } catch (error) { repairError = error }
  check('④ 扁平树上 repairStaleRenameResidue 不抛错（这是"优雅跳过"的底线）', repairError === null, String(repairError?.message ?? ''))
  check('④ 仍能真修好改名残留（扁平树不是"什么都不做"的借口）',
    repair?.restored?.length === 1 && repair.restored[0].to === 'cordis'
    && existsSync(join(flat, '@deepseek-ai', 'cordis', 'package.json'))
    && !existsSync(staleDir),
    JSON.stringify(repair?.restored ?? null))
  check('④ 结果可读：steps 是给人看的一行行字符串（不是空数组、不是 [object Object]）',
    Array.isArray(repair?.steps) && repair.steps.length >= 1 && repair.steps.every((s) => typeof s === 'string' && s.length > 0),
    JSON.stringify(repair?.steps ?? null).slice(0, 160))

  // checkpoint：无 .pnpm ⇒ 不抛、storeSkipped=true、顶层 scope 仍被镜像
  const cpRoot = join(SANDBOX, 'cp-flat')
  let cp = null
  let cpError = null
  try { cp = checkpointFrameworkTree(flat, cpRoot) } catch (error) { cpError = error }
  check('④ 扁平树上 checkpointFrameworkTree 不抛错（旧实现在这里 readdirSync 抛 ENOENT）', cpError === null, String(cpError?.message ?? ''))
  check('④ 扁平树 checkpoint：storeSkipped=true 且 mirrored=0（如实说"没有 store 可镜像"）',
    cp?.storeSkipped === true && cp?.mirrored === 0, JSON.stringify(cp ?? null))
  check('④ 扁平树 checkpoint：dest 真建出来，顶层 @deepseek-ai scope 仍被镜像（回滚点不是空的）',
    typeof cp?.dest === 'string' && existsSync(join(cp.dest, 'top-@deepseek-ai', 'dsh', 'package.json')), cp?.dest)
  check('④ 对照：夹具确实没有 .pnpm（所以上面的"跳过"是真跳过，不是碰巧）', !existsSync(join(flat, '.pnpm')))

  // pnpm 树同函数：照旧镜像 store（没把老路径改坏）
  const pnpmTree = join(SANDBOX, 'disk-pnpm-2', 'node_modules')
  makeTree('disk-pnpm-2', { bin: true, store: true })
  const storeEntity = join(pnpmTree, '.pnpm', '@deepseek-ai+cordis@4.0.4', 'node_modules', '@deepseek-ai', 'cordis')
  mkdirSync(storeEntity, { recursive: true })
  writeFileSync(join(storeEntity, 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis', version: '4.0.4' }), 'utf8')
  const cpPnpm = checkpointFrameworkTree(pnpmTree, join(SANDBOX, 'cp-pnpm'))
  check('④ pnpm 树 checkpoint：storeSkipped=false 且真镜像了 store 实体（既有行为不变）',
    cpPnpm.storeSkipped === false && cpPnpm.mirrored === 1
    && existsSync(join(cpPnpm.dest, '.pnpm', '@deepseek-ai+cordis@4.0.4', 'node_modules', '@deepseek-ai', 'cordis', 'package.json')),
    JSON.stringify(cpPnpm))
}

// ══ ⑤ 路由层（子进程探针；脚本落盘被挡，绝不真升级）═════════════════════════════════
// 探针 = 一个以 `bin.js` 结尾的脚本（`resolveDshBin()` 的 argv[1] 兜底认的就是这个形状），
// 它在子进程里 import 真路由、用桩 deps 跑一次 POST /framework-upgrade，最后把结果 JSON 打到 stdout。
// 「不真升级」的三道保险：① deps 全桩（fetchJson/备份/预禁用）；② 计划任务调用在 writeFile 成功之后，
// 而探针在 tmpdir 里先建一个同名**目录**让 writeFile 必然 EISDIR 失败 ⇒ 永远不会走到 execFile；
// ③ 探针自报 ps1 是否仍是个目录（父进程据此断言"确实没启动脚本"）。
const PROBE_DIR = join(SANDBOX, 'probe')
const PROBE_BIN = join(PROBE_DIR, 'bin.js')
mkdirSync(PROBE_DIR, { recursive: true })
writeFileSync(PROBE_BIN, `import { existsSync, mkdirSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = { started: false }
try {
  // 非 win32 上把平台判据钉成 win32（与 test-framework-upgrade-platform.mjs 同手法）：
  // 本机（Windows）与 CI（Linux）都要能验证"过了平台守卫之后"的那一段。脚本写盘已被挡 ⇒ 不会真升级。
  if (process.platform !== 'win32') Object.defineProperty(process, 'platform', { value: 'win32', configurable: true, writable: true })
  const profile = process.env.PROBE_PROFILE
  // 第二道保险先落地：同名目录 ⇒ 路由里的 writeFile(ps1) 必然失败 ⇒ 不会走到 execFile(schtasks)
  // 2026-11-06（回归稳定性）：先清掉**同 PID 的旧残留**——上一轮跑挂时留下的同名目录会让 mkdir 失败，
  // 整段探针退化成 SKIP；而 ⑤-B/⑤-C 两个对照用例依赖 ⑤-A 真跑出来的回滚点（同一 HOME 下的
  // dsh-package-backup），于是一起假红。PID 是探针自己的，这里的残留只可能是我们自己造的。
  const ps1 = join(tmpdir(), 'fw-upgrade-' + process.pid + '.ps1')
  try { rmSync(ps1, { recursive: true, force: true }) } catch {}
  try { rmdirSync(ps1) } catch {} // Windows 上 rmSync 对**空目录**实测会留着（不报错也不删）⇒ 再补一刀，否则 PID 复用仍然假红
  let blocked = false
  try { mkdirSync(ps1); blocked = true } catch {}
  if (!blocked) { process.stdout.write(JSON.stringify({ skipped: 'ps1-blocker-unavailable', ps1 })); process.exit(0) }
  const { routeFrameworkUpgrade } = await import(pathToFileURL(process.env.PROBE_ROUTE).href)
  const cordisUrl = pathToFileURL(join(profile, 'cordis.yml')).href
  const ctx = {
    baseUrl: cordisUrl,
    loader: { entries: () => [{ id: 'include', options: { name: 'cordis:include', group: true, config: { path: cordisUrl } } }] },
    webServer: { register: () => () => {} },
    effect: (fn) => { try { fn() } catch {}; return () => {} },
  }
  const res = { status: 0, body: null }
  res.writeHead = (s) => { res.status = s }
  res.end = (p) => { res.body = p }
  const req = {
    method: 'POST', url: '/plugin-console/framework-upgrade',
    socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' },
    signal: { aborted: false, addEventListener: () => {} },
    [Symbol.asyncIterator]() { let done = false; return { next: async () => (done ? { value: undefined, done: true } : ((done = true), { value: Buffer.from('{}'), done: false })) } },
  }
  const META = { 'dist-tags': { latest: '0.2.2-rc.1' }, versions: { '0.2.1-rc.5': {}, '0.2.2-rc.1': {} } }
  await routeFrameworkUpgrade(req, res, {
    ctx, url: new URL('/plugin-console/framework-upgrade', 'http://127.0.0.1:3080'), pathname: '/plugin-console/framework-upgrade', method: 'POST', body: {},
    deps: {
      fetchJson: async () => META,
      backupProfileSnapshot: () => join(process.env.PROBE_HOME, 'plugin-console', 'framework-backups', 'probe'),
      preflightDisableIncompatible: async () => ({ disabled: [], skipped: [] }),
      webPort: () => 3080,
      listEntries: () => [],
    },
  })
  out.started = true
  out.status = res.status
  try { out.json = res.body === null ? null : JSON.parse(res.body) } catch {}
  out.ps1 = ps1
  try { out.ps1StillDir = statSync(ps1).isDirectory() } catch { out.ps1StillDir = false }
  try { out.ps1FileAppeared = existsSync(ps1) && !statSync(ps1).isDirectory() } catch { out.ps1FileAppeared = false }
  try { rmSync(ps1, { recursive: true, force: true }) } catch {}
  try { rmdirSync(ps1) } catch {} // 同上：空目录 rmSync 删不掉 ⇒ 每次都留一个 %TEMP% 空壳，攒久了就撞 PID
} catch (error) {
  out.error = String(error && error.stack ? error.stack : error)
}
process.stdout.write(JSON.stringify(out))
`, 'utf8')

/** 跑一次探针（隔离 DSH_HOME；清掉 ELECTRON_RUN_AS_NODE —— 否则路由会被判成"外壳托管"直接 409）。 */
const runProbe = (profile) => {
  const env = { ...process.env, DSH_HOME: HOME, PROBE_HOME: HOME, PROBE_PROFILE: profile, PROBE_ROUTE: join(REPO, 'lib', 'server', 'routes', 'framework-upgrade.js') }
  delete env.ELECTRON_RUN_AS_NODE
  const stdout = execFileSync(process.execPath, [PROBE_BIN], { env, cwd: REPO, encoding: 'utf8' })
  try { return JSON.parse(stdout) } catch { return { parseError: String(stdout).slice(0, 400) } }
}
/** 造一个 profile：有 cordis.yml + 一份可解析的 @deepseek-ai/dsh（版本 0.2.1-rc.5），形状由 opts 决定。 */
const makeProfile = (name, { bin = true, store = false } = {}) => {
  const profile = join(HOME, 'profiles', name)
  const nm = makeTreeAt(profile, { bin, store }) // 绝对路径写入
  writeFileSync(join(profile, 'cordis.yml'), '# stub\n', 'utf8')
  writeFileSync(join(profile, 'cordis.patch.yml'), '- insert:\n    - id: probe\n      name: \'probe\'\n', 'utf8')
  return nm
}

if (process.platform !== 'win32') {
  // 该探针伪造 process.platform='win32' 并依赖 schtasks / .ps1 写盘语义；Linux 上这些前提不成立，
  // 路由会在到达"框架根门闸"之前就早退（实测 200 且无 steps），断言无意义。
  // 显式 SKIP（写明理由），既不假绿也不假红；纯函数与夹具段（①–④）在所有平台照跑。
  skip('⑤ 路由层子进程探针（扁平树不再被拒 / bin.js 与无根两个对照）', '仅 Windows：探针伪造 win32 且依赖 schtasks/.ps1 语义')
} else {
  // ⑤-A 扁平树（= 真机 npx 缓存的形状）⇒ 不再因为 .pnpm 被拒
  const nm = makeProfile('flat', { bin: true, store: false })
  const flatRun = runProbe(join(HOME, 'profiles', 'flat'))
  if (flatRun.skipped !== undefined) {
    skip('⑤ 路由层：扁平树不再被 .pnpm 拒绝', `探针保险挡不住写盘（${flatRun.skipped}）——未跑路由，绝不冒险真升级`)
  } else {
    check('⑤ 探针跑起来了（不是桩把整段吞了）', flatRun.started === true && flatRun.error === undefined, String(flatRun.error ?? '').slice(0, 200))
    check('⑤ 扁平树 ⇒ 升级**不再**被拒（200，而不是 500「无法定位框架安装根」）',
      flatRun.status === 200 && flatRun.json?.ok === true, `status=${flatRun.status} err=${String(flatRun.json?.error ?? '').slice(0, 120)}`)
    check('⑤ 扁平树 ⇒ 响应里没有 framework-root-not-found 这条原因码（旧门闸真的走开了）',
      flatRun.json?.details?.code === undefined, JSON.stringify(flatRun.json?.details ?? null))
    const steps = Array.isArray(flatRun.json?.steps) ? flatRun.json.steps : []
    check('⑤ 升级步骤写明了布局 hoisted（用户/排查者一眼看出是哪天装法）',
      steps.some((s) => typeof s === 'string' && s.includes('布局：hoisted') && s.includes(nm)),
      steps.find((s) => typeof s === 'string' && s.includes('框架安装根')) ?? '(无布局步骤)')
    check('⑤ 升级步骤写明了 checkpoint 跳过 .pnpm store（不静默）',
      steps.some((s) => typeof s === 'string' && s.includes('checkpoint') && s.includes('扁平安装')),
      steps.find((s) => typeof s === 'string' && s.includes('checkpoint')) ?? '(无 checkpoint 步骤)')
    const rb = (() => { try { return JSON.parse(readFileSync(join(HOME, 'plugin-console', 'framework-rollback.json'), 'utf8')) } catch { return null } })()
    check('⑤ 回滚记录落在扁平树上（fwRoot 指向那棵 node_modules，checkpointDir 真存在）',
      rb?.fwRoot === nm && typeof rb?.checkpointDir === 'string' && existsSync(rb.checkpointDir), JSON.stringify({ fwRoot: rb?.fwRoot, checkpointDir: rb?.checkpointDir }))
    check('⑤ **没有**启动升级脚本（ps1 始终是那个目录 ⇒ 没走到 execFile，本套绝不真升级）',
      flatRun.ps1StillDir === true && flatRun.ps1FileAppeared === false, `ps1=${flatRun.ps1} stillDir=${flatRun.ps1StillDir}`)
  }

  // ⑤-B 对照：有 .pnpm 但缺 bin.js（真机 profiles/web 的形状）⇒ 仍然 500 + framework-bin-missing
  makeProfile('store-only', { bin: false, store: true })
  const badRun = runProbe(join(HOME, 'profiles', 'store-only'))
  check('⑤ 对照：有 .pnpm 缺 bin.js ⇒ 500 + code=framework-bin-missing（安全网在路由层仍然生效）',
    badRun.status === 500 && badRun.json?.ok === false && badRun.json?.details?.code === 'framework-bin-missing'
    && String(badRun.json?.error).includes('bin.js'),
    `status=${badRun.status} ${String(badRun.json?.error ?? badRun.error ?? '').slice(0, 140)}`)

  // ⑤-C 对照：一个候选都没有 ⇒ 500 + framework-root-not-found（不放行任意 node_modules）
  const bare = join(HOME, 'profiles', 'bare')
  mkdirSync(join(bare, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
  writeFileSync(join(bare, 'cordis.yml'), '# stub\n', 'utf8')
  writeFileSync(join(bare, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.5' }), 'utf8')
  const bareRun = runProbe(bare)
  check('⑤ 对照：没有可用框架根 ⇒ 500 + code=framework-root-not-found（这条墙也还在）',
    bareRun.status === 500 && bareRun.json?.details?.code === 'framework-root-not-found',
    `status=${bareRun.status} ${String(bareRun.json?.error ?? bareRun.error ?? '').slice(0, 140)}`)
}

// ══ ⑥ 静态接线（防"结论对但代码没接上"）═══════════════════════════════════════════
{
  const upSrc = readFileSync(join(REPO, 'lib', 'server', 'routes', 'framework-upgrade.js'), 'utf8')
  const gateSrc = readFileSync(join(REPO, 'lib', 'server', 'domain', 'framework-root-gate.js'), 'utf8')
  const upLines = upSrc.split('\n').length
  check('⑥ 路由确实调用 domain 判据（judgeFrameworkRoot + frameworkRootRefusal + 布局步骤）',
    upSrc.includes('judgeFrameworkRoot(fwRoot)') && upSrc.includes('frameworkRootRefusal(fwGate, fwRoot)')
    && upSrc.includes('frameworkRootLayoutStep(fwGate, fwRoot)'))
  check('⑥ 旧判据已消失：路由里不再出现「!existsSync(join(fwRoot, \'.pnpm\'))」这种硬条件',
    !upSrc.includes("!existsSync(join(fwRoot, '.pnpm'))") && !upSrc.includes('期望含 .pnpm 与 @deepseek-ai/dsh'))
  check('⑥ framework-upgrade.js 行数没涨（699 行；守卫上限 ≤700）', upLines <= 699, `${upLines} 行`)
  check('⑥ 判据模块 ≤600 行（lib/server/** 通用上限）', gateSrc.split('\n').length <= 600, `${gateSrc.split('\n').length} 行`)
  check('⑥ 判据模块只 import node: 内置（domain 不许依赖宿主/路由）',
    (gateSrc.match(/^import\s[^\n]*from\s+'([^']+)'/gmu) ?? []).every((l) => /from '(?:node:)/u.test(l)))
}
// ══ 清理 ═════════════════════════════════════════════════════════════════════════════
rmSync(SANDBOX, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
