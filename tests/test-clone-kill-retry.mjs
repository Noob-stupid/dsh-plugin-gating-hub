// 覆盖 2026-09-26 真机故障（官方桌面端里装 git 源插件）：
//   ghproxy 卡死 → 我们超时到了但**没杀 git 进程** → git/remote-https/index-pack 常驻占住 .git 里的文件
//   → 目标目录删不掉 → 旧代码谎报「当前环境禁止删除」并**放弃后续源**（break）。
// 本测试全部离线（注入 spawn/探活/删除/改名），断言四件事：
//   ① 超时会调用 killTree（杀整棵进程树），且等不到退出会补杀一次（2026-09-26 加法）
//   ② 每次尝试用**不同的**新目录（.try1 / .try2），残留不再连锁失效
//   ③ 清理失败（unclean）后**仍然继续试下一个源**（旧代码会 break）
//   ④ 错误信息给出真实原因 + 可复制的手动删除命令（不再谎报环境禁止删除）

import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gitCloneRepo, summarizeCloneErrors } from '../lib/server/domain/repoland.js'
import { disposeDir } from '../lib/server/infra/fsx.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

/** 假 git 进程：永不 close（模拟卡死），但可被 killTree 观测到。
 *  2026-09-27：可选写入 `.git/objects` 字节 —— 有进度才配"同源更长超时重试"（见 repoland 的停滞/进度判据）。 */
function fakeHangingSpawn(seen, progressBytes = 0) {
  return (bin, argv, opts) => {
    seen.push({ bin, argv, opts })
    if (progressBytes > 0) {
      const part = argv[argv.length - 1]
      try {
        mkdirSync(join(part, '.git', 'objects', 'pack'), { recursive: true })
        writeFileSync(join(part, '.git', 'objects', 'pack', 'tmp_pack_x'), 'x'.repeat(progressBytes))
      } catch {}
    }
    return {
      pid: 4242 + seen.length,
      stderr: { on() {} },
      on() {}, // 永不触发 close/error
    }
  }
}

/** 假 git 进程：立刻以指定退出码结束。 */
function fakeFailingSpawn(seen, code = 128, stderr = 'fatal: unable to access remote') {
  return (bin, argv, opts) => {
    seen.push({ bin, argv, opts })
    const handlers = {}
    setImmediate(() => { handlers.close?.(code) })
    return {
      pid: 9000 + seen.length,
      stderr: { on(event, cb) { if (event === 'data') cb(stderr) } },
      on(event, cb) { handlers[event] = cb },
    }
  }
}

// 临时目录清理必须走 disposeDir：本机 %TEMP% 下 `rmSync` 会**静默落空**（不抛错、目录还在），
// 用 rmSync 清理会让"上一块的 `.try1` 残留"污染下一块的进度判据（2026-09-27 本测试实测）。
const ROOTDIR = join(tmpdir(), `dsh-clone-kill-retry-${process.pid}`)
const DEST = join(ROOTDIR, 'dsh-suite-job-9')
const DEST2 = join(ROOTDIR, 'dsh-suite-job-9-noprogress')
disposeDir(ROOTDIR)

// ① + ② + ④：两个源都超时 —— **有进度**的源才会"同源更长超时重试一次"（2026-09-27 判据），
//    所以这里让假 git 写入 .git/objects 字节（模拟"慢但在传"），期望 2 源 × 2 次 = 4 次尝试。
{
  const seen = []
  const kills = []
  const dirs = []
  const err = await (async () => {
    try {
      await gitCloneRepo('zhu1090093659/dsh-web', DEST, 'github', 120, {
        spawnFn: fakeHangingSpawn(seen, 4096),
        killTree: (pid) => { kills.push(pid); return true },
        probe: async () => true,
        removeDir: (dir) => { dirs.push(dir); return { ok: true } },
        renameDir: () => {},
        readMemo: () => '', writeMemo: () => {},
      })
      return null
    } catch (error) { return error }
  })()
  // 2026-09-26：同一个源超时后会用**更长超时重试一次**（源策略），所以 2 个源 = 4 次尝试
  check('超时：两个源都被尝试，且各自同源重试一次（2 源 × 2 次 = 4）', seen.length === 4, `spawn ${seen.length} 次`)
  check('超时：每次都调用了 killTree，且等不到退出会补杀一次（4 次尝试 × 2 = 8）', kills.length === 8, `killTree ${kills.length} 次`)
  const timeoutPair = (err?.message ?? '').match(/克隆超时（(\d+)ms，本次已收到 (\d+) B），改用 (\d+)ms 同源重试/u)
  check('同源重试用的是更长超时（≥1.5 倍，真机"慢但在传"场景）',
    timeoutPair !== null && Number(timeoutPair[3]) >= Number(timeoutPair[1]) * 1.5,
    timeoutPair === null ? '（文案里没有重试超时信息）' : `${timeoutPair[1]}ms → ${timeoutPair[3]}ms`)
  check('★ 重试文案带上"本次已收到多少字节"（有进度才重试的事实依据）',
    timeoutPair !== null && Number(timeoutPair[2]) >= 4096, timeoutPair === null ? '（无）' : `${timeoutPair[2]} B`)
  const tried = seen.map((s) => s.argv[s.argv.length - 1])
  check('每次尝试用不同的新目录（残留不再连锁失效）', new Set(tried).size === tried.length && /\.try1$/u.test(tried[0]) && /\.try2$/u.test(tried[1]), tried.join(' | '))
  check('错误信息标出「超时，进程已结束」与「已改用更长超时重试」', /超时，进程已结束/u.test(err?.message ?? '') && /已改用更长超时重试/u.test(err?.message ?? ''), (err?.message ?? '').slice(0, 130))
  check('错误信息不再谎报「环境禁止删除」', !/环境禁止删除/u.test(err?.message ?? ''))
  check('错误信息把「源数」与「尝试次数」分开报（4 次尝试 / 2 个源）', /已尝试 2 个源（共 4 次尝试）/u.test(err?.message ?? ''), (err?.message ?? '').slice(0, 80))
  disposeDir(DEST)
}

// ①-b（2026-09-27 加法）：**0 B 的源不做长超时重试** —— 真机 ghproxy 卡死就是 0 B/s，
// 再用 1.75 倍超时重试只是把白等从 60 秒拉长到 105 秒。同一个源只试一次，把时间留给下一个源。
{
  const seen = []
  const err = await (async () => {
    try {
      await gitCloneRepo('zhu1090093659/dsh-web', DEST2, 'github', 120, {
        spawnFn: fakeHangingSpawn(seen, 0), // 一个字节都不写 = 0 进度
        killTree: () => true,
        probe: async () => true,
        removeDir: () => ({ ok: true }),
        renameDir: () => {},
        readMemo: () => '', writeMemo: () => {},
      })
      return null
    } catch (error) { return error }
  })()
  check('★ 0 B（无进度）的源：2 个源各只试 1 次（不再无条件长超时重试）', seen.length === 2, `spawn ${seen.length} 次`)
  check('★ 文案如实说明"本次收到 0 B（无进度，不再用更长超时重试）"',
    /本次收到 0 B（无进度，不再用更长超时重试）/u.test(err?.message ?? ''), (err?.message ?? '').slice(0, 130))
  disposeDir(ROOTDIR)
}

// ③：第一个源失败且**清理不掉**（残留被占用）→ 仍然继续试第二个源
{
  const seen = []
  let removeCalls = 0
  const err = await (async () => {
    try {
      await gitCloneRepo('zhu1090093659/dsh-web', DEST, 'github', 120, {
        spawnFn: fakeFailingSpawn(seen),
        killTree: () => true,
        probe: async () => true,
        // 目标目录（.tryN）永远删不掉 → 模拟被 git 占用的残留
        removeDir: () => { removeCalls += 1; return { ok: false, error: 'EBUSY' } },
        renameDir: () => {},
      })
      return null
    } catch (error) { return error }
  })()
  check('清理失败后仍继续试下一个源（旧代码会 break）', seen.length === 2, `spawn ${seen.length} 次 / removeDir ${removeCalls} 次`)
  check('错误信息含「残留目录被占用，已跳过重试」与实际原因', /残留目录被占用/u.test(err?.message ?? '') && !/环境禁止删除/u.test(err?.message ?? ''))
  // 2026-09-26（本次改错）：不再给手动删除命令 —— 删不掉的残留由 disposeDir 改名降级成 `.trash-*`，
  // 连改名都失败时也只说"控制台会在后台自动重试清理"。
  check('错误信息不再要求用户手动删除（改说后台自动重试清理）',
    !/Remove-Item/u.test(err?.message ?? '') && !/请手动删除/u.test(err?.message ?? '') && /控制台会在后台自动重试清理/u.test(err?.message ?? ''),
    (err?.message ?? '').slice(-90))
}

// 探活失败 → 直接跳过，不启动 git
{
  const seen = []
  const err = await (async () => {
    try {
      await gitCloneRepo('a/b', DEST, 'github', 120, {
        spawnFn: fakeFailingSpawn(seen),
        killTree: () => true,
        probe: async () => false,
        removeDir: () => ({ ok: true }),
        renameDir: () => {},
        readMemo: () => '', writeMemo: () => {},
      })
      return null
    } catch (error) { return error }
  })()
  check('源探活失败 → 完全不启动 git', seen.length === 0, `spawn ${seen.length} 次`)
  check('探活失败在错误清单里标为「探活失败，已跳过」', /探活失败，已跳过/u.test(err?.message ?? ''))
}

// 成功路径：第一个源探活通过 + clone 成功 → try1 改名成 dest
{
  const renames = []
  const res = await gitCloneRepo('a/b', DEST, 'github', 120, {
    spawnFn: (bin, argv, opts) => {
      const handlers = {}
      setImmediate(() => handlers.close?.(0))
      return { pid: 7777, stderr: { on() {} }, on(event, cb) { handlers[event] = cb } }
    },
    killTree: () => true,
    probe: async () => true,
    removeDir: () => ({ ok: true }),
    renameDir: (from, to) => { renames.push([from, to]) },
    readMemo: () => '', writeMemo: () => {},
  })
  check('成功后把 .try1 落成目标目录并返回 dest', res?.dir === DEST && renames.length === 1 && renames[0][1] === DEST, JSON.stringify(renames))
}

// 纯函数：错误汇总措辞（含探活跳过 / 超时 / 残留三种标注）
{
  const msg = summarizeCloneErrors([
    { url: 'https://ghproxy.net/https://github.com/a/b.git', message: '克隆超时', timedOut: true },
    { url: 'https://github.com/a/b.git', message: '克隆失败，且残留目录无法清理：C:/t/x.try2', unclean: true, dir: 'C:/t/x.try2' },
    { url: 'https://gitee.com/a/b.git', message: '连不上', skipped: true },
  ])
  check('汇总：三种标注齐全', /超时，进程已结束/u.test(msg) && /残留目录被占用/u.test(msg) && /探活失败，已跳过/u.test(msg))
  check('汇总：报第一个错误（真实原因）', /首个错误：克隆超时/u.test(msg), msg.slice(0, 70))
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
