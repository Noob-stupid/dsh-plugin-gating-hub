// UI 契约测试（0.5.67）——把"界面能不能真的用起来"钉成静态断言。
//
// 为什么需要：2026-10-18 一天之内连续暴露同一类问题 —— **服务端发了，界面用不到**：
//   ① 虚拟行 extra:false，被客户端默认筛选（extraOnly=true）滤掉 ⇒ 插件"发了但看不到"；
//   ② 虚拟行 id `bundle-skipped:@scope/pkg` 含 @ 与 /，被 routeDetails 的 entryId 白名单挡下；
//   ③ routeDetails 只在真实 loader 行里找条目 ⇒ 虚拟行的「详情」直接 404；
//   ④ 详情卡片与列表徽标读了**不同副本**（asar vs profile）⇒ 显示"最新"却永远点不动更新；
//   ⑤ 更新按钮只认 latest ⇒ 官方包发在 next 上时永远"已是最新"。
//
// 前五条我的 HTTP 全量实测都测不出来（状态码全是 200），只能靠**静态契约**钉住：
//   "卡片上的这个动作，背后那条路必须接得住这种 id，且两个值必须来自同一份副本。"
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const CLIENT = read('lib/client.js')
const STATE = read('lib/server/routes/state.js')
const PATHS = read('lib/server/infra/paths.js')
const MARKET_DOMAIN = read('lib/server/domain/market.js')
const FW_ROUTE = read('lib/server/routes/framework.js')
const ROUTES_INDEX = read('lib/server/routes/index.js')

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}

// ── ① 虚拟行必须 extra:true，且客户端默认筛选就是这个键 ──────────────────────
check('① 客户端"只看额外"默认开启（默认筛选 extraOnly=true）', () => {
  assert.match(CLIENT, /const \[extraOnly, setExtraOnly\] = react\.useState\(true\)/u,
    'extraOnly 默认值变了：若改成 false 需重审虚拟行可见性断言')
})
check('① ★ 虚拟行必须 extra:true —— 否则默认筛选会把它滤掉（2026-10-18 事故①）', () => {
  const i = STATE.indexOf('bundle-skipped:')
  assert.ok(i > 0, 'state.js 里找不到虚拟行构造')
  const block = STATE.slice(i, i + 2400)
  assert.match(block, /extra: true,/u, '虚拟行没有 extra: true')
  assert.doesNotMatch(block, /extra: false,/u, '虚拟行里还留着 extra: false')
})

// ── ② entryId 白名单必须放行 scope 包名 ───────────────────────────────────
check('② ★ entryId 白名单必须允许 @ 与 / —— 否则 bundle-skipped:@scope/pkg 直接被挡（事故②）', () => {
  const m = /!\/(\^\[[^\]]+\]\{[^}]+\}\$)\/u\.test\(entryId\)/u.exec(STATE)
  assert.ok(m, 'state.js 里找不到 entryId 白名单正则')
  const re = new RegExp(m[1], 'u')
  assert.equal(re.test('bundle-skipped:@openviking/dsh-memory-plugin'), true, '带 scope 的虚拟行 id 过不了白名单')
  assert.equal(re.test('bundle-skipped:dsh-workbuddy-connect'), true, '普通虚拟行 id 过不了白名单')
  assert.equal(re.test('bad id with space'), false, '白名单过宽：含空格的 id 也被放行了')
})

// ── ③ routeDetails 必须支持虚拟行 ────────────────────────────────────────
check('③ ★ routeDetails 必须认 bundle-skipped: 前缀（否则虚拟行"详情"必 404，事故③）', () => {
  // 前缀值必须与合成端**逐字一致** —— 只验"存在 VIRTUAL_PREFIX"抓不到前缀被改错的情况（反向验证实证）。
  assert.match(STATE, /const VIRTUAL_PREFIX = 'bundle-skipped:'/u, 'VIRTUAL_PREFIX 的字面值与虚拟行 id 前缀不一致')
  assert.match(STATE, /entryId: `bundle-skipped:\$\{b\.packageName\}`/u, '虚拟行 id 不是 bundle-skipped:<包名> 形式')
  assert.match(STATE, /entryId\.startsWith\(VIRTUAL_PREFIX\)/u, '没有按前缀分流')
  assert.match(STATE, /virtual: true/u, '虚拟详情的响应没有 virtual 标记（前端无法区分）')
})

// ── ④ 两个读取点必须用同一份副本（profile 优先）──────────────────────────
check('④ ★ 列表徽标与详情卡片必须都 profile 优先（两处读不同副本 ⇒ 显示最新却点不动更新，事故④）', () => {
  assert.match(PATHS, /const hasProfile = typeof profileDir === 'string'/u, 'entryPkgMeta 没有 profile 优先分支')
  assert.match(PATHS, /resolvePackageJson\(moduleName, profileDir, baseDirOf\(baseUrl\)\)/u, 'entryPkgMeta 不是 profile 优先')
  assert.match(MARKET_DOMAIN, /const hasProfile = typeof profileDir === 'string'/u, 'readPluginDetails 没有 profile 优先分支')
  assert.match(MARKET_DOMAIN, /resolvePackageJson\(moduleName, profileDir, baseDirOf\(baseUrl\)\)/u, 'readPluginDetails 不是 profile 优先')
})

// ── ⑤ 更新检查必须看 next/beta，不能只认 latest ───────────────────────────
check('⑤ ★ /check-update 必须下发 target（latest→next→beta），客户端优先用它（事故⑤）', () => {
  assert.match(FW_ROUTE, /target: pickUpdateTarget\(/u, '/check-update 没有下发 target')
  assert.match(CLIENT, /updateCheck\.target \?\? updateCheck\.latest/u, '客户端没有优先用 target（会退回只认 latest）')
})

// ── ⑥ 卡片上的每个动作都要有对应路由（"点了没反应/404"）──────────────────
check('⑥ ★ 客户端调用的每个 /plugin-console 接口都必须已注册（防"按钮背后没路"）', () => {
  const called = new Set()
  for (const m of CLIENT.matchAll(/call\(\s*"(\/plugin-console\/[^"?]*)/gu)) called.add(m[1])
  const registered = new Set()
  // 全文全局匹配：有些登记行里**一行两条路由**（如 install-status 与 framework-check 同行），
  // 逐行取第一条会漏 ⇒ 假报"没注册"。这里改成 matchAll 全文扫。
  for (const mm of ROUTES_INDEX.matchAll(/path:\s*`\$\{ROUTE_PREFIX\}([^`]+)`/gu)) registered.add(`/plugin-console${mm[1]}`)
  const missing = [...called].filter((p) => !registered.has(p) && !p.endsWith('/'))
  assert.deepEqual(missing, [], `这些接口客户端在调、服务端没注册：${missing.join(', ')}`)
})

// ── ⑦ 虚拟行不许出现"点了必失败"的按钮 ─────────────────────────────────
check('⑦ ★ 虚拟行的开关必须禁用、解锁按钮必须不出现（adoptable 为 null）', () => {
  const i = STATE.indexOf('bundle-skipped:')
  const block = STATE.slice(i, i + 2400)
  assert.match(block, /toggleable: false/u, '虚拟行没标 toggleable:false（开关会可点但无对象可切）')
  assert.match(block, /adoptable: null/u, '虚拟行没把 adoptable 置 null（会出现点了必 409 的解锁按钮）')
  assert.match(CLIENT, /disabled: !entry\.toggleable/u, '客户端开关不再按 toggleable 禁用')
  assert.match(CLIENT, /entry\.adoptable !== null && entry\.adoptable !== undefined/u, '客户端的解锁按钮不再要求 adoptable')
})

// ── ⑧ 虚拟行要能拿到"更新并适配"文案 ────────────────────────────────────
check('⑧ ★ 虚拟行必须 pendingCompat:true，才能拿到「更新并适配」而非「更新」（用户明确要的链路）', () => {
  const i = STATE.indexOf('bundle-skipped:')
  const block = STATE.slice(i, i + 2400)
  assert.match(block, /pendingCompat: true/u, '虚拟行没标 pendingCompat:true')
  assert.match(CLIENT, /entry\.pendingCompat === true \? t\("updateAndAdapt"\)/u, '客户端的"更新并适配"分支不见了')
})

// ── ⑨ 不能只在子组件里定义的辅助函数被主面板误用（沿用既有钉子的最小复核）──
check('⑨ 主面板不得调用只属于 safety tab 的 fill()（0.5.59 空白事故的最小复核）', () => {
  const lines = CLIENT.split('\n')
  const mainStart = lines.findIndex((l) => /^\s*function PluginConsoleTab\(/u.test(l)) + 1
  const safetyStart = lines.findIndex((l) => /^\s*function PluginSafetyTab\(/u.test(l)) + 1
  assert.ok(mainStart > 0 && safetyStart > mainStart, '组件边界定位失败')
  const bad = []
  for (let n = mainStart; n < safetyStart; n += 1) {
    const line = lines[n - 1]
    if (/^\s*\/\//u.test(line)) continue
    if (/\bfill\(/u.test(line)) bad.push(`L${n}`)
  }
  assert.deepEqual(bad, [], `主面板里出现了 fill()（会 ReferenceError）：${bad.join(', ')}`)
})

console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
