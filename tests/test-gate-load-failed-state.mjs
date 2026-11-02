// `/state` 的「加载失败的行」视图（0.5.101 加法）
//
// 真机现场（2026-11-02）：`fiberPhase === 'failed'` 的行（例：experimental-inspector 因
// `@deepseek-ai/cordis` 解析失败而挂载失败）**门控完全看不到** —— 这条失败不经过预扫/隔离链。
//
// 本套钉死三件事（隔离 DSH_HOME + 私有 profile 夹具，零外网）：
//   ① `/state` 的 `gating` **只增**一个视图：`loadFailed`（含 rowId/moduleName/version/fiberPhase）+ `loadFailedCount`；
//      既有字段（pendingCount/adoptedCount/pending/adopted/total 等）一个不少、语义不变；
//   ② ★ 这个视图**只读**：`compat-pending.json` 一个字节都不变（运行期故障绝不污染适配裁决记录）；
//      加载失败的行也**不会**出现在 `compatPending.pending` 里；
//   ③ 零失败行时 `loadFailed: []`、计数 0（面板据此不显示分区）。
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'gate-load-failed-state-home')
process.env.DSH_HOME = HOME
process.env.DSH_TEST_SKIP_NETWORK = '1'
rmSync(HOME, { recursive: true, force: true })

const profileDir = join(HOME, 'profiles', 'web')
const cpDir = join(HOME, 'plugin-console')
mkdirSync(cpDir, { recursive: true })
const writePkg = (rel, obj) => {
  const file = join(profileDir, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2), 'utf8')
  return file
}
writePkg('node_modules/@deepseek-ai/dsh/package.json', { name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' })
writePkg('node_modules/@deepseek-ai/dsh/index.js', 'export default {}\n')
writePkg('node_modules/@fake/ok/package.json', { name: '@fake/ok', version: '1.0.0', main: 'index.js' })
writePkg('node_modules/@fake/ok/index.js', 'export default {}\n')
writePkg('node_modules/@fake/broken/package.json', { name: '@fake/broken', version: '0.3.4', main: 'index.js' })
writePkg('node_modules/@fake/broken/index.js', 'export default {}\n')
writePkg('package.json', { name: 'dsh-profile-web', private: true, dsh: { profile: { bundles: [] } } })
const patchFile = writePkg('cordis.patch.yml', [
  '# gate-load-failed fixture',
  '- insert:',
  '    - id: ok-row',
  "      name: '@fake/ok'",
  '    - id: broken-row',
  "      name: '@fake/broken'",
  '',
].join('\n'))
const PENDING_FILE = join(cpDir, 'compat-pending.json')
const { SCANNER_VERSION } = await import('../lib/server/domain/compat-verdict.js')
/**
 * 预置一条**适配裁决**记录：用来证明"加载失败"不会挤进/改动它。
 * ⚠ 必须在 `apply()` **之后**写：
 *   · 启动时的 `reconcileCompatPending` 会把"行已启用"的 pending 记录转成 adopted（v0.3.45 既有行为）；
 *   · 记录带**当前判据戳** ⇒ `/state` 的"读取代发"不会重算/回写它（否则文件会被合法改写，
 *     "一字节不变"的断言就测不到我们想测的东西了）。
 */
function seedPending() {
  writeFileSync(PENDING_FILE, JSON.stringify({
    frameworkVersion: '0.2.1-rc.2',
    upgradeFrom: '0.2.1-rc.1',
    pending: [{
      rowId: 'ok-row', moduleName: '@fake/ok', version: '1.0.0', status: 'pending', check: 'fail', checkNote: '声明不满足',
      source: 'manual-scan',
      scanVerdict: { version: SCANNER_VERSION, decision: 'fail', reason: '声明不满足', at: Date.now(), previous: null, rescinded: false, evidence: null },
    }],
  }, null, 2), 'utf8')
}

let entries = []
const cordisUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
const ctx = {
  baseUrl: cordisUrl,
  loader: {
    entries: () => [
      { id: 'include', options: { name: 'cordis:include', group: true, config: { path: cordisUrl } } },
      { id: 'include:plugin-console', options: { name: '@noob-stupid/dsh-plugin-console' }, disabled: false, fiber: { state: 2 } },
      { id: 'include:ok-row', options: { name: '@fake/ok' }, disabled: false, fiber: { state: 2 } },
      ...entries,
    ],
  },
  webServer: { register: (route) => { globalThis.__route = route; return () => {} } },
  effect: (fn) => { try { fn() } catch {}; return () => {} },
}
const mod = await import('../lib/index.js')
mod.apply(ctx)
const route = globalThis.__route
const fakeReq = (method, pathname) => ({
  method, url: pathname, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' },
  signal: { aborted: false, addEventListener: () => {} },
  [Symbol.asyncIterator]() { return { next: async () => ({ value: undefined, done: true }) } },
})
const fakeRes = () => { const r = { status: 0, body: null }; r.writeHead = (s) => { r.status = s }; r.end = (p) => { r.body = p }; return r }
const getState = async () => { const r = fakeRes(); await route.handler(fakeReq('GET', '/plugin-console/state'), r); return { status: r.status, json: r.body === null ? null : JSON.parse(r.body) } }
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

console.log('=== ① 有加载失败的行：视图如实列出（只增字段）===')
{
  seedPending() // 见上面的说明：必须在 apply() 之后
  entries = [
    { id: 'include:broken-row', options: { name: '@fake/broken' }, disabled: false, fiber: { state: 3 } }, // FAILED
    { id: 'include:ghost-row', options: { name: '@fake/ghost' }, disabled: false, fiber: { state: 3 } },
    { id: 'include:pending-row', options: { name: '@fake/ok' }, disabled: false, fiber: { state: 1 } }, // loading：不算失败
  ]
  const before = { sha: sha256(PENDING_FILE), stat: { size: statSync(PENDING_FILE).size, mtimeMs: statSync(PENDING_FILE).mtimeMs } }
  const st = await getState()
  const g = st.json?.gating ?? null
  check('/state 200 且带 gating', st.status === 200 && g !== null, `status=${st.status}`)
  check('★ gating.loadFailed 列出 2 行加载失败（fiberPhase=failed）', Array.isArray(g?.loadFailed) && g.loadFailed.length === 2,
    JSON.stringify(g?.loadFailed?.map((r) => r.rowId)))
  check('★ loadFailedCount 与数组一致', g?.loadFailedCount === 2, `count=${g?.loadFailedCount}`)
  const broke = (g?.loadFailed ?? []).find((r) => r.rowId === 'broken-row') ?? null
  check('★ 每条带 rowId / moduleName / version / fiberPhase',
    broke?.moduleName === '@fake/broken' && broke?.version === '0.3.4' && broke?.fiberPhase === 'failed',
    JSON.stringify(broke))
  check('加载失败**不**混进适配记录列表（它只是视图，不是裁决）',
    !(g?.pending ?? []).some((r) => r.rowId === 'broken-row') && !(g?.adopted ?? []).some((r) => r.rowId === 'broken-row'),
    JSON.stringify((g?.pending ?? []).map((r) => r.rowId)))
  check('既有字段一个不少（pendingCount / adoptedCount / pending / adopted）',
    typeof g?.pendingCount === 'number' && typeof g?.adoptedCount === 'number'
    && Array.isArray(g?.pending) && Array.isArray(g?.adopted),
    `keys=${Object.keys(g ?? {}).join(',')}`)
  check('既有字段语义没变：pendingCount 仍是"status=pending 的记录数"（1 条 ok-row）',
    g?.pendingCount === 1 && g?.adoptedCount === 0, `pending=${g?.pendingCount} adopted=${g?.adoptedCount}`)
  check('compatPending 视角也没被污染（pending 里只有那条裁决记录）',
    JSON.stringify((st.json?.compatPending?.pending ?? []).map((p) => p.rowId)) === JSON.stringify(['ok-row']),
    JSON.stringify((st.json?.compatPending?.pending ?? []).map((p) => p.rowId)))
  check('★ 视图是只读的：compat-pending.json 一个字节都没变（sha + mtime + size）',
    sha256(PENDING_FILE) === before.sha && statSync(PENDING_FILE).mtimeMs === before.stat.mtimeMs && statSync(PENDING_FILE).size === before.stat.size,
    `sha=${sha256(PENDING_FILE).slice(0, 8)}`)
}

console.log('\n=== ② 零加载失败行：数组为空、计数 0（面板据此不显示分区）===')
{
  entries = [{ id: 'include:fine-row', options: { name: '@fake/ok' }, disabled: false, fiber: { state: 2 } }]
  const st = await getState()
  check('★ 零失败 ⇒ loadFailed: [] / loadFailedCount: 0',
    Array.isArray(st.json?.gating?.loadFailed) && st.json.gating.loadFailed.length === 0 && st.json?.gating?.loadFailedCount === 0,
    JSON.stringify(st.json?.gating?.loadFailed))
  check('零失败时其它字段照旧（pendingCount 仍 1）', st.json?.gating?.pendingCount === 1, `pending=${st.json?.gating?.pendingCount}`)
}

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
