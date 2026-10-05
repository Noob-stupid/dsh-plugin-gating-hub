// `link:` 依赖的**自足性**专项验证（2026-10-06 加法；用户点名「默认真装 + link 自足」）
//
// 真问题（真机现场，不是推测）：`link:` 只把一个目录挂进 profile —— pnpm 建完链接就结束了。
// 而插件要能被 `import` 起来还差两样**没有任何人负责**的东西：
//   ① 目标目录自己的 `dependencies`（作者机器上才有 node_modules）；
//   ② 它声明过的**框架 peer**（目标目录在 profile 树之外时，Node 的解析链走不到 profile 的
//      node_modules）⇒ 真机症状是"面板报安装成功、插件一直是 [no-fiber]"。
// 现场实测（D:\…\plugin-src\dsh-opencode-go）：`import()` 失败于
// `Cannot find package 'opencode-go-pi-ai'`，而该包的实体**早已在 `.pnpm` 里** ——
// 所以"补齐"必须包含"把已有实体接回可达位置"。
//
// 本套把三条硬规矩钉死（判据唯一承担者 = lib/server/domain/link-self-sufficiency.js）：
//   ① 只补缺的：自足 ⇒ **零写盘**（幂等）
//   ② 绝不覆盖：目标位置已有任何东西（含悬空链接）⇒ 跳过并如实记 skipped
//   ③ 绝不因此拒绝安装：失败 ⇒ `ok:true` + `ready:false` + note + 动作，**不抛**
//
// 分组（全离线：私有沙箱 DSH_HOME + 桩 pnpm，零外网；真机那段没有真框架时**响亮 SKIP**）：
//   组 1  判据（只读）：非路径型 / 目标不存在 / 缺依赖 / 缺 peer / 可补 vs 不可补
//   组 2  补齐：建垫片 + **realpath 与框架根逐字相同** + 幂等零写盘 + 绝不覆盖 + 缺依赖必须报
//   组 3  卸载：只清**我们造的**、外部放置的垫片保留、记录文件删除
//   组 4  接线：来源型默认**真装**（`planDependencySpec` 的 source 形态）+ registry 优先**不倒退**
//          + 写成 link: 后自动补齐 + 卸载自动清垫片
//   组 5  绝不抛：坏夹具 / 目录不可写
//   组 6  真机（有真实框架根才跑）：垫片 realpath === 宿主侧 realpath
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  planLinkSelfSufficiency, ensureLinkSelfSufficiency, removeLinkSelfSufficiency,
  listSelfSufficiencyRecords, selfSufficiencyRecordPath, frameworkShimRoot, resolveFromDir, installTargetDependencies,
} from '../lib/server/domain/link-self-sufficiency.js'
import { planDependencySpec, declareProfileDependency, undeclareProfileDependency, specOf } from '../lib/server/domain/manifest.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SANDBOX = join(ROOT, '.testdir', 'link-self-sufficiency')
const HOME = join(SANDBOX, 'home')
const PROFILE = join(HOME, 'profiles', 'web')
const PLUGIN_SRC = join(HOME, 'plugin-src')
const FRAMEWORK_ROOT = frameworkShimRoot(HOME)

let failed = 0
let skipped = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const skip = (label, why) => { skipped += 1; console.log(`SKIP ${label} — ${why}`) }

// ── 沙箱：干净重建（删不掉就改名让开，绝不因为清理失败而让整局红） ──────────────────
function freshSandbox() {
  if (existsSync(SANDBOX)) {
    try { rmSync(SANDBOX, { recursive: true, force: true }) } catch {}
    if (existsSync(SANDBOX)) {
      const aside = `${SANDBOX}.trash-${Date.now().toString(36)}`
      try { rmSync(aside, { recursive: true, force: true }) } catch {}
      try { rmSync(SANDBOX, { recursive: true, force: true }) } catch {}
    }
  }
  mkdirSync(PROFILE, { recursive: true })
  mkdirSync(PLUGIN_SRC, { recursive: true })
  writeFileSync(join(PROFILE, 'package.json'), `${JSON.stringify({ name: 'lss-profile', private: true, dependencies: {} }, null, 2)}\n`, 'utf8')
}
freshSandbox()

const PEER_A = '@deepseek-ai/dsh-lss-probe-a'
const PEER_B = '@deepseek-ai/dsh-lss-probe-b'
const PEER_MISSING = '@deepseek-ai/dsh-lss-not-in-framework'
const DEP = '@lss/fixture-dep'

/** 在沙箱框架根里造一个"框架包"（模拟 <DSH_HOME>/profiles/node_modules/@deepseek-ai/<pkg>）。 */
function makeFrameworkPackage(name) {
  const dir = join(FRAMEWORK_ROOT, name.slice('@deepseek-ai/'.length))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, version: '0.0.0-fixture', main: 'index.js' }, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, 'index.js'), 'export default {}\n', 'utf8')
  return dir
}
makeFrameworkPackage(PEER_A)
makeFrameworkPackage(PEER_B)

/** 造一个"本地开发目录里的插件"（= link: 的目标）。
 *  `occupied` 放的是**不可解析的占位物**（真实目录 + FOREIGN.txt，故意没有 package.json）——
 *  用来验"绝不覆盖"；带 package.json 的目录会让判据直接判 ready，测不到占用那条路。 */
function makePluginDir(slug, { dependencies = {}, peers = {}, installed = [], occupied = [] } = {}) {
  const dir = join(PLUGIN_SRC, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: `lss-${slug}`, version: '1.0.0', main: 'index.js', dependencies, peerDependencies: peers,
  }, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, 'index.js'), 'export default {}\n', 'utf8')
  for (const name of installed) {
    const d = join(dir, 'node_modules', ...name.split('/'))
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'package.json'), `${JSON.stringify({ name, version: '9.9.9' })}\n`, 'utf8')
  }
  for (const name of occupied) {
    const d = join(dir, 'node_modules', ...name.split('/'))
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'FOREIGN.txt'), 'do-not-touch\n', 'utf8')
  }
  return dir
}

const linkSpecOf = (dir) => `link:${dir.replace(/\\/gu, '/')}`

/** 目录树快照（相对路径 → 大小 + mtime + 内容哈希）：用来断言"零写盘"。
 *  链接/接口一律当**叶子**（只记链接目标，绝不跟进读取 —— junction 指过去是目录，readFile 会 EISDIR）。 */
function snapshot(root) {
  const out = new Map()
  if (!existsSync(root)) return out
  const walk = (dir) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      const rel = relative(root, p)
      try {
        if (e.isSymbolicLink()) {
          let target = '?'
          try { target = readlinkSync(p) } catch {}
          out.set(rel, `link:${target}`)
          continue
        }
        if (e.isDirectory()) { out.set(`${rel}/`, 'dir'); walk(p); continue }
        out.set(rel, `${statSync(p).size}:${statSync(p).mtimeMs}:${createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)}`)
      } catch (error) {
        out.set(rel, `unreadable:${String(error?.code ?? error)}`)
      }
    }
  }
  walk(root)
  return out
}
const diffSnapshots = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k))

const probe404 = async () => ({ resolvable: false, hasVersion: false, latest: null, registry: null, tried: ['stub：HTTP 404 Not Found'] })
const probeResolvable = async (name, registries, options = {}) => ({ resolvable: true, hasVersion: true, latest: options.version ?? null, registry: 'stub', tried: [] })

console.log('── 组 1：判据（只读，零写盘）────────────────────────────────────────')
{
  // 先造齐全部夹具，再拍快照 —— 快照必须只覆盖"判据调用期间"（造夹具本身当然会写盘）
  const dir = makePluginDir('g1-plain', { peers: { [PEER_A]: '*' } })
  const unknownPeer = makePluginDir('g1-unknown-peer', { peers: { [PEER_MISSING]: '*' } })
  const depDir = makePluginDir('g1-missing-dep', { dependencies: { [DEP]: '1.0.0' } })
  const suffDir = makePluginDir('g1-sufficient', { dependencies: { [DEP]: '1.0.0' }, peers: { [PEER_A]: '*' }, installed: [DEP, PEER_A] })
  const before = snapshot(SANDBOX)

  const nonPath = planLinkSelfSufficiency({ profileDir: PROFILE, packageName: 'x', spec: '1.2.3', home: HOME })
  check('① 非路径型 spec（版本号）⇒ applies=false、无需补齐', nonPath.applies === false && nonPath.ready === true, nonPath.reason)

  const gone = planLinkSelfSufficiency({ profileDir: PROFILE, packageName: 'x', spec: linkSpecOf(join(PLUGIN_SRC, 'never-existed')), home: HOME })
  check('① 目标目录不存在 ⇒ applies=true、ready=false、如实说明（不猜）', gone.applies === true && gone.ready === false && /package\.json/u.test(String(gone.note)), String(gone.note).slice(0, 90))

  const missingPeer = planLinkSelfSufficiency({ profileDir: PROFILE, packageName: 'x', spec: linkSpecOf(dir), home: HOME })
  check('① 缺框架 peer ⇒ 列入 missingPeers 且**可补**（框架根里有）', missingPeer.missingPeers.join() === PEER_A && missingPeer.shimmablePeers.join() === PEER_A, JSON.stringify({ missing: missingPeer.missingPeers, shimmable: missingPeer.shimmablePeers }))

  const notShimmable = planLinkSelfSufficiency({ profileDir: PROFILE, packageName: 'x', spec: linkSpecOf(unknownPeer), home: HOME })
  check('① 框架根里没有的 peer ⇒ 另列 unavailablePeers（不当成可补，也不静默）', notShimmable.missingPeers.join() === PEER_MISSING && notShimmable.shimmablePeers.length === 0 && notShimmable.unavailablePeers.join() === PEER_MISSING && notShimmable.ready === false, JSON.stringify(notShimmable.unavailablePeers))

  const depPlan = planLinkSelfSufficiency({ profileDir: PROFILE, packageName: 'x', spec: linkSpecOf(depDir), home: HOME })
  check('① 缺 dependencies ⇒ 列入 missingDeps、ready=false、给动作', depPlan.missingDeps.join() === DEP && depPlan.ready === false && depPlan.action !== null, JSON.stringify(depPlan.missingDeps))

  const suffPlan = planLinkSelfSufficiency({ profileDir: PROFILE, packageName: 'x', spec: linkSpecOf(suffDir), home: HOME })
  check('① 已自足 ⇒ ready=true、零动作（判据与"要不要写盘"同一把尺子）', suffPlan.ready === true && suffPlan.action === null && suffPlan.missingDeps.length === 0 && suffPlan.missingPeers.length === 0, JSON.stringify({ deps: suffPlan.missingDeps, peers: suffPlan.missingPeers }))

  check('① 判据全程只读：沙箱快照一字未变', diffSnapshots(before, snapshot(SANDBOX)).length === 0, diffSnapshots(before, snapshot(SANDBOX)).slice(0, 5).join(', '))
}

console.log('\n── 组 2：补齐（只补缺的 / 绝不覆盖 / 失败如实报）────────────────────')
{
  const dir = makePluginDir('g2-shim', { peers: { [PEER_A]: '*', [PEER_B]: '*' } })
  const res = await ensureLinkSelfSufficiency({ profileDir: PROFILE, packageName: 'lss-g2-shim', spec: linkSpecOf(dir), home: HOME })
  check('② 正控：两个缺 peer 都被补上、ready=true', res.ok === true && res.ready === true && res.created.length === 2, JSON.stringify(res.created.map((c) => c.name)))
  check('② 垫片落在目标目录内（垫片根 = 插件根，生态既有约定）', res.created.every((c) => c.link.startsWith(join(dir, 'node_modules', '@deepseek-ai'))), res.created.map((c) => c.link).join(' | '))

  const shim = join(dir, 'node_modules', '@deepseek-ai', PEER_A.slice('@deepseek-ai/'.length))
  const fw = join(FRAMEWORK_ROOT, PEER_A.slice('@deepseek-ai/'.length))
  let realSame = false
  try { realSame = statSync(shim).isDirectory() && existsSync(join(shim, 'package.json')) === existsSync(join(fw, 'package.json')) } catch { realSame = false }
  check('② 垫片指向框架根（realpath 同一份真实文件 ⇒ 模块身份共享）', realSame && statSync(shim).isDirectory(), shim)

  const after = snapshot(SANDBOX)
  const again = await ensureLinkSelfSufficiency({ profileDir: PROFILE, packageName: 'lss-g2-shim', spec: linkSpecOf(dir), home: HOME })
  check('② 幂等：自足后再跑一次 ⇒ 零写盘（快照逐项相同）', again.changed === false && again.created.length === 0 && diffSnapshots(after, snapshot(SANDBOX)).length === 0, diffSnapshots(after, snapshot(SANDBOX)).slice(0, 5).join(', '))

  const rec = listSelfSufficiencyRecords({ home: HOME }).find((r) => r.record?.packageName === 'lss-g2-shim')
  check('② 造过的垫片有记录（卸载据此只清我们造的）', Array.isArray(rec?.record?.shims) && rec.record.shims.length === 2, JSON.stringify(rec?.record?.shims?.map((s) => s.name)))

  // 绝不覆盖：目标位置上放一个**占位但不可解析**的东西（真实目录、没有 package.json）。
  // 为什么不能放"带 package.json 的包"：那它就**可解析**了 —— 判据会判 ready（零写盘），
  // 测不到"占用"这条负控。悬空/空壳才是真正要挡的形状。
  const keepDir = makePluginDir('g2-keep', { peers: { [PEER_A]: '*' }, occupied: [PEER_A] })
  const occupiedPath = join(keepDir, 'node_modules', '@deepseek-ai', PEER_A.slice('@deepseek-ai/'.length))
  const foreignFile = join(occupiedPath, 'FOREIGN.txt')
  const keepSnapshot = snapshot(keepDir)
  const keep = await ensureLinkSelfSufficiency({ profileDir: PROFILE, packageName: 'lss-g2-keep', spec: linkSpecOf(keepDir), home: HOME })
  check('② 负控：目标位置已被占（不可解析的占位物）⇒ 绝不覆盖（跳过并如实记 skipped）', keep.created.length === 0 && keep.skipped.length === 1 && /occupied/u.test(keep.skipped[0].reason), JSON.stringify(keep.skipped))
  check('② 负控：占位物逐字节未动', existsSync(foreignFile) && diffSnapshots(keepSnapshot, snapshot(keepDir)).length === 0, diffSnapshots(keepSnapshot, snapshot(keepDir)).slice(0, 5).join(', '))

  // 缺依赖必须报（负控）+ 装依赖成功（正控）
  const depDir = makePluginDir('g2-dep-fail', { dependencies: { [DEP]: '1.0.0' } })
  const failRun = async () => { throw new Error('stub：pnpm install 失败（模拟离线/锁冲突）') }
  const failedEnsure = await ensureLinkSelfSufficiency({ profileDir: PROFILE, packageName: 'lss-g2-dep-fail', spec: linkSpecOf(depDir), home: HOME, deps: { runPnpm: failRun } })
  check('② 负控：缺依赖必须**报出来**（ready=false + note 点名 + 给动作）', failedEnsure.ok === true && failedEnsure.ready === false && String(failedEnsure.note).includes(DEP) && failedEnsure.action !== null, String(failedEnsure.note).slice(0, 120))
  check('② 负控：装依赖失败**绝不抛**、也绝不因此拒绝安装（ok 仍为 true）', failedEnsure.ok === true, JSON.stringify({ ok: failedEnsure.ok, installed: failedEnsure.installed?.ok }))

  const depDir2 = makePluginDir('g2-dep-ok', { dependencies: { [DEP]: '1.0.0' } })
  const seenArgv = []
  const okRun = async (args, { execOpts }) => {
    seenArgv.push(args)
    const d = join(execOpts.cwd, 'node_modules', ...DEP.split('/'))
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'package.json'), `${JSON.stringify({ name: DEP, version: '1.0.0' })}\n`, 'utf8')
    return { stdout: 'stub install ok', stderr: '' }
  }
  const okEnsure = await ensureLinkSelfSufficiency({ profileDir: PROFILE, packageName: 'lss-g2-dep-ok', spec: linkSpecOf(depDir2), home: HOME, deps: { runPnpm: okRun } })
  check('② 正控：缺依赖 ⇒ 在**目标目录内**装齐后 ready=true', okEnsure.ok === true && okEnsure.ready === true && okEnsure.installed?.ok === true && existsSync(join(depDir2, 'node_modules', ...DEP.split('/'), 'package.json')), JSON.stringify({ ready: okEnsure.ready, installed: okEnsure.installed?.ok }))
  // ★ 关键回归钉子：装依赖时**必须关掉 pnpm 的自动装 peer**（pnpm 8+ 默认 auto-install-peers=true）。
  //   真机实测：开着它，pnpm 会从 registry 装一份 0.1.5-rc.3 的 @deepseek-ai/dsh-llm 进目标目录，
  //   而宿主用的是自己那份 ⇒ **类身份不共享**（Cordis service / LLM error 的 instanceof 会互相不认）。
  //   分工必须是：**dependencies 交给 pnpm，peer 交给框架根垫片**。
  check('② 装依赖时关掉 auto-install-peers（否则 peer 会从 registry 装成"第二份"，模块身份不共享）', seenArgv.length === 1 && seenArgv[0].includes('--config.auto-install-peers=false'), JSON.stringify(seenArgv))
  // 负控：不认识该选项的老 pnpm ⇒ 去掉它重试一次（绝不让"加固"变成"跑不成"）
  const retryArgv = []
  const oldPnpm = async (args) => {
    retryArgv.push(args)
    if (args.includes('--config.auto-install-peers=false')) throw new Error('ERROR Unknown option: \'config.auto-install-peers\'')
    return { stdout: 'stub retry ok', stderr: '' }
  }
  const depDir3 = makePluginDir('g2-dep-old-pnpm', { dependencies: { [DEP]: '1.0.0' } })
  const retried = await installTargetDependencies({ target: depDir3, deps: { runPnpm: oldPnpm } })
  check('② 负控：选项不被认识时去掉它重试一次（加固不许变成跑不成）', retried.ok === true && retryArgv.length === 2 && !retryArgv[1].includes('--config.auto-install-peers=false'), JSON.stringify(retryArgv))
  // 反向：真失败（非选项问题）**不许**悄悄重试成"成功"
  const hardFail = async () => { throw new Error('ERR_PNPM_FETCH_404  Not found') }
  const depDir4 = makePluginDir('g2-dep-hard-fail', { dependencies: { [DEP]: '1.0.0' } })
  const hard = await installTargetDependencies({ target: depDir4, deps: { runPnpm: hardFail } })
  check('② 负控：真失败如实返回（不重试、不谎报）', hard.ok === false && String(hard.error).includes('FETCH_404'), JSON.stringify({ ok: hard.ok, error: String(hard.error).slice(0, 70) }))
}

console.log('\n── 组 3：卸载清理（只清我们造的）──────────────────────────────────')
{
  const dir = makePluginDir('g3-cleanup', { peers: { [PEER_A]: '*', [PEER_B]: '*' } })
  // 外部放的链接（不是我们造的）：占住 PEER_B 的位置，指向别处
  const foreignTarget = join(SANDBOX, 'foreign-target')
  mkdirSync(foreignTarget, { recursive: true })
  writeFileSync(join(foreignTarget, 'FOREIGN.txt'), 'not-ours\n', 'utf8')
  const theirs = join(dir, 'node_modules', '@deepseek-ai', PEER_B.slice('@deepseek-ai/'.length))
  mkdirSync(dirname(theirs), { recursive: true })
  symlinkSync(foreignTarget, theirs, 'junction')

  const res = await ensureLinkSelfSufficiency({ profileDir: PROFILE, packageName: 'lss-g3-cleanup', spec: linkSpecOf(dir), home: HOME })
  const ours = join(dir, 'node_modules', '@deepseek-ai', PEER_A.slice('@deepseek-ai/'.length))
  check('③ 前置：我们造的（PEER_A）与外部放的（PEER_B）同时存在，记录里只有我们造的', res.created.length === 1 && existsSync(ours) && existsSync(theirs) && res.skipped.length === 1, JSON.stringify({ created: res.created.length, skipped: res.skipped.length }))

  const removed = removeLinkSelfSufficiency({ packageName: 'lss-g3-cleanup', home: HOME })
  check('③ 卸载后**我们造的**垫片清干净', removed.removed.length === 1 && !existsSync(ours), JSON.stringify({ removed: removed.removed, kept: removed.kept }))
  check('③ 卸载**不碰**外部放的链接（它指向的目标与里面的文件都还在）', existsSync(theirs) && existsSync(join(foreignTarget, 'FOREIGN.txt')), theirs)
  check('③ 记录文件删除（没有记录就不会误删下一轮的垫片）', !existsSync(selfSufficiencyRecordPath(HOME, 'lss-g3-cleanup')), selfSufficiencyRecordPath(HOME, 'lss-g3-cleanup'))
  const repeat = removeLinkSelfSufficiency({ packageName: 'lss-g3-cleanup', home: HOME })
  check('③ 幂等：再清一次 ⇒ 无操作、不报错', repeat.removed.length === 0 && repeat.kept.length === 0, JSON.stringify(repeat))
}

console.log('\n── 组 4：接线（来源型默认真装 + link 写入即补齐 + 卸载即净）──────────')
{
  // 4a 来源型：给了真实来源规格 ⇒ 写回就是该规格（不是 link:）
  const src = await planDependencySpec({ profileDir: PROFILE, packageName: '@lss/release-only', version: '1.0.0', probe: probe404, sourceSpec: 'github:acme/release-only' })
  check('④ 来源型（registry 404 + 有真实来源规格）⇒ form=source、写回真实规格，**不写 link:**', src.form === 'source' && src.spec === 'github:acme/release-only', JSON.stringify({ form: src.form, spec: src.spec }))
  const tarball = await planDependencySpec({ profileDir: PROFILE, packageName: '@lss/tgz-only', version: '2.0.0', probe: probe404, sourceSpec: 'https://example.invalid/acme/pkg.tgz' })
  check('④ tgz URL 来源同样按真装写回', tarball.form === 'source' && tarball.spec === 'https://example.invalid/acme/pkg.tgz', JSON.stringify({ form: tarball.form, spec: tarball.spec }))
  // 不倒退：registry 可解析 ⇒ 仍写版本号（来源规格不抢优先级）
  const reg = await planDependencySpec({ profileDir: PROFILE, packageName: '@lss/on-registry', version: '3.1.4', probe: probeResolvable, sourceSpec: 'github:acme/on-registry' })
  check('④ 不倒退：registry 可解析 ⇒ 仍写版本号（既有流程一字不改）', reg.form === 'version' && reg.spec === '3.1.4', JSON.stringify({ form: reg.form, spec: reg.spec }))
  // 没有真实规格 ⇒ 仍退回 link:（显式开发式安装，行为不变）。
  // 前置：该包必须**已装在 profile 里** —— 否则物化不出来，写回会如实跳过（不给不存在的目录写 link:）。
  const noSourcePkg = join(PROFILE, 'node_modules', '@lss', 'no-source')
  mkdirSync(noSourcePkg, { recursive: true })
  writeFileSync(join(noSourcePkg, 'package.json'), `${JSON.stringify({ name: '@lss/no-source', version: '1.0.0' })}\n`, 'utf8')
  const noSpec = await planDependencySpec({ profileDir: PROFILE, packageName: '@lss/no-source', version: '1.0.0', probe: probe404 })
  check('④ 拿不到真实规格 ⇒ 仍退回 link:（显式开发式安装，行为不变）', noSpec.form === 'link' && String(noSpec.spec).startsWith('link:'), JSON.stringify({ form: noSpec.form, spec: noSpec.spec }))

  // 4b declareProfileDependency：来源型真装（注入 install，绝不出网）
  const calls = []
  const installStub = async ({ spec }) => {
    calls.push(spec)
    const d = join(PROFILE, 'node_modules', '@lss', 'release-only')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'package.json'), `${JSON.stringify({ name: '@lss/release-only', version: '1.0.0' })}\n`, 'utf8')
  }
  const declared = await declareProfileDependency(PROFILE, '@lss/release-only', null, { syncLock: false, probe: probe404, sourceSpec: 'github:acme/release-only', installSource: installStub })
  check('④ 来源型真装真的被调用（pnpm add <spec> 通道）', calls.join() === 'github:acme/release-only', JSON.stringify(calls))
  check('④ 真装成功后清单写的是真实来源规格', declared.form === 'source' && declared.spec === 'github:acme/release-only' && declared.sourceInstall?.ok === true, JSON.stringify({ form: declared.form, spec: declared.spec }))

  // 4c declareProfileDependency 写成 link: ⇒ 自动补齐（自足性接线）。
  // 夹具就是"profile 里已装好的包"：它声明了框架 peer 却没有 node_modules —— 正是真机形态。
  const wiredPkg = join(PROFILE, 'node_modules', 'lss-g4-wired')
  mkdirSync(wiredPkg, { recursive: true })
  writeFileSync(join(wiredPkg, 'package.json'), `${JSON.stringify({ name: 'lss-g4-wired', version: '1.0.0', main: 'index.js', peerDependencies: { [PEER_A]: '*' } }, null, 2)}\n`, 'utf8')
  writeFileSync(join(wiredPkg, 'index.js'), 'export default {}\n', 'utf8')
  const declaredLink = await declareProfileDependency(PROFILE, 'lss-g4-wired', null, { syncLock: false, probe: probe404, home: HOME })
  const materialized = String(await specOf(PROFILE, 'lss-g4-wired') ?? '')
  const targetDir = materialized.startsWith('link:') ? join(materialized.slice('link:'.length)) : wiredPkg
  const wiredShim = join(targetDir, 'node_modules', '@deepseek-ai', PEER_A.slice('@deepseek-ai/'.length))
  check('④ 写成 link: ⇒ 自动补齐（垫片已建、selfSufficiency.ready=true）', declaredLink.form === 'link' && declaredLink.selfSufficiency?.ready === true && existsSync(wiredShim), JSON.stringify({ form: declaredLink.form, spec: materialized, ready: declaredLink.selfSufficiency?.ready, shim: wiredShim }))

  // 4d 卸载即净：undeclare 自动清掉我们造的垫片
  const undeclared = await undeclareProfileDependency(PROFILE, 'lss-g4-wired', { home: HOME })
  check('④ 卸载 ⇒ 声明撤销 + 垫片清干净（卸载即净）', await specOf(PROFILE, 'lss-g4-wired') === null && !existsSync(wiredShim) && (undeclared.shimsRemoved ?? []).length === 1, JSON.stringify({ removed: undeclared.shimsRemoved, kept: undeclared.shimsKept }))
}

console.log('\n── 组 5：绝不抛（坏夹具 / 目录不可用）──────────────────────────────')
{
  const broken = join(PLUGIN_SRC, 'g5-broken')
  mkdirSync(broken, { recursive: true })
  writeFileSync(join(broken, 'package.json'), '{ this is not json', 'utf8')
  const res = await ensureLinkSelfSufficiency({ profileDir: PROFILE, packageName: 'lss-g5-broken', spec: linkSpecOf(broken), home: HOME })
  check('⑤ 坏 package.json ⇒ 不抛、ok=true、ready=false 并如实说目标里没有可读 package.json', res.ok === true && res.ready === false, String(res.note).slice(0, 110))

  const noHome = await ensureLinkSelfSufficiency({ profileDir: join(SANDBOX, 'does-not-exist'), packageName: 'x', spec: null, home: HOME })
  check('⑤ profile 不存在 / 清单读不到 ⇒ 不抛、applies=false', noHome.ok === true && noHome.applies === false, String(noHome.note).slice(0, 90))
}

console.log('\n── 组 6：真机（有真实框架根才跑；没有则响亮 SKIP）──────────────────')
{
  const realHome = process.env.USERPROFILE ?? process.env.HOME ?? null
  const realFrameworkRoot = realHome === null ? null : frameworkShimRoot(join(realHome, '.dsh'))
  const realPkg = realFrameworkRoot === null ? null : join(realFrameworkRoot, 'dsh-llm', 'package.json')
  if (realPkg === null || !existsSync(realPkg)) {
    skip('⑥ 真机垫片 realpath', '本机没有 <DSH_HOME>/profiles/node_modules/@deepseek-ai/dsh-llm（CI/裸环境正常）')
  } else {
    check('⑥ 真机框架根就是 <DSH_HOME>/profiles/node_modules/@deepseek-ai', existsSync(join(realFrameworkRoot, 'dsh-llm', 'package.json')), realFrameworkRoot)
    // 夹具必须放在 **.testdir 之外**：test-harness.mjs 会在 tests/.testdir/node_modules 下造
    // @deepseek-ai/* 桩包，放在其子树里会被"向上解析"命中，于是永远测不到"缺 peer ⇒ 该补"。
    const probeRoot = mkdtempSync(join(tmpdir(), 'lss-real-'))
    const dir = join(probeRoot, 'plugin-src', 'g6-real')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'lss-g6-real', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-llm': '>=0.1.5-rc.1' } }, null, 2)}\n`, 'utf8')
    check('⑥ 前置：该夹具向上解析不到 dsh-llm（否则这条断言没有意义）', resolveFromDir(dir, '@deepseek-ai/dsh-llm') === null, String(resolveFromDir(dir, '@deepseek-ai/dsh-llm')))

    const res = await ensureLinkSelfSufficiency({ profileDir: PROFILE, packageName: 'lss-g6-real', spec: linkSpecOf(dir), home: join(realHome, '.dsh') })
    const shim = join(dir, 'node_modules', '@deepseek-ai', 'dsh-llm')
    check('⑥ 真机：垫片建在插件根、且能解析到真实框架包', res.created.length === 1 && existsSync(join(shim, 'package.json')), JSON.stringify(res.created.map((c) => c.link)))
    check('⑥ 真机：从插件目录向上解析得到的就是该垫片（解析链真的通了）', resolveFromDir(dir, '@deepseek-ai/dsh-llm') === shim, String(resolveFromDir(dir, '@deepseek-ai/dsh-llm')))
    let sameReal = false
    try { sameReal = realpathSync(shim) === realpathSync(join(realFrameworkRoot, 'dsh-llm')) } catch { sameReal = false }
    check('⑥ 真机：垫片 realpath === 框架根 realpath（模块身份与宿主共享）', sameReal, `${shim}`)
    const cleanup = removeLinkSelfSufficiency({ packageName: 'lss-g6-real', home: join(realHome, '.dsh') })
    check('⑥ 真机：验完立刻清掉（不留痕）', cleanup.removed.length === 1 && !existsSync(shim), JSON.stringify(cleanup.removed))
    // 记录文件：真机 <DSH_HOME>/plugin-console/ 下的删除会静默落空（Windows）⇒ 判据是
    // "删掉了 **或** 已清空" —— 都不成立才算失败（陈旧条目会让人误以为垫片还在）。
    const realRecord = selfSufficiencyRecordPath(join(realHome, '.dsh'), 'lss-g6-real')
    let recordState = 'absent'
    if (existsSync(realRecord)) {
      const parsed = JSON.parse(readFileSync(realRecord, 'utf8'))
      recordState = Array.isArray(parsed?.shims) && parsed.shims.length === 0 ? 'emptied' : `stale(${JSON.stringify(parsed?.shims)})`
    }
    check('⑥ 真机：记录文件已删除或已清空（不留陈旧条目）', recordState === 'absent' || recordState === 'emptied', `${realRecord} → ${recordState}`)
    try { rmSync(probeRoot, { recursive: true, force: true }) } catch {}
    if (existsSync(probeRoot)) { try { rmSync(`${probeRoot}.trash-${Date.now().toString(36)}`, { recursive: true, force: true }) } catch {} }
  }
}

// ── 收尾：只删本套沙箱；删不掉就改名降级（gitignore 覆盖 *.trash-*） ──────────────
try { rmSync(SANDBOX, { recursive: true, force: true }) } catch {}
if (existsSync(SANDBOX)) {
  try { rmSync(`${SANDBOX}.trash-${Date.now().toString(36)}`, { recursive: true, force: true }) } catch {}
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}${skipped === 0 ? '' : `（SKIP ${skipped}）`}`)
process.exit(failed === 0 ? 0 : 1)
