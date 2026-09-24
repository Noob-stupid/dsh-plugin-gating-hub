// 框架升级适配逻辑验证：备份快照 + 版本变化检测 + 补丁状态
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 测试目录放在仓库内（.testdir/，已 gitignore）：系统 tmpdir 在部分环境下 rmSync 静默失败
const ROOT = dirname(fileURLToPath(import.meta.url))
process.env.DSH_HOME = process.env.DSH_TEST_HOME ?? join(ROOT, '.testdir', 'fw-home')
const home = process.env.DSH_HOME
// 该测试需要真实 DSH 框架（@deepseek-ai/dsh 从真实 profile 的 node_modules 解析出版本）；
// CI 无本机 profile 时跳过而非红灯。
const os = await import('node:os')
const realProfile = process.env.DSH_PROFILE_DIR ?? join(os.homedir(), '.dsh', 'profiles', 'web')
const realCordis = join(realProfile, 'cordis.yml')
if (!existsSync(realCordis)) {
  console.log(`SKIP 需要真实 profile（${realCordis}）——CI 环境跳过；本机安装 DSH 后可直接运行`)
  process.exit(0)
}
await rm(home, { recursive: true, force: true })
// 模拟 profile
await mkdir(`${home}/profiles/web`, { recursive: true })
await writeFile(`${home}/profiles/web/cordis.patch.yml`, '- insert:\n    - id: x\n      name: \'x\'\n', 'utf8')
await writeFile(`${home}/profiles/web/package.json`, '{"name":"web","dsh":{"profile":{"bundles":["a"]}}}', 'utf8')
// 模拟已记录版本（旧版 rc.5 → 现在 rc.6 = 升级）
await mkdir(`${home}/plugin-console`, { recursive: true })
await writeFile(`${home}/plugin-console/framework-state.json`, JSON.stringify({ lastVersion: '0.1.0-rc.5', backupAt: 0 }), 'utf8')

const require = createRequire(import.meta.url)
const mod = await import(new URL('./lib/index.js', import.meta.url).href)

const fakeEntries = [
  { id: 'include', options: { name: 'cordis:include', group: true, config: { path: pathToFileURL(`${home}/profiles/web/cordis.yml`).href } } },
  { id: 'include:schedule', options: { name: '@deepseek-ai/dsh-schedule' }, disabled: false, fiber: { state: 2 } },
]
const ctx = {
  // baseUrl 用真实 profile（@deepseek-ai/dsh 从真实 node_modules 链解析出版本）；
  // DSH_HOME 已指到临时目录，备份/状态文件写临时位置，不污染真实环境
  baseUrl: pathToFileURL(realCordis).href,
  loader: { entries: () => fakeEntries },
  webServer: { register: (r) => { globalThis.__route = r; return () => {} } },
  effect: (fn) => { fn() },
}
mod.apply(ctx)
const route = globalThis.__route

function fakeReq(method, pathname, body) {
  const req = { method, url: pathname, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' }, signal: { aborted: false, addEventListener: () => {} }, [Symbol.asyncIterator]() { const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]; let i = 0; return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) } } }
  return req
}
function fakeRes() { const res = { status: 0, body: null }; res.writeHead = (s) => { res.status = s }; res.end = (p) => { res.body = p }; return res }
async function call(method, path, body) { const res = fakeRes(); await route.handler(fakeReq(method, path, body), res); return { status: res.status, json: res.body === null ? null : JSON.parse(res.body) } }

let failed = 0
function check(label, cond, extra) { console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`); if (!cond) failed += 1 }

// 1. state 返回 framework 字段（升级检测：rc.5 → 实际版本）
const r = await call('GET', '/plugin-console/state')
check('state 200', r.status === 200)
check('framework present', r.json?.framework !== null && typeof r.json?.framework?.version === 'string', JSON.stringify(r.json?.framework))
check('upgraded detected (rc.5 → current)', r.json?.framework?.upgraded === true, `from=${r.json?.framework?.from} to=${r.json?.framework?.version}`)
check('backup dir created', typeof r.json?.framework?.backupDir === 'string' && existsSync(`${home}/plugin-console/framework-backups/${r.json.framework.version}/cordis.patch.yml`), r.json?.framework?.backupDir)

// 2. 插件清单备份
const pluginsFile = `${home}/plugin-console/framework-backups/${r.json.framework.version}/plugins.json`
check('plugins.json backed up', existsSync(pluginsFile))

// 3. 第二次调用：版本未变 → upgraded=false
const r2 = await call('GET', '/plugin-console/state')
check('second call upgraded=false', r2.json?.framework?.upgraded === false, JSON.stringify(r2.json?.framework))

// 4. 状态文件已更新
const state = JSON.parse(await readFile(`${home}/plugin-console/framework-state.json`, 'utf8'))
check('state file updated', state.lastVersion === r.json.framework.version)

// ── 5. 升级进度条的「诚实性」（v0.3.37：2026-09-11 事故里卡片把已成功步骤也打成 ✕）──────
const statusFile = `${home}/plugin-console/fw-upgrade-state.txt`
const rollbackFile = `${home}/plugin-console/framework-rollback.json`
// 5a. 新格式：失败记录带 stage=<崩溃前最后阶段>
await writeFile(statusFile, 'failed|升级脚本异常终止：无法将参数绑定到参数"Path"，因为该参数是空值。|stage=relaunching', 'utf8')
let rs = await call('GET', '/plugin-console/framework-upgrade-status')
check('失败状态被解析', rs.status === 200 && rs.json?.status === 'failed', JSON.stringify(rs.json))
check('崩溃前阶段被透出（界面据此显示已完成步骤）', rs.json?.stage === 'relaunching', String(rs.json?.stage))
check('消息里不再混入 stage= 字段', typeof rs.json?.message === 'string' && !rs.json.message.includes('stage=') && rs.json.message.includes('异常终止'), rs.json?.message)

// 5b. 旧格式（没有 stage）但框架本体已在目标版本 → 也要能判定「其实升上去了」
const require2 = createRequire(join(realProfile, 'package.json'))
const dshPkg = require2.resolve('@deepseek-ai/dsh/package.json')
let fwRoot = dirname(dshPkg)
while (fwRoot !== dirname(fwRoot) && !existsSync(join(fwRoot, '.pnpm'))) fwRoot = dirname(fwRoot)
const fwVersion = JSON.parse(await readFile(dshPkg, 'utf8')).version
await writeFile(statusFile, 'failed|升级脚本异常终止：无法将参数绑定到参数"Path"，因为该参数是空值。', 'utf8')
await writeFile(rollbackFile, JSON.stringify({ from: '0.1.5-rc.1', to: fwVersion, fwRoot, at: Date.now() }), 'utf8')
rs = await call('GET', '/plugin-console/framework-upgrade-status')
check('旧记录也能识别「框架本体其实已升到目标版本」', rs.json?.frameworkAtTarget === fwVersion, `frameworkAtTarget=${rs.json?.frameworkAtTarget} 实际=${fwVersion}`)
check('旧记录没有 stage（界面退回整列 ✕ + 提示）', rs.json?.stage === null || rs.json?.stage === undefined, String(rs.json?.stage))

// 5c. 目标版本对不上时不得误报
await writeFile(rollbackFile, JSON.stringify({ from: '0.1.5-rc.1', to: '9.9.9-not-installed', fwRoot, at: Date.now() }), 'utf8')
rs = await call('GET', '/plugin-console/framework-upgrade-status')
check('目标版本对不上时不误报', rs.json?.frameworkAtTarget === undefined || rs.json?.frameworkAtTarget === null, String(rs.json?.frameworkAtTarget))

// 5d. 客户端按 stage 标步骤（接线断言）
const clientSrc = await readFile(join(ROOT, 'lib', 'client.js'), 'utf8')
check('客户端按 stage 标步骤状态', clientSrc.includes('failedStage') && clientSrc.includes('stageIdx'))
check('客户端对「本体已升级」给出说明文案', clientSrc.includes('fwFailedButUpgraded'))

// ── 6. 「功能包 → 框架」常驻面板的版本检查接口 ────────────────────────────────
// 起因：卡片被点过叉号后 localStorage 永久标记，重启后卡片不再出现，用户再也看不到升级状态
// （2026-09-11 实测）。所以框架入口必须常驻，并且状态查询要**无视**那个标记。
await writeFile(statusFile, 'idle|', 'utf8')
const chk1 = await call('POST', '/plugin-console/framework-check', {})
check('framework-check 200', chk1.status === 200 && chk1.json?.ok === true, `status=${chk1.status}`)
check('返回本机已装框架版本', typeof chk1.json?.current === 'string' && chk1.json.current === fwVersion, `current=${chk1.json?.current} 实际=${fwVersion}`)
check('返回 latest / next 字段', (chk1.json?.latest === null || typeof chk1.json?.latest === 'string') && (chk1.json?.next === null || typeof chk1.json?.next === 'string'), `latest=${chk1.json?.latest} next=${chk1.json?.next}`)
check('升级目标只能取自 latest/next', chk1.json?.target === null || chk1.json?.target === chk1.json?.latest || chk1.json?.target === chk1.json?.next, `target=${chk1.json?.target}`)
const chk2 = await call('POST', '/plugin-console/framework-check', {})
check('5 分钟缓存命中（不重复打 registry）', chk2.json?.checkedAt === chk1.json?.checkedAt, `${chk1.json?.checkedAt} vs ${chk2.json?.checkedAt}`)
check('版本检查只读（不碰升级状态文件）', (await readFile(statusFile, 'utf8')) === 'idle|')
check('客户端有常驻 [框架] 入口并调用 framework-check', clientSrc.includes('fwPanelBtn') && clientSrc.includes('/plugin-console/framework-check'))
check('客户端面板无视「已关闭」标记刷新状态', clientSrc.includes('fwStatusRefresh'))
check('升级步骤视图只写一份（卡片与面板共用）', (clientSrc.match(/FW_STEPS\.map/gu) ?? []).length === 1)

// ── 7. 状态自愈（v0.3.39）：脚本被强杀后终态没写成，界面不能永远卡在「进行中」────────
// 2026-09-11 真机：回滚脚本干完活被 Ctrl+C 类事件结束（计划任务 Last Result = 0xC000013A），
// 状态文件停在 rollback|，卡片每 3 秒轮询永不停。用「心跳 + 与现实核对」把它纠正回来。
const hbFile = `${statusFile}.hb`
const ageHb = (seconds) => { const t = (Date.now() - seconds * 1000) / 1000; utimesSync(hbFile, t, t) }

// 7a. 脚本已死（无心跳）+ 框架已在目标版本 → 判定升级实际成功
rmSync(hbFile, { force: true })
await writeFile(statusFile, 'relaunching|升级完成，重启 DSH 服务生效…', 'utf8')
await writeFile(rollbackFile, JSON.stringify({ from: '0.1.5-rc.1', to: fwVersion, fwRoot, at: Date.now() }), 'utf8')
let hz = await call('GET', '/plugin-console/framework-upgrade-status')
check('脚本已死时按现实判定为完成', hz.json?.status === 'done' && hz.json?.reconciled?.from === 'relaunching', JSON.stringify(hz.json?.reconciled))
check('自愈时说明原因（不是假装没发生）', typeof hz.json?.reconciled?.note === 'string' && hz.json.reconciled.note.includes(fwVersion), hz.json?.reconciled?.note)

// 7b. 脚本还活着（心跳新鲜）→ 绝不抢先改判
await writeFile(statusFile, 'relaunching|升级完成，重启 DSH 服务生效…', 'utf8')
await writeFile(hbFile, 'tick', 'utf8')
hz = await call('GET', '/plugin-console/framework-upgrade-status')
check('心跳新鲜时保持原状态（不抢跑）', hz.json?.status === 'relaunching' && hz.json?.reconciled === undefined, `status=${hz.json?.status}`)

// 7c. 脚本已死但现实对不上（版本既不是 to 也不是 from）→ 只报「脚本可能已中断」
await writeFile(statusFile, 'installing|升级框架 0.1.5-rc.1 -> 9.9.9…', 'utf8')
await writeFile(rollbackFile, JSON.stringify({ from: '0.1.5-rc.1', to: '9.9.9-not-installed', fwRoot, at: Date.now() }), 'utf8')
await writeFile(hbFile, 'tick', 'utf8')
ageHb(200)
hz = await call('GET', '/plugin-console/framework-upgrade-status')
check('脚本已死且现实对不上 → 报中断而非乱改判', hz.json?.stalled === true && hz.json?.status === 'installing', `stalled=${hz.json?.stalled} status=${hz.json?.status}`)
rmSync(hbFile, { force: true })

// 7d. 回滚按钮可用性：当前版本已等于记录里的 from 时不该再提供回滚
// （/state 只在 checkpointDir 真实可用时才回 rollback —— 这里造一个合法快照目录）
const cpDir = `${home}/plugin-console/cp`
await mkdir(`${cpDir}/.pnpm`, { recursive: true })
const rollbackWith = (from, to) => JSON.stringify({ from, to, fwRoot, checkpointDir: cpDir, at: Date.now() })
const otherVer = fwVersion === '0.1.5-rc.1' ? '0.1.5-rc.2' : '0.1.5-rc.1'
await writeFile(rollbackFile, rollbackWith(fwVersion, '0.1.5-rc.1'), 'utf8')
let stt = await call('GET', '/plugin-console/state')
check('已回滚到位时回滚按钮不可用', stt.json?.rollback?.applicable === false, JSON.stringify(stt.json?.rollback))
await writeFile(rollbackFile, rollbackWith(otherVer, fwVersion), 'utf8')
stt = await call('GET', '/plugin-console/state')
check('版本不同时回滚按钮可用', stt.json?.rollback?.applicable === true, `from=${otherVer} 当前=${fwVersion} → ${JSON.stringify(stt.json?.rollback)}`)
check('客户端按 applicable 决定是否显示回滚', clientSrc.includes('rollbackUsable') && clientSrc.includes('fwRollbackDone'))
// v0.3.41：客户端自己也算一遍（服务端旧版没有 applicable 字段时同样要判对——用户实测正是这个场景）
check('客户端自算回滚可用性（不只信服务端字段）', clientSrc.includes('curFwVersion') && clientSrc.includes('curFwVersion === rollbackInfo.from'))
check('客户端显示自愈说明', clientSrc.includes('reconciled') && clientSrc.includes('stalled'))


// 7e. 卡片语义（v0.3.40）：只有「进行中」跟「用户没看过的结束卡片」才显示
check('卡片关闭标记按运行时间戳记录（关一次就真的关掉）', clientSrc.includes('pc-fw-dismiss-at') && clientSrc.includes('fwRunKey'))
check('自愈出来的结果不弹卡片（只在面板里常驻）', clientSrc.includes('frameworkStatus.reconciled !== undefined'))

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
await rm(home, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
