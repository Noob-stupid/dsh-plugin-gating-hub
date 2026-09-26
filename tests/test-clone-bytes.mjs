// 批次 B-⑧（2026-09-27 加法）：报错必须带上"本次收到多少字节"。
//
// 为什么：真机 ghproxy 的失败是 **0 B/s**（一个字节都没传），而"慢但在传"的源只是需要更久。
// 只写"超时"两个字，用户（和面板）无法判断该换源还是该再等；字节数是唯一的事实依据。
// 这条事实同时是"要不要用更长超时重试"的判据（见 A-②，只有 bytesReceived > 0 才重试）。
import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gitCloneRepo, summarizeCloneErrors, measureProgressBytes } from '../lib/server/domain/repoland.js'
import { disposeDir } from '../lib/server/infra/fsx.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const ROOT = join(tmpdir(), `dsh-clone-bytes-${process.pid}`)
const DEST = join(ROOT, 'bytes-0')
const DEST2 = join(ROOT, 'bytes-n')
disposeDir(ROOT)

// ── ① 纯函数：超时文案带字节数（0 B / N B / 缺失字段三种）──────────────────────
{
  const zero = summarizeCloneErrors([{ url: 'https://ghproxy.net/x.git', message: '克隆超时', timedOut: true, bytesReceived: 0 }])
  check('★ 0 B 的超时写成"本次仅收到 0 B"（用户立刻明白是镜像只连不传）',
    /https:\/\/ghproxy\.net\/x\.git（超时，进程已结束；本次仅收到 0 B）/u.test(zero), zero.slice(0, 120))
  const some = summarizeCloneErrors([{ url: 'https://m/x.git', message: '克隆超时', timedOut: true, bytesReceived: 20480 }])
  check('★ 有字节的超时写成"本次已收到 20480 B"（说明在传、只是慢）',
    /本次已收到 20480 B/u.test(some), some.slice(0, 120))
  const unknown = summarizeCloneErrors([{ url: 'https://m/x.git', message: '克隆超时', timedOut: true }])
  check('没有 bytesReceived 字段时不瞎编数字（只报"超时，进程已结束"）',
    /超时，进程已结束）/u.test(unknown) && !/本次/u.test(unknown), unknown.slice(0, 120))
}

// ── ② 量字节：优先 .git/objects（git 边下边写的进度所在），没有则量整个目录 ──────────
{
  const plain = join(ROOT, 'plain')
  mkdirSync(join(plain, 'sub'), { recursive: true })
  writeFileSync(join(plain, 'a.txt'), 'x'.repeat(100), 'utf8')
  writeFileSync(join(plain, 'sub', 'b.txt'), 'y'.repeat(23), 'utf8')
  check('只量 .git/objects：目录里没有它时退化成量整棵树（123 B）', measureProgressBytes(plain) === 123, String(measureProgressBytes(plain)))
  const gitDir = join(ROOT, 'withgit')
  mkdirSync(join(gitDir, '.git', 'objects', 'pack'), { recursive: true })
  writeFileSync(join(gitDir, '.git', 'objects', 'pack', 'tmp_pack_x'), 'z'.repeat(4096), 'utf8')
  writeFileSync(join(gitDir, 'huge-other-file.txt'), 'q'.repeat(99999), 'utf8')
  check('★ 有 .git/objects 时**只**看它（4096 B，不被仓库里其它文件干扰）',
    measureProgressBytes(gitDir) === 4096, String(measureProgressBytes(gitDir)))
}

// ── ③ 端到端：真跑一次"卡死但已经落了 N 字节"的克隆，错误里必须带这个 N ──────────────
function hangingSpawnWithBytes(bytes) {
  return (bin, argv) => {
    if (bytes > 0) {
      const part = argv[argv.length - 1]
      try {
        mkdirSync(join(part, '.git', 'objects', 'pack'), { recursive: true })
        writeFileSync(join(part, '.git', 'objects', 'pack', 'tmp_pack_x'), 'x'.repeat(bytes), 'utf8')
      } catch {}
    }
    return { pid: 9500, stderr: { on() {} }, on() {} } // 永不 close
  }
}
async function cloneAndCatch(dest, bytes) {
  try {
    await gitCloneRepo('o/r', dest, 'github', 120, {
      spawnFn: hangingSpawnWithBytes(bytes),
      killTree: () => true,
      probe: async () => true,
      removeDir: () => ({ ok: true, attempts: 1, rounds: 1 }),
      renameDir: () => {},
      readMemo: () => '', writeMemo: () => {},
    })
    return null
  } catch (error) { return error }
}

const zeroErr = await cloneAndCatch(DEST, 0)
check('★ 端到端（0 进度）：错误清单里出现"本次仅收到 0 B"',
  /本次仅收到 0 B/u.test(zeroErr?.message ?? ''), (zeroErr?.message ?? '').slice(0, 160))
check('0 进度同时写进首个错误：无进度 → 不再用更长超时重试',
  /本次收到 0 B（无进度，不再用更长超时重试）/u.test(zeroErr?.message ?? ''), (zeroErr?.message ?? '').slice(0, 160))

const nErr = await cloneAndCatch(DEST2, 8192)
check('★ 端到端（有进度）：错误清单里出现"本次已收到 8192 B"',
  /本次已收到 8192 B/u.test(nErr?.message ?? ''), (nErr?.message ?? '').slice(0, 200))
check('有进度 → 用更长超时重试（判据取自同一个字节数）',
  /改用 \d+ms 同源重试/u.test(nErr?.message ?? ''), (nErr?.message ?? '').slice(0, 160))

disposeDir(ROOT)
assert.ok(pass > 0)
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
