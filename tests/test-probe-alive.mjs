// 批次 B-⑦（2026-09-27 改错）：探活判据与"一次定生死"。
//
// 三个缺口（真机动机）：
//   ① 探活失败的源被判**永久 skipped** —— 一次瞬时抖动（DNS、代理刚起来）就让唯一可用源再没机会；
//   ② 探活用 `HEAD /`，只验"域名活着"：返回 200 的错误页 / 登录页 / 根本不是 git 服务的镜像照样算活，
//      于是白等一整个克隆超时；
//   ③ 报错不区分"网络不可达"与"本地代理/证书拦截" —— 本机装了 Steam++ 这类加速器时，
//      用户看到的是 `unable to get local issuer certificate`，重试永远没用，他需要的是"关掉加速器"。
//
// 全部离线：fetch 与 spawn 都注入。
import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gitCloneRepo, probeSourceAlive, probeSourceAliveDetail, gitInfoRefsUrl, classifyProbeFailure, summarizeCloneErrors } from '../lib/server/domain/repoland.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const DEST = join(tmpdir(), `dsh-probe-alive-${process.pid}`, 'x')

// ── ① 探活地址：必须打到 git 协议的真实入口 ──────────────────────────────────
{
  check('★ 探活地址是 <url>/info/refs?service=git-upload-pack（不再是 HEAD /）',
    gitInfoRefsUrl('https://ghproxy.net/https://github.com/o/r.git') === 'https://ghproxy.net/https://github.com/o/r.git/info/refs?service=git-upload-pack',
    gitInfoRefsUrl('https://ghproxy.net/https://github.com/o/r.git'))
  check('结尾多了斜杠也不会拼出 //info/refs',
    gitInfoRefsUrl('https://mirror/o/r.git/') === 'https://mirror/o/r.git/info/refs?service=git-upload-pack')
}

// ── ② 判据：pkt-line 校验 / 403·405 兼容 / file:// 本地源 ─────────────────────
const stub = (impl) => async () => impl()
{
  const pkt = await probeSourceAliveDetail('https://mirror/o/r.git', 100, { fetch: stub(() => ({ ok: true, status: 200, text: async () => '001e# service=git-upload-pack\n0000' })) })
  check('★ 200 + pkt-line 首行 → 活着（kind=git）', pkt.alive === true && pkt.kind === 'git', JSON.stringify(pkt))

  const html = await probeSourceAliveDetail('https://mirror/o/r.git', 100, { fetch: stub(() => ({ ok: true, status: 200, text: async () => '<!DOCTYPE html><html>登录</html>' })) })
  check('★ 200 + HTML 错误页/登录页 → 不存活（旧 HEAD 判据会当成"活着"白等一次克隆）',
    html.alive === false && html.kind === 'not-git' && html.note.includes('不像 git 服务'), JSON.stringify(html))

  const noBody = await probeSourceAliveDetail('https://mirror/o/r.git', 100, { fetch: stub(() => ({ ok: true, status: 200 })) })
  check('响应体读不到时保守按活着处理（不误杀只回状态码的镜像）', noBody.alive === true, JSON.stringify(noBody))

  const forbidden = await probeSourceAliveDetail('https://mirror/o/r.git', 100, { fetch: stub(() => ({ ok: false, status: 403 })) })
  check('403 / 405 仍按"活着"处理（老判据保留，不误杀镜像）',
    forbidden.alive === true && (await probeSourceAlive('https://mirror/o/r.git', 100, { fetch: stub(() => ({ ok: false, status: 405 })) })) === true, JSON.stringify(forbidden))

  const gone = await probeSourceAliveDetail('https://mirror/o/r.git', 100, { fetch: stub(() => ({ ok: false, status: 404 })) })
  check('404 → 不存活（域名在但仓库/路径没了）', gone.alive === false && gone.kind === 'http', JSON.stringify(gone))

  const local = await probeSourceAliveDetail('file:///D:/repos/o/r.git', 100, { fetch: stub(() => { throw new Error('fetch 不该被调用') }) })
  check('★ file:// 本地裸仓库直接算活着（旧代码一律判死 → 完全离线/内网共享盘场景永远用不上）',
    local.alive === true && local.kind === 'local', JSON.stringify(local))
}

// ── ③ 归因：网络不可达 vs 本地代理/证书拦截（后者必须提示关加速器）──────────────
{
  const tls = classifyProbeFailure(Object.assign(new Error('fetch failed'), { cause: new Error('unable to get local issuer certificate') }))
  check('★ 证书类失败 → "本地代理/证书拦截" + 提示关闭加速器/代理',
    tls.kind === 'intercepted' && tls.note.includes('本地代理/证书拦截') && tls.note.includes('加速器') && tls.note.includes('建议关闭后重试'), tls.note)
  const selfSigned = classifyProbeFailure(new Error('self signed certificate in certificate chain'))
  check('自签证书同样归到"本地代理/证书拦截"', selfSigned.kind === 'intercepted', selfSigned.note)
  const dns = classifyProbeFailure(new Error('getaddrinfo ENOTFOUND github.com'))
  check('★ DNS/连接失败 → "网络不可达"（不含加速器措辞，避免误导）',
    dns.kind === 'unreachable' && dns.note.includes('网络不可达') && !dns.note.includes('加速器'), dns.note)
  const detail = await probeSourceAliveDetail('https://github.com/o/r.git', 100, { fetch: stub(() => { throw Object.assign(new Error('fetch failed'), { cause: new Error('unable to verify the first certificate') }) }) })
  check('★ 探活整体失败时也带上归因（错误清单里直接可读）',
    detail.alive === false && detail.kind === 'intercepted' && detail.note.includes('加速器'), detail.note)
}

// ── ④ 探活失败的源不再"一次定生死"：降级到最后一轮再试 ───────────────────────
{
  const seen = []
  const failed = { ok: false, attempts: 1, rounds: 1 }
  const spawnOk = (bin, argv) => {
    seen.push(argv[argv.length - 1])
    const handlers = {}
    setImmediate(() => handlers.close?.(0))
    return { pid: 8000 + seen.length, stderr: { on() {} }, on(event, cb) { handlers[event] = cb } }
  }
  // 第一个源探活失败（会被降级），第二个源探活通过
  const probes = { 'https://ghproxy.net': false, 'https://github.com': true }
  let res = null
  let err = null
  try {
    res = await gitCloneRepo('o/r', DEST, 'github', 50, {
      spawnFn: spawnOk,
      killTree: () => true,
      archive: null, // 专测 git 路径：不让 archive 通道接上真网络
      probeDetail: async (url) => (Object.entries(probes).find(([k]) => url.startsWith(k))?.[1] === true
        ? { alive: true, kind: 'git', status: 200, note: '' }
        : { alive: false, kind: 'unreachable', status: null, note: '网络不可达（getaddrinfo ENOTFOUND）' }),
      removeDir: () => failed,
      renameDir: () => {},
      readMemo: () => '', writeMemo: () => {},
    })
  } catch (error) { err = error }
  check('★ 探活通过的源先试（不看源顺序也能用上能用的源）', res !== null && res.source === 'github-git', res === null ? String(err?.message).slice(0, 120) : res.source)
  check('第一个源（探活失败）**没有被启动**——它只是被降级，不是被拿来当下一个尝试',
    seen.length === 1, seen.join(' | '))
}
{
  // 两个源探活都失败 → 都降级到最后一轮；每个源各试一次（无进度 → 不做长超时重试）
  const seen = []
  const spawnFail = (bin, argv) => {
    seen.push(argv[argv.length - 1])
    const handlers = {}
    setImmediate(() => handlers.close?.(128))
    return { pid: 8100 + seen.length, stderr: { on(event, cb) { if (event === 'data') cb('fatal: unable to access') } }, on(event, cb) { handlers[event] = cb } }
  }
  let err = null
  try {
    await gitCloneRepo('o/r', DEST, 'github', 50, {
      spawnFn: spawnFail,
      killTree: () => true,
      archive: null, // 专测 git 路径：不让 archive 通道接上真网络
      probeDetail: async () => ({ alive: false, kind: 'intercepted', status: null, note: '本地代理/证书拦截（unable to get local issuer certificate）—— 检测到本机加速器/代理，建议关闭后重试' }),
      removeDir: () => ({ ok: true, attempts: 1, rounds: 1 }),
      renameDir: () => {},
      readMemo: () => '', writeMemo: () => {},
    })
  } catch (error) { err = error }
  check('★ 探活失败的源降级到最后一轮**真的被尝试**（旧代码 0 次）', seen.length === 2, `spawn ${seen.length} 次`)
  check('★ 首条错误就是"探活失败的原因"（含加速器提示），用户一眼能看到真相',
    /源探活失败（本地代理\/证书拦截/u.test(err?.message ?? '') && /加速器/u.test(err?.message ?? ''), (err?.message ?? '').slice(0, 150))
  check('汇总里标明"已降级到本轮末尾重试"（不再说"已跳过"，避免用户以为没试）',
    /探活失败，已降级到本轮末尾重试/u.test(err?.message ?? '') && !/探活失败，已跳过/u.test(err?.message ?? ''), (err?.message ?? '').slice(0, 200))
}

// ── ⑤ 汇总的新旧文案（纯函数回归）─────────────────────────────────────────────
{
  const msg = summarizeCloneErrors([
    { url: 'https://ghproxy.net/x.git', message: '源探活失败（网络不可达）：…', skipped: true },
    { url: 'https://ghproxy.net/x.git', message: '克隆超时（…）', timedOut: true, deferred: true, bytesReceived: 0 },
    { url: 'https://github.com/x.git', message: '克隆失败', stderr: 'fatal: could not read', deferred: true, bytesReceived: 0 },
  ])
  check('探活记录 → "已降级到本轮末尾重试"；重试记录 → "探活失败的源，已在本轮末尾重试"',
    /已降级到本轮末尾重试/u.test(msg) && /探活失败的源，已在本轮末尾重试/u.test(msg), msg.slice(0, 220))
}

assert.ok(pass > 0)
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
