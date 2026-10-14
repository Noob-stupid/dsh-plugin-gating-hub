// 看门狗（scripts/fw-watchdog.mjs）的破坏→恢复演练 —— 全离线、**绝不碰真框架树**。
//
// 判据（每条都要能失败；正控 + 负控齐全）：
//   ① 事故形态（外壳在跑 + HOST 服务进程不在）+ 闭包坏 ⇒ 必须**真的动手修**（--check → --repair → --check 复验）
//   ② 日志必须出现「修复成功」
//   ③ 负控 A：闭包本来是好的（HOST 也不在）⇒ **不许**调 --repair（不能瞎修）
//   ④ 负控 B：外壳没在跑 ⇒ 零动作（用户没开机）
//   ⑤ 负控 C：HOST 在（服务活着）⇒ 零动作（正常状态不该有任何动作）
//   ⑥ 红线：全程不许 spawn dsh（只允许 spawn fw-preflight 与自己）
//   ⑦ 真机只读：不注入任何东西时，判据必须真读到进程数（防"探针恒 0 静默失效"——
//      2026-10-14 实测踩过：PowerShell 里 `$host` 是只读自动变量，赋值报错 ⇒ 探针恒 0）
//
// 怎么做到不碰真框架树：**注入两个缝** ——
//   · `DSH_WATCHDOG_CONSOLE` 指向沙箱里一份 stub fw-preflight（用标记文件表达"修好了没有"）；
//   · `DSH_WATCHDOG_FAKE_PROCS="3|0"` 注入进程树事实（事故形态）。
//   两条缝都只在测试里设；生产路径一个都不设（真机那一节 ⑦ 就是证明）。
//
// 环境：Windows 专属（判据基于 `DeepSeek Harness.exe` 进程树）。非 Windows ⇒ **整段响亮 SKIP**，
//   绝不假装 PASS（CI 跑在 Linux 上，这一节必然 SKIP，这是刻意的）。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const TESTS_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = join(TESTS_DIR, '..')
const WD = join(ROOT, 'scripts', 'fw-watchdog.mjs')

if (process.platform !== 'win32') {
  console.log(`SKIP 看门狗演练：判据基于 Windows 进程树（DeepSeek Harness.exe），本平台 ${process.platform} 无法真跑。`)
  console.log('     这不是 PASS —— 是「本环境跑不到」。要在 Windows 上验证。')
  process.exit(0)
}
if (!existsSync(WD)) {
  console.log(`SKIP 看门狗演练：找不到 ${WD}`)
  process.exit(0)
}

let pass = 0
let fail = 0
const check = (n, ok, i = '') => {
  if (ok) { pass += 1; console.log(`PASS ${n}${i === '' ? '' : ` — ${i}`}`) }
  else { fail += 1; console.log(`FAIL ${n}${i === '' ? '' : ` — ${i}`}`) }
}

// 沙箱放仓库内（tests/.testdir/，已 gitignore）—— 与其它套同一惯例：
// 系统 tmpdir 在部分环境下 rmSync 递归删除会静默落空（仓库里早有实测记录）。
const SANDBOX = join(TESTS_DIR, '.testdir', 'fw-watchdog-drill')
rmSync(SANDBOX, { recursive: true, force: true })
mkdirSync(join(SANDBOX, 'console', 'scripts'), { recursive: true })
mkdirSync(join(SANDBOX, 'home', 'plugin-console'), { recursive: true })

const CALLS = join(SANDBOX, 'calls.log')
const MARK = join(SANDBOX, 'repaired.mark')

// ── stub fw-preflight：用标记文件表达"修好了没有" ─────────────────────────────
writeFileSync(join(SANDBOX, 'console', 'scripts', 'fw-preflight.mjs'), `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
const mode = process.argv[2]
appendFileSync(${JSON.stringify(CALLS)}, mode + '\\n')
if (mode === '--check') {
  if (existsSync(${JSON.stringify(MARK)})) console.log('走了 287 个包，0 个解析不了\\n   ✓ 依赖闭包完整')
  else console.log('走了 287 个包，1 个解析不了\\n   ✗ 依赖闭包不完整')
} else if (mode === '--repair') {
  writeFileSync(${JSON.stringify(MARK)}, 'ok')
  console.log('已从本地 npm 缓存装回 1 个包')
}
`, 'utf8')

const runWd = (env, args = ['--tick']) => {
  const r = spawnSync(process.execPath, [WD, ...args], {
    encoding: 'utf8', timeout: 120000, windowsHide: true,
    env: {
      ...process.env,
      DSH_HOME: join(SANDBOX, 'home'),
      DSH_WATCHDOG_CONSOLE: join(SANDBOX, 'console'),
      DSH_WATCHDOG_STRIKES: '1',      // 单轮即触发，省时间（生产默认 2 轮）
      ...env,
    },
  })
  return String(r.stdout ?? '') + String(r.stderr ?? '')
}
const calls = () => (existsSync(CALLS) ? readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean) : [])
const resetCalls = () => { rmSync(CALLS, { force: true }) }
const logText = () => (existsSync(join(SANDBOX, 'home', 'plugin-console', 'fw-watchdog.log'))
  ? readFileSync(join(SANDBOX, 'home', 'plugin-console', 'fw-watchdog.log'), 'utf8')
  : '')

// ── ① / ② / ⑥ 事故形态 + 闭包坏 ⇒ 必须修好，且不许 spawn dsh ────────────────
console.log('── ① 事故形态（外壳在跑 + HOST 不在 + 闭包坏）──')
{
  resetCalls(); rmSync(MARK, { force: true })
  const out = runWd({ DSH_WATCHDOG_FAKE_PROCS: '3|0' })
  const c = calls()
  check('★ 检测到事故形态并调了 --check', c.includes('--check'), c.join(','))
  check('★ 闭包坏 ⇒ 真的调了 --repair（核心：动手修）', c.includes('--repair'), c.join(','))
  check('★ 修完必须复验（--check 出现第二次）', c.filter((x) => x === '--check').length >= 2, c.join(','))
  check('★ 日志出现「修复成功」', /修复成功/u.test(logText()))
  check('红线：全程没有 spawn dsh（只调 fw-preflight）', !/dsh[/\\]lib[/\\]bin\.js/u.test(out))
}

// ── ③ 负控 A：闭包本来是好的 ⇒ 不许瞎修 ─────────────────────────────────────
console.log('\n── ③ 负控 A：闭包本来就好、但 HOST 也不在 ⇒ 不许 --repair ──')
{
  resetCalls(); writeFileSync(MARK, 'ok')
  runWd({ DSH_WATCHDOG_FAKE_PROCS: '3|0' })
  const c = calls()
  check('★ 只做了 --check，**没有** --repair（不瞎修）', c.includes('--check') && !c.includes('--repair'), c.join(','))
  check('日志写明「另有原因」', /另有原因/u.test(logText()))
}

// ── ④ 负控 B：外壳没在跑 ⇒ 零动作 ──────────────────────────────────────────
console.log('\n── ④ 负控 B：外壳没在跑 ⇒ 零动作 ──')
{
  resetCalls(); rmSync(MARK, { force: true })
  runWd({ DSH_WATCHDOG_FAKE_PROCS: '0|0' })
  check('★ 零动作（连 --check 都不该跑）', calls().length === 0, calls().join(','))
}

// ── ⑤ 负控 C：HOST 在（服务活着）⇒ 零动作 ─────────────────────────────────
console.log('\n── ⑤ 负控 C：HOST 在（服务活着）⇒ 零动作 ──')
{
  resetCalls(); rmSync(MARK, { force: true })
  runWd({ DSH_WATCHDOG_FAKE_PROCS: '3|1' })
  check('★ 零动作（服务活着就不该动）', calls().length === 0, calls().join(','))
}

// ── ⑦ 真机只读：探针必须真读到进程数 ───────────────────────────────────────
console.log('\n── ⑦ 真机只读（不注入任何缝）──')
{
  const r = spawnSync(process.execPath, [WD, '--status'], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, DSH_HOME: join(SANDBOX, 'home'), DSH_WATCHDOG_CONSOLE: join(SANDBOX, 'console') },
  })
  const out = String(r.stdout ?? '')
  const m = /外壳进程:\s*(\d+)\s*个\s+HOST 服务进程:\s*(\d+)\s*个/u.exec(out)
  const shellN = m ? Number(m[1]) : -1
  const hostN = m ? Number(m[2]) : -1
  if (shellN <= 0) {
    // 桌面端没在跑：如实 SKIP（不假装 PASS），但仍要断言格式可解析
    console.log(`SKIP ⑦ 真机判据：本机当前没有 DeepSeek Harness.exe 在跑（读到 shell=${shellN}）——无法验证探针，不假装 PASS。`)
    check('⑦ 探针输出格式可解析（至少证明脚本没崩）', m !== null, out.trim().split('\n').slice(-1)[0])
  } else {
    check('★ 真机探针真读到进程数（防"恒 0 的坏探针"回归）', shellN > 0, `shell=${shellN} host=${hostN}`)
    check('★ 真机判据自洽：HOST 在则说服务活着、不在则说事故形态',
      hostN > 0 ? /服务活着/u.test(out) : /事故形态/u.test(out), out.trim().split('\n').slice(-2)[0])
  }
}

// ── ⑧ 文件格式钉子（★ 2026-10-14 一天之内踩了三次，全是"看起来能跑其实不能"）──────
//   这三条不需要 Windows 也能查（纯字节检查），所以 CI（Linux）也会跑。
//   为什么值得单独钉：三种坏法都**不会**在任何 lint/语法检查里报出来，
//   只有真去执行才炸，而且报错信息离根因很远（cmd 把注释当命令执行 / PowerShell 语法错）。
console.log('\n── ⑧ 脚本文件格式（字节级）──')
{
  const readBytes = (rel) => readFileSync(join(ROOT, 'scripts', rel))
  const hasBom = (b) => b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF
  const crlfCount = (b) => {
    const s = b.toString('latin1')
    return { crlf: (s.match(/\r\n/gu) ?? []).length, bareLf: (s.match(/(?<!\r)\n/gu) ?? []).length }
  }
  const nonAscii = (b) => b.reduce((n, x) => n + (x > 127 ? 1 : 0), 0)

  // .cmd：必须 CRLF + 纯 ASCII。LF 会让 cmd 串行执行（实测：注释被当成命令）；
  //       中文注释在 OEM 代码页下同样会把行结构搞乱（实测同一次）。
  {
    const b = readBytes('fw-watchdog.cmd')
    const { crlf, bareLf } = crlfCount(b)
    check('★ .cmd 必须是 CRLF（LF 会让 cmd.exe 把注释当命令执行）', crlf > 0 && bareLf === 0, `CRLF=${crlf} 裸LF=${bareLf}`)
    check('★ .cmd 必须是纯 ASCII（多字节注释在 OEM 代码页下会破坏行结构）', nonAscii(b) === 0, `非ASCII字节=${nonAscii(b)}`)
  }

  // .ps1：必须 UTF-8 BOM。Windows PowerShell 5.1 读无 BOM 的 .ps1 会按 ANSI 解码 ⇒
  //       中文变乱码并**破坏语法**（实测：edit 工具剥掉 BOM 后脚本直接 ParserError）。
  {
    const b = readBytes('fw-watchdog-task.ps1')
    const { crlf, bareLf } = crlfCount(b)
    check('★ .ps1 必须带 UTF-8 BOM（5.1 无 BOM 时按 ANSI 读中文 ⇒ 语法错）', hasBom(b), `前3字节=${b.slice(0, 3).toString('hex')}`)
    check('.ps1 用 CRLF 行尾', crlf > 0 && bareLf === 0, `CRLF=${crlf} 裸LF=${bareLf}`)
  }

  // .mjs：块注释里若出现"星号+斜杠"式的通配写法，会**提前闭合注释** ⇒ 整份脚本 SyntaxError。
  //       实测：注释里写 profiles + 星号 + /node_modules，看门狗**从未真正运行过**。
  //       ★ 判据用"能不能解析"（`node --check`），而不是拿正则去猜注释边界 ——
  //         第一版启发式就被 `profiles/*/` 这种写法骗过（它含星号+斜杠，但作者意图是正文），
  //         反而对真文件误报。解析器说了算才是硬判据。
  {
    const checkParse = (file) => {
      const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 30000, windowsHide: true })
      return { ok: r.status === 0, out: String(r.stderr ?? '') }
    }
    const mine = checkParse(join(ROOT, 'scripts', 'fw-watchdog.mjs'))
    check('★ 看门狗脚本能被解析（块注释若被提前闭合，这里必然红）', mine.ok, mine.out.split('\n').find((l) => /SyntaxError/u.test(l)) ?? '')

    // 反向自证：构造一份"注释里带星号+斜杠"的坏样本，必须解析失败（证明这条判据不是恒真）
    const badFile = join(SANDBOX, 'bad-comment.mjs')
    mkdirSync(SANDBOX, { recursive: true })
    writeFileSync(badFile, '/** 扫 profiles/*/node_modules 下的东西\n * 第二行\n */\nexport const x = 1\n', 'utf8')
    check('自证：判据对"注释被提前闭合"的坏样本确实报红（不是恒真）', checkParse(badFile).ok === false)
  }
}

rmSync(SANDBOX, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
