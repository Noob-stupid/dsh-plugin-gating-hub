// 覆盖 2026-09-26 真机故障的第三段：git 源策略（本机网络：直连 github.com 不通，唯一可用源是 ghproxy）
//   · 直连 github.com 探活失败 → 跳过（这是对的），但**唯一可用源 ghproxy 超时后就彻底失败**。
// 本次加法三件套：
//   ① 同一个源超时后，用**更长超时重试一次**（默认 1.75 倍；可注入 retryFactor）
//   ② **记住上次成功的 git 源**（进程内 + 状态文件），下次优先用它
//   ③ 探活判据保留「403/405 视为存活」（HEAD 不被支持的镜像不能被误杀）
// 全部离线：spawn / probe / removeDir / renameDir / memo 全部注入。

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { gitCloneRepo, orderGitCandidates, readGitSourceMemo, rememberGitSource } from '../lib/server/domain/repoland.js'
import { gitCloneCandidates, gitCloneUrls } from '../lib/server/domain/sources.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const DEST = join(tmpdir(), `dsh-git-source-probe-${process.pid}`, 'x')
const noMemo = { readMemo: () => '', writeMemo: () => {} }

/** 假 git：第 1 次卡死（超时），第 2 次成功；用于验证"同源更长超时重试后成功"。
 *  2026-09-27：只对**有进度**的源重试，所以第 1 次要在目标目录写下 .git/objects 字节。 */
function spawnTimeoutThenSuccess(seen) {
  return (bin, argv) => {
    seen.push(argv)
    if (seen.length === 1) {
      const part = argv[argv.length - 1]
      try {
        mkdirSync(join(part, '.git', 'objects', 'pack'), { recursive: true })
        writeFileSync(join(part, '.git', 'objects', 'pack', 'tmp_pack_x'), 'x'.repeat(2048))
      } catch {}
    }
    const handlers = {}
    const child = { pid: 6000 + seen.length, stderr: { on() {} }, on(event, cb) { handlers[event] = cb }, handlers }
    if (seen.length > 1) setImmediate(() => handlers.close?.(0))
    return child
  }
}

// ① 同源更长超时重试：第一个源先超时、重试后成功 → 不应该再去试第二个源
{
  const seen = []
  const memoWrites = []
  const res = await gitCloneRepo('octocat/Hello-World', DEST, 'github', 100, {
    spawnFn: spawnTimeoutThenSuccess(seen),
    killTree: () => true,
    archive: null, // 专测 git 路径：不让 archive 通道接上真网络
    probe: async () => true,
    removeDir: () => ({ ok: true, attempts: 1, rounds: 1 }),
    renameDir: () => {},
    exitWaitMs: 20,
    readMemo: () => '',
    writeMemo: (tpl) => memoWrites.push(tpl),
  })
  check('第一个源超时后**同源重试**并成功（不再直接放弃）', seen.length === 2 && res.retried === true && res.source === 'ghproxy-git', `spawn ${seen.length} 次 / retried=${res.retried} source=${res.source}`)
  check('重试成功后**记住这个源**（供下次优先）', memoWrites.length === 1 && /ghproxy\.net/u.test(memoWrites[0]), memoWrites.join('|'))
  check('成功返回里带上源 id 与尝试次数（可观测）', res.url.includes('ghproxy.net') && typeof res.tries === 'number', JSON.stringify({ url: res.url, tries: res.tries }))
}

// ② 记住的源优先：ghproxy 记在案，第二个源（GitHub 直连）即使 primary 也不会被先试
{
  const candidates = gitCloneCandidates('a/b')
  const preferred = candidates[candidates.length - 1].urlTemplate // 故意记"直连"
  const ordered = orderGitCandidates(candidates, preferred)
  check('记住的源被提到最前（其余顺序不变）', ordered[0].urlTemplate === preferred && ordered.length === candidates.length, ordered.map((c) => c.id).join(' > '))
  check('没有记忆时顺序完全不变（纯加法）', JSON.stringify(orderGitCandidates(candidates, '').map((c) => c.url)) === JSON.stringify(candidates.map((c) => c.url)))
  check('记忆的模板不在候选里时顺序不变（换仓库/换配置也安全）', JSON.stringify(orderGitCandidates(candidates, 'https://gitee.com/{owner}/{repo}.git').map((c) => c.url)) === JSON.stringify(candidates.map((c) => c.url)))
  check('gitCloneCandidates 与 gitCloneUrls 顺序一致（同一份排序逻辑）', JSON.stringify(candidates.map((c) => c.url)) === JSON.stringify(gitCloneUrls('a/b')))
  check('gitee 源也有候选描述（不破坏 gitee 直连）', gitCloneCandidates('a/b', 'gitee')[0].url === 'https://gitee.com/a/b.git')
}

// ③ 记忆优先真的体现在克隆顺序上：把"直连"记成上次成功的源 → 第一个被尝试的必须是直连
{
  let firstProbed = null
  const seen = []
  const err = await (async () => {
    try {
      await gitCloneRepo('a/b', DEST, 'github', 60, {
        spawnFn: (bin, argv) => { seen.push(argv); const h = {}; return { pid: 7000 + seen.length, stderr: { on() {} }, on(e, cb) { h[e] = cb } } },
        killTree: () => true,
        archive: null, // 专测 git 路径：不让 archive 通道接上真网络
        probe: async (url) => { if (firstProbed === null) firstProbed = url; return true },
        removeDir: () => ({ ok: true, attempts: 1, rounds: 1 }),
        renameDir: () => {},
        exitWaitMs: 10,
        readMemo: () => 'https://github.com/{owner}/{repo}.git',
        writeMemo: () => {},
      })
      return null
    } catch (error) { return error }
  })()
  check('记忆的源被**优先探活**（不再白等 ghproxy 超时）', firstProbed === 'https://github.com/a/b.git', String(firstProbed))
  assert.ok(err !== null, '两个源都卡死时必须抛错')
}

// ④ 状态文件读写（进程内缓存 + 文件落盘）——用隔离 DSH_HOME，绝不碰真实用户目录
{
  const home = mkdtempSync(join(tmpdir(), 'dsh-memo-'))
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    // 记忆缓存是模块级的：这里只验证"写盘格式 + 读回"，用子进程隔离读
    rememberGitSource('https://ghproxy.net/https://github.com/{owner}/{repo}.git')
    const file = join(home, 'plugin-console', 'git-source-memo.json')
    check('记住的源落盘到 ~/.dsh/plugin-console/git-source-memo.json（跨进程/跨实例可用）', existsSync(file), file)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    check('状态文件内容可读且带时间戳', raw.template === 'https://ghproxy.net/https://github.com/{owner}/{repo}.git' && typeof raw.at === 'number', JSON.stringify(raw))
    check('进程内缓存立刻生效（读回同一个模板）', readGitSourceMemo() === raw.template)
    // 子进程冷读：验证文件确实是"跨进程"的记忆
    const out = execFileSync(process.execPath, ['-e',
      `import(${JSON.stringify(new URL('../lib/server/domain/repoland.js', import.meta.url).href)}).then((m)=>{process.stdout.write(m.readGitSourceMemo())})`,
    ], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', windowsHide: true })
    check('另一个进程冷启动能读到同一个源（真·跨进程记忆）', out.trim() === raw.template, out.trim())
    // 损坏文件不该炸（回退空串）
    writeFileSync(file, '{ this is not json', 'utf8')
    const broken = execFileSync(process.execPath, ['-e',
      `import(${JSON.stringify(new URL('../lib/server/domain/repoland.js', import.meta.url).href)}).then((m)=>{process.stdout.write('['+m.readGitSourceMemo()+']')})`,
    ], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', windowsHide: true })
    check('状态文件损坏时安全回退（不抛错、不阻断安装）', broken.trim() === '[]', broken.trim())
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
  }
  try { execFileSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', home], { windowsHide: true, stdio: 'ignore' }) } catch {}
  try { rmSync(home, { recursive: true, force: true }) } catch {}
}

// ⑤ 探活判据：403/405（HEAD 不被支持的镜像）必须视为存活 —— 本机 ghproxy.net HEAD 就是 403
{
  const { probeSourceAlive } = await import('../lib/server/domain/repoland.js')
  const realFetch = globalThis.fetch
  const stub = (status, ok = false) => async () => ({ ok, status })
  try {
    globalThis.fetch = stub(403)
    check('探活：403 视为存活（ghproxy 这类镜像不支持 HEAD）', (await probeSourceAlive('https://ghproxy.net/x')) === true)
    globalThis.fetch = stub(405)
    check('探活：405 视为存活', (await probeSourceAlive('https://mirror/x')) === true)
    globalThis.fetch = stub(200, true)
    check('探活：200 视为存活', (await probeSourceAlive('https://ok/x')) === true)
    globalThis.fetch = stub(404)
    check('探活：404 视为不存活（域名在但仓库/路径没了）', (await probeSourceAlive('https://x/y')) === false)
    globalThis.fetch = async () => { throw new Error('fetch failed') }
    check('探活：连不上（fetch 抛错）视为不存活 → 跳过，省一整个克隆超时', (await probeSourceAlive('https://github.com/a/b.git')) === false)
  } finally {
    globalThis.fetch = realFetch
  }
}

// ⑥ 真机网络探针（只读、不克隆）：确认本机 ghproxy 存活 / 直连 github 不可达 —— 供 B 段实测前校准
{
  const { probeSourceAlive } = await import('../lib/server/domain/repoland.js')
  const ghproxy = await probeSourceAlive('https://ghproxy.net/https://github.com/octocat/Hello-World.git', 8000)
  const direct = await probeSourceAlive('https://github.com/octocat/Hello-World.git', 8000)
  console.log(`INFO 实网探活：ghproxy=${ghproxy ? '存活' : '不可达'} / github 直连=${direct ? '存活' : '不可达'}`)
  check('实网探活结果与「唯一可用源是 ghproxy」一致（直连不可达时 ghproxy 必须存活）', direct === true || ghproxy === true, `ghproxy=${ghproxy} direct=${direct}`)
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
