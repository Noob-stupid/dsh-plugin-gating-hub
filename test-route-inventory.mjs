// Step 0 行为基线①：路由清单 + 响应字段 + 安全中间件（拆分前钉死，防止结构变更悄悄丢接口/改字段）
//
// 为什么要有它：历史上 `market-index` 的 405 就这样藏了两周——路由悄悄失效没人发现。
// 拆分（L0-L3 分层、45 条 if 分支改成表驱动）最容易犯的错就是"漏搬一条路由"或"顺手改了响应字段"。
// 本测试把当前 47 条路由、13 条只读接口的响应字段、4 类安全校验全部固化为断言：
//   · 路由清单必须与源码完全一致（新增/删除都要同步改这里）
//   · 只读接口的 status 与顶层字段必须逐字段一致（改名即失败）
//   · 环回 / Host / 同源写保护 / 405 方法门禁行为不变
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'route-inventory-home')
process.env.DSH_HOME = HOME
rmSync(HOME, { recursive: true, force: true })
const profileDir = join(HOME, 'profiles', 'web')
mkdirSync(join(profileDir, 'node_modules', '@fake', 'demo'), { recursive: true })
writeFileSync(join(profileDir, 'cordis.patch.yml'), '# baseline\n', 'utf8')
writeFileSync(join(profileDir, 'node_modules', '@fake', 'demo', 'package.json'), JSON.stringify({ name: '@fake/demo', version: '1.0.0', main: 'index.js' }), 'utf8')
writeFileSync(join(profileDir, 'node_modules', '@fake', 'demo', 'index.js'), 'export const ok = true\n', 'utf8')
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })

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
const mod = await import('./lib/index.js')
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

// ── ① 路由清单：与源码逐条对齐（47 条）────────────────────────────────────────
const ROUTES = [
  '/state', '/sources', '/gitee-oauth-url', '/gitee-oauth-callback', '/framework-upgrade-status',
  '/framework-relaunch', '/skills-installed', '/details', '/toggle', '/uninstall', '/search', '/enrich',
  '/repo', '/subpackages', '/registry-scan', '/market-index', '/framework-check', '/compat-gate',
  '/adapt-unlock', '/adapt-unlock-all', '/check-update', '/framework-upgrade', '/framework-rollback',
  '/clean-residuals', '/self-update', '/install', '/skill-remove', '/skill-toggle', '/install-status',
  '/ai-consent', '/ai-empower/plan', '/ai-empower/status', '/ai-empower/list', '/ai-empower/run',
  '/ai-empower/cancel', '/components', '/repo-clone', '/repo-list', '/repo-land-config', '/repo-remove',
  '/repo-open', '/component/autostart', '/component/start', '/component/stop', '/component/status', '/restart',
  '/github-login',
]
const src = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
const found = new Set()
for (const m of src.matchAll(/pathname === `\$\{ROUTE_PREFIX\}([^`]*)`/gu)) found.add(m[1])
const missing = ROUTES.filter((p) => !found.has(p))
const extra = [...found].filter((p) => !ROUTES.includes(p))
check(`路由清单完整（${ROUTES.length} 条）`, missing.length === 0, missing.length === 0 ? '全部命中' : `缺失: ${missing.join(', ')}`)
check('没有未登记的新路由（新增必须同步更新本清单）', extra.length === 0, extra.length === 0 ? '无新增' : `未登记: ${extra.join(', ')}`)

// ── ② 只读接口：status + 顶层响应字段逐字段固化 ───────────────────────────────
const SCHEMAS = [
  ['GET', '/plugin-console/state', undefined, 200, ['compat', 'compatGate', 'compatPending', 'components', 'entries', 'framework', 'github', 'installJobs', 'ok', 'patch', 'patchHeal', 'patchPath', 'recentFailures', 'rollback', 'selfVersion']],
  ['GET', '/plugin-console/sources', undefined, 200, ['giteeStatus', 'ok', 'sources']],
  ['GET', '/plugin-console/skills-installed', undefined, 200, ['ok', 'pluginSkills', 'skills']],
  ['GET', '/plugin-console/framework-upgrade-status', undefined, 200, ['message', 'ok', 'status']],
  ['POST', '/plugin-console/details', { entryId: 'include:demo' }, 200, ['entryId', 'meta', 'moduleName', 'ok', 'readme', 'rowId']],
  ['POST', '/plugin-console/compat-gate', {}, 200, ['compatGate', 'ok']],
  ['POST', '/plugin-console/framework-check', {}, 200, ['checkedAt', 'current', 'latest', 'next', 'ok', 'registryError', 'target']],
  ['POST', '/plugin-console/ai-empower/list', {}, 200, ['ok', 'tasks']],
  ['POST', '/plugin-console/ai-empower/status', {}, 404, ['error', 'ok']],
  ['POST', '/plugin-console/install-status', {}, 404, ['error', 'ok']],
  ['POST', '/plugin-console/repo-list', {}, 200, ['dir', 'ok', 'repos']],
  ['POST', '/plugin-console/components', {}, 200, ['components', 'ok']],
  // github-login 只测"形状不合法"这条不触网的路径：合法 token 会真的打 GitHub，测试不能依赖网络
  ['POST', '/plugin-console/github-login', { token: '' }, 400, ['error', 'ok']],
]
for (const [method, path, body, wantStatus, wantKeys] of SCHEMAS) {
  const r = await call(method, path, body)
  const keys = r.json === null ? [] : Object.keys(r.json).sort()
  const same = r.status === wantStatus && JSON.stringify(keys) === JSON.stringify([...wantKeys].sort())
  check(`响应契约 ${method} ${path.replace('/plugin-console', '')}`, same, `status=${r.status} keys=${keys.join(',')}`)
}

// ── ③ 安全中间件：环回 / Host / 同源写保护 / 方法门禁 ─────────────────────────
{
  const r = fakeRes()
  const q = fakeReq('GET', '/plugin-console/state')
  q.socket.remoteAddress = '10.0.0.5'
  await route.handler(q, r)
  check('非环回一律 403', r.status === 403, `status=${r.status}`)
}
{
  const r = fakeRes()
  const q = fakeReq('GET', '/plugin-console/state')
  q.headers = { host: 'evil.example' }
  await route.handler(q, r)
  check('非法 Host 一律 403', r.status === 403, `status=${r.status}`)
}
{
  const r = fakeRes()
  const q = fakeReq('POST', '/plugin-console/toggle', { entryId: 'include:demo', enabled: false })
  q.headers = { host: '127.0.0.1:3080', origin: 'https://evil.example' }
  await route.handler(q, r)
  check('跨站写请求 403（Origin）', r.status === 403, `status=${r.status}`)
}
{
  const r = fakeRes()
  const q = fakeReq('POST', '/plugin-console/toggle', { entryId: 'include:demo', enabled: false })
  q.headers = { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }
  await route.handler(q, r)
  check('跨站写请求 403（Sec-Fetch-Site）', r.status === 403, `status=${r.status}`)
}
{
  const r = await call('GET', '/plugin-console/toggle')
  check('POST-only 路由用 GET 访问 → 405', r.status === 405, `status=${r.status}`)
}
{
  // GET_COMPAT 白名单当前只有 market-index（只读且无副作用），市场索引用 GET 也必须能进
  const r = await call('GET', '/plugin-console/market-index')
  check('只读白名单：GET market-index 不被 405 拦', r.status !== 405, `status=${r.status}`)
}

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
