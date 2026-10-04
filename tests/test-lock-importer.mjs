// 修 1/2/3 的回归测试（0.5.39 加法 + 改错）—— 非 registry 来源的 lock 持久化走**定点写入**，不再 `pnpm add`。
//
// 用户 2026-10-04 定案（三件事）：
//   修 1：`reconcileLockfile` 对 `link:` 漂移过去会跑一次**完整** `pnpm add`。现在：非 registry 来源
//         **只写 lock importer 条目**（复用既有写入通路，不新造第二套），写出后用 pnpm 的**只读**用法
//         确认 lock 可解析；失败或无法确认 ⇒ 未持久化 + 缺口明细 + 一键钉住（**不许报成功**）。
//   修 2：`link:` 规格的斜杠归一 —— 反斜杠与正斜杠**等价** ⇒ 视为完好、**零写盘**；只有真漂移才写规范形。
//   修 3：现场事实固化 —— `pnpm install --lockfile-only`（pnpm 11.21.0）会剥掉**无关条目**的 peer 后缀，
//         我们的写入**不得**经过这种通路：本套拿一条带 peer 后缀的无关条目做**逐字节**负控。
//
// 本套全部离线（私有 DSH_HOME + 夹具 profile + 注入写入器/校验器，零外网）；真 pnpm 那一组只做
// **只读**校验（不装任何包），pnpm 不可用时**响亮 SKIP**（打印原因、不假装 PASS）。
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'lock-importer-home')
process.env.DSH_HOME = HOME
process.env.DSH_TEST_SKIP_NETWORK = '1'
rmSync(HOME, { recursive: true, force: true })

const PROFILE = join(HOME, 'profiles', 'web')
mkdirSync(join(PROFILE, 'node_modules'), { recursive: true })

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const skip = (label, why) => console.log(`SKIP ${label} — ${why}`)
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

const {
  IMPORTER_ONLY_RE, canWriteImporterEntry, lockEntryKeyMatches, lockVersionText, lockfileSettingsFlags,
  planLockImporterEntry, verifyArgsFor, verifyLockReadOnly, writeLockImporterEntry,
} = await import('../lib/server/domain/lock-importer.js')
const { reconcileLockfile, lockVersion, profileSpec } = await import('../lib/server/domain/selfupdate.js')
const { canonicalSourceSpec, sameSourceSpec } = await import('../lib/server/domain/dep-source.js')
const { setProfileDependency, pinProfileDependency } = await import('../lib/server/domain/manifest.js')
const { persistReport, ensurePersisted } = await import('../lib/server/domain/persist.js')

// ── 夹具 ─────────────────────────────────────────────────────────────────────
const LOCK = join(PROFILE, 'pnpm-lock.yaml')
const MANIFEST = join(PROFILE, 'package.json')
const PATCH = join(PROFILE, 'cordis.patch.yml')
const writeManifest = (deps, extra = {}) => writeFileSync(MANIFEST, `${JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: deps, dsh: { profile: { bundles: [] } }, ...extra }, null, 2)}\n`, 'utf8')
const readManifest = () => JSON.parse(readFileSync(MANIFEST, 'utf8'))
const writePkg = (name, version, dir) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }, null, 2), 'utf8')
  writeFileSync(join(dir, 'index.js'), 'export default {}\n', 'utf8')
  return dir
}
/** 一次性测试插件：真包目录放在 plugin-src，node_modules 里是指向它的链接（pnpm 的 link 形态）。 */
const linkFixture = (name, version = '9.9.9') => {
  const src = writePkg(name, version, join(HOME, 'plugin-src', ...name.split('/')))
  const dest = join(PROFILE, 'node_modules', ...name.split('/'))
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  symlinkSync(src, dest, 'junction')
  return { src, dest, spec: `link:${src.replace(/\\/gu, '/')}` }
}
const lockKeyOf = (name) => (/[/@]/u.test(name) ? `'${name}':` : `${name}:`)
/** 写一份**真机形态**的 lock：`无关条目` 带 peer 后缀（真机 desktop profile 的
 *  `@deepseek-ai/dsh-experimental-schedule-bundle` 就是这个形态）—— 修 3 的负控就靠它。 */
const PEER_ENTRY = [
  "      '@deepseek-ai/dsh-experimental-schedule-bundle':",
  '        specifier: 0.2.0-rc.2',
  '        version: 0.2.0-rc.2(@deepseek-ai/dsh-brand@0.1.7-rc.2)',
].join('\n')
const UNRELATED_LINES = [
  'settings:',
  '  autoInstallPeers: false',
  '  excludeLinksFromLockfile: false',
]
const writeLock = ({ name = null, specifier = null, version = null, section = 'dependencies', extraImporter = [] } = {}) => {
  const lines = ["lockfileVersion: '9.0'", '', ...UNRELATED_LINES, '', 'importers:', '', '  .:', `    ${section}:`, PEER_ENTRY, ...extraImporter]
  if (name !== null) lines.push(`      ${lockKeyOf(name)}`, `        specifier: ${specifier}`, `        version: ${version}`)
  lines.push('', 'packages:', '', "  '@deepseek-ai/dsh-brand@0.1.7-rc.2':", '    resolution: {integrity: sha512-xx}', '')
  writeFileSync(LOCK, lines.join('\n'), 'utf8')
  return readFileSync(LOCK, 'utf8')
}
const peerLinesOf = (text) => text.split(/\r?\n/u).filter((l) => l.includes('dsh-experimental-schedule-bundle') || l.includes('(@deepseek-ai/dsh-brand'))

console.log('=== ① 修 3 现场事实：写通路**不动**无关条目（含 peer 后缀）逐字节负控 ===')
{
  const { src } = linkFixture('@fake/importer-target')
  const spec = `link:${src.replace(/\\/gu, '/')}`
  const before = writeLock({})
  const peerBefore = peerLinesOf(before).join('\n')
  const plan = planLockImporterEntry(before, { name: '@fake/importer-target', specifier: spec, version: 'link:../../plugin-src/@fake/importer-target' })
  check('① 正控：未知条目被插入（changed=true），且无关条目一字不动',
    plan.ok === true && plan.changed === true && peerLinesOf(plan.text).join('\n') === peerBefore,
    JSON.stringify({ ok: plan.ok, changed: plan.changed }))
  check('① 正控：插入的键/两行形态与 pnpm 一致（引号键 + specifier 逐字 + version 相对路径）',
    plan.text.includes("      '@fake/importer-target':") && plan.text.includes(`        specifier: ${spec}`)
    && plan.text.includes('        version: link:../../plugin-src/@fake/importer-target'), '')
  // 逐字节负控：除了新增的那三行，其余每一行都必须与原文**逐行相同**（含 CRLF 场景）
  const probe = (text, label) => {
    const out = planLockImporterEntry(text, { name: '@fake/importer-target', specifier: spec, version: 'link:../../plugin-src/@fake/importer-target' })
    const kept = out.text.split(/\r?\n/u).filter((l) => !l.includes('importer-target'))
    const orig = text.split(/\r?\n/u)
    return check(`① 负控（${label}）：无关行**逐行逐字节**不变（含带 peer 后缀的条目）`,
      kept.length === orig.length && kept.every((l, i) => l === orig[i]), `kept=${kept.length} orig=${orig.length}`)
  }
  probe(before, 'LF')
  probe(before.replace(/\n/gu, '\r\n'), 'CRLF')
  const real = writeLock({ name: '@fake/importer-target', specifier: spec, version: 'link:../../plugin-src/@fake/other-place' })
  const fix = planLockImporterEntry(real, { name: '@fake/importer-target', specifier: spec, version: 'link:../../plugin-src/@fake/importer-target' })
  check('① 正控：真漂移时**只动该条目的 version 行**（无关条目 + 其它字节不变）',
    fix.changed === true && fix.text.replace('        version: link:../../plugin-src/@fake/importer-target', '        version: link:../../plugin-src/@fake/other-place') === real,
    '')
  const same = planLockImporterEntry(real, { name: '@fake/importer-target', specifier: spec, version: 'link:../../plugin-src/@fake/other-place' })
  check('① 负控：形态已经正确 ⇒ changed=false（零写盘）', same.ok === true && same.changed === false)
  check('① 修 3 注释：写入实现**不经过** pnpm（本模块只做文本手术，无任何 pnpm 调用点）',
    !/pnpm install --lockfile-only[^\n]*\n[^\n]*writeFileSync/u.test(readFileSync(join(ROOT, '..', 'lib', 'server', 'domain', 'lock-importer.js'), 'utf8')), '')
}

console.log('\n=== ② 修 2：斜杠归一与等价判等（等价 ⇒ 零写盘；真漂移 ⇒ 写规范形）===')
{
  const NAME = '@fake/slash-target'
  const { src, spec } = linkFixture(NAME)
  const backslash = `link:${src.replace(/\//gu, '\\')}`
  check('② 规范形：反斜杠 → 正斜杠；尾斜杠去掉；盘根保留',
    canonicalSourceSpec(backslash) === spec && canonicalSourceSpec(`${spec}/`) === spec
    && canonicalSourceSpec('link:C:\\') === 'link:C:/' && canonicalSourceSpec(' 1.0.0 ') === '1.0.0',
    `${canonicalSourceSpec(backslash)} | ${canonicalSourceSpec(`${spec}/`)}`)
  check('② 等价判等：反斜杠 ↔ 正斜杠、相对 ↔ 绝对（同一目录）都算等价',
    sameSourceSpec(PROFILE, backslash, spec) === true
    && sameSourceSpec(PROFILE, spec, `link:${src.replace(/\\/gu, '/').toUpperCase()}`) === true,
    '')
  check('② 负控：指向**不同**目录不算等价（真漂移照样判得出来）',
    sameSourceSpec(PROFILE, spec, 'link:C:/nowhere/else') === false)

  // 清单写入器：等价 ⇒ **零写盘**（幂等），并逐字节核对
  writeManifest({ [NAME]: backslash })
  const manifestBefore = readFileSync(MANIFEST, 'utf8')
  const wrote = await setProfileDependency(PROFILE, NAME, spec)
  check('② 负控（幂等零写盘）：清单里是反斜杠、目标是正斜杠（同一目录）⇒ 一个字节都不写',
    wrote.changed === false && readFileSync(MANIFEST, 'utf8') === manifestBefore, JSON.stringify(wrote))
  const pinned = await pinProfileDependency(PROFILE, NAME, {})
  check('② 负控：pinProfileDependency（0.5.38 里"任何路径都会把它改成正斜杠"的那条）等价时也不写清单',
    pinned.changed === false && readFileSync(MANIFEST, 'utf8') === manifestBefore && pinned.ok === true, JSON.stringify({ changed: pinned.changed, ok: pinned.ok }))
  // 真漂移：写规范形
  const other = writePkg(NAME, '9.9.9', join(HOME, 'plugin-src', 'other-copy'))
  const drifted = await setProfileDependency(PROFILE, NAME, `link:${other.replace(/\\/gu, '/')}`)
  check('② 正控：真实漂移（目标不同）⇒ 写，且写的是**规范形**（正斜杠）',
    drifted.changed === true && readManifest().dependencies[NAME] === `link:${other.replace(/\\/gu, '/')}` && !readManifest().dependencies[NAME].includes('\\'),
    String(readManifest().dependencies[NAME]))
  writeManifest({ [NAME]: backslash })
}

console.log('\n=== ③ 修 1：真漂移 ⇒ **只写 lock importer 条目**（绝不用 pnpm add 当持久化手段）===')
{
  const NAME = '@fake/lock-only'
  const { spec } = linkFixture(NAME)
  writeManifest({ [NAME]: spec })
  const before = writeLock({ section: 'dependencies' })
  const peerBefore = peerLinesOf(before).join('\n')
  let pnpmAddCalls = 0
  const r = await reconcileLockfile({
    profileDir: PROFILE, packages: [{ name: NAME }], registries: ['http://127.0.0.1:1'],
    pnpmAdd: async () => { pnpmAddCalls += 1; throw new Error('不该被调用：非 registry 来源不得用 pnpm add 当持久化手段') },
    fetchJson: async () => { throw new Error('不该被调用：非 registry 来源不探 registry') },
    deps: { verifyLock: async () => ({ verified: true, via: 'stub', reason: null }) },
  })
  const lockText = readFileSync(LOCK, 'utf8')
  check('③ 正控：lock 里出现了 importer 条目（specifier 逐字 + version 相对路径）',
    lockText.includes(`        specifier: ${spec}`) && lockText.includes('        version: link:../../plugin-src/@fake/lock-only'), '')
  check('③ 正控：pnpm add 一次都没跑（修 1 的核心：不改用完整安装当持久化手段）', pnpmAddCalls === 0, `calls=${pnpmAddCalls}`)
  check('③ 正控：lockUpdated=true（读回核实 + 只读校验确认）+ lockVerified=true + method=lock-importer',
    r.lockUpdated === true && r.lockVerified === true && r.method === 'lock-importer' && r.lockNote === null,
    JSON.stringify({ lockUpdated: r.lockUpdated, lockVerified: r.lockVerified, method: r.method, note: r.lockNote }))
  check('③ 正控：无关条目（含 peer 后缀）逐字节不变', peerLinesOf(lockText).join('\n') === peerBefore, '')
  const again = await reconcileLockfile({
    profileDir: PROFILE, packages: [{ name: NAME }], registries: [],
    pnpmAdd: async () => { throw new Error('不该被调用') },
    deps: { verifyLock: async () => { throw new Error('不该被调用：没有写入就不需要校验') } },
  })
  check('③ 负控（幂等零写盘）：条目已就位时再对账 ⇒ 零写盘、lockUpdated=true、不去校验',
    again.lockUpdated === true && readFileSync(LOCK, 'utf8') === lockText, JSON.stringify({ lockUpdated: again.lockUpdated }))
}

console.log('\n=== ④ 负控：lock 写失败 / 只读校验没通过 / 无法确认 ⇒ 必须报未持久化（不许报成功）===')
{
  const NAME = '@fake/lock-broken'
  const { spec } = linkFixture(NAME)
  writeManifest({ [NAME]: spec })
  writeLock({})
  const r = await reconcileLockfile({
    profileDir: PROFILE, packages: [{ name: NAME }], registries: [],
    pnpmAdd: async () => { throw new Error('不该被调用') },
    deps: { writeImporter: async () => ({ changed: false, unchanged: false, reason: '模拟：lock 写盘失败（负控）' }) },
  })
  check('④ 负控：lock 写失败 ⇒ lockUpdated=false、缺口明细点名该包、一键钉住动作下发',
    r.lockUpdated === false && /lock 写盘失败/u.test(String(r.lockNote)) && r.suggestedActions[0]?.payload?.action === 'pin-dependency',
    JSON.stringify({ note: String(r.lockNote).slice(0, 90), action: r.suggestedActions[0]?.payload?.action }))
  check('④ 负控：depNote 如实说"未写入"，绝不出现"已按 link: 形式记录依赖"',
    /未写入|未能写入/u.test(String(r.depNote)) && !/已按 link: 形式记录依赖/u.test(String(r.depNote)), String(r.depNote).slice(0, 120))

  // 只读校验没通过 / 无法确认 ⇒ 条目虽然写进去了，也必须按未持久化处理
  const NAME2 = '@fake/verify-fail'
  const f2 = linkFixture(NAME2)
  writeManifest({ [NAME2]: f2.spec })
  writeLock({})
  const rFail = await reconcileLockfile({
    profileDir: PROFILE, packages: [{ name: NAME2 }], registries: [],
    pnpmAdd: async () => { throw new Error('不该被调用') },
    deps: { verifyLock: async () => ({ verified: false, reason: '模拟：pnpm 只读校验未通过', attempts: [] }) },
  })
  check('④ 负控：只读校验未通过 ⇒ lockUpdated=false（即便磁盘上已有那两行）+ lockVerified=false',
    rFail.lockUpdated === false && rFail.lockVerified === false && /只读校验未通过/u.test(String(rFail.lockNote)),
    String(rFail.lockNote).slice(0, 140))
  check('④ 负控：这一条照样下发一键钉住（缺口明细 + 出路）',
    rFail.suggestedActions.some((a) => a?.payload?.action === 'pin-dependency'), JSON.stringify(rFail.suggestedActions.map((a) => a?.payload?.action)))
  // 先造**真漂移**（lock 里的 version 指错地方）⇒ 这次确实会写条目，只读校验才有"确认"可言
  writeLock({ name: NAME2, specifier: f2.spec, version: 'link:../../plugin-src/@fake/wrong-place' })
  const rNull = await reconcileLockfile({
    profileDir: PROFILE, packages: [{ name: NAME2 }], registries: [],
    pnpmAdd: async () => { throw new Error('不该被调用') },
    deps: { verifyLock: async () => ({ verified: null, reason: '模拟：pnpm 执行方式不可用（无法确认）' }) },
  })
  check('④ 负控：无法确认（pnpm 跑不起来）⇒ 同样 lockUpdated=false、lockVerified=null、文案含"未持久化"',
    rNull.lockUpdated === false && rNull.lockVerified === null && /未持久化/u.test(String(rNull.lockNote)),
    JSON.stringify({ lockUpdated: rNull.lockUpdated, lockVerified: rNull.lockVerified, note: String(rNull.lockNote).slice(0, 110) }))
  // 端到端（persist.js 收口）：只读校验没过时，**最终结论**必须跟着降级
  writeLock({ name: NAME2, specifier: f2.spec, version: 'link:../../plugin-src/@fake/still-wrong' })
  const settled = await ensurePersisted({
    profileDir: PROFILE, patchPath: PATCH, packageName: NAME2, mode: 'insert', taken: new Set(), registries: [],
    deps: {
      declare: async (profileDir, name) => setProfileDependency(profileDir, name, f2.spec).then((w) => ({ changed: w.changed, version: '9.9.9', spec: w.after, form: 'link', reason: null, lockSynced: false, lockNote: null, depNote: null, suggested: null })),
      insert: async () => ({ changed: true }),
      reconcile: async () => {
        writeLock({ name: NAME2, specifier: f2.spec, version: 'link:../../plugin-src/@fake/verify-fail' })
        return { lockUpdated: false, lockVerified: null, lockNote: 'pnpm 的**只读**校验无法确认（模拟）—— 按**未持久化**处理，绝不报成功', depNote: null, suggestedActions: [] }
      },
    },
  })
  check('④ 负控（收口）：persisted=false 且 missing 点名 lock、note 含「未持久化」、一键钉住动作在下发',
    settled.persisted === false && settled.missing.includes('lock') && /未持久化/u.test(String(settled.note))
    && settled.suggested?.kind === 'persist-plugin', JSON.stringify({ persisted: settled.persisted, missing: settled.missing }))
  check('④ 负控（收口）：lock 那一处的 reason 用的是只读校验的真实原因（不是"没有条目"）',
    /只读/u.test(String(settled.parts.lock.reason)) && /未持久化/u.test(String(settled.parts.lock.reason)), String(settled.parts.lock.reason))
}

console.log('\n=== ⑤ 负控：link: 来源**不得**用 registry 404 判问题（既有规矩，回归）===')
{
  const NAME = '@fake/no-registry-judge'
  const { spec } = linkFixture(NAME)
  writeManifest({ [NAME]: spec })
  writeLock({})
  let probes = 0
  const r = await reconcileLockfile({
    profileDir: PROFILE, packages: [{ name: NAME }], registries: ['http://127.0.0.1:1'],
    pnpmAdd: async () => { throw new Error('不该被调用') },
    fetchJson: async () => { probes += 1; throw new Error('不该被调用：link: 依赖不经 registry 解析') },
    deps: { verifyLock: async () => ({ verified: true, via: 'stub', reason: null }) },
  })
  check('⑤ 负控：link: 漂移全程 0 次 registry 探测、0 次 pnpm add', probes === 0, `probes=${probes}`)
  check('⑤ 负控：文案里不出现 404 / registry 查无此包一类判据',
    !/404|查无此包/u.test(`${r.lockNote ?? ''}${r.depNote ?? ''}`), String(`${r.lockNote ?? ''}${r.depNote ?? ''}`).slice(0, 120))
  const report = persistReport({ profileDir: PROFILE, patchPath: PATCH, packageName: NAME, entries: [], bundles: [] })
  check('⑤ 正控：三处判据里 lock 那处已就位（link 条目没有 integrity 也照样算数）',
    report.parts.lock.ok === true, JSON.stringify(report.parts.lock))
}

console.log('\n=== ⑥ 单测：argv 唯一产出点 + 设置镜像 + 非白名单来源不伪造条目 ===')
{
  check('⑥ verifyArgsFor：只读三件套 + 设置镜像；不带 relax 时**没有**任何绕过开关',
    JSON.stringify(verifyArgsFor({ registry: 'https://r.example', settings: ['--config.autoInstallPeers=false'] }))
    === JSON.stringify(['install', '--lockfile-only', '--dry-run', '--frozen-lockfile', '--registry', 'https://r.example', '--config.autoInstallPeers=false']),
    JSON.stringify(verifyArgsFor({ registry: 'https://r.example', settings: ['--config.autoInstallPeers=false'] })))
  check('⑥ verifyArgsFor：放宽供应链年龄闸只在**显式要求**时出现（只读重试用），且仍带 --dry-run',
    verifyArgsFor({ relaxReleaseAge: true }).includes('--config.minimumReleaseAge=0')
    && verifyArgsFor({ relaxReleaseAge: true }).includes('--dry-run')
    && verifyArgsFor({ relaxReleaseAge: true }).includes('--lockfile-only'),
    JSON.stringify(verifyArgsFor({ relaxReleaseAge: true })))
  check('⑥ 设置镜像：从 lock 自己的 settings 段取值（autoInstallPeers/excludeLinksFromLockfile）',
    JSON.stringify(lockfileSettingsFlags(readFileSync(LOCK, 'utf8'))) === JSON.stringify(['--config.autoInstallPeers=false', '--config.excludeLinksFromLockfile=false']),
    JSON.stringify(lockfileSettingsFlags(readFileSync(LOCK, 'utf8'))))
  check('⑥ 白名单：只有 link: 走定点写入；file:/git+/URL/workspace: 一律不在白名单',
    canWriteImporterEntry('link:C:/x') === true && IMPORTER_ONLY_RE.test('link:../../x')
    && !canWriteImporterEntry('file:C:/x.tgz') && !canWriteImporterEntry('git+https://x/y.git') && !canWriteImporterEntry('https://x/y.tgz')
    && !canWriteImporterEntry('workspace:*') && !canWriteImporterEntry('1.2.3'))
  check('⑥ 键判据唯一真源：裸键/单引号/双引号三种形态都认（与 lockVersion 同一份）',
    lockEntryKeyMatches('      dshmarket:', 'dshmarket') && lockEntryKeyMatches("      '@a/b':", '@a/b') && lockEntryKeyMatches('      "@a/b":', '@a/b')
    && !lockEntryKeyMatches('        specifier: link:C:/x', 'dshmarket'))
  check('⑥ 非白名单来源不伪造条目：writeLockImporterEntry 直接拒绝（changed=false + 原因）', await (async () => {
    const text = readFileSync(LOCK, 'utf8')
    const w = await writeLockImporterEntry(PROFILE, { name: '@fake/git-dep', spec: 'git+https://github.com/x/y.git' })
    return w.changed === false && /不止 importer 一行/u.test(String(w.reason)) && readFileSync(LOCK, 'utf8') === text
  })(), '')
  const sectionLock = writeLock({ name: '@fake/section-probe', specifier: 'link:C:/x', version: 'link:x', section: 'devDependencies' })
  const intoDev = planLockImporterEntry(readFileSync(LOCK, 'utf8'), { name: '@fake/other-probe', specifier: 'link:C:/y', version: 'link:y', section: 'devDependencies' })
  check('⑥ 分区：目标分区不存在时补分区头（不塞进 dependencies）',
    sectionLock.includes('    devDependencies:') && intoDev.changed === true
    && /devDependencies:[\s\S]*'@fake\/other-probe':/u.test(intoDev.text) && !/dependencies:[\s\S]*other-probe/u.test(intoDev.text.split('devDependencies:')[0]), '')
}

console.log('\n=== ⑦ 真 pnpm（只读）：校验不改 lock 字节；真机形态的 lock 能被确认可解析 ===')
{
  const { runPnpmWithFallback } = await import('../lib/server/infra/exec.js')
  let pnpmUsable = true
  let pnpmError = null
  try {
    await runPnpmWithFallback(['--version'], { execOpts: { cwd: PROFILE, timeout: 60000, windowsHide: true } })
  } catch (error) {
    pnpmUsable = false
    pnpmError = String(error?.message ?? error).slice(0, 300)
  }
  if (!pnpmUsable) {
    skip('真 pnpm 只读校验组', `真 pnpm 通道不可用：${pnpmError}`)
  } else {
    const NAME = '@fake/real-verify'
    const { spec } = linkFixture(NAME)
    writeManifest({ [NAME]: spec })
    // 真机形态：无关条目带 peer 后缀 + 我们的 link 条目（version 用规范形）
    writeLock({ name: NAME, specifier: spec, version: 'link:../../plugin-src/@fake/real-verify' })
    const before = readFileSync(LOCK, 'utf8')
    const verdict = await verifyLockReadOnly({ profileDir: PROFILE, registry: null })
    check('⑦ 真 pnpm：只读校验跑起来了（不是"无法确认"）', verdict.verified !== null, JSON.stringify({ verified: verdict.verified, reason: verdict.reason }))
    check('⑦ 真 pnpm：无 registry 依赖的 link: 夹具 lock 被确认可解析（verified=true）', verdict.verified === true, String(verdict.reason))
    check('⑦ 真 pnpm：校验**不写盘** —— lock 逐字节不变（含带 peer 后缀的无关条目）',
      readFileSync(LOCK, 'utf8') === before, `sha=${sha(readFileSync(LOCK, 'utf8')).slice(0, 12)}`)
    check('⑦ 真 pnpm：校验没有生成/改动别的文件（只认 lock 一个哈希源）',
      existsSync(LOCK) && !existsSync(join(PROFILE, 'node_modules', '.modules.yaml')), '')
    const importer = await writeLockImporterEntry(PROFILE, { name: NAME, spec, section: 'dependencies' })
    check('⑦ 真 pnpm：条目已就位时定点写入返回 unchanged（幂等零写盘）',
      importer.changed === false && importer.unchanged === true, JSON.stringify(importer))
  }
}

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
