// 批次 A-①（2026-09-27）：git 克隆的**停滞判据** —— 连续 20 秒 <1 B/s 让 git 自己退出。
//
// 真机证据（本机 2026-09-27）：同一个 ghproxy.net 域名下
//   · archive（HTTP GET）4 MB/s，429 MB / 105 秒能下完；
//   · git 协议 0 B/s，`git clone` 挂满整个超时（旧默认 180 秒 × 3 个源 = 9 分钟白等）。
// 处置：把「停滞」交给 git 自己判（`-c http.lowSpeedLimit=1 -c http.lowSpeedTime=20`），
// 一个"只连不传"的源 ≈20 秒即报 `Operation too slow` 并立刻换下一个源。
//
// 三段断言（前两段离线、第三段用**本机 TCP 桩源**，不碰外网）：
//   ① spawnFn 收到的 argv 前几项就是这两个 `-c`，且排在子命令 `clone` 之前
//   ② 真 git 接受这两个选项（`git -c … --version`），并真的对着"只连不传"的桩源 ≈20 秒判死
//   ③ 走完整 gitCloneRepo：桩源卡死 → **自动换到下一个源**（本机裸仓库 file://）并克隆成功
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { execFileSync } from 'node:child_process'
import { GIT_STALL_ARGS, gitCloneRepo } from '../lib/server/domain/repoland.js'
import { gitBin } from '../lib/server/infra/exec.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const git = (args, opts = {}) => execFileSync(gitBin(), args, { encoding: 'utf8', windowsHide: true, ...opts })

// ── ① argv 形状（离线，钉死"停滞判据真的传给了 git"）────────────────────────────
{
  const seen = []
  const DEST = join(tmpdir(), 'dsh-stall-argv', 'x')
  await gitCloneRepo('octocat/Hello-World', DEST, 'github', 50, {
    spawnFn: (bin, argv) => {
      seen.push({ bin, argv })
      const handlers = {}
      setImmediate(() => handlers.close?.(0))
      return { pid: 5150, stderr: { on() {} }, on(event, cb) { handlers[event] = cb } }
    },
    killTree: () => true,
    archive: null, // 专测 git 路径：不让 archive 通道接上真网络
    probe: async () => true,
    removeDir: () => ({ ok: true, attempts: 1, rounds: 1 }),
    renameDir: () => {},
    readMemo: () => '', writeMemo: () => {},
  })
  const argv = seen[0]?.argv ?? []
  check('★ spawnFn 收到 git，argv 前 4 项就是停滞判据的两个 -c（顺序固定）',
    argv[0] === '-c' && argv[1] === 'http.lowSpeedLimit=1' && argv[2] === '-c' && argv[3] === 'http.lowSpeedTime=20',
    argv.slice(0, 6).join(' '))
  check('停滞判据排在子命令 clone 之前（git 全局选项必须在前，否则会被当成 clone 的参数）',
    argv.indexOf('clone') === 4 && argv.indexOf('clone') > argv.lastIndexOf('http.lowSpeedTime=20'),
    argv.join(' '))
  check('GIT_STALL_ARGS 导出且内容与实测一致（1 B/s × 20 秒）',
    GIT_STALL_ARGS.length === 4 && GIT_STALL_ARGS.includes('http.lowSpeedLimit=1') && GIT_STALL_ARGS.includes('http.lowSpeedTime=20'),
    GIT_STALL_ARGS.join(' '))
}

// ── ② 真 git：接受这两个选项，且对"只连不传"的桩源 ≈20 秒判死 ────────────────────
{
  const version = git([...GIT_STALL_ARGS, '--version']).trim()
  check('真 git 接受 `-c http.lowSpeedLimit/-c http.lowSpeedTime`（不是我们编的选项名）', /^git version/u.test(version), version)

  // 桩源：TCP 接受连接后**一个字节都不发**（模拟"连得上、传不动"的镜像），持续到测试结束
  const sockets = []
  const server = createServer((socket) => { sockets.push(socket) /* 故意不写任何响应 */ })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const target = join(tmpdir(), `dsh-stall-probe-target-${Date.now().toString(36)}`)
  const t = Date.now()
  let stderr = ''
  try {
    git([...GIT_STALL_ARGS, 'clone', '--depth', '1', '--quiet', `http://127.0.0.1:${port}/o/r.git`, target],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 })
  } catch (error) {
    stderr = String(error.stderr ?? error.message ?? '')
  }
  const ms = Date.now() - t
  check('★ "只连不传"的桩源：git 在 ~20 秒（<45 秒）内自己退出，而不是挂满超时',
    ms < 45000 && ms > 12000, `${(ms / 1000).toFixed(1)} 秒`)
  check('★ 退出原因是速率为 0（Operation too slow / low speed）—— 用户能看懂的一句话',
    /too slow|low speed|timed out/iu.test(stderr), JSON.stringify(stderr.trim().split('\n').slice(-2).join(' | ')))
  for (const s of sockets) { try { s.destroy() } catch {} }
  await new Promise((resolve) => server.close(resolve))
  try { rmSync(target, { recursive: true, force: true }) } catch {}
}

// ── ③ 完整 gitCloneRepo：桩源卡死 → 自动换下一个源（本机裸仓库）并成功 ─────────────
// 用隔离 DSH_HOME 写「软件源」配置：主源 = 只连不传的桩源，备用源 = 本机 file:// 裸仓库
// （模板里的 {owner}/{repo} 是**配置占位符**，替换后落在 <root>/o/r.git 上；全程不出本机）。
{
  const home = mkdtempSync(join(tmpdir(), 'dsh-stall-home-'))
  const root = join(home, 'www')
  const work = join(home, 'work')
  const bare = join(root, 'o', 'r.git')
  const dest = join(home, 'clone-target')
  mkdirSync(work, { recursive: true })
  mkdirSync(join(root, 'o'), { recursive: true })
  writeFileSync(join(work, 'a.txt'), 'hello\n', 'utf8')
  git(['init', '-q'], { cwd: work })
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: work })
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: work })
  git(['clone', '-q', '--bare', work, bare])

  const sockets = []
  const server = createServer((socket) => { sockets.push(socket) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  writeFileSync(join(home, 'plugin-console-sources.json'), JSON.stringify({
    registries: [{ id: 'npmmirror', name: 'npmmirror', url: 'https://registry.npmmirror.com', primary: true }],
    gitSources: [
      { id: 'stall', name: '只连不传的桩源', urlTemplate: `http://127.0.0.1:${port}/{owner}/{repo}.git`, primary: true },
      { id: 'local-bare', name: '本机裸仓库', urlTemplate: `file:///${root.replace(/\\/gu, '/')}/{owner}/{repo}.git`, primary: false },
    ],
  }, null, 2), 'utf8')

  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const t = Date.now()
  let res = null
  let err = null
  try {
    res = await gitCloneRepo('o/r', dest, 'github', 120000, {
      probe: async () => true, // 探活单独由 ②/⑦ 覆盖；这里只量"卡死 → 换源"的时延
      readMemo: () => '', writeMemo: () => {},
    })
  } catch (error) { err = error } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    for (const s of sockets) { try { s.destroy() } catch {} }
    await new Promise((resolve) => server.close(resolve))
  }
  const ms = Date.now() - t
  check('★ 主源"只连不传"→ 停滞判据判死后**进入下一个源**并克隆成功', res !== null, err === null ? JSON.stringify({ url: res?.url, source: res?.source }) : String(err?.message))
  check('★ 落在备用源上（source = local-bare），全程 <60 秒（旧行为：3 个源 × 180 秒白等）',
    res?.source === 'local-bare' && ms < 60000, `${(ms / 1000).toFixed(1)} 秒 / source=${res?.source}`)
  check('克隆结果真的落地（含 .git 与文件）', existsSync(join(dest, '.git')) && existsSync(join(dest, 'a.txt')), dest)
  check('停滞的源真的耗掉了 ~20 秒判死时间（不是"直接跳过"的假成功）', ms >= 18000, `${(ms / 1000).toFixed(1)} 秒`)
  try { rmSync(home, { recursive: true, force: true }) } catch {}
}
assert.ok(pass > 0)
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
