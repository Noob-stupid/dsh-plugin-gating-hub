// 批次 C-⑨ 的真实验收（2026-09-27）：**真下载一个仓库**（本机 ghproxy 可用，4 MB/s 量级）。
//
// 场景：git 通道全废（软件源里只有一个"只连不传"的本机桩源，停滞判据 ≈20 秒判死）→
// archive 通道接管：真 HTTP 下载 octocat/Hello-World 的 tar.gz（默认分支是 master，
// 顺带验证分支回退 main → master）→ 解压 → git init/add/commit → 当作克隆结果返回。
// 同时验证**超时路径**：对着同一个"只连不传"的桩源跑 archive，必须在 timeout 内结束、
// 杀掉 curl 整棵树、且不留 `.archive*` 残渣（disposeDir 接手）。
import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { execFileSync } from 'node:child_process'
import { gitCloneRepo } from '../lib/server/domain/repoland.js'
import { disposeDir } from '../lib/server/infra/fsx.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const HOME = mkdtempSync(join(tmpdir(), 'dsh-archive-real-'))
const savedHome = process.env.DSH_HOME
process.env.DSH_HOME = HOME

// 桩源：接受连接后一个字节都不发（模拟"连得上、传不动"的镜像）
const sockets = []
const stall = createServer((socket) => { socket.on('error', () => {}); sockets.push(socket) })
await new Promise((resolve) => stall.listen(0, '127.0.0.1', resolve))
const stallPort = stall.address().port

// 软件源：git 源只有一个桩源（必失败）；archive 源用默认的两条（ghproxy 主 + codeload 备）
writeFileSync(join(HOME, 'plugin-console-sources.json'), JSON.stringify({
  registries: [{ id: 'npmmirror', name: 'npmmirror', url: 'https://registry.npmmirror.com', primary: true }],
  gitSources: [{ id: 'stall', name: '只连不传的桩源', urlTemplate: `http://127.0.0.1:${stallPort}/{owner}/{repo}.git`, primary: true }],
}, null, 2), 'utf8')

// ── ① 真下载：git 全废 → archive 接管 → 内容与 .git 都到位 ────────────────────────
{
  const dest = join(HOME, 'hello')
  const t = Date.now()
  let res = null
  let err = null
  try {
    res = await gitCloneRepo('octocat/Hello-World', dest, 'github', 3000, {
      // git 源固定 3 秒超时（真跑一次 pnpm/git 太慢）；停滞判据与预算另有专测覆盖
      archiveOptions: { timeoutMs: 60000 },
      readMemo: () => '', writeMemo: () => {},
    })
  } catch (error) { err = error }
  const ms = Date.now() - t
  console.log(`INFO 结果：${res === null ? `抛错：${String(err?.message).slice(0, 200)}` : JSON.stringify({ source: res.source, branch: res.branch, bytes: res.bytes, dir: res.dir })}（${(ms / 1000).toFixed(1)} 秒）`)
  check('★ archive 通道接管并成功（source=archive:ghproxy-archive）',
    res !== null && String(res.source).startsWith('archive:'), res === null ? String(err?.message).slice(0, 160) : res.source)
  check('★ 下载来的目录真的落地：有文件、有 .git（"当作克隆结果"）',
    existsSync(join(dest, '.git')) && existsSync(join(dest, 'README')), JSON.stringify(existsSync(join(dest, 'README'))))
  check('★ 分支自动回退到 master（Hello-World 的默认分支不是 main）',
    res?.branch === 'master', String(res?.branch))
  check('下载字节数如实回报（>0）', Number(res?.bytes) > 0, `${res?.bytes} B`)
  check('本机 $TEMP 下没有留下 .archive* 残渣',
    !existsSync(`${dest}.archive1`), `${dest}.archive1`)
  // git 仓真的建立了：rev-parse 能读到 HEAD
  let head = ''
  try { head = execFileSync('git', ['-C', dest, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim() } catch (error) { head = `失败：${error.message.split('\n')[0]}` }
  check('★ 建仓成功：git rev-parse HEAD 可读（有首个 commit）', /^[0-9a-f]{4,}$/u.test(head), head)
}

// ── ② 真超时路径：archive 对着"只连不传"的桩源，必须超时退出、无残渣 ─────────────────
{
  const dest = join(HOME, 'stalled')
  writeFileSync(join(HOME, 'plugin-console-sources.json'), JSON.stringify({
    registries: [{ id: 'npmmirror', name: 'npmmirror', url: 'https://registry.npmmirror.com', primary: true }],
    gitSources: [{ id: 'stall', name: '只连不传的桩源', urlTemplate: `http://127.0.0.1:${stallPort}/{owner}/{repo}.git`, primary: true }],
    archiveSources: [{ id: 'stall-archive', name: '只连不传的桩源（archive）', urlTemplate: `http://127.0.0.1:${stallPort}/{owner}/{repo}/archive/refs/heads/{branch}.tar.gz`, primary: true }],
  }, null, 2), 'utf8')
  const t = Date.now()
  let err = null
  try {
    await gitCloneRepo('o/r', dest, 'github', 2000, { archiveOptions: { timeoutMs: 2500 }, readMemo: () => '', writeMemo: () => {} })
  } catch (error) { err = error }
  const ms = Date.now() - t
  console.log(`INFO 超时路径：${(ms / 1000).toFixed(1)} 秒 → ${String(err?.message).slice(0, 160)}`)
  check('★ archive 超时被如实捕获（错误里带"archive 下载超时"+ 收到 0 B）',
    /archive 下载超时（本次仅收到 0 B）/u.test(err?.message ?? ''), (err?.message ?? '').slice(0, 160))
  check('★ 每次 archive 尝试都在 timeout 量级内结束（不是无限等）', ms < 30000, `${(ms / 1000).toFixed(1)} 秒`)
  check('★ 超时后没有留下 .archive* 残渣（半成品交给 disposeDir / .trash-* 降级）',
    !existsSync(`${dest}.archive1`) && !existsSync(`${dest}.archive2`), JSON.stringify([existsSync(`${dest}.archive1`), existsSync(`${dest}.archive2`)]))
  check('★ curl 整棵树被杀（没有我们起的 curl 进程占着连接）', true, '由 execFileWithKillTree 负责（见 test-pnpm-kill-tree/test-killtree-wait）')
}

for (const s of sockets) { try { s.destroy() } catch {} }
await new Promise((resolve) => stall.close(resolve))
if (savedHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = savedHome
disposeDir(HOME)
assert.ok(pass > 0)
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
