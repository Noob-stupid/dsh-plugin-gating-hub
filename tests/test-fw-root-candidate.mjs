// 0.5.99 加法（issue #27 同源）：框架树探测**别把「死 profile」当候选**。
//
// 现场（已核实）：`fwRootFromDshHome()` 把 `<dshHome>/profiles/` 下**每个**子目录都塞进候选
//   （`if (d === 'node_modules') continue` 只跳过这一个），于是废弃 profile 也进候选。
//   真机上 desktop 在用、web 是 issue #27 的受害者；废弃 profile 里常留着旧框架的残影
//   （`@deepseek-ai/dsh/lib/bin.js` 还在、`.pnpm` store 早没了），而既有判据 `looksLikeFwRoot()`
//   **分不出死活** ⇒ 谁先被 readdir 排到谁就被选中（`--repair` 于是修错了树）。
//
// 本套钉死 7 段（全离线：私有临时目录 + 注入 readdir/排序器；不联网、不起子进程、不碰真实 profile）：
//   ① 活 desktop + 死 web（残缺树仍满足"像框架树"的既有判据、且 readdir 里排在前面）⇒ 选 desktop
//      —— 并且用"关掉排序器 = 旧顺序"把**旧行为确实会选死 web** 钉在同一段里（证明这是真回归测试）
//   ② **只有 web 一棵能用的树** ⇒ 仍选 web（不误杀 —— 防"修复过度"的关键反例）
//   ③ 两棵都像框架树、desktop 是当前 profile ⇒ 选 desktop（不随目录名 / readdir 顺序漂移）
//   ④ `DSH_PROFILE_DIR` 指向某棵树 ⇒ 直接用它（既有最高优先级不被破坏）
//   ⑤ `profiles/` 读不到 ⇒ 不抛错、沿用既有兜底（返回 null）—— 与改动前一致
//   ⑥ **旧顺序兜底**：排序器返回空 / 抛错 / 返回怪值 ⇒ 仍按旧顺序选到那棵树（不许因新判据选不到）
//   ⑦ 排序器本身：只**排**不增不减（是原列表的一个排列）、同档内保持原顺序（稳定）
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  activeProfileDirOf, fwRootFromDshHome, rankProfileCandidates,
} from '../lib/server/infra/fw-root-detect.js'

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

const SANDBOX = mkdtempSync(join(tmpdir(), 'dsh-fw-cand-'))
const home = join(SANDBOX, 'dsh-home')
const profiles = join(home, 'profiles')

/** 造一棵"像框架树"的 node_modules（真磁盘；判据看的就是这个文件）。 */
const makeTree = (name, { store = true } = {}) => {
  const nm = join(profiles, name, 'node_modules')
  const bin = join(nm, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  mkdirSync(dirname(bin), { recursive: true })
  writeFileSync(bin, '// entry\n', 'utf8')
  if (store) {
    const inner = join(nm, '.pnpm', '@deepseek-ai+dsh@0.2.0-rc.2', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    mkdirSync(dirname(inner), { recursive: true })
    writeFileSync(inner, '// store entry\n', 'utf8')
  }
  return nm
}
/** 造一个"死 profile"：node_modules 有残影、但没有 store（= issue #27 里那个废弃 web 的形状）。 */
const makeDeadProfile = (name) => {
  const nm = join(profiles, name, 'node_modules')
  const bin = join(nm, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  mkdirSync(dirname(bin), { recursive: true })
  writeFileSync(bin, '// stale leftover from an old framework version\n', 'utf8')
  mkdirSync(join(nm, '.pnpm'), { recursive: true })   // 空 store：目录在、实体早被清掉
  return nm
}

const desktopTree = makeTree('desktop')
const webTree = makeDeadProfile('web')
const legacyTree = makeTree('legacy')

/** 注入 readdir：让 `profiles/` 的枚举顺序**固定**成给定数组（不受宿主排序影响）。 */
const readdirOf = (order) => (p) => {
  if (p === profiles) return [...order]
  throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
}

// ══ ① 活 desktop + 死 web ⇒ 选 desktop；同一段证明"旧顺序会选死 web" ══════════════
{
  const env = { DSH_HOME: home, DSH_PROFILE_DIR: join(profiles, 'desktop') }
  const got = fwRootFromDshHome({ env, home, deps: { readdir: readdirOf(['web', 'desktop']) } })
  check('① 活 desktop + 死 web（readdir 里 web 在前）⇒ 选 desktop',
    got?.fwRoot === desktopTree, JSON.stringify(got))
  check('① via 仍是既有的 dsh-home（返回形状没变）', got?.via === 'dsh-home', String(got?.via))

  // 同一夹具、把排序器换成"什么都不排"（== 旧顺序）⇒ 旧行为确实会选死 web
  const legacyOrder = fwRootFromDshHome({
    env, home, deps: { readdir: readdirOf(['web', 'desktop']), rankCandidates: () => [] },
  })
  check('① 对照：按**旧顺序**（排序器注入成空）确实会选死 web —— 说明上一条是真回归，不是白测',
    legacyOrder?.fwRoot === webTree, JSON.stringify(legacyOrder))
}

// ══ ② 只有 web 一棵能用的树 ⇒ 仍选 web（不误杀）══════════════════════════════════
{
  // desktop 目录在、但**不是**框架树（node_modules 里没有 dsh）⇒ 不能被误选
  mkdirSync(join(profiles, 'desktop-only-empty', 'node_modules'), { recursive: true })
  const env = { DSH_HOME: home, DSH_PROFILE_DIR: join(profiles, 'desktop-only-empty') }
  const got = fwRootFromDshHome({ env, home, deps: { readdir: readdirOf(['web', 'desktop-only-empty']) } })
  check('② 只有 web 一棵能用的树 ⇒ 仍选 web（**不误杀** —— 防"修复过度"的关键反例）',
    got?.fwRoot === webTree, JSON.stringify(got))
}

// ══ ③ 两棵都像框架树、desktop 是当前 profile ⇒ 选 desktop（稳定）════════════════════
{
  const desktopAlive = makeTree('desktop-alive')
  const webAlive = makeTree('web-alive')
  const env = { DSH_HOME: home, DSH_PROFILE_DIR: join(profiles, 'desktop-alive') }
  const deps = { readdir: readdirOf(['web-alive', 'desktop-alive']) }
  const got = fwRootFromDshHome({ env, home, deps })
  check('③ 两棵都像框架树时选"当前 profile"那棵（readdir 里它在后面 ⇒ 不是靠目录名排序碰巧）',
    got?.fwRoot === desktopAlive && got?.fwRoot !== webAlive, JSON.stringify(got))
  // 稳定：同样的输入连跑 3 次结论一致（不随排序实现抖动）
  const again = [0, 1, 2].map(() => fwRootFromDshHome({ env, home, deps })?.fwRoot)
  check('③ 稳定：同输入连跑 3 次结论一致', again.every((p) => p === desktopAlive), JSON.stringify(again))
  // 活/死与顺序无关的第二组：把 readdir 顺序反过来也选同一棵
  const reversed = fwRootFromDshHome({ env, home, deps: { readdir: readdirOf(['desktop-alive', 'web-alive']) } })
  check('③ 稳定：readdir 顺序反过来仍选同一棵', reversed?.fwRoot === desktopAlive, JSON.stringify(reversed))
}

// ══ ④ DSH_PROFILE_DIR 指向某棵树 ⇒ 直接用它（既有优先级不被破坏）══════════════════
{
  const env = { DSH_HOME: home, DSH_PROFILE_DIR: legacyTree }
  const got = fwRootFromDshHome({ env, home, deps: { readdir: readdirOf(['web', 'desktop']) } })
  check('④ DSH_PROFILE_DIR 指向某棵树 ⇒ 第一个就返回它（既有最高优先级不动）',
    got?.fwRoot === legacyTree, JSON.stringify(got))
  // DSH_PROFILE（只给名字）同样仍然生效
  const byName = fwRootFromDshHome({
    env: { DSH_HOME: home, DSH_PROFILE: 'legacy' }, home, deps: { readdir: readdirOf(['web', 'desktop', 'legacy']) },
  })
  check('④ DSH_PROFILE（只给名字）仍然生效（拼 profiles/<name>，行为不变）',
    byName?.fwRoot === legacyTree, JSON.stringify(byName))
}

// ══ ⑤ profiles/ 读不到 ⇒ 不抛错、返回 null（与改动前一致）══════════════════════════
{
  const throwing = () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) }
  let got = 'unset'
  let error = null
  try { got = fwRootFromDshHome({ env: { DSH_HOME: join(SANDBOX, 'no-such-home') }, home, deps: { readdir: throwing } }) } catch (e) { error = e }
  check('⑤ profiles/ 读不到时不抛错（既有兜底语义不变）', error === null, String(error?.message ?? ''))
  check('⑤ 且如实返回 null（不猜一棵）', got === null, JSON.stringify(got))
  // 再来一次：home 整个不存在（连 DSH_HOME 都没有）
  let got2 = 'unset'
  let error2 = null
  try { got2 = fwRootFromDshHome({ env: {}, home: join(SANDBOX, 'ghost-home'), deps: { readdir: throwing } }) } catch (e) { error2 = e }
  check('⑤ home 不存在 + profiles 读不到 ⇒ 同样不抛错、返回 null',
    error2 === null && got2 === null, `${String(error2?.message ?? '')} ${JSON.stringify(got2)}`)
}

// ══ ⑥ 旧顺序兜底：排序器空 / 抛错 / 返回怪值 ⇒ 仍按旧顺序选到（不许选不到）════════════
{
  const env = { DSH_HOME: home, DSH_PROFILE_DIR: join(profiles, 'desktop') }
  const order = ['web', 'desktop']
  const cases = {
    '排序器返回空数组': () => [],
    '排序器抛异常': () => { throw new Error('boom') },
    '排序器返回怪值（字符串）': () => 'nope',
    '排序器返回怪值（数字数组）': () => [1, 2, 3],
    '排序器把候选全换成别的路径': () => [join(SANDBOX, 'elsewhere'), join(SANDBOX, 'nowhere')],
  }
  for (const [label, rank] of Object.entries(cases)) {
    let got = 'unset'
    let error = null
    try { got = fwRootFromDshHome({ env, home, deps: { readdir: readdirOf(order), rankCandidates: rank } }) } catch (e) { error = e }
    check(`⑥ ${label} ⇒ 仍按旧顺序选到一棵树（不抛错、不返回 null）`,
      error === null && (got?.fwRoot === webTree || got?.fwRoot === desktopTree), JSON.stringify(got ?? String(error?.message)))
  }
  // 兜底的确切语义：旧顺序里第一棵能用的必须还是"第一棵能用的"
  const legacyHit = fwRootFromDshHome({ env, home, deps: { readdir: readdirOf(order), rankCandidates: () => [] } })
  check('⑥ 兜底走的是**旧顺序**（web 在前 ⇒ web），不是"随便一棵"', legacyHit?.fwRoot === webTree, JSON.stringify(legacyHit))
}

// ══ ⑦ 排序器本身：只排不增不减 + 同档稳定 ════════════════════════════════════════
{
  const list = ['a', 'b', 'c', 'd']
  // 只有 c 是"像框架树"的；c 同时不在当前 profile 里
  const looksLike = (dir) => dir === join('/home', 'profiles', 'c', 'node_modules')
  const out = rankProfileCandidates(
    list.map((n) => join('/home/profiles', n, 'node_modules')),
    { activeProfileDir: join('/home/profiles', 'b'), looksLike },
  )
  const asNames = out.map((p) => p.split(/[\\/]/u)[3])
  check('⑦ 只排不增不减：输出是输入的**排列**（长度相同、集合相同）',
    out.length === 4 && asNames.slice().sort().join(',') === 'a,b,c,d', JSON.stringify(asNames))
  check('⑦ 当前 profile（b）最先，其次"像框架树"的（c），其余按原顺序（a、d）',
    asNames.join(',') === 'b,c,a,d', JSON.stringify(asNames))
  // 稳定：同档内保持传入顺序
  const zTree = join('/h/p/z/node_modules')
  const yTree = join('/h/p/y/node_modules')
  const flat = rankProfileCandidates([zTree, yTree], { looksLike: () => false })
  check('⑦ 同档内保持传入顺序（稳定，不靠目录名排序）',
    flat.length === 2 && flat[0] === zTree && flat[1] === yTree, JSON.stringify(flat))
  // 非法输入不抛：空数组 / 非数组 / 混进非字符串
  check('⑦ 非法输入不抛错（空数组 / null / 混进非字符串）',
    JSON.stringify(rankProfileCandidates([])) === '[]'
    && JSON.stringify(rankProfileCandidates(null)) === '[]'
    && JSON.stringify(rankProfileCandidates([null, 42, join('/h/p/q/node_modules')])) === JSON.stringify([join('/h/p/q/node_modules')]),
    '三例各一次')
  // 「当前 profile」比对要认 Windows 的大小写不敏感（同一个目录不许被当成两个）
  const winCase = process.platform === 'win32'
    ? rankProfileCandidates(['C:\\Users\\X\\.dsh\\profiles\\Desktop\\node_modules', 'C:\\Users\\X\\.dsh\\profiles\\web\\node_modules'],
      { activeProfileDir: 'c:\\users\\x\\.dsh\\profiles\\desktop', looksLike: () => false })
    : [join('/H/P/desk/NM')]
  check('⑦ 大小写不同的同一目录仍认成"当前 profile"（Windows 语义；非 win32 跳过比对）',
    process.platform !== 'win32' || winCase[0].toLowerCase().includes('desktop'), JSON.stringify(winCase))
  // activeProfileDirOf：都推导不出来时返回 null（排序优化自动跳过，不报错）
  check('⑦ activeProfileDirOf 推导不出来 ⇒ null（不猜、不抛）',
    activeProfileDirOf({ env: {}, dshHome: '/h', deps: {} }) === null, String(activeProfileDirOf({ env: {}, dshHome: '/h', deps: {} })))
  const abs = (p) => resolve(p)
  check('⑦ activeProfileDirOf 认得 deps.patchPath / deps.profileDir / deps.derivePatchPath（含抛错不炸）',
    activeProfileDirOf({ env: {}, dshHome: '/h', deps: { patchPath: join('/h', 'profiles', 'p1', 'cordis.patch.yml') } }) === abs(join('/h', 'profiles', 'p1'))
    && activeProfileDirOf({ env: {}, dshHome: '/h', deps: { profileDir: join('/h', 'profiles', 'p2') } }) === abs(join('/h', 'profiles', 'p2'))
    && activeProfileDirOf({ env: {}, dshHome: '/h', deps: { derivePatchPath: () => join('/h', 'profiles', 'p3', 'cordis.patch.yml') } }) === abs(join('/h', 'profiles', 'p3'))
    && activeProfileDirOf({ env: {}, dshHome: '/h', deps: { derivePatchPath: () => { throw new Error('boom') }, profileDir: join('/h', 'profiles', 'p4') } }) === abs(join('/h', 'profiles', 'p4')),
    `p1=${activeProfileDirOf({ env: {}, dshHome: '/h', deps: { patchPath: join('/h', 'profiles', 'p1', 'cordis.patch.yml') } })}`)
}

rmSync(SANDBOX, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
