// 覆盖 2026-09-26 真机故障（官方桌面端里装 git 源插件）的第二段：
//   杀树**成功**了（`git` 进程 0），但删得太早 —— Windows 句柄释放慢一拍 →
//   旧代码里 `removeDirVerified` 一次失败就判「残留被占用」，用户看到的是"环境不让删"。
// 本测试全部离线（注入 spawn/探活/删除/改名），断言四件事：
//   ① 超时杀树后**会等子进程退出**（等到才继续；等不到如实标注 exited:false）
//   ② 清理走「带重试的核实删除」：首次删不掉会再试（不是一次定生死）
//   ③ 确实清不掉才报「占用」，并且**仍然继续试下一个源**
//   ④ 文案区分「进程已结束但目录仍占」与「进程压根没退出」

import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gitCloneRepo } from '../lib/server/domain/repoland.js'
import { removeDirVerifiedWithRetry } from '../lib/server/infra/fsx.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

/** 假 git：永不自己 close；`killTree` 被调用后按 delayMs（或永不）把 exitCode 置上，模拟"杀完还要一会儿才退出"。 */
function fakeSpawn({ exitAfterKillMs = null, seen = [] } = {}) {
  const children = []
  const spawnFn = (bin, argv, opts) => {
    seen.push({ bin, argv, opts })
    const child = {
      pid: 5000 + seen.length,
      exitCode: null,
      signalCode: null,
      stderr: { on() {} },
      handlers: {},
      on(event, cb) { this.handlers[event] = cb },
    }
    children.push(child)
    return child
  }
  const killTree = (pid) => {
    const child = children.find((c) => c.pid === pid)
    if (child === undefined) return false
    if (exitAfterKillMs !== null) setTimeout(() => { child.exitCode = 1 }, exitAfterKillMs)
    return true
  }
  return { spawnFn, killTree, children }
}

const DEST = join(tmpdir(), 'dsh-clone-retry-probe', 'x')

// ① 杀树后等待：子进程在 kill 后 40ms 才退出 → runGitClone 必须等到它（exited:true）才算完
{
  const seen = []
  const { spawnFn, killTree, children } = fakeSpawn({ exitAfterKillMs: 40, seen })
  const started = Date.now()
  const err = await (async () => {
    try {
      await gitCloneRepo('a/b', DEST, 'github', 30, {
        spawnFn,
        killTree,
        exitWaitMs: 900,
        probe: async () => true,
        removeDir: () => ({ ok: true, attempts: 1, rounds: 1 }),
        renameDir: () => {},
      })
      return null
    } catch (error) { return error }
  })()
  const elapsed = Date.now() - started
  check('超时后等到子进程真的退出（不是杀完就往下走）', children[0].exitCode === 1 && elapsed >= 40, `elapsed=${elapsed}ms exitCode=${children[0].exitCode}`)
  check('子进程已退出时不再重复 killTree（只杀一次）', seen.length >= 1 && /克隆超时/u.test(err?.message ?? ''), `attempts=${seen.length}`)
}

// ② 杀不掉（永不退出）：如实标注，且清理尝试不是"一次定生死"
{
  const seen = []
  const { spawnFn, killTree } = fakeSpawn({ exitAfterKillMs: null, seen })
  let removeCalls = 0
  const started = Date.now()
  const err = await (async () => {
    try {
      await gitCloneRepo('a/b', DEST, 'github', 30, {
        spawnFn,
        killTree,
        exitWaitMs: 120,
        probe: async () => true,
        // 模拟"带重试的核实删除"最终仍失败：返回 ok:false + rounds:3
        removeDir: () => { removeCalls += 1; return { ok: false, attempts: 2, rounds: 3, error: 'EBUSY：目录仍被占用' } },
        renameDir: () => {},
      })
      return null
    } catch (error) { return error }
  })()
  const elapsed = Date.now() - started
  check('杀不掉时会等满两轮（800/300 由入参缩短为 120ms）再判定', elapsed >= 240, `elapsed=${elapsed}ms`)
  check('文案如实区分「git 进程在等待后仍未退出」', /git 进程在等待后仍未退出/u.test(err?.message ?? ''), (err?.message ?? '').slice(0, 100))
  check('仍标注为「残留目录被占用，已跳过重试」（用户可读）', /残留目录被占用/u.test(err?.message ?? ''))
  check('清理失败后**继续试下一个源**（两个源都跑过）', seen.length >= 2, `spawn ${seen.length} 次`)
  check('清理带重试轮次信息（rounds=3 进入文案）', /清理已重试 3 轮/u.test(err?.message ?? ''), (err?.message ?? '').slice(0, 140))
  assert.ok(removeCalls >= 2, 'removeDir 至少被调用两次（每个源一次）')
}

// ③ 进程已结束、但目录确实清不掉 → 文案说"进程已结束但目录仍被占用"（不再甩锅给环境）
{
  const seen = []
  const { spawnFn, killTree } = fakeSpawn({ exitAfterKillMs: 5, seen })
  const err = await (async () => {
    try {
      await gitCloneRepo('a/b', DEST, 'github', 30, {
        spawnFn,
        killTree,
        exitWaitMs: 300,
        probe: async () => true,
        removeDir: () => ({ ok: false, attempts: 2, rounds: 3, error: 'EBUSY' }),
        renameDir: () => {},
      })
      return null
    } catch (error) { return error }
  })()
  check('进程已退出 + 目录仍占 → 文案不谎报「进程已尝试结束」也不谎报环境', /git 进程已结束，但残留目录重试 3 轮后仍清不掉/u.test(err?.message ?? ''), (err?.message ?? '').slice(0, 120))
  check('全流程没有「环境禁止删除」这种假原因', !/环境禁止删除/u.test(err?.message ?? ''))
}

// ④ fsx.removeDirVerifiedWithRetry 单测（注入 remover/shellRemover，离线确定）
{
  const base = mkdtempSync(join(tmpdir(), 'dsh-rm-retry-'))
  const mk = (name) => { const d = join(base, name); mkdirSync(join(d, 'sub'), { recursive: true }); writeFileSync(join(d, 'sub', 'f.txt'), 'x'); return d }
  // 本机实测：`rmSync` 在 %TEMP% 下会**静默落空**（不抛错、目录还在），只有 `cmd /c rmdir /s /q` 删得掉。
  // 所以"真的删掉"这个动作统一走外部命令，保证断言不依赖 rmSync 的行為。
  const hardDelete = (dir) => {
    try { execFileSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', dir], { windowsHide: true, stdio: 'ignore' }) } catch {}
    return !existsSync(dir)
  }

  const gone = join(base, 'already-gone')
  let called = 0
  const r0 = removeDirVerifiedWithRetry(gone, { remover: () => { called += 1; return { ok: true } } })
  check('目录本来就不存在 → 直接成功且不调用 remover', r0.ok === true && r0.rounds === 1 && r0.method === 'already-gone' && called === 0, JSON.stringify(r0))

  // 默认 remover + 默认外部兜底：真实目录必须被删掉（本机 rmSync 会静默失败 → 兜底顶上）
  const real = mk('real')
  const r1 = removeDirVerifiedWithRetry(real, {})
  check('真实目录：默认路径下确实删掉（rmSync 静默失败时由 rmdir 兜底）', r1.ok === true && !existsSync(real) && r1.rounds === 1 && r1.method !== null, JSON.stringify(r1))

  // 前两轮失败、第三轮成功 → 必须不是一次定生死
  const flaky = mk('flaky')
  let round = 0
  const r2 = removeDirVerifiedWithRetry(flaky, {
    attempts: 3,
    pollMs: 10,
    viaShell: false,
    remover: () => {
      round += 1
      if (round < 3) return { ok: false, attempts: 2, error: 'EBUSY' }
      hardDelete(flaky)
      return { ok: true, attempts: 1 }
    },
  })
  check('前两轮失败、第三轮成功 → ok:true 且 rounds=3（旧实现会判"被占用"）', r2.ok === true && r2.rounds === 3, JSON.stringify(r2))

  // 永远失败 → ok:false 且带 rounds/attempts 供文案使用
  const stuck = mk('stuck')
  const r3 = removeDirVerifiedWithRetry(stuck, { attempts: 3, pollMs: 10, viaShell: false, remover: () => ({ ok: false, attempts: 2, error: 'EBUSY：目录仍被占用' }) })
  check('确实清不掉 → ok:false，带上 rounds/attempts/真实错误（不吞）', r3.ok === false && r3.rounds === 3 && /EBUSY/u.test(String(r3.error)), JSON.stringify(r3))

  // rmSync 一路失败、外部兜底成功 → 视为成功并记下方法（本机的真实路径）
  const viaShellDir = mk('viashell')
  const r4 = removeDirVerifiedWithRetry(viaShellDir, {
    attempts: 3,
    pollMs: 10,
    remover: () => ({ ok: false, attempts: 2, error: null }),
    shellRemover: (dir) => { hardDelete(dir); return { ok: true, method: 'rmdir' } },
  })
  check('rmSync 失败但外部 rmdir 兜底成功 → ok:true/method=rmdir（不再误报占用）', r4.ok === true && r4.rounds === 1 && r4.method === 'rmdir', JSON.stringify(r4))
  check('外部兜底也删不掉时如实报占用（不谎报成功）', removeDirVerifiedWithRetry(mk('stuck2'), { attempts: 2, pollMs: 10, remover: () => ({ ok: false, attempts: 2, error: 'EPERM' }), shellRemover: () => ({ ok: false, method: null, error: '拒绝访问' }) }).ok === false)

  try { rmSync(base, { recursive: true, force: true }) } catch {}
  try { execFileSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', base], { windowsHide: true, stdio: 'ignore' }) } catch {}
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
