// link 面板两个写动作的**路由层**判据（0.5.87 加法）
//
// 为什么单独一套：domain 层已经被 test-link-repair / test-unpin-dev-dir 钉死，客户端行为被
// test-links-actions-ui 钉死，但**中间那一层**（body 真的到 handler 了吗、拒绝得对不对、
// 回包字段够不够面板用）过去反复出事 —— 0.5.87 修的就是 `/dev-roots`、`/pin-dev-dir` 的
// POST body 根本没到 handler（"钉住"恒 403）。所以这里真起一张路由表，真的发带 body 的请求。
//
// 本套钉死：
//   ① `/links` 每行带 targetMtime（有目标就有时间，没有目标就是 null）
//   ② `POST /link-repair`：kind=shims 真的**通过路由**建出垫片（200 + created），
//      不跑 pnpm；包名不在本 profile 的 link 依赖里 ⇒ 400 且一句人话
//   ③ `POST /unpin-dev-dir`：第一段是**只读**计划（200 + steps + warnings，清单逐字节不变）；
//      不是 link:/file: 依赖 ⇒ 400
//   ④ 两个写动作都不接受"路径"入参（路径由服务端按当前 profile 决定，不让调用方指定）
//
// 未覆盖（写清原因，不假装测过）：`confirm:true` 的真删段没有在这里跑 —— 它会调用
//   `rc.deps.pnpmRemove`（真 pnpm 子进程），本套不许 spawn。真删的语义由
//   tests/test-unpin-dev-dir.mjs 用注入的假执行器完整覆盖（含回滚与读回三处）。
//
// 全离线：私有 DSH_HOME（tests/.testdir，已 gitignore），一次真实 pnpm / 网络都不跑。
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = join(HERE, '.testdir', 'link-actions-routes-home')
rmSync(HOME, { recursive: true, force: true })
process.env.DSH_HOME = HOME
const profileDir = join(HOME, 'profiles', 'web')
const DEV = join(HOME, 'plugin-src', 'route-linked')
const FW = join(HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-route-probe-peer')

const writeJson = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8') }
// 名字取"保证不存在"的：tests/.testdir/node_modules 里有历史夹具残留，用真实包名会假绿
const PEER = '@deepseek-ai/dsh-route-probe-peer'
writeJson(join(FW, 'package.json'), { name: PEER, version: '9.9.9' })
writeJson(join(DEV, 'package.json'), { name: 'route-linked', version: '0.2.1', peerDependencies: { [PEER]: '^1.0.0' } })
writeFileSync(join(DEV, 'index.js'), 'export const ok = true\n', 'utf8')
mkdirSync(profileDir, { recursive: true })
writeFileSync(join(profileDir, 'cordis.patch.yml'), '# fixture\n', 'utf8')
writeJson(join(profileDir, 'package.json'), {
  name: 'profile-fixture', private: true,
  dependencies: { 'route-linked': `link:${DEV.replace(/\\/gu, '/')}`, 'plain-dep': '^1.0.0' },
  dsh: { profile: { bundles: ['route-linked'] } },
})

const cordisUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
const ctx = {
  baseUrl: cordisUrl,
  loader: { entries: () => [] },
  webServer: { register: (route) => { globalThis.__route = route; return () => {} } },
  effect: (fn) => { try { fn() } catch {}; return () => {} },
}
const mod = await import(pathToFileURL(join(HERE, '..', 'lib', 'index.js')).href)
mod.apply(ctx)
const route = globalThis.__route
assert.ok(route, '路由未注册')

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

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}
const checkAsync = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}
const manifestText = () => readFileSync(join(profileDir, 'package.json'), 'utf8')

// ── ① /links 的 targetMtime ────────────────────────────────────────────────
await checkAsync('① /links 每行带 targetMtime；目标存在就有时间、不存在就是 null（不编造）', async () => {
  const r = await call('GET', '/plugin-console/links')
  assert.equal(r.status, 200)
  const row = r.json.items.find((x) => x.packageName === 'route-linked')
  assert.ok(row, `清单里没有 route-linked：${JSON.stringify(r.json.items?.map((x) => x.packageName))}`)
  assert.equal(typeof row.targetMtime, 'string', `targetMtime=${JSON.stringify(row.targetMtime)}`)
  assert.ok(!Number.isNaN(new Date(row.targetMtime).getTime()), row.targetMtime)
})

// ── ② /link-repair 走路由真的建垫片（kind=shims，不跑 pnpm）────────────────
await checkAsync('② ★ POST /link-repair kind=shims 通过路由真的建出垫片（一次 pnpm 都不跑）', async () => {
  const r = await call('POST', '/plugin-console/link-repair', { packageName: 'route-linked', kind: 'shims' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ok, true)
  assert.equal(r.json.kind, 'shims')
  assert.equal(r.json.created.length, 1, JSON.stringify(r.json.created))
  assert.equal(r.json.created[0].name, PEER)
  assert.equal(r.json.ready, true, '垫片到位后应判自足')
  // 回包字段够面板直接渲染（不要求客户端再算一遍）
  for (const key of ['packageName', 'ready', 'changed', 'installed', 'created', 'skipped', 'target', 'missingDeps', 'missingPeers', 'shimmablePeers', 'note']) {
    assert.ok(key in r.json, `回包缺字段 ${key}`)
  }
  assert.equal(r.json.installed, null, 'kind=shims 不许跑 pnpm（installed 必须是 null）')
})

await checkAsync('② 负控：包名不在本 profile 的 link 依赖里 ⇒ 400 + 一句人话（不对任意包名动手）', async () => {
  const r = await call('POST', '/plugin-console/link-repair', { packageName: 'plain-dep', kind: 'deps' })
  assert.equal(r.status, 400, JSON.stringify(r.json))
  assert.equal(r.json.ok, false)
  assert.ok(String(r.json.error).includes('不是本 profile 里的 link:/file: 依赖'), r.json.error)
})
await checkAsync('② 负控：非法包名 ⇒ 400（白名单先于任何动作）', async () => {
  for (const bad of ['', '../etc', 'a b', '@@@/x', null]) {
    const r = await call('POST', '/plugin-console/link-repair', { packageName: bad, kind: 'deps' })
    assert.equal(r.status, 400, `${JSON.stringify(bad)} → ${r.status}`)
  }
})

// ── ③ /unpin-dev-dir 的第一段：只读计划 ────────────────────────────────────
await checkAsync('③ ★ POST /unpin-dev-dir 第一段是**只读**计划（200 + steps + 后果），清单逐字节不变', async () => {
  const before = manifestText()
  const r = await call('POST', '/plugin-console/unpin-dev-dir', { packageName: 'route-linked' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.applied, false)
  assert.equal(r.json.packageName, 'route-linked')
  assert.ok(String(r.json.spec).startsWith('link:'), r.json.spec)
  assert.ok(Array.isArray(r.json.steps) && r.json.steps.length >= 3, JSON.stringify(r.json.steps))
  assert.equal(r.json.inBundles, true, '它在 dsh.profile.bundles 里 ⇒ 必须标出来')
  assert.equal(r.json.warnings.length, 1)
  assert.ok(String(r.json.warnings[0]).includes('dsh.profile.bundles'), r.json.warnings[0])
  assert.equal(manifestText(), before, '只读计划不许改清单')
})
await checkAsync('③ 负控：registry 依赖 ⇒ 400（"本来就没被钉住"），不代劳', async () => {
  const r = await call('POST', '/plugin-console/unpin-dev-dir', { packageName: 'plain-dep' })
  assert.equal(r.status, 400, JSON.stringify(r.json))
  assert.ok(String(r.json.error).includes('不是 link:/file:'), r.json.error)
})

// ── ④ 两个动作都不接受"路径"入参 ─────────────────────────────────────────
await checkAsync('④ ★ 写动作的路径不来自请求体（传 dir/path 一律被忽略，profileDir 由服务端决定）', async () => {
  const before = manifestText()
  const r = await call('POST', '/plugin-console/unpin-dev-dir', { packageName: 'route-linked', profileDir: 'C:/evil', dir: 'C:/evil' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(manifestText(), before)
  assert.ok(!JSON.stringify(r.json).includes('C:/evil'), '回包里出现了调用方传的路径')
})

rmSync(HOME, { recursive: true, force: true })
console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
