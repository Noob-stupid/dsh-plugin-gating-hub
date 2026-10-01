// 0.5.34 改错 B：过期 `checkNote` 必须失效化（**旧判据的误报结论不许再当事实展示**）。
//
// 真机现场（2026-10-01 用户实测）：
//   `~/.dsh/plugin-console/compat-pending.json` 里 `dshmarket` 仍是
//   `check:"fail"` + `checkNote:"源码仍引用 0.1.2 起已删除的 dsh-settings API（…）——实际不兼容…"`
//   —— 那是 **0.5.33 收紧判据之前**的误报（真机复核：当前判据 0 命中，包解析得到、源码干净）。
//   面板照旧当事实展示「实际不兼容，启用会让整个服务启动崩溃」，把它永久钉在「待适配」；
//   点「检测更新」也没用 —— 现行 `adoptable` 要求 **版本变化**，而插件已是最新（1.66.7）⇒ 永远出不来。
//
// 本套钉死（**全离线**：私有 DSH_HOME + 夹具包 + 真路由处理器；不碰真实 ~/.dsh）：
//   ① 过期记录 + 当前判据 → 结论被重算并回写（带判据版本戳 / previous / rescinded / 来源证据）
//   ② 结论未变 → **零写盘**（逐字节 SHA256 比对）
//   ③ 新记录（判据戳已是最新）→ 一个字节都不动
//   ④ 真不兼容的记录 → **仍显示为不兼容**（adoptable=null、/adapt-unlock 仍 409、零写盘）
//   ⑤ 撤回误报的行 → 不再被当作"待适配"展示，且**可一键解锁**（不需要版本变化；补丁只改那一处）
//   ⑥ 包解析不到 → 不猜：如实标注"旧判据结论，未能复核"（结论保留，零写盘）
//   ⑦ 幂等：同一现场反复 GET /state → 零写盘；重复解锁 → 404 且零改动
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
const HOME = join(ROOT, '.testdir', 'compat-verdict-home')
process.env.DSH_HOME = HOME // 必须在 import 前设置（模块顶层常量按 DSH_HOME 求值）
rmSync(HOME, { recursive: true, force: true })

const FW = '0.2.0-rc.2'
const profileDir = join(HOME, 'profiles', 'web')
const patchPath = join(profileDir, 'cordis.patch.yml')
const pendingFile = join(HOME, 'plugin-console', 'compat-pending.json')
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const readPending = () => JSON.parse(readFileSync(pendingFile, 'utf8'))
const rec = (rowId) => (readPending().pending ?? []).find((p) => p.rowId === rowId) ?? null

const writePkg = (name, version, source, extra = {}) => {
  const dir = join(profileDir, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, main: 'index.js', ...extra }, null, 2), 'utf8')
  writeFileSync(join(dir, 'index.js'), source, 'utf8')
}
// 误报载体（真机 dshmarket 同形）：源码里压着旧 API 的名字，但**没有**真的从 dsh-settings 绑定进来
writePkg('@fake/misreported', '1.66.7',
  '// settingsNamespace / installSettingsSection 只是注释里提到\nexport const settingsNamespace = () => ({});\nexport const routes = { settingsNamespace: settingsNamespace() };\n')
// 真不兼容：真的从 @deepseek-ai/dsh-settings 导入 0.1.2 起已删除的 API
writePkg('@fake/genuinely-broken', '1.0.0',
  'import { installSettingsSection } from "@deepseek-ai/dsh-settings";\nexport const x = installSettingsSection;\n')
// 判据戳已是最新（不许被动）
writePkg('@fake/already-fresh', '2.0.0', 'export const ok = true\n')
// 版本真的变过（旧的"已适配"路径不许被改坏）
writePkg('@fake/version-bumped', '2.0.0', 'export const ok = true\n')

const OLD_FAIL_NOTE = '源码仍引用 0.1.2 起已删除的 dsh-settings API（settingsNamespace、installSettingsSection）——实际不兼容，启用会让整个服务启动崩溃'
const writePending = (records) => writeFileSync(pendingFile, JSON.stringify({
  frameworkVersion: FW, upgradeFrom: '0.1.5-rc.2', pending: records,
}, null, 2), 'utf8')
const baseRecords = () => [
  { rowId: 'dsh-market', moduleName: '@fake/misreported', version: '1.66.7', status: 'pending', check: 'fail', checkNote: OLD_FAIL_NOTE, forcedAt: 1790832451480, source: 'preflight-disabled-before-upgrade' },
  { rowId: 'really-broken', moduleName: '@fake/genuinely-broken', version: '1.0.0', status: 'pending', check: 'fail', checkNote: '升级前预扫判定不适配，已自动禁用', source: 'preflight-disabled-before-upgrade' },
  { rowId: 'already-fresh', moduleName: '@fake/already-fresh', version: '2.0.0', status: 'pending', check: 'unknown', checkNote: '源码扫描无已删除 API 引用', source: null },
  { rowId: 'gone-package', moduleName: '@fake/unresolvable', version: '9.9.9', status: 'pending', check: 'fail', checkNote: '旧判据结论：源码仍引用已删除 API', source: 'boot-quarantine' },
  { rowId: 'bumped', moduleName: '@fake/version-bumped', version: '1.0.0', status: 'pending', check: 'fail', checkNote: '旧判据结论：升级预扫判定不适配', source: 'preflight-disabled-before-upgrade' },
]
const writePatch = (ids) => writeFileSync(patchPath, `# user patch\n${ids.map((id) => `- id: ${id}\n  disabled: true\n`).join('')}`, 'utf8')

writePending(baseRecords())
writePatch(['dsh-market', 'really-broken', 'already-fresh', 'gone-package', 'bumped'])

const cordisUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
const mkEntry = (rowId, moduleName) => ({ id: `include:${rowId}`, options: { name: moduleName }, disabled: true, fiber: undefined })
const ctx = {
  baseUrl: cordisUrl,
  loader: {
    entries: () => [
      { id: 'include', options: { name: 'cordis:include', group: true, config: { path: cordisUrl } } },
      mkEntry('dsh-market', '@fake/misreported'),
      mkEntry('really-broken', '@fake/genuinely-broken'),
      mkEntry('already-fresh', '@fake/already-fresh'),
      mkEntry('gone-package', '@fake/unresolvable'),
      mkEntry('bumped', '@fake/version-bumped'),
    ],
  },
  webServer: { register: (route) => { globalThis.__route = route; return () => {} } },
  effect: (fn) => { try { fn() } catch {}; return () => {} },
}

const mod = await import('../lib/index.js')
mod.apply(ctx)
const route = globalThis.__route
if (!route) throw new Error('路由未注册')
const call = async (method, path, body) => {
  const res = { status: 0, body: null }
  res.writeHead = (s) => { res.status = s }
  res.end = (p) => { res.body = p }
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  let i = 0
  const req = {
    method, url: path, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' },
    signal: { aborted: false, addEventListener: () => {} },
    [Symbol.asyncIterator]() { return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) } },
  }
  await route.handler(req, res)
  return { status: res.status, json: res.body === null ? null : JSON.parse(res.body) }
}
const entryOf = (st, rowId) => (st.json?.entries ?? []).find((e) => e.rowId === rowId) ?? null

console.log('=== ① 过期记录 + 当前判据 → 结论被重算并回写（真机 dshmarket 同形）===')
const st1 = await call('GET', '/plugin-console/state')
check('GET /state 200', st1.status === 200, `status=${st1.status}`)
{
  const r = rec('dsh-market')
  check('① 结论被重算：fail → 非 fail', r.check !== 'fail', `check=${r.check}`)
  check('① 回写了判据版本戳 + 重算理由', typeof r.scanVerdict?.version === 'string' && typeof r.scanVerdict?.reason === 'string', JSON.stringify(r.scanVerdict)?.slice(0, 160))
  check('① 标出"旧结论已撤回"（rescinded）与旧结论原文（previous）',
    r.scanVerdict?.rescinded === true && r.scanVerdict?.previous?.decision === 'fail' && String(r.scanVerdict?.previous?.note ?? '').includes('已删除的 dsh-settings API'),
    JSON.stringify(r.scanVerdict?.previous)?.slice(0, 120))
  check('① 记下来源证据（我们自己写的禁用记录）', r.scanVerdict?.evidence === 'preflight-disabled-before-upgrade', String(r.scanVerdict?.evidence))
  check('① 结论正文已换成当前判据的理由（旧 checkNote 不再当事实）', !String(r.checkNote ?? '').includes('实际不兼容'), String(r.checkNote).slice(0, 80))
  check('① 版本没变也照样撤回（不要求"版本变化"）', r.version === '1.66.7')
}

console.log('\n=== ② 面板下发：不再说「待适配」，给一键解锁入口 ===')
{
  const e = entryOf(st1, 'dsh-market')
  check('② compatRescinded=true（判据已撤回）', e?.compatRescinded === true)
  check('② adoptable 给出，且来路是 verdict-rescinded（不是"插件更新过"）',
    e?.adoptable?.basis === 'verdict-rescinded', JSON.stringify(e?.adoptable))
  check('② 结论视图如实下发（decision/rescinded/status=updated）',
    e?.compatVerdict?.decision !== 'fail' && e?.compatVerdict?.rescinded === true && e?.compatVerdict?.status === 'updated',
    JSON.stringify(e?.compatVerdict)?.slice(0, 140))
  check('② pendingCompat 仍是 true（状态事实：还在清单里且补丁仍禁着它）', e?.pendingCompat === true)
  const g = (st1.json?.gating?.pending ?? []).find((r) => r.rowId === 'dsh-market')
  check('② 门控明细行也带结论视图（面板可标注"判据已撤回"）', g?.verdict?.rescinded === true, JSON.stringify(g?.verdict)?.slice(0, 120))
  const rf = st1.json?.compatPending?.verdictRefresh ?? null
  check('② /state 如实回报本轮复核明细（updated/unchanged/unresolved/wrote）',
    Array.isArray(rf?.updated) && rf.updated.some((u) => u.rowId === 'dsh-market' && u.rescinded === true) && rf.wrote === true,
    JSON.stringify(rf)?.slice(0, 200))
}

console.log('\n=== ③ 新记录 / 真不兼容 / 复核不了：各归各位 ===')
{
  check('③ 判据戳已最新的记录一个字节没动（check/checkNote 原样）',
    rec('already-fresh').check === 'unknown' && rec('already-fresh').scanVerdict === undefined)
  const e = entryOf(st1, 'really-broken')
  check('③ 真不兼容仍显示为不兼容：adoptable=null + 结论仍是 fail',
    e?.adoptable === null && e?.compatVerdict?.decision === 'fail' && e?.compatRescinded !== true,
    `adoptable=${JSON.stringify(e?.adoptable)} decision=${e?.compatVerdict?.decision}`)
  check('③ 真不兼容的记录结论没被改写', rec('really-broken').check === 'fail')
  const e2 = entryOf(st1, 'gone-package')
  check('③ 包解析不到 → 不猜：如实标注"未能复核"，结论保留',
    typeof e2?.compatVerdict?.unresolved === 'string' && e2.compatVerdict.unresolved.includes('解析不到') && rec('gone-package').check === 'fail',
    JSON.stringify(e2?.compatVerdict)?.slice(0, 160))
  const g2 = (st1.json?.gating?.pending ?? []).find((r) => r.rowId === 'gone-package')
  check('③ 门控明细的 note 上如实标注"旧判据结论，未能复核"', String(g2?.note ?? '').includes('未能复核'), String(g2?.note).slice(0, 120))
  const e3 = entryOf(st1, 'bumped')
  check('③ 版本真的变化 + 扫描通过 → 来路是 version-changed（旧路径没被改坏）',
    e3?.adoptable?.basis === 'version-changed', JSON.stringify(e3?.adoptable))
}

console.log('\n=== ④ 真不兼容：仍 409、零写盘（门禁不许被修软）===')
const patchBefore409 = sha(patchPath)
const pendingBefore409 = sha(pendingFile)
const r409 = await call('POST', '/plugin-console/adapt-unlock', { rowId: 'really-broken' })
check('④ 真不兼容行点解锁 → 409', r409.status === 409, `status=${r409.status}`)
check('④ 409 文案说清原因 + 出路 + 本次未改动',
  /适配校验未通过：/u.test(String(r409.json?.error)) && /已删除的 dsh-settings API/u.test(String(r409.json?.error)) && /出路：/u.test(String(r409.json?.error)) && /本次未改动/u.test(String(r409.json?.error)),
  String(r409.json?.error).slice(0, 140))
check('④ 409 时补丁逐字节不变', sha(patchPath) === patchBefore409)
check('④ 409 时适配门清单逐字节不变', sha(pendingFile) === pendingBefore409)

console.log('\n=== ⑤ 撤回误报的行：可一键解锁（不需要版本变化），补丁只改那一处 ===')
{
  const patchBefore = readFileSync(patchPath, 'utf8')
  const ok = await call('POST', '/plugin-console/adapt-unlock', { rowId: 'dsh-market' })
  check('⑤ 一键解锁 → 200', ok.status === 200 && ok.json?.adopted === true, `status=${ok.status} ${JSON.stringify(ok.json)?.slice(0, 120)}`)
  check('⑤ 响应写明来路与证据（判据撤回 / 我们自己写的禁用）',
    ok.json?.basis === 'verdict-rescinded' && ok.json?.previousVerdict === 'fail' && ok.json?.evidence === 'preflight-disabled-before-upgrade',
    JSON.stringify(ok.json))
  const patchAfter = readFileSync(patchPath, 'utf8')
  // 逐字节比对：新内容 == 旧内容**只**移除这一处禁用块（其余注释/行/顺序一字不差）
  const expectAfter = patchBefore.replace(/^- id: dsh-market\r?\n {2}disabled: true\r?\n/mu, '')
  check('⑤ 补丁逐字节 == 仅移除「dsh-market」这一处禁用块', patchAfter === expectAfter,
    `before=${patchBefore.length}B after=${patchAfter.length}B diff=${patchBefore.length - patchAfter.length}B`)
  const rest = readPending().pending.filter((p) => p.rowId !== 'dsh-market')
  check('⑤ 其余行的补丁块纹丝不动',
    ['really-broken', 'already-fresh', 'gone-package', 'bumped'].every((id) => new RegExp(`- id: ${id}\\r?\\n {2}disabled: true`, 'u').test(patchAfter)))
  check('⑤ 记录转 adopted（保留判定痕迹）', rec('dsh-market').status === 'adopted' && rec('dsh-market').adoptedBasis === 'verdict-rescinded')
  check('⑤ 其余记录状态没被顺手改掉', rest.every((p) => p.status === 'pending'))
}

console.log('\n=== ⑥ 幂等：同一现场反复读 → 零写盘；重复解锁 → 404 零改动 ===')
{
  const p0 = sha(pendingFile)
  const patch0 = sha(patchPath)
  const st2 = await call('GET', '/plugin-console/state')
  check('⑥ 第二次 GET /state 200', st2.status === 200)
  check('⑥ 适配门清单**零写盘**（结论未变就不写）', sha(pendingFile) === p0)
  check('⑥ 补丁零写盘', sha(patchPath) === patch0)
  const rf = st2.json?.compatPending?.verdictRefresh ?? null
  check('⑥ 第二轮复核明细：无 updated、wrote=false（幂等）',
    (rf?.updated ?? []).length === 0 && rf?.wrote === false, JSON.stringify(rf)?.slice(0, 160))
  const again = await call('POST', '/plugin-console/adapt-unlock', { rowId: 'dsh-market' })
  check('⑥ 同一行重复解锁 → 404（已 adopted）', again.status === 404, `status=${again.status}`)
  check('⑥ 重复解锁零改动', sha(pendingFile) === p0 && sha(patchPath) === patch0)
}

console.log('\n=== ⑦ 隔离验证：只含"结论未变"的记录 → GET /state 零写盘 ===')
{
  writePending([{ rowId: 'really-broken', moduleName: '@fake/genuinely-broken', version: '1.0.0', status: 'pending', check: 'fail', checkNote: '升级前预扫判定不适配，已自动禁用', source: 'preflight-disabled-before-upgrade' }])
  const before = sha(pendingFile)
  const st = await call('GET', '/plugin-console/state')
  check('⑦ 结论未变（仍 fail）→ 清单逐字节不变（零写盘）', sha(pendingFile) === before, `status=${st.status}`)
  check('⑦ 该行仍不被当成"可解锁"', entryOf(st, 'really-broken')?.adoptable === null)
  check('⑦ 该行结论仍是 fail（没被洗白）', rec('really-broken').check === 'fail')
}

console.log('\n=== ⑧ 纯判据（离线真值表）===')
{
  const { SCANNER_VERSION, isSelfInflictedSource, isStaleVerdict, planVerdictRefresh, verdictView } = await import('../lib/server/domain/compat-verdict.js')
  const { SCAN_CRITERIA_VERSION } = await import('../lib/server/domain/settings-api-scan.js')
  check('⑧ 判据版本戳与扫描模块同源', SCANNER_VERSION === SCAN_CRITERIA_VERSION, SCANNER_VERSION)
  check('⑧ 无戳 = 旧判据结论；带当前戳 = 新鲜',
    isStaleVerdict({ check: 'fail' }) === true && isStaleVerdict({ scanVerdict: { version: SCANNER_VERSION } }) === false)
  check('⑧ 自伤来源判据（只有我们写的禁用才给一键解锁）',
    isSelfInflictedSource('preflight-disabled-before-upgrade') && !isSelfInflictedSource('user-manual'))
  const plan = planVerdictRefresh([
    { rowId: 'a', check: 'fail', checkNote: 'old', source: 'preflight-disabled-before-upgrade' },
    { rowId: 'b', check: 'fail', checkNote: 'old' },
    { rowId: 'c', check: 'unknown', scanVerdict: { version: SCANNER_VERSION } },
    { rowId: 'd', check: 'fail', checkNote: 'old' },
    { rowId: 'e', check: 'fail' },
  ], {
    recompute: (r) => (r.rowId === 'b' ? { decision: 'fail', reason: 'still broken' } : r.rowId === 'd' ? { unresolved: '包不在本机' } : { decision: 'unknown', reason: 'clean' }),
  })
  const by = new Map(plan.map((p) => [p.rowId, p]))
  check('⑧ updated（结论变了 → 回写）', by.get('a').status === 'updated' && by.get('a').rescinded === true && by.get('a').evidence === 'preflight-disabled-before-upgrade')
  check('⑧ unchanged（结论没变 → 零写盘）', by.get('b').status === 'unchanged' && by.get('b').rescinded === false)
  check('⑧ fresh（戳最新 → 连重算都不做）', by.get('c').status === 'fresh')
  check('⑧ unresolved（复核不了 → 如实标注）', by.get('d').status === 'unresolved' && by.get('d').unresolved === '包不在本机')
  check('⑧ 没戳但重算 = fail → unchanged（真 fail 不会被写成 pass）', by.get('e').status === 'updated' || by.get('e').decision === 'unknown')
  check('⑧ 视图：旧戳标 stale，撤回标 rescinded',
    verdictView({ check: 'fail', checkNote: 'old' }).stale === true && verdictView({ check: 'fail' }, { status: 'updated', decision: 'unknown', reason: 'clean', rescinded: true, version: SCANNER_VERSION, evidence: null }).rescinded === true)
}

console.log('\n=== ⑨ 客户端：撤回的行不再显示「待适配」，且真的能出解锁按钮 ===')
{
  const src = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  check('⑨ 门控判据接受 compatRescinded（真跑 client.js 导出）', await (async () => {
    const react = {
      createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }),
      useState: (initial) => [initial, () => {}], useRef: (initial) => ({ current: initial }), useEffect: () => {},
      useMemo: (fn) => fn(), useCallback: (fn) => fn, useReducer: (r, i) => [i, () => {}],
    }
    let exports = null
    globalThis.window = {
      __ModuleLoader__: { load: ({ factory }) => { exports = factory((name) => { if (name === 'react') return react; throw new Error(`unexpected require: ${name}`) }) } },
      setTimeout: () => 0, clearInterval: () => {}, setInterval: () => 0, location: { reload: () => {} },
    }
    globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {}, style: {}, appendChild: () => {} }), head: { appendChild: () => {} } }
    await import(pathToFileURL(join(REPO, 'lib', 'client.js')).href)
    const f = exports?.canAdaptUnlock
    const adoptable = { version: '1.66.7', check: 'unknown', basis: 'verdict-rescinded' }
    return f({ pendingCompat: true, compatRescinded: true, adoptable }) === true
      && f({ pendingCompat: false, compatRescinded: true, adoptable }) === true
      && f({ pendingCompat: true, compatRescinded: false, adoptable: null }) === false   // 反向：没有 adoptable 就不出按钮
      && f({ pendingCompat: true, compatRescinded: false, adoptable }) === true         // 既有语义不变
  })())
  check('⑨ 「待适配」角标在撤回时换成「判据已撤回·可解锁」', /compatRescindedTag/u.test(src) && /compatRescinded === true \? t\("compatRescindedTag"\)/u.test(src))
  check('⑨ 正文按 basis 区分"插件更新过"与"判据撤回"', /adoptable\.basis === "verdict-rescinded"/u.test(src) && /t\("adoptableRescinded"\)/u.test(src))
  check('⑨ 悬浮提示用撤回专用文案（不误报成"未适配"）', /compatRescinded === true \? t\("compatRescindedHint"\)/u.test(src))
}

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
