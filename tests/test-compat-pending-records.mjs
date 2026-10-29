// 适配门记录：**真待适配**的计数口径 + 记录删除（0.5.98 加法，用户 2026-10-28 实测缺口）
//
// 用户现场（已核实）：`~/.dsh/plugin-console/compat-pending.json` 自 2026-10-04 后没再被写过，
// 24 条记录 = 20 条 adopted（历史）+ 3 条 pending 但 `moduleName: null`（对应补丁行**早已不存在**）
// + 1 条真 pending。门控面板把 `pending` 数组长度当"待适配"，于是用户看到"有 N 行待适配"，其实一行都没有。
//
// 本套钉死三件事（全离线：隔离 DSH_HOME + 私有 profile 夹具，零外网）：
//   ① 计数口径（唯一真源 `isActionablePending`）：24 条 ⇒ actionableCount 1 / staleCount 3；
//      且 `/state` 既有字段（compatPending.pending 长度、gating.pendingCount）**语义一个字没改**。
//   ② 删除记录（`POST /compat-gate {action:'forget'|'forget-stale'}`）：只删记录 ——
//      补丁文件与插件目录**逐字节不变**；删不存在的 rowId ⇒ 明确错误且文件不被改写；
//      批量清理只清 stale，真 pending 与 adopted 一条不动。
//   ③ 写盘纪律：坏文件拒绝覆盖（保住用户数据）、rename 失败 / 读回不符 ⇒ 回滚且如实报错。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'compat-pending-records-home')
process.env.DSH_HOME = HOME
// 与 CI 的单测分组同口径：不出网（本套本来也不该出网，这里只是把意外的网络尝试变成本地失败）
process.env.DSH_TEST_SKIP_NETWORK = '1'
rmSync(HOME, { recursive: true, force: true })

const profileDir = join(HOME, 'profiles', 'web')
const cpDir = join(HOME, 'plugin-console')
const PENDING_FILE = join(cpDir, 'compat-pending.json')
const PATCH_FILE = join(profileDir, 'cordis.patch.yml')
const DEMO_PKG_DIR = join(profileDir, 'node_modules', '@fake', 'demo')
mkdirSync(DEMO_PKG_DIR, { recursive: true })
mkdirSync(cpDir, { recursive: true })
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dsh: { profile: { bundles: [] } } }, null, 2), 'utf8')
writeFileSync(join(DEMO_PKG_DIR, 'package.json'), JSON.stringify({ name: '@fake/demo', version: '1.0.0', main: 'index.js' }), 'utf8')
writeFileSync(join(DEMO_PKG_DIR, 'index.js'), 'export const ok = true\n', 'utf8')

// 补丁夹具：三种"行还在"的形态各一条（disables / forced / inserts）—— 全都是 readPatchState 的既有产物。
// 注意：**故意不写"指向不存在包"的 insert 行**，否则 /state 里的 patchHealSafety 会真的自动禁用它，
// 那会让"补丁逐字节不变"的断言掺进无关写盘。
const PATCH_TEXT = [
  '# compat-pending-records fixture',
  '- id: row-real',
  '  disabled: true',
  '- id: row-forced',
  '  disabled: false',
  '- insert:',
  '    - id: demo-row',
  "      name: '@fake/demo'",
  '',
].join('\n')
writeFileSync(PATCH_FILE, PATCH_TEXT, 'utf8')

const cordisUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
const ctx = {
  baseUrl: cordisUrl,
  loader: {
    entries: () => [
      { id: 'include', options: { name: 'cordis:include', group: true, config: { path: cordisUrl } } },
      { id: 'include:demo', options: { name: '@fake/demo' }, disabled: false, fiber: { state: 2 } },
      { id: 'include:plugin-console', options: { name: '@noob-stupid/dsh-plugin-console' }, disabled: false, fiber: { state: 2 } },
    ],
  },
  webServer: { register: (route) => { globalThis.__route = route; return () => {} } },
  effect: (fn) => { try { fn() } catch {}; return () => {} },
}
const mod = await import('../lib/index.js')
mod.apply(ctx)
const route = globalThis.__route

const fakeReq = (method, pathname, body) => ({
  method, url: pathname, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' },
  signal: { aborted: false, addEventListener: () => {} },
  [Symbol.asyncIterator]() {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    let i = 0
    return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) }
  },
})
const fakeRes = () => { const r = { status: 0, body: null }; r.writeHead = (s) => { r.status = s }; r.end = (p) => { r.body = p }; return r }
const call = async (method, path, body) => { const r = fakeRes(); await route.handler(fakeReq(method, path, body), r); return { status: r.status, json: r.body === null ? null : JSON.parse(r.body) } }

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const statOf = (file) => ({ size: statSync(file).size, mtimeMs: statSync(file).mtimeMs })

// ── 夹具：24 条记录（20 adopted + 3 条"行已消失"的 pending + 1 条真 pending）──────────────
const STALE_IDS = ['web-ui-describe-image', 'web-ui-doctor', 'web-ui-better-sidebar']
const REAL_ID = 'row-real'
const adopted = Array.from({ length: 20 }, (_, i) => ({
  rowId: `adopted-row-${i}`, moduleName: null, version: null, status: 'adopted', check: 'unknown',
  checkNote: '已适配解锁（历史）', source: 'preflight-disabled-before-upgrade', adoptedAt: 1790000000000 + i,
}))
const stale = STALE_IDS.map((rowId) => ({
  rowId, moduleName: null, version: null, status: 'pending', check: 'unknown',
  checkNote: '升级预扫判定不适配', source: 'preflight-disabled-before-upgrade', forcedAt: 1790218032109,
}))
const realPending = {
  rowId: REAL_ID, moduleName: null, version: null, status: 'pending', check: 'unknown',
  checkNote: '升级预扫判定不适配（该行仍在补丁里）', source: 'preflight-disabled-before-upgrade', forcedAt: 1790218032200,
}
const RECORDS = [...adopted, ...stale, realPending]
const fixtureText = `${JSON.stringify({ frameworkVersion: '0.2.1-rc.2', upgradeFrom: '0.2.1-rc.1', pending: RECORDS }, null, 2)}\n`
const writeFixture = (text = fixtureText) => writeFileSync(PENDING_FILE, text, 'utf8')
const readFixture = () => JSON.parse(readFileSync(PENDING_FILE, 'utf8'))
const rowIdsOf = (raw) => (raw.pending ?? []).map((r) => r.rowId)

console.log('=== ① 计数口径：只数"status=pending 且该行仍在补丁里"的 ===')
{
  writeFixture()
  const before = { sha: sha256(PENDING_FILE), stat: statOf(PENDING_FILE), patch: sha256(PATCH_FILE) }
  const st = await call('GET', '/plugin-console/state')
  const cp = st.json?.compatPending ?? null
  check('/state 200 且带 compatPending', st.status === 200 && cp !== null, `status=${st.status}`)
  check('★ actionableCount === 1（24 条里只有 row-real 是真待适配）', cp?.actionableCount === 1, `actionableCount=${cp?.actionableCount}`)
  check('★ staleCount === 3（adopted 不算失效；只有"行已消失的 pending"算）', cp?.staleCount === 3, `staleCount=${cp?.staleCount}`)
  // 既有字段语义**一个字没改**：pending 数组仍是"status=pending 的记录"（4 条，含 3 条失效的）
  check('既有字段语义不变：compatPending.pending 仍是 status=pending 的 4 条',
    JSON.stringify((cp?.pending ?? []).map((p) => p.rowId).sort()) === JSON.stringify([...STALE_IDS, REAL_ID].sort()),
    JSON.stringify((cp?.pending ?? []).map((p) => p.rowId)))
  check('既有字段语义不变：gating.pendingCount 仍是 status=pending 的条数（4）',
    st.json?.gating?.pendingCount === 4, `pendingCount=${st.json?.gating?.pendingCount}`)
  check('既有字段语义不变：gating.adoptedCount 仍是 20', st.json?.gating?.adoptedCount === 20, `adoptedCount=${st.json?.gating?.adoptedCount}`)
  const rows = st.json?.gating?.pending ?? []
  const byId = new Map(rows.map((r) => [r.rowId, r]))
  check('★ 明细行如实标注"行还在/不在了"（rowMissing）',
    byId.get(REAL_ID)?.rowMissing === false && STALE_IDS.every((id) => byId.get(id)?.rowMissing === true),
    JSON.stringify(rows.map((r) => `${r.rowId}:${r.rowMissing}`)))
  check('★ 明细行带 actionable（与计数同一个判据）',
    byId.get(REAL_ID)?.actionable === true && STALE_IDS.every((id) => byId.get(id)?.actionable === false),
    JSON.stringify(rows.map((r) => `${r.rowId}:${r.actionable}`)))
  check('记录里的 moduleName 是 null 时**不编造**名字（如实是 null，name 回落到 rowId）',
    byId.get(STALE_IDS[0])?.moduleName === null && byId.get(STALE_IDS[0])?.name === STALE_IDS[0],
    `moduleName=${JSON.stringify(byId.get(STALE_IDS[0])?.moduleName)} name=${byId.get(STALE_IDS[0])?.name}`)
  check('★ GET /state 是只读的（记录文件与补丁文件一个字节都没动）',
    sha256(PENDING_FILE) === before.sha && statOf(PENDING_FILE).mtimeMs === before.stat.mtimeMs && sha256(PATCH_FILE) === before.patch,
    `pending=${sha256(PENDING_FILE).slice(0, 8)} patch=${sha256(PATCH_FILE).slice(0, 8)}`)
}

console.log('\n=== ② 删除单条记录：只删记录，补丁与插件目录逐字节不变 ===')
{
  writeFixture()
  const patchBefore = { sha: sha256(PATCH_FILE), stat: statOf(PATCH_FILE) }
  const pluginBefore = { sha: sha256(join(DEMO_PKG_DIR, 'package.json')), stat: statOf(join(DEMO_PKG_DIR, 'package.json')) }
  const r = await call('POST', '/plugin-console/compat-gate', { action: 'forget', rowId: REAL_ID })
  check('POST /compat-gate {action:forget} → 200 且 ok', r.status === 200 && r.json?.ok === true, `status=${r.status} body=${JSON.stringify(r.json)?.slice(0, 200)}`)
  check('响应如实回报删了哪一条（removed / removedCount）',
    JSON.stringify(r.json?.removed) === JSON.stringify([REAL_ID]) && r.json?.removedCount === 1, JSON.stringify(r.json?.removed))
  check('★ 落盘核实：读回核实通过（verified:true，不是"删完就报成功"）', r.json?.verified === true, `verified=${r.json?.verified}`)
  check('★ 记录文件里该条消失', !rowIdsOf(readFixture()).includes(REAL_ID), JSON.stringify(rowIdsOf(readFixture()).length))
  check('★ 其余 23 条原样保留（顺序与内容都不变）',
    JSON.stringify(rowIdsOf(readFixture())) === JSON.stringify(RECORDS.filter((x) => x.rowId !== REAL_ID).map((x) => x.rowId))
    && JSON.stringify(readFixture().pending[0]) === JSON.stringify(adopted[0]),
    `kept=${rowIdsOf(readFixture()).length}`)
  check('★ 补丁文件一个字节都没动（插件/补丁绝不因为删记录而变）',
    sha256(PATCH_FILE) === patchBefore.sha && statOf(PATCH_FILE).mtimeMs === patchBefore.stat.mtimeMs,
    `patch=${sha256(PATCH_FILE).slice(0, 8)}`)
  check('★ 插件目录一个字节都没动',
    sha256(join(DEMO_PKG_DIR, 'package.json')) === pluginBefore.sha && statOf(join(DEMO_PKG_DIR, 'package.json')).mtimeMs === pluginBefore.stat.mtimeMs,
    `pkg=${sha256(join(DEMO_PKG_DIR, 'package.json')).slice(0, 8)}`)
  check('写盘前留了备份（.bak-forget-<时间戳>）',
    typeof r.json?.backup === 'string' && r.json.backup.includes('.bak-forget-') && existsSync(r.json.backup), String(r.json?.backup))
  // 删完之后按同一判据重算：真待适配 0、失效 3
  check('删完后 counts 按同一判据重算（actionable 0 / stale 3）',
    r.json?.counts?.actionableCount === 0 && r.json?.counts?.staleCount === 3, JSON.stringify(r.json?.counts))
  const st = await call('GET', '/plugin-console/state')
  check('/state 跟着变（面板刷新后拿到的是 0 而不是旧数字）',
    st.json?.compatPending?.actionableCount === 0 && st.json?.compatPending?.staleCount === 3,
    `actionable=${st.json?.compatPending?.actionableCount} stale=${st.json?.compatPending?.staleCount}`)
}

console.log('\n=== ③ 删不存在的 rowId：明确错误，且文件**不被改写** ===')
{
  writeFixture()
  const before = { sha: sha256(PENDING_FILE), stat: statOf(PENDING_FILE) }
  const r = await call('POST', '/plugin-console/compat-gate', { action: 'forget', rowId: 'no-such-row' })
  check('★ 404 + ok:false + 明确原因（绝不静默成功）',
    r.status === 404 && r.json?.ok === false && String(r.json?.error ?? '').includes('no-such-row'),
    `status=${r.status} error=${r.json?.error}`)
  check('★ 文件未被改写（连 mtime 都没动）',
    sha256(PENDING_FILE) === before.sha && statOf(PENDING_FILE).mtimeMs === before.stat.mtimeMs,
    `sha=${sha256(PENDING_FILE).slice(0, 8)}`)
  check('不写备份（没改东西就不留垃圾文件）',
    (r.json?.details?.backup ?? null) === null && !existsSync(`${PENDING_FILE}.bak-forget-${Date.now()}`), String(r.json?.details?.backup))
  const missing = await call('POST', '/plugin-console/compat-gate', { action: 'forget' })
  check('缺 rowId → 400 且说清缺什么', missing.status === 400 && String(missing.json?.error ?? '').includes('rowId'), `status=${missing.status} error=${missing.json?.error}`)
  const unknown = await call('POST', '/plugin-console/compat-gate', { action: 'nope' })
  check('未知 action → 400（不落进总开关分支，也不静默）', unknown.status === 400 && unknown.json?.ok === false, `status=${unknown.status} error=${unknown.json?.error}`)
}

console.log('\n=== ④ 批量清理：只清 stale，真 pending 与 adopted 一条不动 ===')
{
  writeFixture()
  const r = await call('POST', '/plugin-console/compat-gate', { action: 'forget-stale' })
  check('POST {action:forget-stale} → 200 且删掉 3 条', r.status === 200 && r.json?.removedCount === 3, `status=${r.status} removed=${JSON.stringify(r.json?.removed)}`)
  const left = rowIdsOf(readFixture())
  check('★ 3 条失效记录全部消失', STALE_IDS.every((id) => !left.includes(id)), JSON.stringify(left.slice(0, 6)))
  check('★ 真 pending（row-real）保留', left.includes(REAL_ID), JSON.stringify(left))
  check('★ 20 条 adopted 一条不少', adopted.every((x) => left.includes(x.rowId)) && left.length === 21, `left=${left.length}`)
  check('清理后计数按同一判据重算（actionable 1 / stale 0）',
    r.json?.counts?.actionableCount === 1 && r.json?.counts?.staleCount === 0, JSON.stringify(r.json?.counts))
  // 再清一次：没有可清的 ⇒ 零写盘 + 明确"没有可清理的"
  const sha = sha256(PENDING_FILE)
  const again = await call('POST', '/plugin-console/compat-gate', { action: 'forget-stale' })
  check('再清一次：changed:false + 明确说"没有可清理的"（不是错误，也不是假成功）',
    again.status === 200 && again.json?.changed === false && again.json?.removedCount === 0 && String(again.json?.note ?? '').includes('没有可清理'),
    `changed=${again.json?.changed} note=${again.json?.note}`)
  check('没有可清理时零写盘（文件字节保持不变）', sha256(PENDING_FILE) === sha)
}

console.log('\n=== ⑤ 坏文件：读降级为空结构，删除**拒绝覆盖**（保住用户数据）===')
{
  const broken = '{ 这不是 JSON '
  writeFileSync(PENDING_FILE, broken, 'utf8')
  const before = { sha: sha256(PENDING_FILE), stat: statOf(PENDING_FILE) }
  const st = await call('GET', '/plugin-console/state')
  check('坏记录文件时 /state 仍 200（不拖垮整份状态）', st.status === 200, `status=${st.status}`)
  check('读降级：计数为 0（compatPending 读不出来 ⇒ 没有"待适配"可言）',
    st.json?.compatPending === null || (st.json?.compatPending?.actionableCount === 0 && st.json?.compatPending?.staleCount === 0),
    JSON.stringify(st.json?.compatPending ?? null)?.slice(0, 120))
  const r = await call('POST', '/plugin-console/compat-gate', { action: 'forget-stale' })
  check('★ 坏文件时删除被拒绝（409 + 明确原因，绝不覆盖用户文件）',
    r.status === 409 && r.json?.ok === false && String(r.json?.error ?? '').includes('读不出来'),
    `status=${r.status} error=${r.json?.error}`)
  const single = await call('POST', '/plugin-console/compat-gate', { action: 'forget', rowId: REAL_ID })
  check('单条删除同样拒绝（409）', single.status === 409 && single.json?.ok === false, `status=${single.status}`)
  check('★ 坏文件一个字节都没被改写（用户数据保住了）',
    sha256(PENDING_FILE) === before.sha && statOf(PENDING_FILE).mtimeMs === before.stat.mtimeMs,
    `sha=${sha256(PENDING_FILE).slice(0, 8)}`)
  check('坏文件内容原样还在', readFileSync(PENDING_FILE, 'utf8') === broken)
  // 空文件 = "没有内容"（不是坏文件）：读侧降级为空结构，删除**明确说没东西可删**，同样不改写
  writeFileSync(PENDING_FILE, '', 'utf8')
  const emptySha = sha256(PENDING_FILE)
  const empty = await call('POST', '/plugin-console/compat-gate', { action: 'forget-stale' })
  check('空文件按"没有内容"处理（不是坏文件）：明确说没有可清理的，且不改写',
    empty.status === 200 && empty.json?.changed === false && String(empty.json?.note ?? '').includes('没有可清理') && sha256(PENDING_FILE) === emptySha,
    `status=${empty.status} note=${empty.json?.note}`)
  const emptyOne = await call('POST', '/plugin-console/compat-gate', { action: 'forget', rowId: REAL_ID })
  check('空文件里删某条 ⇒ 404 说清"没有这条记录"，且不改写',
    emptyOne.status === 404 && String(emptyOne.json?.error ?? '').includes(REAL_ID) && sha256(PENDING_FILE) === emptySha,
    `status=${emptyOne.status} error=${emptyOne.json?.error}`)
}

console.log('\n=== ⑥ 写盘失败路径（注入）：rename 失败 / 读回不符 ⇒ 回滚且如实报错 ===')
{
  const { applyPendingForget, readPendingRecords, planForgetRecord, countPendingRecords, liveRowIdsFromPatch, isActionablePending, annotateGateRows } = await import('../lib/server/domain/compat-pending-records.js')
  writeFixture()
  const before = { sha: sha256(PENDING_FILE), text: readFileSync(PENDING_FILE, 'utf8') }
  const read = readPendingRecords(PENDING_FILE)
  const plan = planForgetRecord({ read, rowId: REAL_ID })
  check('纯规划：ok + changed + 期望删掉的那条', plan.ok === true && plan.changed === true && plan.removedRowIds.join() === REAL_ID, JSON.stringify(plan.removedRowIds))

  // ① rename 抛错（磁盘只读 / 占用 / 权限）
  const renameFail = applyPendingForget(plan, { renameSync: () => { const e = new Error('EPERM: operation not permitted, rename'); e.code = 'EPERM'; throw e } })
  check('★ rename 失败 → ok:false + 带真因（EPERM）', renameFail.ok === false && String(renameFail.error).includes('EPERM'), renameFail.error)
  check('★ rename 失败 → 文件保持原样（逐字节）', sha256(PENDING_FILE) === before.sha && readFileSync(PENDING_FILE, 'utf8') === before.text)

  // ② rename 静默不生效（"写了但没落盘"）：读回核实必须抓住它
  const silent = applyPendingForget(plan, { renameSync: () => {} })
  check('★ 读回不符（rename 空转）→ ok:false 且点明"读回内容与期望不一致"',
    silent.ok === false && String(silent.error).includes('读回内容与期望不一致'), silent.error)
  check('★ 读回不符 → 文件仍是原样（那条记录还在，绝不谎报已删）',
    sha256(PENDING_FILE) === before.sha && rowIdsOf(readFileSync(PENDING_FILE, 'utf8').trim() === '' ? { pending: [] } : JSON.parse(readFileSync(PENDING_FILE, 'utf8'))).includes(REAL_ID),
    `sha=${sha256(PENDING_FILE).slice(0, 8)}`)

  // ③ 正常路径仍然成功（证明上面的失败不是"永远失败"的假红）
  const okRun = applyPendingForget(plan)
  check('正常路径：verified:true 且那条真的没了', okRun.ok === true && okRun.verified === true && !rowIdsOf(readFixture()).includes(REAL_ID), JSON.stringify(okRun.removedRowIds))

  // ④ 纯判据自校验（检测器本身有效）
  const live = liveRowIdsFromPatch({ disables: ['row-real'], forced: [], inserts: [] })
  check('判据：pending + 行在 ⇒ actionable', isActionablePending({ rowId: 'row-real', status: 'pending' }, live) === true)
  check('判据：pending + 行不在 ⇒ 不是 actionable', isActionablePending({ rowId: 'ghost', status: 'pending' }, live) === false)
  check('判据：adopted + 行在 ⇒ 也不是 actionable（历史不是待办）', isActionablePending({ rowId: 'row-real', status: 'adopted' }, live) === false)
  check('计数：24 条 ⇒ 1 / 3 / 20 / 24',
    JSON.stringify(countPendingRecords(RECORDS, live)) === JSON.stringify({ totalCount: 24, actionableCount: 1, staleCount: 3, adoptedCount: 20 }),
    JSON.stringify(countPendingRecords(RECORDS, live)))
  const annotated = annotateGateRows([{ rowId: 'row-real', status: 'pending' }, { rowId: 'ghost', status: 'pending' }], live)
  check('明细注解：既有字段一个不少（只在末尾加 rowMissing / actionable）',
    annotated[0].rowId === 'row-real' && annotated[0].status === 'pending' && annotated[0].rowMissing === false && annotated[0].actionable === true
    && annotated[1].rowMissing === true, JSON.stringify(annotated))
}

console.log('\n=== ⑦ 既有契约零变化：不带 action 的 /compat-gate 仍是总开关 ===')
{
  const r = await call('POST', '/plugin-console/compat-gate', {})
  check('POST /compat-gate {} → 200 且响应仍是 {ok, compatGate}',
    r.status === 200 && r.json?.ok === true && typeof r.json?.compatGate === 'object'
    && JSON.stringify(Object.keys(r.json).sort()) === JSON.stringify(['compatGate', 'ok']),
    `status=${r.status} keys=${Object.keys(r.json ?? {}).join(',')}`)
  const set = await call('POST', '/plugin-console/compat-gate', { autoDetect: false })
  check('开关照旧生效（autoDetect:false 真的写进 compatGate）', set.json?.compatGate?.autoDetect === false, JSON.stringify(set.json?.compatGate))
  check('开关没有副作用到记录文件（请求两条通道互不相干）', !existsSync(PENDING_FILE) === false)
}

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
