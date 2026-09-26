// 覆盖 2026-09-26 真机故障（官方桌面端里装 git 源插件）：
//   ghproxy 卡死 → 我们超时到了但**没杀 git 进程** → git/remote-https/index-pack 常驻占住 .git 里的文件
//   → 目标目录删不掉 → 旧代码谎报「当前环境禁止删除」并**放弃后续源**（break）。
// 本测试全部离线（注入 spawn/探活/删除/改名），断言四件事：
//   ① 超时会调用 killTree（杀整棵进程树）
//   ② 每次尝试用**不同的**新目录（.try1 / .try2），残留不再连锁失效
//   ③ 清理失败（unclean）后**仍然继续试下一个源**（旧代码会 break）
//   ④ 错误信息给出真实原因 + 可复制的手动删除命令（不再谎报环境禁止删除）

import { strict as assert } from 'node:assert'
import { gitCloneRepo, summarizeCloneErrors } from '../lib/server/domain/repoland.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

/** 假 git 进程：永不 close（模拟卡死），但可被 killTree 观测到。 */
function fakeHangingSpawn(seen) {
  return (bin, argv, opts) => {
    seen.push({ bin, argv, opts })
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

const DEST = 'C:/tmp/whatever/dsh-suite-job-9'

// ① + ② + ④：两个源都超时 → 杀树两次、用两个不同目录、报真实原因与手动删除命令
{
  const seen = []
  const kills = []
  const dirs = []
  const err = await (async () => {
    try {
      await gitCloneRepo('zhu1090093659/dsh-web', DEST, 'github', 120, {
        spawnFn: fakeHangingSpawn(seen),
        killTree: (pid) => { kills.push(pid); return true },
        probe: async () => true,
        removeDir: (dir) => { dirs.push(dir); return { ok: true } },
        renameDir: () => {},
      })
      return null
    } catch (error) { return error }
  })()
  check('超时：两个源都被尝试', seen.length === 2, `spawn ${seen.length} 次`)
  check('超时：每次都调用了 killTree（杀整棵进程树）', kills.length === 2, `killTree ${kills.length} 次：${kills.join(',')}`)
  const tried = seen.map((s) => s.argv[s.argv.length - 1])
  check('每次尝试用不同新目录（残留不再连锁失效）', tried[0] !== tried[1] && /\.try1$/u.test(tried[0]) && /\.try2$/u.test(tried[1]), tried.join(' | '))
  check('错误信息标出「超时，进程已结束」', /超时，进程已结束/u.test(err?.message ?? ''), (err?.message ?? '').slice(0, 90))
  check('错误信息不再谎报「环境禁止删除」', !/环境禁止删除/u.test(err?.message ?? ''))
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
  check('错误信息给出可复制的手动删除命令', /Remove-Item -Recurse -Force/u.test(err?.message ?? ''), (err?.message ?? '').slice(0, 60))
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
