// Step 0 行为基线①：路由清单 + 响应字段 + 安全中间件（拆分前钉死，防止结构变更悄悄丢接口/改字段）
//
// 为什么要有它：历史上 `market-index` 的 405 就这样藏了两周——路由悄悄失效没人发现。
// 拆分（L0-L3 分层、45 条 if 分支改成表驱动）最容易犯的错就是"漏搬一条路由"或"顺手改了响应字段"。
// 本测试把当前 48 条路由、13 条只读接口的响应字段、4 类安全校验全部固化为断言：
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
  ['GET', '/plugin-console/state', undefined, 200, ['compat', 'compatGate', 'compatPending', 'components', 'entries', 'framework', 'github', 'installJobs', 'ok', 'patch', 'patchHeal', 'patchPath', 'pendingRestart', 'recentFailures', 'rollback', 'selfVersion']],
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
  // github-open-login 不能进这张表：它的响应随环境分两种形状（成功 {ok,started,status} / 不可用
  // {ok,started,reason}），逐字段钉死必然误报；更要紧的是**它会真的去 fetch 本机 web 端口**，
  // 而本机装了 dsh-github-login 且 exe 在（D:\dsh\dsh-github-login\dist\DSH-GitHub-Login.exe），
  // 默认端口 3080 又正是本机在跑的宿主 —— 真调一次会弹出登录窗口，测试不该有可见副作用。
  // 所以它改用下面的「②b 弱断言」：把端口临时指到没人监听的空端口，走真实的降级分支。
]
for (const [method, path, body, wantStatus, wantKeys] of SCHEMAS) {
  const r = await call(method, path, body)
  const keys = r.json === null ? [] : Object.keys(r.json).sort()
  const same = r.status === wantStatus && JSON.stringify(keys) === JSON.stringify([...wantKeys].sort())
  check(`响应契约 ${method} ${path.replace('/plugin-console', '')}`, same, `status=${r.status} keys=${keys.join(',')}`)
}

// ── ②b /github-open-login：弱断言（只钉 200 与字段名，不追究完整字段集合）─────────────
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

// ── ②c /uninstall 接受 jobId：撤销「已安装但尚未生效」的安装 ─────────────────────
// 2026-09-20 真装真卸演练实测的产品缺口：装完一个 bundle 型插件后 /install 返回 entryId: null、
// /state 里新增 loader 条目 = 0（要重启才被加载），而旧 /uninstall 只按**运行中** loader 条目
// 查找 → 恒 404「没有名为 X 的插件条目」，于是刚装错的插件在重启前无法从面板卸载。
// 这里钉死三件事：① /uninstall 接受 { jobId } 这种入参形态；② /state 输出含 pendingRestart；
// ③ 撤销真的把补丁行 / bundles 清单清干净，并回报 verified（回读核实，不是"删完就报成功"）。
{
  const { installJobs } = mod
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

// ── ②d 撤销的"如实汇报"：删不干净必须带 warn + 路径（不许 500、不许假成功）─────────
// 本机实测过 rmSync/pnpm 在受限环境里会静默落空甚至抛错（见 removeDirVerified 注释），
// 所以 revokePendingInstall 的三个子项都回读核实。这里用注入的 pnpmRemove 桩钉死各条路径。
{
  const { revokePendingInstall } = mod
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

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
