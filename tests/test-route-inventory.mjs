// Step 0 行为基线①：路由清单 + 响应字段 + 安全中间件（拆分前钉死，防止结构变更悄悄丢接口/改字段）
//
// 为什么要有它：历史上 `market-index` 的 405 就这样藏了两周——路由悄悄失效没人发现。
// 拆分（L0-L3 分层、45 条 if 分支改成表驱动）最容易犯的错就是"漏搬一条路由"或"顺手改了响应字段"。
// 本测试把当前 48 条路由、13 条只读接口的响应字段、4 类安全校验全部固化为断言：
//   · 路由清单必须与源码完全一致（新增/删除都要同步改这里）
//   · 只读接口的 status 与顶层字段必须逐字段一致（改名即失败）
//   · 环回 / Host / 同源写保护 / 405 方法门禁行为不变
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync, symlinkSync } from 'node:fs'
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

// ── ① 路由清单：与源码逐条对齐（48 条）────────────────────────────────────────
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
  '/github-open-login',
  '/framework-preflight',
  '/framework-preflight-patch',
  // 门控常驻化（2026-09-24）：触发源从「我们的升级动作」换成「环境指纹变化」——
  // 官方桌面端自带升级器 / 官方只发桌面端时，门控仍能守门
  '/compat-status',
  '/compat-mode',
  '/compat-stamp',
]
// 分层后路由可能写在 lib/server/routes/**（表项）或 index.js（内联分支）—— 两种写法都要认
const walkSrc = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const f = join(dir, e.name)
  return e.isDirectory() ? walkSrc(f) : (e.name.endsWith('.js') ? [readFileSync(f, 'utf8')] : [])
})
const src = [readFileSync(join(ROOT, '..', 'lib', 'index.js'), 'utf8'), ...walkSrc(join(ROOT, '..', 'lib', 'server'))].join('\n')
const found = new Set()
for (const m of src.matchAll(/path(?:name === |: )`\$\{ROUTE_PREFIX\}([^`]*)`/gu)) found.add(m[1])
const missing = ROUTES.filter((p) => !found.has(p))
const extra = [...found].filter((p) => !ROUTES.includes(p))
check(`路由清单完整（${ROUTES.length} 条）`, missing.length === 0, missing.length === 0 ? '全部命中' : `缺失: ${missing.join(', ')}`)
check('没有未登记的新路由（新增必须同步更新本清单）', extra.length === 0, extra.length === 0 ? '无新增' : `未登记: ${extra.join(', ')}`)

// ── ② 只读接口：status + 顶层响应字段逐字段固化 ───────────────────────────────
const SCHEMAS = [
  // 2026-09-24：门控面板要显示「具体是哪些插件」→ /state 新增 gating 明细块
  ['GET', '/plugin-console/state', undefined, 200, ['compat', 'compatGate', 'compatPending', 'components', 'entries', 'framework', 'gating', 'github', 'installJobs', 'ok', 'patch', 'patchHeal', 'patchPath', 'pendingRestart', 'recentFailures', 'rollback', 'selfVersion']],
  ['GET', '/plugin-console/sources', undefined, 200, ['giteeStatus', 'ok', 'sources']],
  ['GET', '/plugin-console/skills-installed', undefined, 200, ['ok', 'pluginSkills', 'skills']],
  ['GET', '/plugin-console/framework-upgrade-status', undefined, 200, ['message', 'ok', 'status']],
  ['POST', '/plugin-console/details', { entryId: 'include:demo' }, 200, ['entryId', 'meta', 'moduleName', 'ok', 'readme', 'rowId']],
  ['POST', '/plugin-console/compat-gate', {}, 200, ['compatGate', 'ok']],
  // 2026-09-23：面板改成「可选版本列表」→ 契约新增 alpha / tagDefault / versions 三个字段
  ['POST', '/plugin-console/framework-check', {}, 200, ['alpha', 'checkedAt', 'current', 'latest', 'next', 'ok', 'registryError', 'tagDefault', 'target', 'versions']],
  ['POST', '/plugin-console/ai-empower/list', {}, 200, ['ok', 'tasks']],
  ['POST', '/plugin-console/ai-empower/status', {}, 404, ['error', 'ok']],
  ['POST', '/plugin-console/install-status', {}, 404, ['error', 'ok']],
  ['POST', '/plugin-console/repo-list', {}, 200, ['dir', 'ok', 'repos']],
  ['POST', '/plugin-console/components', {}, 200, ['components', 'ok']],
  // github-login 只测"形状不合法"这条不触网的路径：合法 token 会真的打 GitHub，测试不能依赖网络
  ['POST', '/plugin-console/github-login', { token: '' }, 400, ['error', 'ok']],
  // github-open-login 不能进这张表：它的响应随环境分两种形状（成功 {ok,started,status} / 不可用
  // {ok,started,reason}），逐字段钉死必然误报；更要紧的是**它会真的去 fetch 本机 web 端口**，
  // 而本机装了 dsh-github-login 且 exe 在（D:\dsh\dsh-github-login\dist\DSH-GitHub-Login.exe），
  // 默认端口 3080 又正是本机在跑的宿主 —— 真调一次会弹出登录窗口，测试不该有可见副作用。
  // 所以它改用下面的「②c 弱断言」：把端口临时指到没人监听的空端口，走真实的降级分支。
]
for (const [method, path, body, wantStatus, wantKeys] of SCHEMAS) {
  const r = await call(method, path, body)
  const keys = r.json === null ? [] : Object.keys(r.json).sort()
  const same = r.status === wantStatus && JSON.stringify(keys) === JSON.stringify([...wantKeys].sort())
  check(`响应契约 ${method} ${path.replace('/plugin-console', '')}`, same, `status=${r.status} keys=${keys.join(',')}`)
}

// ── ①b 门控面板必须能看到「具体是哪些插件」（2026-09-24 用户要求）─────────────
// 用户原话：「门控面板应该可以显示是哪些，有列表数据」。此前 /state 只下发 pending 行、
// 且只有 rowId/checkNote，面板也只显示一句「当前待适配：N 行」——看得到数量，看不到是谁。
// 这一节真造一份 compat-pending.json（一条 pending + 一条 adopted），验证 /state 把它们变成可读明细。
{
  const cpDir = join(HOME, 'plugin-console')
  mkdirSync(cpDir, { recursive: true })
  writeFileSync(join(cpDir, 'compat-pending.json'), JSON.stringify({
    frameworkVersion: '0.1.5-rc.2',
    upgradeFrom: '0.1.5-rc.1',
    pending: [
      { rowId: 'include:demo', moduleName: '@fake/demo', version: '1.0.0', status: 'pending', check: 'unknown', checkNote: '启动失败隔离（safe-mode）：启动日志命中，服务曾被它拖垮', source: 'boot-quarantine', forcedAt: 1790218032109 },
      { rowId: 'web-ui-pet', moduleName: null, version: null, status: 'pending', check: 'unknown', checkNote: '升级预扫判定不适配', source: 'upgrade-prescan' },
      { rowId: 'web-ui-market', moduleName: '@fake/demo/market', version: '0.3.14', status: 'adopted', check: 'unknown', checkNote: '源码扫描无已删除 API 引用', adoptedAt: 1789996822423 },
    ],
  }, null, 2), 'utf8')

  const st = await call('GET', '/plugin-console/state', undefined)
  const g = st.json?.gating ?? null
  check('/state 带 gating 明细块', g !== null && typeof g === 'object', `gating=${g === null ? 'null' : 'ok'}`)
  check('gating 分开统计 pending / adopted 两侧', g?.pendingCount === 2 && g?.adoptedCount === 1, `pending=${g?.pendingCount} adopted=${g?.adoptedCount}`)
  const p0 = (g?.pending ?? [])[0] ?? {}
  check('pending 行带名字（moduleName 缺失时回落到可读条目名）',
    p0.name === '@fake/demo' && (g?.pending ?? [])[1]?.name === 'web-ui-pet',
    `name0=${p0.name} name1=${(g?.pending ?? [])[1]?.name}`)
  check('pending 行带原因与来源（面板要显示"为什么被拦"）',
    typeof p0.note === 'string' && p0.note.includes('启动失败隔离') && p0.source === 'boot-quarantine', `note=${String(p0.note).slice(0, 30)} source=${p0.source}`)
  check('adopted 行也在（用户要能核对历史上动过哪些行）',
    (g?.adopted ?? [])[0]?.name === '@fake/demo/market' && (g?.adopted ?? [])[0]?.version === '0.3.14')
  const gateClient = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')
  check('门控面板渲染 gating 明细（不再只有一句数量）',
    gateClient.includes('state.data.gating') && gateClient.includes('gateRows.pending') && gateClient.includes('gateRows.adopted'))
  rmSync(join(cpDir, 'compat-pending.json'), { force: true })
}

// ── ②b /install-status 命中真实任务必须 200（防 installJobView 漏 import 复发）─────
// 事故（2026-09-19，live 实测）：routes/install.js 用了 installJobView(job) 却没有 import
// → ReferenceError → /install-status 恒 500（轮询 90 次全 500，安装进度卡刷不出来），
// 而上面的契约表只测了 jobId 为空的 404 早返回分支，命不中出错那一行 → 测试与守卫双双漏过。
{
  const { installJobs } = await import('../lib/server/state.js')
  installJobs.set('job-inventory-1', {
    id: 'job-inventory-1', repo: 'owner/demo', source: 'github', packageName: null, status: 'installing',
    stage: 'preparing', error: null, startedAt: 1, finishedAt: null, entryId: null, bundle: false, ai: false,
    aiNote: null, subpackages: null, lastError: null, update: false, kind: 'plugin',
  })
  const r = await call('POST', '/plugin-console/install-status', { jobId: 'job-inventory-1' })
  check('install-status 命中真实任务 → 200（不是 500）',
    r.status === 200 && r.json?.ok === true && r.json?.jobId === 'job-inventory-1' && r.json?.status === 'installing',
    `status=${r.status} body=${JSON.stringify(r.json)?.slice(0, 140)}`)
  const view = r.json ?? {}
  check('install-status 视图字段完整（kind/curlNote/suiteNote）',
    view.kind === 'plugin' && view.stage === 'preparing' && 'suiteNote' in view && 'curlNote' in view,
    `kind=${view.kind} stage=${view.stage} keys=${Object.keys(view).length}`)
  installJobs.delete('job-inventory-1')
  // 同一类漏 import（守卫补洞后新发现）：routes/ai.js 用了 aiJobView 却没有 import
  // → /ai-empower/status 命中真实任务时必然 500；老契约表同样只测了 jobId 为空的 404 分支。
  const { aiJobs } = await import('../lib/server/domain/ai.js')
  aiJobs.set('ai-inventory-1', { id: 'ai-inventory-1', source: 'local', status: 'running', stage: 'planning', error: null })
  const a = await call('POST', '/plugin-console/ai-empower/status', { jobId: 'ai-inventory-1' })
  check('ai-empower/status 命中真实任务 → 200（不是 500）',
    a.status === 200 && a.json?.ok === true && a.json?.jobId === 'ai-inventory-1' && a.json?.status === 'running',
    `status=${a.status} body=${JSON.stringify(a.json)?.slice(0, 140)}`)
  aiJobs.delete('ai-inventory-1')
}

// ── ②b-2 子包级进度 + AI 授权请求必须能被面板看到（2026-09-20 真装实测缺口）──────────
// 真实事故：装聚合仓库 CAPTAIN1275/dsh-ui-web（11 个子包）从点下到失败整整 19 分钟，job.stage 一直
// 停在 installing —— 面板只有一个不动的进度，用户不知道在装第几个、还剩几个；确定性通道全失败后
// 服务端挂起等授权（stage=ai-consent），前端却没有醒目提示，用户干等 10 分钟被「等待授权超时」取消。
// 这一节把「服务端必须下发什么」钉死：progress{index,total,name,done} 与
// aiConsent{pending,since,timeoutMs,lastError}，以及同意/取消两条决策路径真的送达等待中的任务。
{
  const { installJobView, AI_CONSENT_TIMEOUT_MS } = await import('../lib/server/domain/install.js')
  const { installJobs } = await import('../lib/server/state.js')

  // ① 聚合安装进行中：第 3/11 个，正在试 @captain1275/dsh-full-stats
  const running = installJobView({
    id: 'job-progress-1', repo: 'CAPTAIN1275/dsh-ui-web', packageName: null, status: 'installing', stage: 'installing',
    candidateTotal: 11, candidateIndex: 3, candidateName: '@captain1275/dsh-full-stats', candidateDone: false,
  })
  check('★ installJobView 暴露子包级 progress（第 i/n 个 + 当前候选名）',
    JSON.stringify(running.progress) === JSON.stringify({ channel: 'subpackage', phase: 'install', index: 3, total: 11, name: '@captain1275/dsh-full-stats', done: false }),
    JSON.stringify(running.progress))
  check('新增字段不破坏既有契约（jobId/kind/curlNote/suiteNote/subpackages 仍在）',
    running.jobId === 'job-progress-1' && running.kind === 'plugin' && running.curlNote === null
    && 'suiteNote' in running && 'subpackages' in running && running.status === 'installing',
    `keys=${Object.keys(running).length}`)
  // ② 还没进候选循环 → progress 为 null（不许编造"第 0/0 个"）
  check('未开始候选循环时 progress 为 null（不编造 0/0）',
    installJobView({ id: 'job-x', status: 'installing', stage: 'preparing' }).progress === null)
  // ③ 套装通道：clone / 装配两阶段共用同一个 progress 字段（channel=suite）
  const suiteView = installJobView({ id: 'job-s', status: 'installing', stage: 'detecting', suiteProgress: { phase: 'clone', index: 2, total: 4, name: 'injector', done: false } })
  check('★ 套装进度也走 progress 字段（channel=suite · clone 阶段 · 第 i/n 个子模块）',
    JSON.stringify(suiteView.progress) === JSON.stringify({ channel: 'suite', phase: 'clone', index: 2, total: 4, name: 'injector', done: false }),
    JSON.stringify(suiteView.progress))
  // ④ 装成功后必须标记完成（否则面板会一直显示"正在装第 i 个"）
  const doneView = installJobView({ id: 'job-done', status: 'done', candidateTotal: 11, candidateIndex: 5, candidateName: '@a/five', candidateDone: true })
  check('装上后 progress.done = true（index 停在真正成功的那一轮）',
    doneView.progress.done === true && doneView.progress.index === 5 && doneView.progress.total === 11,
    JSON.stringify(doneView.progress))
  // ⑤ aiConsent 形状固定（前端直接读 job.aiConsent.pending / since / timeoutMs / lastError）
  const idle = installJobView({ id: 'job-idle', status: 'installing', stage: 'installing' })
  check('aiConsent 字段形状固定（pending/since/timeoutMs/lastError 恒在）',
    JSON.stringify(Object.keys(idle.aiConsent).sort()) === JSON.stringify(['lastError', 'pending', 'since', 'timeoutMs'])
    && idle.aiConsent.pending === false && idle.aiConsent.since === null && idle.aiConsent.lastError === null,
    JSON.stringify(idle.aiConsent))
  check('未等待时 timeoutMs 仍是真实上限（10 分钟），不是 undefined',
    idle.aiConsent.timeoutMs === AI_CONSENT_TIMEOUT_MS && AI_CONSENT_TIMEOUT_MS === 600000, String(idle.aiConsent.timeoutMs))

  // ⑥ 真造一个「等授权」现场，走真路由：/install-status 必须能给出 pending + 卡在第几个子包
  const consentJobOf = (id, extra) => ({
    id, repo: 'CAPTAIN1275/dsh-ui-web', source: 'github', packageName: null, status: 'installing', stage: 'ai-consent',
    error: null, startedAt: Date.now(), finishedAt: null, entryId: null, bundle: false, ai: false, aiNote: null,
    subpackages: ['@captain1275/dsh-full-stats'], lastError: 'pnpm 通道：EPERM', update: false, kind: 'plugin',
    candidateTotal: 11, candidateIndex: 11, candidateName: '@captain1275/dsh-last', candidateDone: false,
    ...extra,
  })
  let resolver = null
  const waited = new Promise((resolve) => { resolver = resolve })
  const since = Date.now()
  installJobs.set('job-consent-1', consentJobOf('job-consent-1', {
    aiPending: { lastError: 'pnpm 通道：EPERM', resolver }, aiPendingSince: since, aiConsentTimeoutMs: 600000, aiWait: waited,
  }))
  const status = await call('POST', '/plugin-console/install-status', { jobId: 'job-consent-1' })
  const consent = status.json?.aiConsent
  check('★ 等授权期间 /install-status 下发 aiConsent.pending === true（带 since / timeoutMs / lastError）',
    status.status === 200 && consent?.pending === true && consent?.since === since
    && consent?.timeoutMs === 600000 && consent?.lastError === 'pnpm 通道：EPERM',
    `status=${status.status} aiConsent=${JSON.stringify(consent)}`)
  check('★ 等授权期间进度仍在（面板能显示卡在第 11/11 个子包）',
    status.json?.progress?.index === 11 && status.json?.progress?.total === 11 && status.json?.progress?.name === '@captain1275/dsh-last',
    JSON.stringify(status.json?.progress))
  const approve = await call('POST', '/plugin-console/ai-consent', { jobId: 'job-consent-1', approved: true })
  const decision = await waited
  check('★ 同意 → 200 且等待中的任务收到 approved:true（随后继续走 aiRepair）',
    approve.status === 200 && approve.json?.approved === true && decision.approved === true,
    `status=${approve.status} body=${JSON.stringify(approve.json)} decision=${JSON.stringify(decision)}`)
  check('同意后任务离开等待态（aiWait/aiPending 清空，视图 pending=false）',
    installJobs.get('job-consent-1').aiWait === null && installJobs.get('job-consent-1').aiPending === null
    && installJobView(installJobs.get('job-consent-1')).aiConsent.pending === false)

  // ⑦ 取消路径：approved:false → 任务收到"不授权"，runInstallJob 据此走失败清场分支
  let resolver2 = null
  const waited2 = new Promise((resolve) => { resolver2 = resolve })
  installJobs.set('job-consent-2', consentJobOf('job-consent-2', {
    aiPending: { lastError: 'curl 通道：404', resolver: resolver2 }, aiPendingSince: Date.now(), aiConsentTimeoutMs: 600000, aiWait: waited2,
  }))
  const deny = await call('POST', '/plugin-console/ai-consent', { jobId: 'job-consent-2', approved: false })
  const decision2 = await waited2
  check('★ 取消 → 200 且任务收到 approved:false（runInstallJob 走失败清场分支）',
    deny.status === 200 && decision2.approved === false, `status=${deny.status} decision=${JSON.stringify(decision2)}`)
  // 不在等待态的任务不许被"授权"（否则一个 jobId 就能触发模型调用）
  installJobs.set('job-consent-3', consentJobOf('job-consent-3', { stage: 'installing' }))
  const bogus = await call('POST', '/plugin-console/ai-consent', { jobId: 'job-consent-3', approved: true })
  check('非等待态的任务 → 400 拒绝授权（不能凭 jobId 触发模型调用）',
    bogus.status === 400 && String(bogus.json?.error).includes('AI 授权'), `status=${bogus.status} error=${bogus.json?.error}`)

  // ⑧ 失败文案（纯函数）：超时 / 取消两条路径的措辞 + 清场汇报都必须如实
  const { aiConsentFailureText } = await import('../lib/server/domain/install-job.js')
  const timeoutText = aiConsentFailureText({ approved: false, timeout: true }, { cleaned: ['@a/one'], failed: [] })
  check('★ 超时失败文案：说清 10 分钟超时 + 清掉了什么',
    timeoutText.includes('等待授权超时（10 分钟）') && timeoutText.includes('已清理本次落盘残留：@a/one'),
    timeoutText)
  const cancelText = aiConsentFailureText({ approved: false }, { cleaned: [], failed: [{ name: '@a/two', path: 'D:/p/node_modules/@a/two', error: 'EPERM' }] })
  check('★ 取消失败文案：说清用户取消 + 没清掉的那项与路径',
    cancelText.startsWith('用户取消本地 AI 兜底') && cancelText.includes('有 1 项没能清理') && cancelText.includes('D:/p/node_modules/@a/two'),
    cancelText)
  for (const id of ['job-consent-1', 'job-consent-2', 'job-consent-3']) installJobs.delete(id)
}

// ── ②c /github-open-login：弱断言（只钉 200 与字段名，不追究完整字段集合）─────────────
// 这条路由是"唤起 dsh-github-login 的登录窗口"，成败取决于外挂插件在不在、有没有 exe、
// 平台支不支持，所以响应有两种形状：成功 {ok,started,status} / 不可用 {ok,started,reason}。
// 弱断言 = 状态码 200（**绝不允许 500**：不可用不是错误）+ ok 恒为 true + started 是布尔
//          + started:false 时必须给非空 reason（前端要把这句话念给用户）。
// 为了既跑真实链路又不弹窗：把 webServer.port 临时指到一个刚探测出的空端口 —— Host 校验与
// 目标地址同源（都用 webPort(ctx)），所以这次调用必然连接被拒（毫秒级），落进降级分支。
{
  const { createServer } = await import('node:net')
  const emptyPort = await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port
      probe.close(() => resolve(p))
    })
  })
  const r = fakeRes()
  ctx.webServer.port = emptyPort
  try {
    const q = fakeReq('POST', '/plugin-console/github-open-login', {})
    q.headers = { host: `127.0.0.1:${emptyPort}` }
    await route.handler(q, r)
  } finally {
    delete ctx.webServer.port
  }
  const body = r.body === null ? null : JSON.parse(r.body)
  check('响应契约 POST /plugin-console/github-open-login → 200（不可用也不能 500）',
    r.status === 200, `status=${r.status} body=${String(r.body)?.slice(0, 160)}`)
  check('响应契约 github-open-login：有 ok 与 started 字段',
    body !== null && body.ok === true && typeof body.started === 'boolean', `body=${JSON.stringify(body)?.slice(0, 160)}`)
  check('响应契约 github-open-login：started:false 时 reason 是非空字符串',
    body !== null && (body.started === true || (typeof body.reason === 'string' && body.reason !== '')),
    `started=${body?.started} reason=${body?.reason}`)
}

// ── ②d /uninstall 接受 jobId：撤销「已安装但尚未生效」的安装 ─────────────────────
// 2026-09-20 真装真卸演练实测的产品缺口：装完一个 bundle 型插件后 /install 返回 entryId: null、
// /state 里新增 loader 条目 = 0（要重启才被加载），而旧 /uninstall 只按**运行中** loader 条目
// 查找 → 恒 404「没有名为 X 的插件条目」，于是刚装错的插件在重启前无法从面板卸载。
// 这里钉死三件事：① /uninstall 接受 { jobId } 这种入参形态；② /state 输出含 pendingRestart；
// ③ 撤销真的把补丁行 / bundles 清单清干净，并回报 verified（回读核实，不是"删完就报成功"）。
{
  const { installJobs } = await import('../lib/server/state.js')
  const manifestPath = join(profileDir, 'package.json')
  const readPatchText = () => readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
  const readBundles = () => JSON.parse(readFileSync(manifestPath, 'utf8')).dsh.profile.bundles
  const PKG = '@fake/pending-widget'
  const JOB = 'job-pending-1'
  // 夹具 = 一次「已安装但尚未生效」的 bundle 型安装留下的现场：
  //   patch 里的 insert 行（appendInsert 写的）+ bundles 清单（addBundleToManifest 写的）+ 任务记录
  writeFileSync(manifestPath, JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', PKG, '@linxin666/dsh-web-all'] } },
  }, null, 2) + '\n', 'utf8')
  writeFileSync(join(profileDir, 'cordis.patch.yml'),
    `${readPatchText()}- insert:\n    - id: pending-widget\n      name: '${PKG}'\n- id: pending-widget\n  disabled: true\n`, 'utf8')
  installJobs.set(JOB, {
    id: JOB, repo: 'fake/pending-widget', source: 'github', packageName: PKG, status: 'done',
    stage: 'configuring', error: null, startedAt: 1, finishedAt: 2, entryId: null, bundle: true,
    ai: false, aiNote: null, subpackages: null, lastError: null, update: false, kind: 'plugin',
  })

  // ① /state 必须能表达「装了但还没生效」（前端据此显示徽标 + 删除按钮）
  const stateBefore = await call('GET', '/plugin-console/state')
  const pending = stateBefore.json?.pendingRestart
  const row = Array.isArray(pending) ? pending.find((j) => j.jobId === JOB) : null
  check('★ /state 输出 pendingRestart（已安装·重启后生效）',
    Array.isArray(pending) && row !== null && row.packageName === PKG && row.bundle === true,
    `pendingRestart=${JSON.stringify(pending)}`)
  check('pendingRestart 行字段固定（jobId/repo/packageName/bundle/finishedAt）',
    row !== null && JSON.stringify(Object.keys(row).sort()) === JSON.stringify(['bundle', 'finishedAt', 'jobId', 'packageName', 'repo']),
    row === null ? '（没有该任务）' : Object.keys(row).join(','))

  // ② /uninstall 接受 { jobId }（旧代码在这里返回 400「entryId 无效」）
  const undo = await call('POST', '/plugin-console/uninstall', { jobId: JOB })
  check('★ /uninstall 接受 { jobId } 入参形态（不再要求 entryId）',
    undo.status === 200 && undo.json?.ok === true && undo.json?.removed === 'pending-install',
    `status=${undo.status} body=${JSON.stringify(undo.json)?.slice(0, 200)}`)
  check('撤销响应：packageName / restart:false / verified 三项齐全',
    undo.json?.packageName === PKG && undo.json?.restart === false
    && undo.json?.verified?.patchClean === true && undo.json?.verified?.bundlesClean === true && undo.json?.verified?.packageGone === true
    && undo.json?.warn === null && undo.json?.uninstallError === null,
    `verified=${JSON.stringify(undo.json?.verified)} warn=${undo.json?.warn} uninstallError=${undo.json?.uninstallError}`)
  check('撤销后补丁里不再出现该包（insert 行与 disabled 覆盖块都清掉）',
    !readPatchText().includes(PKG) && !/- id: pending-widget/u.test(readPatchText()), JSON.stringify(readPatchText()))
  check('撤销后 bundles 只少这一项（保留顺序与其余项）',
    JSON.stringify(readBundles()) === JSON.stringify(['@deepseek-ai/dsh-base', '@linxin666/dsh-web-all']), JSON.stringify(readBundles()))
  check('撤销的行 id 如实回报（rowIds）',
    Array.isArray(undo.json?.rowIds) && undo.json.rowIds.includes('pending-widget'), JSON.stringify(undo.json?.rowIds))

  // ③ 撤销过的任务不再出现在 pendingRestart 里（否则前端会一直显示一个删不掉的幽灵行）
  const stateAfter = await call('GET', '/plugin-console/state')
  check('撤销后 /state 的 pendingRestart 不再含该任务',
    Array.isArray(stateAfter.json?.pendingRestart) && !stateAfter.json.pendingRestart.some((j) => j.jobId === JOB),
    JSON.stringify(stateAfter.json?.pendingRestart))

  // ④ 入参校验与安全护栏（与 entry 分支同规格：@deepseek-ai/* · 受保护模块 · 控制台自身）
  const bad = async (label, body, wantStatus, wantWord) => {
    const r = await call('POST', '/plugin-console/uninstall', body)
    check(label, r.status === wantStatus && String(r.json?.error ?? '').includes(wantWord),
      `status=${r.status} error=${r.json?.error}`)
  }
  await bad('无 entryId 也无 jobId → 400', {}, 400, 'entryId 无效')
  await bad('jobId 不存在 → 404（说明任务不存在，不是 entryId 无效）', { jobId: 'job-nope' }, 404, '没有这个安装任务')
  await bad('entryId 找不到 + jobId 不存在 → 404 也是"没有这个安装任务"',
    { entryId: 'include:nope', jobId: 'job-nope' }, 404, '没有这个安装任务')
  installJobs.set('job-installing-1', { id: 'job-installing-1', repo: 'a/b', packageName: '@fake/installing', status: 'installing', stage: 'installing', entryId: null, bundle: false })
  await bad('任务未完成（installing）→ 400 如实说明还在进行中', { jobId: 'job-installing-1' }, 400, '还在进行中')
  installJobs.set('job-noname-1', { id: 'job-noname-1', repo: 'a/b', packageName: '', status: 'done', entryId: null, bundle: false })
  await bad('任务没有包名 → 400 如实说明', { jobId: 'job-noname-1' }, 400, '没有记录包名')
  installJobs.set('job-official-1', { id: 'job-official-1', repo: 'deepseek-ai/x', packageName: '@deepseek-ai/dsh-web-app', status: 'done', entryId: null, bundle: true })
  await bad('@deepseek-ai/* 官方包 → 403（与 entry 分支同护栏）', { jobId: 'job-official-1' }, 403, '框架官方包')
  installJobs.set('job-self-1', { id: 'job-self-1', repo: 'noob-stupid/x', packageName: '@noob-stupid/dsh-plugin-console', status: 'done', entryId: 'plugin-console', bundle: true })
  await bad('控制台自身 → 400 禁止自删', { jobId: 'job-self-1' }, 400, '控制台自身')
  installJobs.set('job-live-1', { id: 'job-live-1', repo: 'fake/demo', packageName: '@fake/demo', status: 'done', entryId: null, bundle: false })
  await bad('包已在运行中的 loader 里（重启已完成）→ 400 指路按条目删除', { jobId: 'job-live-1' }, 400, '已经在运行中的插件列表里')
  // entryId 优先：两者都传且 entry 存在时仍走原来的 entry 分支（demo 行不是用户安装的行 → 400 不可删除）
  await bad('同时传 entryId 与 jobId 时 entry 分支优先（行为不变）',
    { entryId: 'include:demo', jobId: 'job-live-1' }, 400, '不是用户安装的额外插件')
  for (const id of ['job-installing-1', 'job-noname-1', 'job-official-1', 'job-self-1', 'job-live-1']) installJobs.delete(id)

  // ⑤ 反向保险：普通「条目删除」成功后，同包名的 pendingRestart 记录必须一并作废 ——
  //    否则重启后从列表里删掉的插件会在面板上留一行删不掉的「已安装·重启后生效」幽灵行。
  const baseEntries = ctx.loader.entries
  ctx.loader.entries = () => [...baseEntries(), { id: 'include:ghost', options: { name: '@fake/ghost-pkg' }, disabled: false, fiber: { state: 2 } }]
  writeFileSync(join(profileDir, 'cordis.patch.yml'), `${readPatchText()}- insert:\n    - id: ghost\n      name: '@fake/ghost-pkg'\n`, 'utf8')
  installJobs.set('job-ghost-1', {
    id: 'job-ghost-1', repo: 'fake/ghost-pkg', source: 'github', packageName: '@fake/ghost-pkg', status: 'done',
    stage: 'configuring', error: null, startedAt: 1, finishedAt: 2, entryId: 'ghost', bundle: false,
    ai: false, aiNote: null, subpackages: null, lastError: null, update: false, kind: 'plugin',
  })
  const ghost = await call('POST', '/plugin-console/uninstall', { entryId: 'include:ghost' })
  check('entry 分支：删掉用户安装的行并成功卸载包（uninstallError 为空）',
    ghost.status === 200 && ghost.json?.removed === 'entry' && ghost.json?.uninstallError === null,
    `status=${ghost.status} body=${JSON.stringify(ghost.json)}`)
  ctx.loader.entries = baseEntries // 补丁行已删 → HMR 重组后 loader 里不再有这个条目
  const stateGhost = await call('GET', '/plugin-console/state')
  check('★ entry 分支删除后 pendingRestart 不作假（同包名任务一并作废，不留幽灵行）',
    Array.isArray(stateGhost.json?.pendingRestart) && !stateGhost.json.pendingRestart.some((j) => j.jobId === 'job-ghost-1'),
    JSON.stringify(stateGhost.json?.pendingRestart))
  installJobs.delete('job-ghost-1')
}

// ── ②e 撤销的"如实汇报"：删不干净必须带 warn + 路径（不许 500、不许假成功）─────────
// 本机实测过 rmSync/pnpm 在受限环境里会静默落空甚至抛错（见 infra/fsx.js removeDirVerified 注释），
// 所以 domain/revoke.js 的三个子项都回读核实。这里用注入的 pnpmRemove 桩钉死两条路径。
{
  const { revokePendingInstall } = await import('../lib/server/domain/revoke.js')
  const manifestPath = join(profileDir, 'package.json')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const STUCK = '@fake/stuck-pkg'
  const stuckDir = join(profileDir, 'node_modules', '@fake', 'stuck-pkg')
  mkdirSync(stuckDir, { recursive: true })
  writeFileSync(join(stuckDir, 'package.json'), JSON.stringify({ name: STUCK, version: '1.0.0' }), 'utf8')
  writeFileSync(manifestPath, JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', STUCK] } },
  }, null, 2) + '\n', 'utf8')
  writeFileSync(patchPath, `${readFileSync(patchPath, 'utf8')}- insert:\n    - id: stuck-pkg\n      name: '${STUCK}'\n`, 'utf8')
  const job = { id: 'job-stuck-1', packageName: STUCK, entryId: 'stuck-pkg', bundle: true, status: 'done' }

  const failed = await revokePendingInstall(job, { profileDir, patchPath, pnpmRemove: async () => { throw new Error('模拟 pnpm 失败：EPERM') } })
  const warnText = String(failed.warn).replace(/\\/gu, '/') // Windows 路径分隔符归一后再断言
  check('★ 包删不掉时：ok 仍可判成功，但 verified.packageGone=false + warn 说清哪项没干净与目录路径',
    failed.verified.patchClean === true && failed.verified.bundlesClean === true && failed.verified.packageGone === false
    && warnText.includes('包目录仍在') && warnText.includes(STUCK) && warnText.includes(String(stuckDir).replace(/\\/gu, '/'))
    && String(failed.uninstallError).includes('模拟 pnpm 失败'),
    `verified=${JSON.stringify(failed.verified)} warn=${failed.warn}`)

  const okUndo = await revokePendingInstall(job, {
    profileDir, patchPath,
    pnpmRemove: async (dir, name) => rmSync(join(dir, 'node_modules', ...name.split('/')), { recursive: true, force: true }),
  })
  check('★ 包真删掉后：verified 三项为 true 且不带 warn',
    okUndo.verified.patchClean === true && okUndo.verified.bundlesClean === true && okUndo.verified.packageGone === true && okUndo.warn === null,
    `verified=${JSON.stringify(okUndo.verified)} warn=${okUndo.warn}`)
  // 反面对照：目录已不在、但 manifest 还引用它（pnpm add 会写 dependencies）→ 仍需 pnpm remove 清依赖
  let calls = 0
  writeFileSync(manifestPath, JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: { [STUCK]: '^1.0.0' } }, null, 2) + '\n', 'utf8')
  const depOnly = await revokePendingInstall({ id: 'job-dep-1', packageName: STUCK, entryId: null, bundle: false },
    { profileDir, patchPath, pnpmRemove: async () => { calls += 1 } })
  check('目录已不在但 manifest 仍引用 → 仍调 pnpm remove（否则 package.json 留下幽灵依赖）',
    calls === 1 && depOnly.verified.packageGone === true, `calls=${calls} verified=${JSON.stringify(depOnly.verified)}`)

  // bundle 型的行由**包内** cordis.patch.yml 提供，profile 补丁里没有 insert 块、只可能有
  // `- id: X` + disabled 覆盖块 —— 归属只能从包内补丁反查（bundleOwnRowIds），
  // 且必须只清自己家的行（聚合包补丁常引用别人家的包）。
  const BUNDLE = '@fake/bundle-pkg'
  const bundleDir = join(profileDir, 'node_modules', '@fake', 'bundle-pkg')
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({ name: BUNDLE, version: '1.0.0' }), 'utf8')
  writeFileSync(join(bundleDir, 'cordis.patch.yml'),
    `- insert:\n    - id: whale\n      name: '${BUNDLE}'\n    - id: other\n      name: '@linxin666/dsh-web-all'\n`, 'utf8')
  writeFileSync(patchPath, `${readFileSync(patchPath, 'utf8')}- id: whale\n  disabled: true\n- id: other\n  disabled: true\n`, 'utf8')
  const bundleUndo = await revokePendingInstall(
    { id: 'job-bundle-1', packageName: BUNDLE, entryId: null, bundle: true },
    {
      profileDir, patchPath,
      pnpmRemove: async (dir, name) => rmSync(join(dir, 'node_modules', ...name.split('/')), { recursive: true, force: true }),
    },
  )
  const patchAfterBundle = readFileSync(patchPath, 'utf8')
  check('★ bundle 型：清掉自带 patch 归属行的 disabled 覆盖块，且不碰别人家的行',
    bundleUndo.verified.patchClean === true && bundleUndo.verified.packageGone === true
    && !/- id: whale/u.test(patchAfterBundle) && /- id: other\r?\n {2}disabled: true/u.test(patchAfterBundle),
    JSON.stringify(patchAfterBundle))
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

// ── 自更新必须写进 lockfile（2026-09-20 用户实测缺陷）─────────────────────────────
// 现象：一键更新只把文件铺进 node_modules、不写 pnpm-lock.yaml，之后任何 pnpm 操作都会把它还原成
// lock 里钉住的旧版本（用户侧看到"升级成功、重启后还是旧版"）。下面把"包管理器优先 + 回读核实 +
// 兜底必带警告"三条口径钉死。
{
  const { isRegistryRange, lockVersion, selfUpdateToLatest } = await import('../lib/server/domain/selfupdate.js')
  const PKG = '@noob-stupid/dsh-plugin-console'
  const fix = join(ROOT, '.testdir', 'selfupdate-fixture')
  const nmPkg = join(fix, 'node_modules', '@noob-stupid', 'dsh-plugin-console')
  mkdirSync(nmPkg, { recursive: true })
  writeFileSync(join(fix, 'package.json'), JSON.stringify({ dependencies: { [PKG]: '^0.3.47' } }, null, 2), 'utf8')
  writeFileSync(join(nmPkg, 'package.json'), JSON.stringify({ name: PKG, version: '0.3.47' }), 'utf8')
  const lockText = (v) => [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    `      '${PKG}':`,
    '        specifier: ^0.3.47',
    `        version: ${v}`,
    "      '@noob-stupid/dsh-plugin-console-extra':",
    '        specifier: ^9.9.9',
    '        version: 9.9.9',
    '',
    'packages:',
    '',
    `  ${PKG}@${v}:`,
    '    resolution: {integrity: sha512-x}',
    '',
    '  @noob-stupid/dsh-plugin-console-extra@9.9.9:',
    '    resolution: {integrity: sha512-y}',
    '',
  ].join('\n')
  writeFileSync(join(fix, 'pnpm-lock.yaml'), lockText('0.3.47'), 'utf8')

  check('★ spec 判定：registry 范围才允许 pnpm update（git/file 来源不算）',
    isRegistryRange('^0.3.47') && isRegistryRange('~1.2.3') && isRegistryRange('0.3.47') && isRegistryRange('>=1')
    && !isRegistryRange('git+https://github.com/Noob-stupid/dsh-plugin-hub.git') && !isRegistryRange('file:../x') && !isRegistryRange(null))
  check('★ lock 版本解析：从 importers 段读到被钉住的版本，且不被同前缀包误导',
    lockVersion(fix, PKG) === '0.3.47', String(lockVersion(fix, PKG)))

  const bump = (v) => {
    writeFileSync(join(fix, 'pnpm-lock.yaml'), lockText(v), 'utf8')
    writeFileSync(join(nmPkg, 'package.json'), JSON.stringify({ name: PKG, version: v }), 'utf8')
  }
  const okResult = await selfUpdateToLatest({
    profileDir: fix, latest: '0.3.55', registries: ['https://registry.example'],
    curlManualInstall: async () => { throw new Error('不该走到手铺兜底') },
    runPnpm: async (args, opts) => { check('pnpm update 被调用且 cwd 指向 profile', args[0] === 'update' && opts.execOpts.cwd === fix); bump('0.3.55') },
    pnpmAdd: async () => { throw new Error('不该走到 pnpm add') },
  })
  check('★ 走 pnpm update 后回读核实通过（lock 与安装版本都是新版）',
    okResult.method === 'pnpm-update' && okResult.lockUpdated === true && okResult.lockVersion === '0.3.55' && okResult.lockNote === null,
    JSON.stringify(okResult))

  writeFileSync(join(fix, 'pnpm-lock.yaml'), lockText('0.3.47'), 'utf8')
  writeFileSync(join(nmPkg, 'package.json'), JSON.stringify({ name: PKG, version: '0.3.47' }), 'utf8')
  const addResult = await selfUpdateToLatest({
    profileDir: fix, latest: '0.3.55', registries: ['https://registry.example'],
    curlManualInstall: async () => { throw new Error('不该走到手铺兜底') },
    runPnpm: async () => {},
    pnpmAdd: async (dir, spec) => { check('pnpm add 收到 <包>@<版本>', spec === `${PKG}@0.3.55`, spec); bump('0.3.55') },
  })
  check('★ update 无效时改用 pnpm add，同样回读核实通过',
    addResult.method === 'pnpm-update+pnpm-add' && addResult.lockUpdated === true, JSON.stringify(addResult))

  writeFileSync(join(fix, 'pnpm-lock.yaml'), lockText('0.3.47'), 'utf8')
  writeFileSync(join(nmPkg, 'package.json'), JSON.stringify({ name: PKG, version: '0.3.47' }), 'utf8')
  const fallback = await selfUpdateToLatest({
    profileDir: fix, latest: '0.3.55', registries: ['https://registry.example'],
    curlManualInstall: async () => { writeFileSync(join(nmPkg, 'package.json'), JSON.stringify({ name: PKG, version: '0.3.55' }), 'utf8'); return { version: '0.3.55' } },
    runPnpm: async () => { throw new Error('模拟 pnpm update 失败') },
    pnpmAdd: async () => { throw new Error('模拟 pnpm add 失败') },
  })
  check('★ 兜底手铺文件时如实报 lockUpdated=false + 说明会被 pnpm 还原',
    fallback.method.includes('manual-copy') && fallback.lockUpdated === false
    && typeof fallback.lockNote === 'string' && fallback.lockNote.includes('未写入 pnpm-lock.yaml') && fallback.lockNote.includes('0.3.47'),
    String(fallback.lockNote))
  check('兜底响应给出可复制的 dsh 命令', fallback.command.includes('dsh plugin --profile') && fallback.command.includes(`${PKG}@0.3.55`), fallback.command)
}

// ── 多包 lock 对账（2026-09-21：非 pnpm 通道装的包 + 套装装配 + 聚合子包都要写进 lock）──────────
{
  const { reconcileLockfile } = await import('../lib/server/domain/selfupdate.js')
  const fix = join(ROOT, '.testdir', 'reconcile-multi-fixture')
  const pkgs = ['@drill/pkg-a', '@drill/pkg-b']
  for (const p of pkgs) mkdirSync(join(fix, 'node_modules', ...p.split('/')), { recursive: true })
  const writeLock = (map) => writeFileSync(join(fix, 'pnpm-lock.yaml'), ['lockfileVersion: \'9.0\'', '', 'importers:', '', '  .:', '    dependencies:',
    ...pkgs.map((p) => `      '${p}':\n        specifier: ^1.0.0\n        version: ${map[p] ?? '1.0.0'}`), '', 'packages:', '',
    ...pkgs.map((p) => `  ${p}@${map[p] ?? '1.0.0'}:\n    resolution: {integrity: sha512-x}`), ''].join('\n'), 'utf8')
  const setVer = (p, v) => writeFileSync(join(fix, 'node_modules', ...p.split('/'), 'package.json'), JSON.stringify({ name: p, version: v }), 'utf8')

  // 场景一：两个包都漂移（装了 2.0.0 / lock 记 1.0.0）→ 一次 pnpm add 带两个 spec 对齐
  // （fetchJson 桩：这两个包在 registry 上"可解析到 2.0.0"，即正常 registry 来源包）
  const resolvableAt2 = async () => ({ versions: { '2.0.0': {} }, 'dist-tags': { latest: '2.0.0' } })
  writeLock({})
  setVer(pkgs[0], '2.0.0')
  setVer(pkgs[1], '2.0.0')
  let calls = []
  const r1 = await reconcileLockfile({
    profileDir: fix,
    packages: pkgs.map((name) => ({ name })),
    registries: ['https://registry.example'],
    fetchJson: resolvableAt2,
    pnpmAdd: async (dir, spec) => { calls.push(spec); writeLock({ [pkgs[0]]: '2.0.0', [pkgs[1]]: '2.0.0' }) },
  })
  check('★ 多包对账：一次 pnpm add 传数组 spec（不是逐包串行）',
    calls.length === 1 && Array.isArray(calls[0]) && calls[0].length === 2 && calls[0][0] === '@drill/pkg-a@2.0.0', JSON.stringify(calls))
  check('★ 多包对账：对齐后 lockUpdated=true 且逐包 aligned=true',
    r1.lockUpdated === true && r1.lockNote === null && r1.packages.every((p) => p.aligned === true), JSON.stringify(r1.packages))

  // 场景二：一个包始终对不上 → lockNote 逐包列出 + 可复制命令
  writeLock({ [pkgs[0]]: '2.0.0', [pkgs[1]]: '1.0.0' })
  setVer(pkgs[0], '2.0.0')
  setVer(pkgs[1], '2.0.0')
  const r2 = await reconcileLockfile({
    profileDir: fix,
    packages: pkgs.map((name) => ({ name })),
    registries: ['https://registry.example'],
    fetchJson: resolvableAt2,
    pnpmAdd: async () => { throw new Error('模拟 pnpm 失败') },
  })
  check('★ 对不上时如实报 lockUpdated=false 并逐包说清（含可复制命令）',
    r2.lockUpdated === false && typeof r2.lockNote === 'string' && r2.lockNote.includes('@drill/pkg-b') && r2.lockNote.includes('dsh plugin --profile'), String(r2.lockNote).slice(0, 120))
  check('对齐失败的包在 packages 里 aligned=false（不谎报）', r2.packages.some((p) => p.aligned === false), JSON.stringify(r2.packages))
}

// ── 缺陷②：依赖来源写回 —— release/URL 来源**绝不能**写成不可解析的裸版本号 ──────────────────
// 背景（用户 issue 草案「缺陷②」实测）：release 通道装的包只存在于 GitHub release，npm 上查无此包；
// 旧 reconcileLockfile 一律 `pnpm add <name>@<installed>`，pnpm 见"已装版本满足新 spec"就静默把
// package.json 改写成裸版本号（EXIT=0）→ lock 一重建就 ERR_PNPM_FETCH_404，而报错指向 npm registry。
// 修法：写回前先探 registry（不可解析 → 物化到 <DSH_HOME>/plugin-src + 写 link:），并保持其它来源不变。
{
  const { reconcileLockfile, lockVersion } = await import('../lib/server/domain/selfupdate.js')
  const fix = join(ROOT, '.testdir', 'dep-source-fixture')
  const releaseOnly = '@dsh-external/dsh-super-injector'
  const notFound = async () => { const e = new Error('Response code 404 (Not Found)'); e.statusCode = 404; throw e }
  const resolvable = (version) => async () => ({ versions: { [version]: {} }, 'dist-tags': { latest: version } })
  const putInstalled = (name, version) => {
    mkdirSync(join(fix, 'node_modules', ...name.split('/')), { recursive: true })
    writeFileSync(join(fix, 'node_modules', ...name.split('/'), 'package.json'),
      JSON.stringify({ name, version, main: 'index.js' }), 'utf8')
    writeFileSync(join(fix, 'node_modules', ...name.split('/'), 'index.js'), 'export const ok = true\n', 'utf8')
  }
  const setManifest = (deps) => writeFileSync(join(fix, 'package.json'),
    JSON.stringify({ name: 'dep-source-fix', private: true, dependencies: deps }, null, 2), 'utf8')
  const specNow = (name) => {
    try { return JSON.parse(readFileSync(join(fix, 'package.json'), 'utf8')).dependencies?.[name] ?? null } catch { return null }
  }
  const writeLockText = (text) => writeFileSync(join(fix, 'pnpm-lock.yaml'), text, 'utf8')
  const importerLock = (name, specifier, version) => [
    "lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies:',
    `      '${name}':`, `        specifier: ${specifier}`, `        version: ${version}`,
    '', 'packages:', '',
  ].join('\n')
  const capture = () => { const acc = []; return { acc, add: async (dir, spec) => { acc.push(...(Array.isArray(spec) ? spec : [spec])) } } }
  /** 忠实模拟 `pnpm add <spec>` 的副作用：把 pnpm 收到的 spec 原样写回 manifest 的 dependencies。
   *  这正是缺陷②的机制 —— 旧代码递给 pnpm 的是 `<name>@<版本>`，pnpm 就把它写成裸版本号。 */
  const captureAndApply = (name) => {
    const acc = []
    return {
      acc,
      add: async (dir, spec) => {
        const list = Array.isArray(spec) ? spec : [spec]
        acc.push(...list)
        for (const s of list) {
          const manifest = JSON.parse(readFileSync(join(fix, 'package.json'), 'utf8'))
          const deps = manifest.dependencies ?? {}
          deps[name] = s.startsWith(`${name}@`) ? s.slice(name.length + 1) : s
          writeFileSync(join(fix, 'package.json'), JSON.stringify({ ...manifest, dependencies: deps }, null, 2), 'utf8')
        }
      },
    }
  }

  // ① registry 404 + manifest 无条目（release 通道首次安装的写回路径）
  rmSync(fix, { recursive: true, force: true })
  mkdirSync(fix, { recursive: true })
  setManifest({})
  putInstalled(releaseOnly, '0.3.3')
  const c1 = captureAndApply(releaseOnly)
  const r1 = await reconcileLockfile({
    profileDir: fix, packages: [{ name: releaseOnly }], registries: ['https://registry.example'],
    home: fix, pnpmAdd: c1.add, fetchJson: notFound,
  })
  check('★ 缺陷②：registry 404（release 专属包）时写回 link:，绝不写裸版本号',
    c1.acc.length === 1 && c1.acc[0].startsWith('link:') && c1.acc[0].includes(`plugin-src/${releaseOnly}`), JSON.stringify(c1.acc))
  check('★ 缺陷②：物化到 <DSH_HOME>/plugin-src/<包名> 且是完整包',
    existsSync(join(fix, 'plugin-src', ...releaseOnly.split('/'), 'package.json')), '')
  check('★ 缺陷②：安装结果带用户可见 depNote（说清只存在于 GitHub release）',
    typeof r1.depNote === 'string' && r1.depNote.includes('link:') && r1.depNote.includes('registry'), String(r1.depNote))

  // ② registry 可解析 → 仍写版本号（不误伤正常 registry 来源包）
  // 先把现场复位成"正常的 registry 来源包"：manifest 是版本号、lock 解析到旧版本
  writeLockText(importerLock(releaseOnly, '0.3.3', '0.3.2'))
  setManifest({ [releaseOnly]: '0.3.3' })
  const c2 = capture()
  await reconcileLockfile({
    profileDir: fix, packages: [{ name: releaseOnly }], registries: ['https://registry.example'],
    home: fix, pnpmAdd: c2.add, fetchJson: resolvable('0.3.3'),
  })
  check('★ 缺陷②：registry 可解析时仍写 <name>@<版本>（正常包不受影响）',
    c2.acc.length === 1 && c2.acc[0] === `${releaseOnly}@0.3.3`, JSON.stringify(c2.acc))

  // ③ 已被旧代码污染（manifest 裸版本号 + lock 解析到 URL）→ 自愈成 link:
  writeLockText(importerLock(releaseOnly, '0.3.3', 'https://example.com/pkg-0.3.3.tgz'))
  setManifest({ [releaseOnly]: '0.3.3' })
  const c3 = captureAndApply(releaseOnly)
  const r3 = await reconcileLockfile({
    profileDir: fix, packages: [{ name: releaseOnly }], registries: ['https://registry.example'],
    home: fix, pnpmAdd: c3.add, fetchJson: notFound,
  })
  check('★ 缺陷②：已污染状态（裸版本号 spec + URL 解析）被自愈为 link:',
    c3.acc.length === 1 && c3.acc[0].startsWith('link:'), JSON.stringify(c3.acc))
  check('★ 缺陷②：lock 里能读到 URL 形态的解析（旧实现读到 `https` 截断值）',
    lockVersion(fix, releaseOnly) === 'https://example.com/pkg-0.3.3.tgz', String(lockVersion(fix, releaseOnly)))
  check('★ 缺陷②：自愈后的 specifier 不是「不可解析的裸版本号」',
    !/^\d+\.\d+\.\d+/u.test(String(specNow(releaseOnly))), String(specNow(releaseOnly)))

  // ④ manifest 是 tarball URL → 归整成 link:（pnpm 10 对 direct-URL 重写 lock 会丢 integrity）
  writeLockText(importerLock(releaseOnly, 'https://example.com/pkg-0.3.3.tgz', 'https://example.com/pkg-0.3.3.tgz'))
  setManifest({ [releaseOnly]: 'https://example.com/pkg-0.3.3.tgz' })
  const c4 = captureAndApply(releaseOnly)
  await reconcileLockfile({
    profileDir: fix, packages: [{ name: releaseOnly }], registries: ['https://registry.example'],
    home: fix, pnpmAdd: c4.add, fetchJson: notFound,
  })
  check('★ 缺陷②：tarball URL 来源被归整成 link:（不再留下 URL 死循环形态）',
    c4.acc.length === 1 && c4.acc[0].startsWith('link:'), JSON.stringify(c4.acc))

  // ⑤ git 来源 → 原样重放，绝不降级成版本号
  const gitSpec = 'git+https://github.com/Noob-stupid/dsh-plugin-hub.git'
  putInstalled('dsh-git-probe', '0.0.1')
  writeLockText(importerLock('dsh-git-probe', gitSpec, 'github.com/Noob-stupid/dsh-plugin-hub/abc123'))
  setManifest({ 'dsh-git-probe': gitSpec })
  const c5 = captureAndApply('dsh-git-probe')
  await reconcileLockfile({
    profileDir: fix, packages: [{ name: 'dsh-git-probe' }], registries: ['https://registry.example'],
    home: fix, pnpmAdd: c5.add, fetchJson: notFound,
  })
  check('★ 缺陷②：git 来源保持 git+ 规格（来源不被改写）',
    c5.acc.length === 1 && c5.acc[0] === gitSpec, JSON.stringify(c5.acc))

  // ⑤b dist-tag 规格（latest）：registry 来源，但必须**保留标签**，
  //     绝不能原样丢给 pnpm（`pnpm add latest` 会去装一个名叫 latest 的包）
  putInstalled('dsh-tag-probe', '1.4.0')
  writeLockText(importerLock('dsh-tag-probe', 'latest', '1.3.0'))
  setManifest({ 'dsh-tag-probe': 'latest' })
  const c5b = captureAndApply('dsh-tag-probe')
  await reconcileLockfile({
    profileDir: fix, packages: [{ name: 'dsh-tag-probe' }], registries: ['https://registry.example'],
    home: fix, pnpmAdd: c5b.add, fetchJson: resolvable('1.4.0'),
  })
  check('★ 缺陷②：dist-tag 规格保留标签（写 dsh-tag-probe@latest，不是裸 latest、也不是钉成版本号）',
    c5b.acc.length === 1 && c5b.acc[0] === 'dsh-tag-probe@latest', JSON.stringify(c5b.acc))
  const c5c = captureAndApply('dsh-tag-probe')
  setManifest({ 'dsh-tag-probe': 'latest' })
  await reconcileLockfile({
    profileDir: fix, packages: [{ name: 'dsh-tag-probe' }], registries: ['https://registry.example'],
    home: fix, pnpmAdd: c5c.add, fetchJson: notFound,
  })
  check('★ 缺陷②：dist-tag 但 registry 查无此包 → 同样走 link:（不写 latest 也不写版本号）',
    c5c.acc.length === 1 && c5c.acc[0].startsWith('link:'), JSON.stringify(c5c.acc))

  // ⑥ lock 里已是 link 解析、且链接**真的**还在 → 视为已对齐（不白跑 pnpm add、不假报未写入 lock）
  const linkTarget = join(fix, 'plugin-src', ...releaseOnly.split('/'))
  mkdirSync(join(linkTarget, 'lib'), { recursive: true })
  writeFileSync(join(linkTarget, 'package.json'), JSON.stringify({ name: releaseOnly, version: '0.3.3', main: 'lib/index.js' }), 'utf8')
  writeFileSync(join(linkTarget, 'lib', 'index.js'), 'export const ok = true\n', 'utf8')
  const linkSpec = `link:${linkTarget.replace(/\\/gu, '/')}`
  rmSync(join(fix, 'node_modules', ...releaseOnly.split('/')), { recursive: true, force: true })
  symlinkSync(linkTarget, join(fix, 'node_modules', ...releaseOnly.split('/')), 'junction')
  writeLockText(importerLock(releaseOnly, linkSpec, 'link:../../plugin-src/@dsh-external/dsh-super-injector'))
  setManifest({ [releaseOnly]: linkSpec })
  const c6 = captureAndApply(releaseOnly)
  const r6 = await reconcileLockfile({
    profileDir: fix, packages: [{ name: releaseOnly }], registries: ['https://registry.example'],
    home: fix, pnpmAdd: c6.add, fetchJson: notFound,
  })
  check('★ 缺陷②：link 链接仍在时判为对齐（不再白跑 pnpm add、不再假报未写入 lock）',
    c6.acc.length === 0 && r6.lockUpdated === true && r6.lockNote === null && r6.method === null,
    JSON.stringify({ calls: c6.acc, lockUpdated: r6.lockUpdated, note: r6.lockNote }))
  check('★ lockVersion 能读 importers 段的 version（含 link:/URL 形态，旧实现在 specifier 行 break）',
    lockVersion(fix, releaseOnly) === 'link:../../plugin-src/@dsh-external/dsh-super-injector', String(lockVersion(fix, releaseOnly)))

  // ⑦ release 通道「先删再铺」把链接换成真实目录（新版）→ 必须判为漂移、重新物化 + 重放 link:，
  //    否则下一次 pnpm 操作会按 lock 重建链接，把刚更新上去的版本还原成 plugin-src 里的旧副本
  const nmPkg = join(fix, 'node_modules', ...releaseOnly.split('/'))
  rmSync(nmPkg, { recursive: true, force: true })
  mkdirSync(join(nmPkg, 'lib'), { recursive: true })
  writeFileSync(join(nmPkg, 'package.json'), JSON.stringify({ name: releaseOnly, version: '0.4.0', main: 'lib/index.js' }), 'utf8')
  writeFileSync(join(nmPkg, 'lib', 'index.js'), 'export const v = "0.4.0"\n', 'utf8')
  const c7 = captureAndApply(releaseOnly)
  await reconcileLockfile({
    profileDir: fix, packages: [{ name: releaseOnly }], registries: ['https://registry.example'],
    home: fix, pnpmAdd: c7.add, fetchJson: notFound,
  })
  check('★ 缺陷②：链接被打断（release 通道更新）→ 判为漂移并重放 link:',
    c7.acc.length === 1 && c7.acc[0] === linkSpec, JSON.stringify(c7.acc))
  check('★ 缺陷②：重放前把**新副本**刷进了 plugin-src（否则更新会被还原成旧版）',
    JSON.parse(readFileSync(join(linkTarget, 'package.json'), 'utf8')).version === '0.4.0',
    JSON.parse(readFileSync(join(linkTarget, 'package.json'), 'utf8')).version)
  check('★ 缺陷②：重放后再次对账即判为对齐（幂等）', await (async () => {
    rmSync(nmPkg, { recursive: true, force: true })
    symlinkSync(linkTarget, nmPkg, 'junction')
    const c8 = captureAndApply(releaseOnly)
    const r8 = await reconcileLockfile({
      profileDir: fix, packages: [{ name: releaseOnly }], registries: ['https://registry.example'],
      home: fix, pnpmAdd: c8.add, fetchJson: notFound,
    })
    return c8.acc.length === 0 && r8.lockUpdated === true
  })(), '')
}

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
