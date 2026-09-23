// 兼容门三条用户定案行为的端到端验证（2026-09-11 用户确认后实现）：
//   ① 自动禁用是**软禁**——点启用先要风险确认（confirmRisky），确认后放行；
//      但「启用前 import 冒烟检查」仍是**硬**门禁（模块根本加载不了＝事实性崩溃，不允许覆盖）。
//   ② 自动检测**只提示、绝不自动解锁**——/state 只多回一个 adoptable 字段。
//   ③ 两个自动行为各有**总开关**——关掉即回到纯手动（升级只提示不动开关 / 不显示可解锁提示）。
// 全部走真实路由处理器（fake ctx + fake req/res），不碰真实 ~/.dsh。
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HOME = join(ROOT, '.testdir', 'compat-soft-home')
process.env.DSH_HOME = HOME // 必须在 import 前设置（模块顶层常量按 DSH_HOME 求值）
rmSync(HOME, { recursive: true, force: true })

const profileDir = join(HOME, 'profiles', 'web')
const patchPath = join(profileDir, 'cordis.patch.yml')
const pendingFile = join(HOME, 'plugin-console', 'compat-pending.json')
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })

const writePkg = (name, version, source) => {
  const dir = join(profileDir, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, main: 'index.js', dsh: { engines: { framework: '>=0.1.0-rc.6' } } }, null, 2), 'utf8')
  writeFileSync(join(dir, 'index.js'), source, 'utf8')
}

// 已更新的正常包：源码干净 → 兼容判定不再是 fail（对应「用户更新插件后」的场景）
writePkg('@fake/locked', '2.0.0', 'export const ok = true\n')
// 没更新且源码坏掉的包：import 冒烟检查会拦（硬门禁用的样本）
writePkg('@fake/broken', '1.0.0', 'export const bad = ;\n')
// 真不适配的包：引用 0.1.2 起已删除的 dsh-settings API（适配门硬判据）
writePkg('@fake/incompat', '1.0.0', 'import { installSettingsSection } from "@deepseek-ai/dsh-client-ui-settings";\nexport const x = installSettingsSection;\n')

// 升级前预扫/隔离留下的现场：两个待适配行都已被自动禁用
writeFileSync(patchPath, '# user patch\n- id: locked-row\n  disabled: true\n- id: broken-row\n  disabled: true\n', 'utf8')
writeFileSync(pendingFile, JSON.stringify({
  frameworkVersion: '0.1.5-rc.1',
  upgradeFrom: '0.1.2-rc.1',
  pending: [
    { rowId: 'locked-row', moduleName: '@fake/locked', version: '1.0.0', status: 'pending', check: 'fail', checkNote: '升级前预扫判定不适配，已自动禁用', source: 'preflight-disabled-before-upgrade' },
    { rowId: 'broken-row', moduleName: '@fake/broken', version: '1.0.0', status: 'pending', check: 'fail', checkNote: '升级前预扫判定不适配，已自动禁用', source: 'preflight-disabled-before-upgrade' },
  ],
}, null, 2), 'utf8')

const ctx = {
  baseUrl: pathToFileURL(join(profileDir, 'cordis.yml')).href,
  loader: {
    entries: () => [
      { id: 'include', options: { name: 'cordis:include', group: true, config: { path: pathToFileURL(join(profileDir, 'cordis.yml')).href } } },
      { id: 'include:locked-row', options: { name: '@fake/locked' }, disabled: true, fiber: undefined },
      { id: 'include:broken-row', options: { name: '@fake/broken' }, disabled: true, fiber: undefined },
      { id: 'include:incompat-row', options: { name: '@fake/incompat' }, disabled: false, fiber: { state: 2 } },
      { id: 'include:plugin-console', options: { name: '@noob-stupid/dsh-plugin-console' }, disabled: false, fiber: { state: 2 } },
    ],
  },
  webServer: { register: (route) => { globalThis.__route = route; return () => {} } },
  effect: (fn) => { try { fn() } catch {}; return () => {} },
}

const mod = await import('../lib/index.js')
mod.apply(ctx)
const route = globalThis.__route
if (!route) throw new Error('路由未注册')

function fakeReq(method, pathname, body) {
  const req = {
    method,
    url: pathname,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    signal: { aborted: false, addEventListener: () => {} },
    [Symbol.asyncIterator]() {
      const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
      let i = 0
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) }
    },
  }
  return req
}
function fakeRes() {
  const res = { status: 0, body: null }
  res.writeHead = (status) => { res.status = status }
  res.end = (payload) => { res.body = payload }
  return res
}
async function call(method, path, body) {
  const res = fakeRes()
  await route.handler(fakeReq(method, path, body), res)
  return { status: res.status, json: res.body === null ? null : JSON.parse(res.body) }
}

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const readPending = () => JSON.parse(readFileSync(pendingFile, 'utf8'))
const readPatch = () => readFileSync(patchPath, 'utf8')

// ── ① 默认状态：总开关默认开，检测结果只提示 ────────────────────────────────
let r = await call('GET', '/plugin-console/state')
check('state 200', r.status === 200, `status=${r.status}`)
check('总开关默认全开', r.json?.compatGate?.autoDisable === true && r.json?.compatGate?.autoDetect === true, JSON.stringify(r.json?.compatGate))
const locked = r.json.entries.find((e) => e.rowId === 'locked-row')
const broken = r.json.entries.find((e) => e.rowId === 'broken-row')
check('待适配行标记 pendingCompat', locked?.pendingCompat === true && broken?.pendingCompat === true)
check('已更新的行给出「已适配」检测结果', locked?.adoptable?.version === '2.0.0' && locked.adoptable.check !== 'fail', JSON.stringify(locked?.adoptable))
check('未更新的行不给「已适配」提示', broken?.adoptable === null, JSON.stringify(broken?.adoptable))
check('检测结果附在 compatPending 里', r.json?.compatPending?.pending?.find((p) => p.rowId === 'locked-row')?.adoptable !== null)
check('检测不改开关状态（locked-row 仍禁用）', locked?.enabled === false)

// ── ② 软禁：不带确认 → 409 拒绝，开关不动 ────────────────────────────────────
r = await call('POST', '/plugin-console/toggle', { entryId: 'include:locked-row', enabled: true })
check('未确认强行启用被拒 409', r.status === 409, `status=${r.status}`)
check('拒绝原因带 compat-confirm 标记', r.json?.details?.code === 'compat-confirm', JSON.stringify(r.json?.details))
check('拒绝响应带行/框架/判定信息', r.json?.details?.rowId === 'locked-row' && r.json?.details?.frameworkVersion === '0.1.5-rc.1' && typeof r.json?.details?.checkNote === 'string', JSON.stringify(r.json?.details))
check('被拒后补丁未被改写（仍禁用）', /- id: locked-row\r?\n {2}disabled: true/u.test(readPatch()))
check('被拒后不记录强行启用时间', readPending().pending.find((p) => p.rowId === 'locked-row')?.riskyApprovedAt === undefined)
r = await call('GET', '/plugin-console/state')
check('被拒后仍处于禁用（不自动解锁）', /- id: locked-row\r?\n {2}disabled: true/u.test(readPatch()) && r.json.entries.find((e) => e.rowId === 'locked-row')?.pendingCompat === true)

// ── ③ 软禁：带确认 → 放行，补丁解锁并留痕 ───────────────────────────────────
r = await call('POST', '/plugin-console/toggle', { entryId: 'include:locked-row', enabled: true, confirmRisky: true })
check('确认风险后启用成功', r.status === 200 && r.json?.ok === true, `status=${r.status} ${JSON.stringify(r.json)?.slice(0, 120)}`)
check('补丁里的禁用块被移除', !/- id: locked-row/u.test(readPatch()), readPatch())
const riskyRec = readPending().pending.find((p) => p.rowId === 'locked-row')
check('留痕 riskyApprovedAt', typeof riskyRec?.riskyApprovedAt === 'number', JSON.stringify(riskyRec?.riskyApprovedAt))
// v0.3.45（用户定案：启用即视为已适配，但保留痕迹）——启用后清单必须从 pending 转成 adopted，
// 否则重启后界面上会出现「已启用却还挂着【待适配】」（用户实测的 5 行就是这个原因）
check('启用后清单记录转为 adopted', riskyRec?.status === 'adopted' && riskyRec?.adoptedBy === 'manual-enable', JSON.stringify({ status: riskyRec?.status, by: riskyRec?.adoptedBy }))
check('转 adopted 不丢判定痕迹', typeof riskyRec?.checkNote === 'string' && riskyRec.checkNote !== '', String(riskyRec?.checkNote).slice(0, 40))
r = await call('GET', '/plugin-console/state')
check('已启用的行不再显示【待适配】', r.json.entries.find((e) => e.rowId === 'locked-row')?.pendingCompat === false)
check('仍禁用且待适配的行照旧显示【待适配】', r.json.entries.find((e) => e.rowId === 'broken-row')?.pendingCompat === true)

// ── ④ 硬门禁不被软禁覆盖：模块加载不了照样拒绝 ──────────────────────────────
const pipeOk = (() => {
  try { return spawnSync(process.execPath, ['-e', 'console.log("PIPE_OK")'], { encoding: 'utf8' }).stdout?.includes('PIPE_OK') === true } catch { return false }
})()
r = await call('POST', '/plugin-console/toggle', { entryId: 'include:broken-row', enabled: true, confirmRisky: true })
if (pipeOk) {
  check('坏模块即使确认风险也被拦（冒烟检查＝硬门禁）', r.status === 409 && /冒烟检查/u.test(r.json?.error ?? ''), `status=${r.status} err=${r.json?.error ?? ''}`)
  check('硬门禁拦下后补丁未解锁', /- id: broken-row\r?\n {2}disabled: true/u.test(readPatch()))
} else {
  console.log('SKIP 硬门禁断言 — 当前环境不允许捕获子进程输出，probe 按「放行」降级')
}
check('软禁已放行（确认记录仍写入，说明拦它的是硬门禁）', typeof readPending().pending.find((p) => p.rowId === 'broken-row')?.riskyApprovedAt === 'number')

// ── ⑤ 总开关：自动检测可关 ──────────────────────────────────────────────────
r = await call('POST', '/plugin-console/compat-gate', { autoDetect: false })
check('关闭自动检测返回新状态', r.status === 200 && r.json?.compatGate?.autoDetect === false && r.json?.compatGate?.autoDisable === true, JSON.stringify(r.json?.compatGate))
r = await call('GET', '/plugin-console/state')
check('关闭后不再回 adoptable（行）', r.json.entries.find((e) => e.rowId === 'locked-row')?.adoptable === null)
// 注：locked-row 在 ③ 里已被启用 → 记录转 adopted，不再出现在待适配清单里（v0.3.45 语义）
const lockedListRec = r.json.compatPending.pending.find((p) => p.rowId === 'locked-row')
check('关闭后不再回 adoptable（清单）', lockedListRec === undefined || lockedListRec.adoptable === null, JSON.stringify(lockedListRec))
// 注：fake loader 条目是静态的（不随补丁变化），故「用户开关状态」一律以补丁文本为准
check('关闭自动检测不影响用户的开关动作', !/- id: locked-row/u.test(readPatch()))
r = await call('POST', '/plugin-console/compat-gate', { autoDetect: true })
check('重新打开自动检测', r.json?.compatGate?.autoDetect === true)

// ── ⑥ 总开关：升级时自动禁用可关（只提示不动开关）──────────────────────────
r = await call('POST', '/plugin-console/compat-gate', { autoDisable: false })
check('关闭自动禁用返回新状态', r.status === 200 && r.json?.compatGate?.autoDisable === false, JSON.stringify(r.json?.compatGate))
let pre = await mod.preflightDisableIncompatible({ ctx, profileDir, patchPath, targetVersion: '0.1.5-rc.1' })
check('关闭后预扫不禁用任何行', pre.disabled.length === 0, JSON.stringify(pre.disabled))
check('关闭后仍报告「判定不适配但被你关了」', pre.skipped.some((s) => s.rowId === 'incompat-row' && /自动禁用.*已关闭|已关闭/u.test(s.reason ?? '')), JSON.stringify(pre.skipped))
check('关闭后补丁没有 incompat-row 禁用块', !/- id: incompat-row/u.test(readPatch()))
r = await call('POST', '/plugin-console/compat-gate', { autoDisable: true })
check('重新打开自动禁用', r.json?.compatGate?.autoDisable === true)
pre = await mod.preflightDisableIncompatible({ ctx, profileDir, patchPath, targetVersion: '0.1.5-rc.1' })
check('打开后预扫真的禁用了不适配行', pre.disabled.some((d) => d.rowId === 'incompat-row'), JSON.stringify(pre.disabled.map((d) => d.rowId)))
check('打开后补丁写入禁用块', /- id: incompat-row\r?\n {2}disabled: true/u.test(readPatch()))
check('用户强行启用过的行不被预扫回收（enabled 的不再扫到）', !/- id: locked-row/u.test(readPatch()))

// ── ⑦ 客户端接线（服务端有、UI 没接 = 用户看不到）───────────────────────────
const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
check('客户端调用 /compat-gate', client.includes('/plugin-console/compat-gate'))
check('客户端渲染两个总开关', client.includes('compatGateAutoDisable') && client.includes('compatGateAutoDetect'))
// v0.3.36（用户要求）：总开关收进「功能包」里的 [门控] 按钮（弹窗拉杆），不再占已安装列表表头
check('客户端有 [门控] 按钮与面板', client.includes('gateBtn') && client.includes('gateModalTitle'))
check('客户端门控面板用拉杆开关', client.includes('gateAutoDisable') && client.includes('gateAutoDetect') && client.includes('pcSwitch'))
check('已安装表头不再放门控复选框', !/installedHead[\s\S]{0,800}compatGateAutoDisable/u.test(client))
check('客户端有风险确认弹条', client.includes('riskyEnableTitle') && client.includes('confirmRisky'))
check('客户端展示「已适配」提示', client.includes('adoptableDetected') && client.includes('adoptable'))

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
