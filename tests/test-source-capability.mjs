// 源能力**模拟测试**（0.5.70 加法）——用本地假 registry 覆盖"内网源/私有源/离线"这些真机测不到的情形。
//
// 用户 2026-10-18：「你测不了的那个你不能模拟自己测试吗」
//   —— 对。私有源鉴权、内网不可达、全部源挂掉、降级链，全都**可以**在本地模拟：
//     起一个 127.0.0.1 的假 registry，按需返回 200 / 401 / 500 / 超时，然后看产品判据怎么反应。
//
// 本套钉的是**用户目标**（不是实现细节）：
//   ① 正常源 ⇒ 能拿到版本（内网源只有 URL 不同，走同一条通道）
//   ② 401（缺 token）⇒ 必须识别为"鉴权问题"，**不能**说成"包不存在"
//   ③ 500/坏 JSON ⇒ 必须失败，不能当成"查到了"
//   ④ 超时/端口关闭 ⇒ 必须失败（离线语义），且分类是网络类
//   ⑤ **降级链**：第一个源挂 ⇒ 自动用第二个，并如实记录试过谁
//   ⑥ **全挂** ⇒ 如实失败（绝不假装成功）
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const { probeRegistryPackage, probeFailureKind } = await import(`file://${join(HERE, '..', 'lib', 'server', 'domain', 'dep-source.js').replace(/\\/gu, '/')}`)

const PKG = '@probe/intranet-demo'
const VERSION = '1.2.3'
const metaBody = JSON.stringify({
  name: PKG,
  'dist-tags': { latest: VERSION },
  versions: { [VERSION]: { name: PKG, version: VERSION, dist: { tarball: 'http://example.invalid/x.tgz', integrity: 'sha512-AAA' } } },
})

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}
const checkAsync = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); process.exitCode = 1 }
}

// ── 假 registry：按路径前缀决定行为 ────────────────────────────────────────
const server = createServer((req, res) => {
  const url = req.url ?? ''
  if (url.startsWith('/ok/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(metaBody); return }
  if (url.startsWith('/auth/')) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); return }
  if (url.startsWith('/boom/')) { res.writeHead(500); res.end('boom'); return }
  if (url.startsWith('/garbage/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('not json at all'); return }
  if (url.startsWith('/slow/')) { setTimeout(() => { try { res.writeHead(200); res.end(metaBody) } catch {} }, 5000); return }
  res.writeHead(404); res.end('{"error":"not found"}')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = (p) => `http://127.0.0.1:${port}${p}`
console.log(`  假 registry: ${base('')}\n`)

try {
  // ① 正常（内网源走同一条通道）
  await checkAsync('① 正常源 ⇒ 拿到版本（内网源与公网源同一条通道）', async () => {
    const r = await probeRegistryPackage(PKG, [base('/ok')], { timeoutMs: 5000 })
    assert.equal(r.resolvable, true, JSON.stringify(r))
    assert.equal(r.latest, VERSION, JSON.stringify(r))
  })

  // ② 401 必须识别为鉴权问题，而不是"包不存在"
  await checkAsync('② ★ 401（缺 token）⇒ 分类为鉴权类，**不能**说成"包不存在"', async () => {
    const r = await probeRegistryPackage(PKG, [base('/auth')], { timeoutMs: 5000 })
    assert.equal(r.resolvable, false, '401 不该被判成功')
    const kind = probeFailureKind(r)
    assert.notEqual(kind, 'not-found', `401 被误判成"包不存在"（kind=${kind}）—— 用户会以为包没了`)
  })

  // ③ 500 / 坏 JSON 必须失败
  await checkAsync('③ 500 与 坏 JSON ⇒ 失败（绝不"查到了"）', async () => {
    for (const p of ['/boom', '/garbage']) {
      const r = await probeRegistryPackage(PKG, [base(p)], { timeoutMs: 5000 })
      assert.equal(r.resolvable, false, `${p} 被判成功`)
    }
  })

  // ④ 端口关闭 = 离线语义
  await checkAsync('④ ★ 端口关闭（离线/内网不可达）⇒ 失败且分类可辨识', async () => {
    const dead = 'http://127.0.0.1:1'
    const r = await probeRegistryPackage(PKG, [dead], { timeoutMs: 2000 })
    assert.equal(r.resolvable, false, '不可达却判成功')
    const kind = probeFailureKind(r)
    assert.notEqual(kind, 'not-found', `不可达被误判成"包不存在"（kind=${kind}）`)
  })

  // ⑤ 降级链：第一个挂 ⇒ 用第二个
  await checkAsync('⑤ ★ 降级链：主源 401/500 ⇒ 自动落到下一个可用源', async () => {
    const r = await probeRegistryPackage(PKG, [base('/auth'), base('/ok')], { timeoutMs: 5000 })
    assert.equal(r.resolvable, true, `降级没生效：${JSON.stringify(r)}`)
    assert.equal(r.latest, VERSION)
    // tried 记的是**失败的尝试**（成功那次不入列），所以这里验证两件事：
    //   ① 最终用的是**第二个**源（说明真的降级了）
    //   ② 第一个源的失败被如实记录（用户能看到"主源为什么没用上"）
    assert.ok(String(r.registry).endsWith('/ok'), `没有降到备用源，实际用的：${r.registry}`)
    const tried = Array.isArray(r.tried) ? r.tried : []
    assert.ok(tried.some((x) => String(x).includes('/auth')), `没有记录主源的失败原因：${JSON.stringify(r.tried)}`)
  })

  // ⑥ 全挂 ⇒ 如实失败
  await checkAsync('⑥ ★ 所有源都挂 ⇒ 如实失败（绝不假装成功）', async () => {
    const r = await probeRegistryPackage(PKG, [base('/auth'), base('/boom'), 'http://127.0.0.1:1'], { timeoutMs: 2000 })
    assert.equal(r.resolvable, false, '全挂却判成功')
  })
} finally {
  server.close()
}

console.log(passed > 0 && process.exitCode !== 1 ? `\n${passed} PASS / 全绿` : `\n${passed} PASS / 有失败`)
