// 0.5.84 判据降噪：「未持久化」只在**真的会丢插件**时报红，其余降级成提示。
//
// 用户反馈（2026-10）：面板上到处是红字「未持久化」，但绝大多数并不影响使用 ——
// 看一眼就关了，真正要紧的那条也跟着被无视。
//
// 判据（唯一出处：domain/persist.js#persistSeverity 顶部那段）：
//   critical = ① 清单里没有这个条目（pnpm 会清掉）② 重启后挂不上（没有行会加载它）
//   warn     = 其余（lock 形态/目标不一致、清单形态与磁盘版本不一致）—— 清单才是事实来源，
//              pnpm 会按清单收敛，插件本身不会被清掉。
//
// 本套同时钉死**闸门没被放松**：persisted / note / suggestedAction 三个老字段的语义与强度不变
// （装完不齐备仍然不是"成功"），只是"报不报红"这一档变了。
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'persist-severity-home')
process.env.DSH_HOME = HOME
process.env.DSH_TEST_SKIP_NETWORK = '1'
rmSync(HOME, { recursive: true, force: true })
const PROFILE = join(HOME, 'profiles', 'web')
const PATCH = join(PROFILE, 'cordis.patch.yml')
mkdirSync(join(PROFILE, 'node_modules'), { recursive: true })

const {
  persistReport, persistSeverity, isPersistCriticalCode, PERSIST_CODE_TEXT,
} = await import('../lib/server/domain/persist.js')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

// ── 夹具（与 test-persist-pipeline 同一套几何）──────────────────────────────────
const writeManifest = (manifest) => writeFileSync(join(PROFILE, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
const writePatch = (text) => writeFileSync(PATCH, text, 'utf8')
const writePkg = (name, version) => {
  const dir = join(PROFILE, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }, null, 2), 'utf8')
  writeFileSync(join(dir, 'index.js'), 'export default {}\n', 'utf8')
}
const writeLockEntry = (name, spec) => {
  const key = /[/@]/u.test(name) ? `'${name}':` : `${name}:`
  writeFileSync(join(PROFILE, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      ${key}\n        specifier: ${spec}\n        version: ${spec}\n`, 'utf8')
}
const dropLock = () => rmSync(join(PROFILE, 'pnpm-lock.yaml'), { force: true })
const rowFor = (name) => `    - id: ${name.replace(/^@/u, '').replace(/[/]/gu, '-')}\n      name: '${name}'\n`
const reset = ({ bundles = [], patch = '# fixture profile patch\n', deps = {} } = {}) => {
  writeManifest({ name: 'dsh-profile-web', private: true, dependencies: deps, dsh: { profile: { bundles } } })
  writePatch(patch)
  dropLock()
}

console.log('=== ① 降噪的核心现场：只有 lock 口径不一致 ⇒ 提示，不报红 ===')
{
  const NAME = '@fake/lock-only-gap'
  writePkg(NAME, '1.0.0')
  reset({ deps: { [NAME]: '1.0.0' }, patch: `# fixture profile patch\n- insert:\n${rowFor(NAME)}` })
  dropLock() // lock 里没有条目（用户最常遇到的"红字"来源）
  const report = persistReport({ profileDir: PROFILE, patchPath: PATCH, packageName: NAME })
  check('① 结论降级为 warn（不是 critical）', report.severity?.level === 'warn' && report.severity.losesAfterRestart === false, JSON.stringify(report.severity))
  check('① 点名唯一的缺口是 lock（清单与挂载行都是好的）',
    JSON.stringify(report.severity.downgraded) === JSON.stringify(['lock']) && report.severity.critical.length === 0,
    JSON.stringify(report.severity.downgraded))
  check('① 降级后的人话明说「不影响重启后加载」（不是含糊过去）',
    /不影响重启后加载/u.test(String(report.severity.note)), String(report.severity.note).slice(0, 70))
  check('① 闸门没放松：persisted 仍是 false、旧 note 仍含「未持久化」（安装仍不报成功）',
    report.persisted === false && /未持久化/u.test(String(report.note)), JSON.stringify({ persisted: report.persisted }))
}

console.log('\n=== ② 会丢插件的那种：清单里没有条目 ⇒ 必须红 ===')
{
  const NAME = '@fake/no-manifest-entry'
  writePkg(NAME, '2.0.0')
  reset({ patch: `# fixture profile patch\n- insert:\n${rowFor(NAME)}` }) // 清单里没有它
  writeLockEntry(NAME, '2.0.0')
  const report = persistReport({ profileDir: PROFILE, patchPath: PATCH, packageName: NAME })
  check('② level=critical 且 losesAfterRestart=true', report.severity?.level === 'critical' && report.severity.losesAfterRestart === true, JSON.stringify(report.severity))
  check('② 原因是「清单里没有条目」（dep-missing-entry）', report.severity.codes.dependency === 'dep-missing-entry', JSON.stringify(report.severity.codes))
  check('② 红字的人话里带上了具体缺口', /清单 dependencies/u.test(String(report.severity.note)), String(report.severity.note).slice(0, 60))
}

console.log('\n=== ③ 会丢插件的那种：重启后挂不上 ⇒ 必须红 ===')
{
  const NAME = '@fake/no-mount-row'
  writePkg(NAME, '3.0.0')
  reset({ deps: { [NAME]: '3.0.0' }, patch: '# fixture profile patch\n' }) // 补丁里没有行、bundles 里也没有
  writeLockEntry(NAME, '3.0.0')
  const report = persistReport({ profileDir: PROFILE, patchPath: PATCH, packageName: NAME })
  check('③ level=critical（包在盘上，但没有任何行会加载它）', report.severity?.level === 'critical', JSON.stringify({ level: report.severity?.level, codes: report.severity?.codes }))
  check('③ 原因是 mount-no-row', report.severity.codes.mount === 'mount-no-row', JSON.stringify(report.severity.codes))
}

console.log('\n=== ④ 两档混在一起：红 + 一并说清可以不管的那些 ===')
{
  const NAME = '@fake/mixed-gap'
  writePkg(NAME, '4.0.0')
  reset({ deps: { [NAME]: '4.0.0' }, patch: '# fixture profile patch\n' }) // 挂不上 + lock 也没有
  const report = persistReport({ profileDir: PROFILE, patchPath: PATCH, packageName: NAME })
  check('④ level=critical（有真问题）', report.severity?.level === 'critical')
  check('④ critical 只列 mount，lock 被列进 downgraded（不陪绑成红字）',
    JSON.stringify(report.severity.critical) === JSON.stringify(['mount']) && JSON.stringify(report.severity.downgraded) === JSON.stringify(['lock']),
    JSON.stringify({ critical: report.severity.critical, downgraded: report.severity.downgraded }))
  check('④ 人话里两档都写了（红的那条 + 「另有 N 处口径不一致」）',
    /未持久化/u.test(String(report.severity.note)) && /另有 1 处口径不一致/u.test(String(report.severity.note)), String(report.severity.note).slice(-90))
}

console.log('\n=== ⑤ 三处齐备 ⇒ ok（不多报一条红） ===')
{
  const NAME = '@fake/all-good'
  writePkg(NAME, '5.0.0')
  reset({ deps: { [NAME]: '5.0.0' }, patch: `# fixture profile patch\n- insert:\n${rowFor(NAME)}` })
  writeLockEntry(NAME, '5.0.0')
  const report = persistReport({ profileDir: PROFILE, patchPath: PATCH, packageName: NAME })
  check('⑤ persisted=true 且 level=ok', report.persisted === true && report.severity?.level === 'ok', JSON.stringify(report.severity))
  check('⑤ 齐备时不产出任何提示文案', report.severity.note === null && report.note === null)
}

console.log('\n=== ⑥ 清单形态与磁盘版本不一致 ⇒ 提示（包还在，pnpm 会按清单重装） ===')
{
  const NAME = '@fake/version-drift'
  writePkg(NAME, '6.0.1') // 磁盘是 6.0.1
  reset({ deps: { [NAME]: '6.0.0' }, patch: `# fixture profile patch\n- insert:\n${rowFor(NAME)}` }) // 清单写 6.0.0
  writeLockEntry(NAME, '6.0.0')
  const report = persistReport({ profileDir: PROFILE, patchPath: PATCH, packageName: NAME })
  check('⑥ 降级为 warn（换一份副本 ≠ 没有）', report.severity?.level === 'warn' && report.severity.codes.dependency === 'dep-version-drift', JSON.stringify(report.severity))
}

console.log('\n=== ⑦ 原因码表本身：白名单可数、未知码一律按 warn（宁可少报红） ===')
{
  check('⑦ 四个"会丢"的依赖码都在表里',
    ['dep-missing-entry', 'dep-link-broken', 'dep-version-missing', 'dep-range-missing'].every((c) => isPersistCriticalCode(c)),
    JSON.stringify(Array.from(PERSIST_CODE_TEXT).slice(0, 3)))
  check('⑦ 挂载类的码也是 critical（挂不上 = 重启后看不见）',
    ['mount-no-row', 'mount-bundle-no-patch', 'mount-bundle-patch-missing', 'mount-bundle-patch-empty'].every((c) => isPersistCriticalCode(c)))
  check('⑦ lock 类的码不是 critical（清单才是事实来源）',
    ['lock-missing-entry', 'lock-link-target-drift', 'lock-form-drift', 'lock-version-drift'].every((c) => !isPersistCriticalCode(c)))
  const loose = persistSeverity({ parts: { dependency: { ok: true }, lock: { ok: true }, mount: { ok: true } } })
  check('⑦ 三处齐备 ⇒ ok', loose.level === 'ok')
  const unknownCode = persistSeverity({ parts: { dependency: { ok: true }, lock: { ok: false, code: 'some-new-code' }, mount: { ok: true } } })
  check('⑦ 表里没有的原因码 ⇒ 按 warn（不因为出现新码就刷一堆红）', unknownCode.level === 'warn', unknownCode.level)
  const noCode = persistSeverity({ parts: { dependency: { ok: true }, lock: { ok: false }, mount: { ok: true } } })
  check('⑦ 连 code 都没有（老服务端/新缺口）⇒ 也是 warn', noCode.level === 'warn', noCode.level)
  check('⑦ 裸 parts 与整份 report 两种入参结果一致',
    JSON.stringify(persistSeverity({ parts: { dependency: { ok: false, code: 'dep-missing-entry' }, lock: { ok: true }, mount: { ok: true } } }).critical) === JSON.stringify(['dependency']))
}

console.log('\n=== ⑧ 面板接线（静态）：红/黄由服务端 severity 决定，客户端不自己重判 ===')
{
  const client = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')
  check('⑧ 诊断行按 severity.level 选等级（critical→error，其余→warn）',
    /const critical = severity === null \? true : severity\.level === "critical"/u.test(client)
    && /level: critical \? "error" : "warn"/u.test(client))
  check('⑧ 没有 severity 字段的老服务端仍按 critical 处理（不静默降级旧行为）',
    /severity === null \? true : severity\.level === "critical"/u.test(client))
  check('⑧ 安装完成那句也分两档（会丢 / 不影响加载）',
    /const head = criticalGap \? t\("installedNotPersisted"\) : t\("installedNotPersistedWarn"\)/u.test(client))
  const zh = client.split('\n').filter((l) => /installedNotPersistedWarn:|diagPersistDowngraded:/u.test(l))
  check('⑧ 两个新键中英各一条（en ⊆ zh 由 test-i18n-keys 把守）', zh.length === 4, `found=${zh.length}`)
  check('⑧ 服务端把 severity 一路带到作业字段（install-finalize → view）',
    /severity: persist\.after\?\.severity \?\? persist\.severity \?\? null/u.test(readFileSync(join(ROOT, '..', 'lib', 'server', 'domain', 'install-finalize.js'), 'utf8')))
}

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
