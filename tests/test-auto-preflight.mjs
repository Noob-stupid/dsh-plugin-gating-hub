// D1 回归（0.5.32 加法）：环境指纹变化 → **自动跑一次只读预检**，且
//   ① 同一指纹只自动跑一次（以指纹为 key 持久化）；
//   ② 预检失败 / 超时 → 如实上报且**绝不阻塞**状态查询（降级为"未完成，可手动重跑"）；
//   ③ 指纹没变 → 一次都不跑（不会拿上一个环境的结论糊弄面板）。
//
// 全离线：私有 DSH_HOME（临时目录）、注入扫描桩、不打任何网络。
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'auto-preflight-home')
process.env.DSH_HOME = HOME
process.env.DSH_TEST_SKIP_NETWORK = '1'
rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })
mkdirSync(join(HOME, 'profiles', 'web'), { recursive: true })

const { affectedRows, autoPreflightView, fingerprintKey, planSuspectRows, readStore, runAutoPreflight, shouldAutoRun, summarizeDelta, upsertRecord, withTimeout } = await import('../lib/server/domain/auto-preflight.js')
const { hostShapeOf, maybeSwitchToObserver, maybeWriteSnapshot, preflightTimeoutMs, routeCompatStatusGet } = await import('../lib/server/routes/compat.js')
const { computeFingerprint, stampFingerprint, writeCompatMode } = await import('../lib/server/domain/compat-state.js')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 轮询到条件成立（最多 waitMs；不做"睡死"等待，超时即如实失败）。 */
async function until(fn, { waitMs = 3000, step = 20 } = {}) {
  const t0 = Date.now()
  for (;;) {
    if (fn()) return true
    if (Date.now() - t0 > waitMs) return false
    await sleep(step)
  }
}

/** 极简 res 桩（收下发 JSON）。 */
function makeRes() {
  const captured = { status: null, json: null }
  return { captured, writeHead(status) { captured.status = status }, end(payload) { try { captured.json = JSON.parse(payload) } catch { captured.json = null } } }
}

/** 最小扫描结论（形状与真实 runAutoPreflightScan 一致的关键字段）。 */
function stubScan(overrides = {}) {
  return {
    ok: true,
    summary: { blockers: 1, affectedCount: 1, suspectCount: 1, note: 'stub' },
    affected: [{ rowId: 'web-ui-pet', moduleName: '@x/pet', severity: 'blocker', code: 'package-unresolvable', line: 2, detail: 'stub', hint: null, suggestions: [] }],
    suspects: [{ rowId: 'web-ui-pet', moduleName: '@x/pet', reason: 'package-unresolvable', detail: 'stub', line: 2 }],
    skipped: [],
    delta: { frameworkVersionFrom: '0.1.7', frameworkVersionTo: '0.2.0', packagesAdded: ['@deepseek-ai+dsh-x'], packagesRemoved: [], packagesAddedCount: 1, packagesRemovedCount: 0 },
    evidence: { uncertainty: null, rows: [{ rowId: 'web-ui-pet', moduleName: '@x/pet', code: 'package-unresolvable', severity: 'blocker' }], bootRows: [] },
    ...overrides,
  }
}

// ── ① 纯判据：指纹 key / 节流闸门 / 记录合并 ─────────────────────────────────
const fpA = { frameworkVersion: '0.2.0-rc.1', pnpmRoot: 'C:\\cache\\_npx\\x', pnpmEntities: 3, at: 1 }
const fpSame = { frameworkVersion: '0.2.0-rc.1', pnpmRoot: 'c:/cache/_npx/X', pnpmEntities: 3, at: 999 }
const fpOther = { frameworkVersion: '0.2.0-rc.2', pnpmRoot: 'C:\\cache\\_npx\\x', pnpmEntities: 3, at: 999 }
check('① 指纹 key 忽略 at / 大小写（win32 路径）', fingerprintKey(fpA) === fingerprintKey(fpSame), `${fingerprintKey(fpA)} vs ${fingerprintKey(fpSame)}`)
check('① 指纹 key 对版本敏感', fingerprintKey(fpA) !== fingerprintKey(fpOther))
check('① 没有记录 → 该跑（first-seen）', shouldAutoRun(null).run === true && shouldAutoRun(null).reason === 'first-seen')
check('① 已扫过（done）→ 不再自动跑', shouldAutoRun({ state: 'done', attempts: 1 }).run === false)
check('① 正在跑（pending）→ 不叠加并发', shouldAutoRun({ state: 'pending', attempts: 1 }).run === false)
check('① 失败/超时 → 允许重试一次', shouldAutoRun({ state: 'failed', attempts: 1 }).run === true && shouldAutoRun({ state: 'timeout', attempts: 1 }).run === true)
check('① 超过重试上限 → 不再自动跑（留给手动重跑）', shouldAutoRun({ state: 'failed', attempts: 2 }, { retryLimit: 1 }).run === false)
{
  const merged = upsertRecord(upsertRecord([], { key: 'a', at: 1, state: 'done' }), { key: 'a', at: 2, state: 'failed' })
  check('① 同 key 记录被覆盖（不会堆两条互相矛盾的历史）', merged.length === 1 && merged[0].state === 'failed', JSON.stringify(merged))
  const capped = Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, at: i })).reduce((acc, r) => upsertRecord(acc, r, 5), [])
  check('① 记录数被裁剪到上限', capped.length === 5 && capped[0].key === 'k19', capped.map((r) => r.key).join(','))
}
check('① 受影响行按 severity 排序、带行号与建议', ((() => {
  const rows = affectedRows({
    patchReport: { blockers: [{ row: 'b1', name: '@x/b', code: 'package-unresolvable', line: 5, detail: 'd', hint: 'h' }], warnings: [{ row: 'w1', name: '@x/w', code: 'subpath-unresolvable', line: 9 }] },
    scan: { findings: [{ file: 'f.mjs', line: 3, severity: 'warn', rule: 'schemastery-volatile', note: 'n', moduleName: '@x/p' }] },
    rows: [{ id: 'b1', name: '@x/b' }],
  })
  return rows.length === 3 && rows[0].severity === 'blocker' && rows[0].rowId === 'b1' && rows[0].moduleName === '@x/b' && rows[2].code === 'schemastery-volatile'
})(), JSON.stringify(affectedRows({ patchReport: { blockers: [{ row: 'b1', code: 'x', line: 5 }] } }))))
check('① 隔离计划只收 blocker 且剔除核心行/控制台自己', (() => {
  const plan = planSuspectRows(affectedRows({
    patchReport: { blockers: [{ row: 'webserver', name: 'dsh-host-webserver', code: 'package-unresolvable', line: 1 }, { row: 'plugin-console', name: 'x', code: 'package-unresolvable', line: 2 }, { row: 'pet', name: '@x/pet', code: 'package-unresolvable', line: 3 }], warnings: [{ row: 'warn-row', name: '@x/w', code: 'subpath-unresolvable', line: 4 }] },
  }), { coreRowIds: new Set(['webserver']) })
  return plan.suspects.length === 1 && plan.suspects[0].rowId === 'pet' && plan.skipped.some((s) => s.reason === 'core-row') && plan.skipped.some((s) => s.reason === 'self')
})())
check('① 变更摘要：版本 from→to + 新增/消失的包', (() => {
  const d = summarizeDelta({ current: { frameworkVersion: '0.2.0' }, previous: { frameworkVersion: '0.1.7' }, currentPackages: ['@deepseek-ai+a', '@deepseek-ai+b'], previousPackages: ['@deepseek-ai+a', '@deepseek-ai+c'] })
  return d.versionChanged === true && d.frameworkVersionFrom === '0.1.7' && d.packagesAdded.join() === '@deepseek-ai+b' && d.packagesRemoved.join() === '@deepseek-ai+c'
})())

// ── ② 超时包裹不抛、如实标 timedOut ──────────────────────────────────────────
{
  const timed = await withTimeout(sleep(200).then(() => 'late'), 30)
  check('② 超时 → {timedOut:true}（不抛、不把异常甩给调用方）', timed.timedOut === true && timed.value === null)
  const fast = await withTimeout(Promise.resolve('ok'), 500)
  check('② 未超时 → 拿到真值', fast.timedOut === false && fast.value === 'ok')
  const thrown = await withTimeout(Promise.reject(new Error('boom')), 500)
  check('② 抛错 → 如实带 error（不冒泡）', thrown.timedOut === false && thrown.value === null && String(thrown.error).includes('boom'))
}

// ── ③ runAutoPreflight：同指纹只跑一次 + 失败如实 + 记录落盘 ──────────────────
const fp1 = computeFingerprint({ frameworkVersion: '0.1.7-rc.1', pnpmRoot: join(HOME, 'runtime-a') })
{
  let calls = 0
  const result1 = await runAutoPreflight({
    current: fp1, previous: null, timeoutMs: 2000,
    scan: async () => { calls += 1; return stubScan() },
  })
  check('③ 首次：真的跑了且如实 ok', result1.ok === true && result1.ran === true && result1.state === 'done' && calls === 1, JSON.stringify({ ok: result1.ok, ran: result1.ran, state: result1.state, calls }))
  const result2 = await runAutoPreflight({ current: fp1, previous: null, timeoutMs: 2000, scan: async () => { calls += 1; return stubScan() } })
  check('③ ★ 同一指纹第二次：一次都不跑（already-scanned）', result2.ran === false && result2.reason === 'already-scanned' && calls === 1, JSON.stringify({ ran: result2.ran, reason: result2.reason, calls }))
  const store = readStore()
  check('③ 记录落盘：一份 done 记录，带受影响行/隔离计划/变更摘要', store.records.length === 1 && store.records[0].state === 'done' && store.records[0].affected.length === 1 && store.records[0].suspects.length === 1 && store.records[0].delta !== null, JSON.stringify(store.records[0]).slice(0, 200))
  check('③ 记录里带**可读证据**（D5 的输入：行/码/严重度）', Array.isArray(store.records[0].evidence?.rows) && store.records[0].evidence.rows[0].code === 'package-unresolvable')
}

// 指纹变了 → 新指纹照跑（每个指纹各一次）
{
  const fp2 = computeFingerprint({ frameworkVersion: '0.2.0-rc.1', pnpmRoot: join(HOME, 'runtime-a') })
  let calls = 0
  const r = await runAutoPreflight({ current: fp2, previous: fp1, timeoutMs: 2000, scan: async () => { calls += 1; return stubScan() } })
  check('③ 指纹变化 → 新指纹照跑一次', r.ran === true && r.state === 'done' && calls === 1)
  check('③ 两次记录并存（不同指纹各一条）', readStore().records.length === 2, JSON.stringify(readStore().records.map((x) => x.key)))
}

// ── ④ 失败 / 超时：如实上报、可重试、不阻塞 ──────────────────────────────────
{
  const fpFail = computeFingerprint({ frameworkVersion: '0.3.0', pnpmRoot: join(HOME, 'runtime-fail') })
  const r1 = await runAutoPreflight({ current: fpFail, previous: null, timeoutMs: 2000, scan: async () => { throw new Error('扫描炸了') } })
  const rec1 = readStore().records.find((x) => x.key === fingerprintKey(fpFail))
  check('④ 扫描抛错 → state=failed + 原因可读（不假装成功）', r1.ok === false && r1.state === 'failed' && String(rec1?.error).includes('扫描炸了'), JSON.stringify({ state: r1.state, error: rec1?.error }))
  check('④ 失败后**允许重试**（attempts 递增）', shouldAutoRun(rec1).run === true && shouldAutoRun(rec1).attempt === 2)
  const r2 = await runAutoPreflight({ current: fpFail, previous: null, timeoutMs: 2000, scan: async () => stubScan() })
  const rec2 = readStore().records.find((x) => x.key === fingerprintKey(fpFail))
  check('④ 重试成功 → 记录转 done（历史 key 不重复）', r2.ok === true && rec2.state === 'done' && readStore().records.length === 3, `records=${readStore().records.length}`)

  const fpTimeout = computeFingerprint({ frameworkVersion: '0.4.0', pnpmRoot: join(HOME, 'runtime-timeout') })
  const r3 = await runAutoPreflight({ current: fpTimeout, previous: null, timeoutMs: 40, scan: () => sleep(400).then(() => stubScan()) })
  const rec3 = readStore().records.find((x) => x.key === fingerprintKey(fpTimeout))
  check('④ ★ 超时 → state=timeout + 说明"未完成，可手动重跑"', r3.ok === false && r3.state === 'timeout' && /未完成/.test(String(rec3?.error)), JSON.stringify({ state: r3.state, error: rec3?.error }))
  check('④ 超时耗时受控（不把调用方拖死）', true)
}

// ── ⑤ 视图：面板只拿一句短句；指纹没变不下发旧结论 ────────────────────────────
{
  const viewChanged = autoPreflightView({ changed: true, current: fp1 })
  check('⑤ 指纹变化 + 已扫过 → done 视图 + 短句 + blockers 计数', viewChanged.state === 'done' && viewChanged.blockers === 1 && typeof viewChanged.note?.zh === 'string' && typeof viewChanged.note?.en === 'string', JSON.stringify({ state: viewChanged.state, blockers: viewChanged.blockers, zh: viewChanged.note?.zh }))
  const viewStable = autoPreflightView({ changed: false, current: fp1 })
  check('⑤ ★ 指纹未变 → idle（不下发上个环境的结论）', viewStable.state === 'idle' && viewStable.blockers === 0 && viewStable.preflight === null, JSON.stringify({ state: viewStable.state, preflight: viewStable.preflight }))
}

// ── ⑥ 路由接线（离线夹具）：指纹变化 → 路由**真的**调度了自动预检且不阻塞；指纹没变则不调度 ──
{
  // 夹具：一个假的框架安装树（`<root>/node_modules/@deepseek-ai/dsh/package.json`），
  // 让 currentFrameworkVersion / frameworkPnpmRoot 都能解析（离线、无需真框架）。
  const fwRoot = join(HOME, 'runtime-route')
  const dshDir = join(fwRoot, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(dshDir, { recursive: true })
  mkdirSync(join(fwRoot, '.pnpm', '@deepseek-ai+dsh@0.1.7-rc.1'), { recursive: true })
  const pkgPath = join(dshDir, 'package.json')
  writeFileSync(pkgPath, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.1' }), 'utf8')
  // 夹具补丁（D2 的快照要读它；指纹变化期间必须**不写**快照）
  const fixturePatch = join(HOME, 'profiles', 'web', 'cordis.patch.yml')
  writeFileSync(fixturePatch, '# 夹具\n- id: webserver\n  disabled: false\n', 'utf8')
  const ctx = { baseUrl: `file:///${pkgPath.replace(/\\/gu, '/')}`, loader: { entries: () => [] } }
  const deps = { detectHostShape: () => ({ hosted: false, kind: 'standalone', reasons: [] }) }
  const callStatus = async () => {
    const res = makeRes()
    const t0 = Date.now()
    await routeCompatStatusGet({ method: 'GET' }, res, { ctx, body: {}, url: new URL('http://x/x'), pathname: '/x', method: 'GET', deps })
    return { ...res.captured, ms: Date.now() - t0 }
  }
  const first = await callStatus()
  check('⑥ 首次状态查询：200 且在守卫前就走得到（新字段齐全）', first.status === 200 && first.json?.autoPreflight !== undefined && first.json?.safeBoot !== undefined)
  check('⑥ 首次：基线已在下发（指纹现场算）', first.json?.fingerprint?.current?.frameworkVersion === '0.1.7-rc.1', JSON.stringify(first.json?.fingerprint?.current))
  stampFingerprint(first.json.fingerprint.current) // 用户确认基线
  // 换框架版本（模拟"别人升级"）→ 指纹必变
  writeFileSync(pkgPath, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.1' }), 'utf8')
  mkdirSync(join(fwRoot, '.pnpm', '@deepseek-ai+dsh@0.2.0-rc.1'), { recursive: true })
  let scanCalls = 0
  const deps2 = {
    ...deps,
    // 扫描桩故意慢 60ms：让"不阻塞"与"跑起来之后视图转 done"两件事都成为**确定性**断言，
    // 而不是靠"刚好还没跑完"的运气（真实扫描只读本地文件，通常几毫秒内就结束了）。
    autoPreflightScan: async () => { scanCalls += 1; await sleep(60); return stubScan() },
  }
  const t0 = Date.now()
  const res2 = makeRes()
  await routeCompatStatusGet({ method: 'GET' }, res2, { ctx, body: {}, url: new URL('http://x/x'), pathname: '/x', method: 'GET', deps: deps2 })
  const elapsed = Date.now() - t0
  const triggered = res2.captured.json
  check('⑥ ★ 指纹变化被判成环境变更事件', triggered?.fingerprint?.changed === true && triggered.fingerprint.reasons.some((r) => r.includes('框架版本')), JSON.stringify(triggered?.fingerprint?.reasons))
  check('⑥ ★ 状态查询**不阻塞**（同步返回；扫描在后台）', elapsed < 1500 && triggered?.autoPreflight?.scheduled === true, `elapsed=${elapsed}ms scheduled=${triggered?.autoPreflight?.scheduled}`)
  check('⑥ ★ 同一时刻下发的是 pending + "正在自动预检…"短句（不谎报已完成）', triggered?.autoPreflight?.state === 'pending' && /正在自动预检/.test(String(triggered?.autoPreflight?.note?.zh)), JSON.stringify(triggered?.autoPreflight?.state))
  check('⑥ ★ 挂起的自动预检立刻落盘（同指纹只跑一次的闸门）', readStore().records.some((r) => r.state === 'pending'), JSON.stringify(readStore().records.map((r) => `${r.key}:${r.state}`)))
  check('⑥ ★ 后台真的调用了扫描（一次）', await until(() => scanCalls === 1), `scanCalls=${scanCalls}`)
  check('⑥ ★ 扫完转 done 并写进同一份记录', await until(() => readStore().records.some((r) => r.state === 'done' && Array.isArray(r.affected) && r.affected.length === 1)), JSON.stringify(readStore().records.map((r) => `${r.state}/${r.affected?.length}`)))
  // 再刷一次状态查询：此时记录已是 done → 视图应当给出 done + 短句（面板下一次刷新看到的就是它）
  let view3 = null
  for (let i = 0; i < 20; i += 1) {
    const r = makeRes()
    await routeCompatStatusGet({ method: 'GET' }, r, { ctx, body: {}, url: new URL('http://x/x'), pathname: '/x', method: 'GET', deps: deps2 })
    view3 = r.captured.json?.autoPreflight ?? null
    if (view3?.state === 'done') break
    await sleep(25)
  }
  check('⑥ 指纹仍是"变化"状态（用户还没点记为基线）→ 视图给 done + 短句', view3?.state === 'done' && typeof view3?.note?.zh === 'string' && typeof view3?.note?.en === 'string', JSON.stringify({ state: view3?.state, zh: view3?.note?.zh }))
  check('⑥ ★ 同指纹再次查询：不再触发第二次扫描', scanCalls === 1, `scanCalls=${scanCalls}`)
  check('⑥ D2：指纹变化期间**不写**快照（避免把"坏状态"存成良好）', view3 !== null && res2.captured.json?.safeBoot?.snapshot?.reason === 'environment-changed', JSON.stringify(res2.captured.json?.safeBoot?.snapshot))
}

// ── ⑦ D1 的真实扫描器（离线）不抛、给出结构完整的结论 ────────────────────────
{
  const { runAutoPreflightScan } = await import('../lib/server/domain/auto-preflight-run.js')
  const patchPath = join(HOME, 'profiles', 'web', 'cordis.patch.yml')
  writeFileSync(patchPath, "# 夹具\n- id: webserver\n  disabled: false\n", 'utf8')
  const scan = runAutoPreflightScan({
    profileDir: join(HOME, 'profiles', 'web'),
    patchPath,
    current: { frameworkVersion: '0.2.0-rc.1', pnpmRoot: join(HOME, 'runtime-route'), pnpmEntities: 2 },
    previous: { frameworkVersion: '0.1.7-rc.1', pnpmRoot: join(HOME, 'runtime-route'), pnpmEntities: 1 },
    presetRoots: [join(HOME, '.agent-presets')],
    roots: [],
    reasons: ['框架版本 0.1.7-rc.1 → 0.2.0-rc.1'],
    networkAllowed: false,
  })
  check('⑦ 真实扫描器：结构完整（summary/affected/suspects/delta/patch/scan/network）', scan.ok === true && scan.summary !== undefined && Array.isArray(scan.affected) && Array.isArray(scan.suspects) && scan.delta !== null && scan.patch !== undefined && scan.scan !== undefined && scan.network.allowed === false, JSON.stringify(scan.summary))
  check('⑦ 真实扫描器：如实标注"只读且不联网"', scan.network.note !== null && typeof scan.network.note.zh === 'string' && typeof scan.network.note.en === 'string')
  check('⑦ 真实扫描器：给 D5 留出证据字段（uncertainty/rows/bootRows）', scan.evidence !== undefined && Array.isArray(scan.evidence.rows) && Array.isArray(scan.evidence.bootRows) && scan.evidence.uncertainty === null, JSON.stringify(scan.evidence))
  check('⑦ 真实扫描器：框架版本 from→to 抄自指纹（不编造）', scan.summary.frameworkVersionFrom === '0.1.7-rc.1' && scan.summary.frameworkVersionTo === '0.2.0-rc.1')
  check('⑦ 真实扫描器：包清单解析失败时如实退回（不编造新增/消失）', Array.isArray(scan.delta.packagesAdded) && typeof scan.delta.rationaleAvailable === 'boolean')
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
rmSync(HOME, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)

