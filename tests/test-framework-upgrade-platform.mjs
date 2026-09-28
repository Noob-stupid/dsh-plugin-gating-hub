// 非 win32 平台守卫测试（2026-09-29 改错）——「一键框架升级/回滚」在非 Windows 上必须**明确拒绝**，
// 绝不"假成功"。
//
// 背景（真缺陷）：升级/回滚脚本整体依赖 Windows 机制（schtasks.exe 计划任务 + PowerShell +
// Get-NetTCPConnection）。非 Windows 上 execFile('schtasks.exe') 必然 ENOENT，而旧实现会：
//   ① 先 writeFileSync 一个「脚本已通过 detached 启动」的状态文件（骗自己脚本在跑）；
//   ② 再 execFile 不存在的 powershell.exe（静默失败，回调被吞）；
//   ③ **照样** `upgraded = true`，路由回 `ok: true, steps: ['框架升级脚本已启动…']`。
// 用户看到"已启动"，实际一个字节都没动。回滚路由是同一个毛病（回 ok:true + from/checkpointDir）。
//
// 本套断言（全离线：私有临时 DSH_HOME + 注入 fetchJson，绝不碰真实 profile、不出网络、绝不执行升级）：
//   ① 判据函数：非 win32 返回结构化拒绝载荷；win32 返回 null（行为不变）
//   ② **真跑** POST /framework-upgrade（fake ctx + fake req/res）：非 win32 → 501、body.ok !== true、
//      文案点明"暂不支持"且给出手动升级出路；**零副作用**（备份/预禁用/预检都没被调用，
//      状态文件与脚本文件都没落盘）
//   ③ 回滚路由同样拒绝（且同样零写盘）
//   ④ 静态接线：平台守卫落在入参校验（400 分支）之后、任何副作用之前；deps 里 fetchJson 有真通道兜底
//
// 为什么用 defineProperty 注入平台：`process.platform` 是只读取值器，测试要在**本机（Windows）**
// 与 CI（Linux）上都能验证"另一侧"的行为；这里只改本进程的判定值，不启动任何升级。
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'fw-platform-home')
process.env.DSH_HOME = HOME
rmSync(HOME, { recursive: true, force: true })

// 假 profile：让路由真的解析到"当前框架版本"（否则 current=null，走不到本套要测的分支）
const profileDir = join(HOME, 'profiles', 'web')
mkdirSync(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })
writeFileSync(join(profileDir, 'cordis.yml'), '# stub\n', 'utf8')
writeFileSync(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.2', main: 'index.js' }), 'utf8')
writeFileSync(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'index.js'), 'export const ok = true\n', 'utf8')

let pass = 0
let failed = 0
let skipped = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (cond) pass += 1
  else failed += 1
}
// 响亮 SKIP：打印原因、计入汇总（绝不假装 PASS）
const skip = (label, reason) => { console.log(`SKIP ${label} — ${reason}`); skipped += 1 }

const STATE_FILE = join(HOME, 'plugin-console', 'fw-upgrade-state.txt')
const ROLLBACK_FILE = join(HOME, 'plugin-console', 'framework-rollback.json')

// ── 平台注入（只改本进程判定值；还原用描述符，绝不真跑升级）─────────────────────
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
function withPlatform(value, fn) {
  try {
    Object.defineProperty(process, 'platform', { value, configurable: true, writable: true })
  } catch (error) {
    return { injected: false, error: error instanceof Error ? error.message : String(error) }
  }
  try {
    return { injected: true, value: fn() }
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor)
  }
}
// 路由 handler 是 async：**必须跨 await 持有**注入值，否则 handler 里 await 之后读到的
// 已是还原后的真平台（本套第一次跑就是这么假绿/假红的 —— 平台注入的经典坑）。
async function withPlatformAsync(value, fn) {
  try {
    Object.defineProperty(process, 'platform', { value, configurable: true, writable: true })
  } catch (error) {
    return { injected: false, error: error instanceof Error ? error.message : String(error) }
  }
  try {
    return { injected: true, value: await fn() }
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor)
  }
}

const { platformUpgradeRefusal } = await import('../lib/server/domain/framework.js')
const { routeFrameworkUpgrade } = await import('../lib/server/routes/framework-upgrade.js')
const { refuseWhenPlatformUnsupported, routeFrameworkRollback } = await import('../lib/server/routes/framework.js')

const fakeReq = (method, pathname, body) => ({
  method, url: pathname, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' },
  signal: { aborted: false, addEventListener: () => {} },
  [Symbol.asyncIterator]() {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    let i = 0
    return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) }
  },
})
const fakeRes = () => {
  const r = { status: 0, body: null }
  r.writeHead = (s) => { r.status = s }
  r.end = (p) => { r.body = p }
  return r
}

// ── ① 判据函数：非 win32 拒绝载荷 / win32 放行 ────────────────────────────────
{
  const linux = withPlatform('linux', () => platformUpgradeRefusal())
  if (!linux.injected) {
    skip('判据函数（非 win32）', `本进程无法注入 platform（${linux.error}）`)
  } else {
    const r = linux.value
    check('非 win32：判据返回结构化拒绝载荷（不是 null）', r !== null && typeof r.error === 'string', String(r?.error ?? r))
    check('非 win32：文案明确"暂不支持"并给出手动升级出路',
      typeof r?.error === 'string' && r.error.includes('暂不支持') && Array.isArray(r?.details?.manual) && r.details.manual.length > 0
      && r.details.manual.some((m) => m.includes('npm i -g @deepseek-ai/dsh')),
      `${r?.error ?? ''} | manual=${JSON.stringify(r?.details?.manual ?? [])}`.slice(0, 150))
    check('非 win32：载荷带 code/platform（前端与日志可判因）', r?.details?.code === 'unsupported-platform' && r?.details?.platform === 'linux', JSON.stringify(r?.details?.platform))
  }
  const win = withPlatform('win32', () => platformUpgradeRefusal())
  check('win32：判据放行（返回 null —— 升级/回滚路径一字不改）', win.injected && win.value === null, String(win.value))
  // 包装器（路由用）：win32 下 false 且**不写任何响应**
  const res = fakeRes()
  const refused = withPlatform('win32', () => refuseWhenPlatformUnsupported(res))
  check('win32：路由包装器返回 false 且不写响应（status 仍为 0）', refused.value === false && res.status === 0, `status=${res.status}`)
}

// ── ② 真跑升级路由（非 win32）：501 拒绝 + 零副作用 ─────────────────────────────
const META = { 'dist-tags': { latest: '0.5.0' }, versions: { '0.1.5-rc.2': {}, '0.5.0': {} } }
const sideEffectSpies = []
const spy = (name) => (...args) => { sideEffectSpies.push(name); throw new Error(`不该被调用：${name}`) }
const cordisUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
const ctx = {
  baseUrl: cordisUrl,
  loader: { entries: () => [{ id: 'include', options: { name: 'cordis:include', group: true, config: { path: cordisUrl } } }] },
  webServer: { register: () => () => {} },
  effect: (fn) => { try { fn() } catch {}; return () => {} },
}
const run = async (handler, pathname, body) => {
  const res = fakeRes()
  await handler(fakeReq('POST', pathname, body), res, {
    ctx, url: new URL(pathname, 'http://127.0.0.1:3080'), pathname, method: 'POST', body,
    deps: {
      fetchJson: async () => META, // 注入固定 registry 元数据：不出网络，且保证"版本合法"（走到平台守卫）
      backupProfileSnapshot: spy('backupProfileSnapshot'),
      preflightDisableIncompatible: spy('preflightDisableIncompatible'),
      webPort: () => 3080,
      listEntries: () => [],
    },
  })
  let json = null
  try { json = res.body === null || res.body === undefined ? null : JSON.parse(res.body) } catch {}
  return { status: res.status, json, raw: res.body }
}

{
  const out = (await withPlatformAsync('linux', () => run(routeFrameworkUpgrade, '/plugin-console/framework-upgrade', {}))).value
  check('非 win32：POST /framework-upgrade 被拒绝（501，不是 200）', out.status === 501, `status=${out.status}`)
  check('非 win32：**绝不返回 ok:true**（ok !== true 且 upgraded 不存在）', out.json?.ok !== true && out.json?.upgraded === undefined, `ok=${String(out.json?.ok)} upgraded=${String(out.json?.upgraded)}`)
  check('非 win32：拒绝文案点明"暂不支持「一键框架升级/回滚」"并给手动升级出路',
    typeof out.json?.error === 'string' && out.json.error.includes('暂不支持') && out.json.error.includes('一键框架升级/回滚')
    && Array.isArray(out.json?.details?.manual) && out.json.details.manual.length > 0,
    String(out.json?.error ?? out.raw).slice(0, 120))
  check('非 win32：**不写 detached 状态文件**（fw-upgrade-state.txt 不存在）', !existsSync(STATE_FILE), STATE_FILE)
  check('非 win32：拒绝发生在任何副作用之前（备份/预禁用一次都没被调用）', sideEffectSpies.length === 0, sideEffectSpies.join(',') || '0 次')
  check('非 win32：没有生成升级脚本（临时目录里没有 fw-upgrade-*.ps1 残渣）', !existsSync(join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', `fw-upgrade-${process.pid}.ps1`)), `pid=${process.pid}`)
}

// ── ③ 真跑回滚路由（非 win32）：同样拒绝 + 不写状态文件 ─────────────────────────
{
  // 先造一个"看起来可用"的回滚点，确保拒绝**不是**因为 409「没有可用回滚点」
  const tree = join(HOME, 'framework-tree')
  mkdirSync(join(tree, '.pnpm'), { recursive: true })
  const checkpointDir = join(HOME, 'plugin-console', 'framework-backups', '0.1.5-rc.2', 'fw-tree')
  mkdirSync(join(checkpointDir, '.pnpm'), { recursive: true })
  writeFileSync(ROLLBACK_FILE, JSON.stringify({ from: '0.1.5-rc.2', to: '0.1.7-rc.1', fwRoot: tree, checkpointDir, at: Date.now() }), 'utf8')
  rmSync(STATE_FILE, { force: true })

  const out = (await withPlatformAsync('linux', () => run(routeFrameworkRollback, '/plugin-console/framework-rollback', {}))).value
  check('非 win32：POST /framework-rollback 被拒绝（501）', out.status === 501, `status=${out.status}`)
  check('非 win32：回滚同样**绝不返回 ok:true**（ok !== true 且不带 checkpointDir）', out.json?.ok !== true && out.json?.checkpointDir === undefined, `ok=${String(out.json?.ok)} checkpointDir=${String(out.json?.checkpointDir)}`)
  check('非 win32：回滚也不写状态文件', !existsSync(STATE_FILE), STATE_FILE)
}

// ── ④ 静态接线：守卫位置 + deps 真通道兜底 ────────────────────────────────────
{
  const up = readFileSync(join(ROOT, '..', 'lib', 'server', 'routes', 'framework-upgrade.js'), 'utf8')
  const idxGuard = up.indexOf('platformUpgradeRefusal()')
  const idxValidate = up.indexOf('plan.rejected !== null')
  const idxBackup = up.indexOf('backupProfileSnapshot(profileDir')
  check('接线：升级路由确实调用平台判据', idxGuard > 0)
  check('接线顺序：入参校验（400 分支）→ 平台守卫 → 任何副作用（备份）',
    idxValidate > 0 && idxBackup > 0 && idxValidate < idxGuard && idxGuard < idxBackup,
    `validate=${idxValidate} guard=${idxGuard} backup=${idxBackup}`)
  check('接线：fetchJson 有真通道兜底（rc.deps.fetchJson ?? fetchJsonUrl）', up.includes('rc.deps.fetchJson ?? fetchJsonUrl'))
  const routesIndex = readFileSync(join(ROOT, '..', 'lib', 'server', 'routes', 'index.js'), 'utf8')
  check('接线：deps 表里 fetchJson 指向真通道（生产不会拿到 undefined）', /fetchJson:\s*fetchJsonUrl/u.test(routesIndex))
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\nPASS ${pass} / FAIL ${failed}${skipped > 0 ? ` / SKIP ${skipped}` : ''}`)
process.exit(failed === 0 ? 0 : 1)
