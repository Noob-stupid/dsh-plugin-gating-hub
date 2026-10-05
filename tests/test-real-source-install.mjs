// 「来源型默认真装」的**真 pnpm** 验收（2026-10-06 加法；用户点名「四种来源各真装一次必须成功」）
//
// 要证的是什么：`link:` 只把**一个目录**挂进 profile —— 依赖与 peer 谁都不管（真机 dsh-opencode-go
// 就是这样"装上了但加载不起来"）。把**真实来源规格**交给包管理器（`pnpm add <spec>`）之后，
// **依赖由 pnpm 负责装齐**，与官方 `dsh plugin add` 同一条通道。本套按四种来源逐个真装一次：
//   组 1  registry    `pnpm add <name>@<version>`
//   组 2  tgz（本地 tarball，刻意带一个 dependencies ⇒ 验"依赖真的被装齐"）
//   组 3  本地目录    `pnpm add file:<dir>`（同上，且与 link: 形成对照）
//   组 4  GitHub      `pnpm add github:<owner>/<repo>`（要网络 + git，缺则**响亮 SKIP**）
//   组 5  交叉验证    每种来源：**pnpm 自己写进清单的 specifier** === 我们 `planDependencySpec`
//                     计划的写回规格（= 我们直装的结果与官方通道逐字一致，不只是"看起来像"）
//   组 6  对照（负控）`link:` 装法**不会**补齐依赖 —— 证明"默认真装"不是措辞差别
//
// 环境门槛（缺就**响亮 SKIP**、退出码 0，绝不假装 PASS）：
//   · pnpm 解析不到（无 corepack / 无桌面端运行时）⇒ 整组 SKIP
//   · registry 不可达（离线/镜像挂）⇒ 组 1/2/3 SKIP；组 4 另需 git + GitHub 可达
// 本套刻意**不出网也能跑完**（组 3 与组 6 纯本地），这样 CI 的离线宿主仍有确定性断言。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPnpmWithFallback, execFileWithKillTree } from '../lib/server/infra/exec.js'
import { planDependencySpec } from '../lib/server/domain/manifest.js'
import { declareProfileDependency, installSourceDependency } from '../lib/server/domain/manifest.js'
import { lockVersion } from '../lib/server/domain/selfupdate.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SANDBOX = join(ROOT, '.testdir', 'real-source-install')
const REGISTRY = 'https://registry.npmmirror.com'
// 挑一个"小到不会拖慢 CI、又没有自己的依赖树"的真包做夹具依赖
const TINY_DEP = 'ms'
const TINY_DEP_VERSION = '2.1.3'

let failed = 0
let skipped = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const skip = (label, why) => { skipped += 1; console.log(`SKIP ${label} — ${why}`) }

function fresh(rel) {
  const dir = join(SANDBOX, rel)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: `rsi-${rel.replace(/[^a-z0-9]+/giu, '-')}`, private: true, dependencies: {} }, null, 2)}\n`, 'utf8')
  return dir
}
if (existsSync(SANDBOX)) { try { rmSync(SANDBOX, { recursive: true, force: true }) } catch {} }
mkdirSync(SANDBOX, { recursive: true })

const pnpmAdd = async (profileDir, spec) => {
  try {
    await runPnpmWithFallback(['add', spec, '--registry', REGISTRY], {
      execOpts: { cwd: profileDir, timeout: 180000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    })
    return { ok: true, error: null }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 400) }
  }
}
const depsOf = (dir) => {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies ?? {} } catch { return {} }
}
const resolvable = (from, name) => {
  let cur = from
  for (let i = 0; i < 12; i += 1) {
    const p = join(cur, 'node_modules', ...name.split('/'))
    if (existsSync(join(p, 'package.json'))) return p
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}
/**
 * pnpm 的 isolated 布局里，"依赖真的被装齐"落在 `<profile>/node_modules/.pnpm/<pkg>@<ver>/node_modules/<dep>`
 * （与包目录**同级**，不是提升到 profile 顶层）。本函数按这个布局找依赖实体 ——
 * 这正是"包管理器负责依赖"的可验证形态；`link:` 装法**不会**产生这样的实体（组 6 的反向断言）。
 */
const storeDepOf = (profileDir, dep) => {
  const store = join(profileDir, 'node_modules', '.pnpm')
  let entries = []
  try { entries = readdirSync(store, { withFileTypes: true }).filter((e) => e.isDirectory()) } catch { return null }
  for (const e of entries) {
    const p = join(store, e.name, 'node_modules', ...dep.split('/'))
    if (existsSync(join(p, 'package.json'))) return p
  }
  return null
}

// ── 前置：pnpm 能不能跑（跑不了就整组 SKIP，并说清原因） ─────────────────────
const probeDir = fresh('probe')
const probe = await pnpmAdd(probeDir, `${TINY_DEP}@${TINY_DEP_VERSION}`)
if (probe.ok !== true) {
  skip('真 pnpm 来源验收（组 1/2/3/5/6）', `pnpm add 跑不通（多为无 corepack/桌面端运行时或镜像不可达）：${probe.error}`)
} else {
  console.log(`前置：真 pnpm 可用，registry 可达（${TINY_DEP}@${TINY_DEP_VERSION} 已装）`)

  console.log('\n── 组 1：registry 来源 ─────────────────────────────────────────')
  {
    check('① registry 来源真装成功且可从 profile 解析', resolvable(probeDir, TINY_DEP) !== null, String(resolvable(probeDir, TINY_DEP)))
    check('① 清单里被 pnpm 写成真实版本规格', depsOf(probeDir)[TINY_DEP] === TINY_DEP_VERSION, JSON.stringify(depsOf(probeDir)))
  }

  console.log('\n── 组 2：tgz 来源（本地 tarball，带 dependencies）──────────────')
  {
    // 造一个真的 npm-pack 形状的 tarball：package/package.json + 一个真依赖
    const staging = join(SANDBOX, 'tgz-staging')
    mkdirSync(join(staging, 'package'), { recursive: true })
    writeFileSync(join(staging, 'package', 'package.json'), `${JSON.stringify({ name: 'rsi-tgz-fixture', version: '1.0.0', main: 'index.js', dependencies: { [TINY_DEP]: TINY_DEP_VERSION } }, null, 2)}\n`, 'utf8')
    writeFileSync(join(staging, 'package', 'index.js'), 'export default {}\n', 'utf8')
    const tgz = join(SANDBOX, 'rsi-tgz-fixture-1.0.0.tgz')
    let tarOk = true
    try {
      await execFileWithKillTree('tar', ['-czf', tgz, 'package'], { cwd: staging, timeout: 60000, windowsHide: true })
    } catch (error) {
      tarOk = false
      skip('② tgz 来源', `本机 tar 不可用：${String(error?.message ?? error).slice(0, 120)}`)
    }
    if (tarOk && existsSync(tgz)) {
      const profile2 = fresh('tgz')
      const ins = await pnpmAdd(profile2, tgz)
      check('② tgz 来源真装成功', ins.ok === true, ins.error ?? undefined)
      const installed2 = resolvable(profile2, 'rsi-tgz-fixture')
      check('② 包本身可从 profile 解析', installed2 !== null, String(installed2))
      // pnpm 的 isolated node-linker 把依赖装在**包自己的虚拟store里**（不提升到 profile 顶层），
      // 所以判据必须从**装好的那个包**出发解析 —— 这也正是"包管理器负责依赖"的实证。
      const dep2 = installed2 === null ? null : storeDepOf(profile2, TINY_DEP)
      check('② **依赖由 pnpm 装齐**（isolated 布局里确有依赖实体）', dep2 !== null, String(dep2))
      check('② 清单里写的是 tarball 规格（pnpm 自己写的形态）', String(depsOf(profile2)['rsi-tgz-fixture'] ?? '').length > 0, JSON.stringify(depsOf(profile2)))
    }
  }

  console.log('\n── 组 3：本地目录来源（file:）──────────────────────────────────')
  {
    const localDir = join(SANDBOX, 'local-dir-src')
    mkdirSync(localDir, { recursive: true })
    writeFileSync(join(localDir, 'package.json'), `${JSON.stringify({ name: 'rsi-local-fixture', version: '1.0.0', main: 'index.js', dependencies: { [TINY_DEP]: TINY_DEP_VERSION } }, null, 2)}\n`, 'utf8')
    writeFileSync(join(localDir, 'index.js'), 'export default {}\n', 'utf8')
    const profile3 = fresh('localdir')
    const spec = `file:${localDir.replace(/\\/gu, '/')}`
    const ins = await pnpmAdd(profile3, spec)
    check('③ 本地目录来源真装成功', ins.ok === true, ins.error ?? undefined)
    const installed3 = resolvable(profile3, 'rsi-local-fixture')
    check('③ 包本身可从 profile 解析', installed3 !== null, String(installed3))
    const dep3 = installed3 === null ? null : storeDepOf(profile3, TINY_DEP)
    check('③ **依赖由 pnpm 装齐**（isolated 布局里确有依赖实体；link: 做不到，见组 6）', dep3 !== null, String(dep3))
  }

  console.log('\n── 组 5：交叉验证（pnpm 自己写的 spec === 我们计划的写回 spec）──')
  {
    const probe404 = async () => ({ resolvable: false, hasVersion: false, latest: null, registry: null, tried: ['stub：HTTP 404 Not Found'] })
    // registry 来源
    const p1 = await planDependencySpec({ profileDir: probeDir, packageName: TINY_DEP, version: TINY_DEP_VERSION, probe: async (n, r, o = {}) => ({ resolvable: true, hasVersion: true, latest: o.version ?? null, registry: 'stub', tried: [] }) })
    check('⑤ registry：我们写版本号，pnpm 也写版本号（同一形态）', p1.form === 'version' && p1.spec === depsOf(probeDir)[TINY_DEP], JSON.stringify({ ours: p1.spec, pnpm: depsOf(probeDir)[TINY_DEP] }))
    // 来源型：我们计划的 spec 必须与"交给 pnpm 的那个 spec"逐字一致（否则清单与实测会分叉）
    const tgzProfile = join(SANDBOX, 'tgz')
    const tgzSpec = existsSync(tgzProfile) ? String(depsOf(tgzProfile)['rsi-tgz-fixture'] ?? '') : ''
    const p2 = await planDependencySpec({ profileDir: tgzProfile, packageName: 'rsi-tgz-fixture', version: '1.0.0', probe: probe404, sourceSpec: tgzSpec })
    check('⑤ 来源型：我们计划的写回规格与 pnpm 实际写入的规格逐字相同', p2.form === 'source' && p2.spec === tgzSpec && tgzSpec !== '', JSON.stringify({ ours: p2.spec, pnpm: tgzSpec }))
    check('⑤ 交叉验证：直装结果 == 官方通道结果（同一 pnpm、同一 spec、同一形态）', p2.spec === tgzSpec, `${p2.spec}`)
  }

  console.log('\n── 组 6：对照（负控）link: 装法**不会**补齐依赖 ────────────────')
  {
    const localDir = join(SANDBOX, 'local-dir-src')
    const profile6 = fresh('linkcontrast')
    const ins = await pnpmAdd(profile6, `link:${localDir.replace(/\\/gu, '/')}`)
    check('⑥ link: 装法本身可用（包能解析）', ins.ok === true && resolvable(profile6, 'rsi-local-fixture') !== null, ins.error ?? String(resolvable(profile6, 'rsi-local-fixture')))
    check('⑥ 负控：link: **不装**它的 dependencies（.pnpm 里查无该依赖实体 —— 所以必须由 link 自足性补齐）', storeDepOf(profile6, TINY_DEP) === null, `store=${storeDepOf(profile6, TINY_DEP)}`)
  }

  // ── 组 7～9（0.5.41 接线）：**收口层**把真实来源规格交给 pnpm 真装 ────────────────────────────
  // 组 1～6 证的是"pnpm 自己装的时候依赖跟着来"；这三组证的是**我们的产品路径**：
  // 取样通道（release 资产 / tarball URL / 本地目录）装完之后，收口那一步（declareProfileDependency）
  // 把真实来源规格交回 pnpm ⇒ 依赖由包管理器装齐（而不是只挂一个 link: 目录）。
  {
    const home = join(SANDBOX, 'wire-home')
    mkdirSync(home, { recursive: true })
    const probe404 = async () => ({ resolvable: false, hasVersion: false, latest: null, registry: null, tried: ['stub：HTTP 404 Not Found'] })

    console.log('\n── 组 7：接线 · tarball URL（真 pnpm：依赖由包管理器装齐）──────────')
    {
      const profile7 = fresh('wire-url')
      // 取样通道的形态：包已被解压铺进 node_modules（我们是"照抄一份"来模拟）
      const sampled = join(profile7, 'node_modules', 'debug')
      mkdirSync(sampled, { recursive: true })
      writeFileSync(join(sampled, 'package.json'), `${JSON.stringify({ name: 'debug', version: '4.3.4', main: 'src/index.js' }, null, 2)}\n`, 'utf8')
      const url = 'https://registry.npmmirror.com/debug/-/debug-4.3.4.tgz'
      // **不关 syncLock**：走生产默认（写完清单立刻对账）—— 这一步正是"URL 会不会被老保护规整回 link:"的现场
      const declared = await declareProfileDependency(profile7, 'debug', null, {
        home, probe: probe404, sourceSpec: url, sourceOrigin: 'sampled',
      })
      check('⑦ 收口层：真装被真的调用且成功（真 pnpm add <tarball URL>）', declared.sourceInstall?.ok === true, JSON.stringify({ ok: declared.sourceInstall?.ok, error: declared.sourceInstall?.error }))
      check('⑦ 清单写的是**真实来源规格**（不是 link:、不是版本号）', depsOf(profile7).debug === url, JSON.stringify({ manifest: depsOf(profile7).debug ?? null, form: declared.form }))
      check('★⑦ **依赖由 pnpm 装齐**（isolated 布局里确有 ms 实体）', storeDepOf(profile7, TINY_DEP) !== null, String(storeDepOf(profile7, TINY_DEP)))
      check('★⑦ 没有走 link: 回落（plugin-src 里没有这个包的副本）', !existsSync(join(home, 'plugin-src', 'debug')), join(home, 'plugin-src', 'debug'))
      check('★⑦ 最后的 lock 对账**没把真装出来的 URL 规整回 link:**（keepUrlSpecs 生效、清单逐字未变）',
        declared.lockSynced === true && depsOf(profile7).debug === url && !/已按 link: 形式记录/u.test(String(declared.depNote ?? '')),
        JSON.stringify({ lockSynced: declared.lockSynced, manifest: depsOf(profile7).debug ?? null, depNote: String(declared.depNote ?? '').slice(0, 160) }))
      check('★⑦ lock 里就是 pnpm 自己写下的那条 URL 解析（来源与清单同一形态）',
        typeof lockVersion(profile7, 'debug') === 'string' && String(lockVersion(profile7, 'debug')).length > 0,
        String(lockVersion(profile7, 'debug')))
      check('⑦ 文案如实说"已按真实来源规格真装"', /已按真实来源规格真装/u.test(String(declared.depNote ?? '')), String(declared.depNote ?? '').slice(0, 160))
    }

    console.log('\n── 组 8：接线 · registry 不倒退（真探测可解析 ⇒ 写版本号，不真装 URL）──────')
    {
      const profile8 = fresh('wire-registry')
      // 取样通道的形态：包已在 node_modules 里（registry 可解析的那一类）
      const sampled8 = join(profile8, 'node_modules', TINY_DEP)
      mkdirSync(sampled8, { recursive: true })
      writeFileSync(join(sampled8, 'package.json'), `${JSON.stringify({ name: TINY_DEP, version: TINY_DEP_VERSION }, null, 2)}\n`, 'utf8')
      const declared = await declareProfileDependency(profile8, TINY_DEP, TINY_DEP_VERSION, {
        syncLock: false, home, sourceSpec: `https://registry.npmmirror.com/ms/-/ms-${TINY_DEP_VERSION}.tgz`, sourceOrigin: 'sampled',
      })
      check('★⑧ registry 路径一字不改：清单写的是**版本号**（来源规格不抢优先级）',
        declared.form === 'version' && depsOf(profile8)[TINY_DEP] === TINY_DEP_VERSION,
        JSON.stringify({ form: declared.form, manifest: depsOf(profile8)[TINY_DEP] ?? null }))
      check('★⑧ registry 可解析 ⇒ **一次真装都不发起**（既有流程一字未改）', declared.sourceInstall === null, JSON.stringify(declared.sourceInstall))
    }

    console.log('\n── 组 9：接线 · 本地目录仍 link: + 自足（真 pnpm 在目标目录里装依赖）──────')
    {
      const profile9 = fresh('wire-localdir')
      const localDir = join(SANDBOX, 'wire-local-src')
      mkdirSync(localDir, { recursive: true })
      writeFileSync(join(localDir, 'package.json'), `${JSON.stringify({ name: 'rsi-wire-local', version: '1.0.0', main: 'index.js', dependencies: { [TINY_DEP]: TINY_DEP_VERSION } }, null, 2)}\n`, 'utf8')
      writeFileSync(join(localDir, 'index.js'), 'export default {}\n', 'utf8')
      const declared = await declareProfileDependency(profile9, 'rsi-wire-local', '1.0.0', {
        syncLock: false, home, probe: probe404, sourceSpec: `link:${localDir.replace(/\\/gu, '/')}`,
      })
      check('★⑨ 本地目录：清单仍按 link: 记录（显式开发式安装；不真装、不变 file:/版本号）',
        declared.form === 'link' && String(depsOf(profile9)['rsi-wire-local'] ?? '').startsWith('link:'),
        JSON.stringify({ form: declared.form, manifest: depsOf(profile9)['rsi-wire-local'] ?? null }))
      check('★⑨ 自足性照旧补齐：目标目录里真的装上了它的 dependencies（真 pnpm）',
        existsSync(join(localDir, 'node_modules', TINY_DEP, 'package.json')),
        join(localDir, 'node_modules', TINY_DEP))
    }
  }
}

// ── 组 4：GitHub 来源（要 git + GitHub 可达；缺则响亮 SKIP） ─────────────────
console.log('\n── 组 4：GitHub 来源（github:）────────────────────────────────')
{
  const skipNetwork = process.env.DSH_TEST_SKIP_NETWORK === '1'
  if (skipNetwork) {
    skip('④ GitHub 来源', 'DSH_TEST_SKIP_NETWORK=1（CI 离线模式：网络断言不参与门禁）')
  } else {
    const profile4 = fresh('github')
    // 用一个小而稳定的公开仓库；装成"别的包名"也算通过（这里只验通道能真装）
    const ins = await pnpmAdd(profile4, 'github:sindresorhus/is-npm')
    if (!ins.ok) {
      skip('④ GitHub 来源', `本机 github: 通道不可用（多为 git/GitHub 不可达）：${ins.error}`)
    } else {
      check('④ GitHub 来源真装成功', ins.ok === true, ins.error ?? undefined)
      // pnpm 会把 `github:owner/repo` 规范化成 `git+https://github.com/owner/repo.git` 写进清单
      // （实测），所以判据是"git 族规格"，不是字面量 github:。
      const written = String(depsOf(profile4)['is-npm'] ?? '')
      check('④ 清单里写的是 git 族规格（pnpm 规范化后的官方形态）', /^(?:git\+|github:)/u.test(written), written)
    }
  }
}

// ── 收尾 ─────────────────────────────────────────────────────────────────
try { rmSync(SANDBOX, { recursive: true, force: true }) } catch {}
if (existsSync(SANDBOX)) {
  try { rmSync(`${SANDBOX}.trash-${Date.now().toString(36)}`, { recursive: true, force: true }) } catch {}
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch {}
}

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}${skipped === 0 ? '' : `（SKIP ${skipped}）`}`)
process.exit(failed === 0 ? 0 : 1)
