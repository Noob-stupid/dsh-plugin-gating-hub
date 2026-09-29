// D4 + 本机化纪律回归（0.5.32 加法）：
//   · D4：检测到**桌面端宿主形态**时，把**非用户手动设定**的运行模式自动拨回观察者；
//     用户手动拨过（source='manual'，含缺字段的老记录）→ **永不自动改**；已是 observer → **零写盘**；
//     非桌面形态 → 不动；来源字段读写往返正确（含老记录兼容）。
//   · 纪律：本轮新增/改动的**所有源码与测试**里，本机绝对路径 / 用户名 **0 出现**
//     （扫描断言，进 CI 硬门槛；允许清单逐条写清理由）。
//
// 全离线：私有 DSH_HOME（临时目录）；不重启任何实例、不碰真实 profile。
import { readFileSync, rmSync, mkdirSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(ROOT, '..')
const HOME = join(ROOT, '.testdir', 'desktop-host-home')
process.env.DSH_HOME = HOME
process.env.DSH_TEST_SKIP_NETWORK = '1'
rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })

const { MODE_SOURCES, planDesktopHostSwitch, readCompatMode, writeCompatMode } = await import('../lib/server/domain/compat-state.js')
const { maybeSwitchToObserver, resetHostSwitchChecked } = await import('../lib/server/routes/compat.js')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const modeFile = () => join(HOME, 'plugin-console', 'compat-mode.json')
const readModeRaw = () => JSON.parse(readFileSync(modeFile(), 'utf8'))
/** 「零写盘」判据：内容 + mtime 都不许变（内容相同但被重写也算写盘）。 */
function freeze(path) {
  const st = statSync(path)
  const past = new Date(Date.now() - 86400000)
  utimesSync(path, past, past)
  return { text: readFileSync(path, 'utf8'), mtimeMs: statSync(path).mtimeMs, size: st.size }
}
const untouched = (path, snap) => {
  const st = statSync(path)
  return readFileSync(path, 'utf8') === snap.text && st.mtimeMs === snap.mtimeMs
}
const HOSTED = { hosted: true, kind: 'desktop-shell', reasons: ['process.versions.electron=30'] }
const STANDALONE = { hosted: false, kind: 'standalone', reasons: [] }

// ── ① 判定是纯函数：四种结局 ────────────────────────────────────────────────
{
  check('① 桌面形态 + auto:console-upgrade（非手动）→ 切观察者', (() => {
    const v = planDesktopHostSwitch({ mode: 'managed', source: 'auto:console-upgrade' }, { hosted: true })
    return v.action === 'switch-to-observer' && v.mode === 'observer' && typeof v.note?.zh === 'string' && typeof v.note?.en === 'string'
  })())
  check('① ★ 桌面形态 + manual（用户手动拨过）→ 不动', planDesktopHostSwitch({ mode: 'managed', source: 'manual' }, { hosted: true }).action === 'none' && planDesktopHostSwitch({ mode: 'managed', source: 'manual' }, { hosted: true }).reason === 'user-set-manual')
  check('① ★ 缺 source 的老记录按 manual 兼容 → 不动（不抢用户意图）', planDesktopHostSwitch({ mode: 'managed' }, { hosted: true }).action === 'none' && planDesktopHostSwitch({ mode: 'managed', at: 1, reason: 'x' }, { hosted: true }).from === 'manual')
  check('① 非桌面形态（独立 dsh web）→ 不动（既有行为一字不改）', planDesktopHostSwitch({ mode: 'managed', source: 'auto:console-upgrade' }, { hosted: false }).action === 'none')
  check('① 已是 observer → 不动（幂等）', planDesktopHostSwitch({ mode: 'observer', source: 'auto:console-upgrade' }, { hosted: true }).reason === 'already-observer')
  check('① 来源白名单齐全（manual / auto:console-upgrade / auto:desktop-host）', MODE_SOURCES.join() === 'manual,auto:console-upgrade,auto:desktop-host', MODE_SOURCES.join())
}

// ── ② 来源字段读写往返（含老记录兼容）───────────────────────────────────────
{
  const user = writeCompatMode('managed', { source: 'manual', reason: '用户手动切换' })
  check('② 手动拨动 → source=manual（写入成功）', user.ok === true && user.source === 'manual' && readModeRaw().source === 'manual', JSON.stringify(readModeRaw()))
  const autoUpgrade = writeCompatMode('managed', { source: 'auto:console-upgrade', reason: '使用本控制台执行框架升级' })
  check('② 控制台升级的自动切换 → source=auto:console-upgrade', autoUpgrade.ok === true && readModeRaw().source === 'auto:console-upgrade', JSON.stringify(readModeRaw()))
  check('② 读回：mode/source/reason 三者一致', readCompatMode().mode === 'managed' && readCompatMode().source === 'auto:console-upgrade' && readCompatMode().reason === '使用本控制台执行框架升级')
  const autoHost = writeCompatMode('observer', { source: 'auto:desktop-host', reason: '检测到桌面端托管' })
  check('② 自动拨回记录 → source=auto:desktop-host（可被后续判定识别）', autoHost.ok === true && readCompatMode().source === 'auto:desktop-host')
  const bad = writeCompatMode('god-mode', { source: 'manual' })
  check('② 非法模式仍被拒（既有语义不变）', bad.ok === false && typeof bad.error === 'string')
  // 老记录（0.5.32 之前没有 source 字段）→ 兼容成 manual
  writeFileSync(modeFile(), JSON.stringify({ mode: 'managed', at: Date.now(), reason: null }), 'utf8')
  check('② ★ 老记录（无 source）读回 = manual（这才是"永不自动改"的兼容依据）', readCompatMode().source === 'manual' && readCompatMode().fileSource === 'file', JSON.stringify(readCompatMode()))
}

// ── ③ maybeSwitchToObserver（路由侧接线）：三种现场 + 零写盘证据 ──────────────
{
  const rcHosted = { ctx: {}, deps: { detectHostShape: () => HOSTED } }
  const rcStandalone = { ctx: {}, deps: { detectHostShape: () => STANDALONE } }
  // ③-1 桌面形态 + auto:console-upgrade → 自动切 + 给原因
  resetHostSwitchChecked() // "首次状态查询才判定"这条规则由 ③-5 单独断言；这里显式驱动首次判定
  writeCompatMode('managed', { source: 'auto:console-upgrade', reason: '使用本控制台执行框架升级' })
  const switched = maybeSwitchToObserver(rcHosted, { force: true })
  check('③ ★ 桌面形态 + auto → 真的切到 observer', switched.switched === true && readCompatMode().mode === 'observer' && readCompatMode().source === 'auto:desktop-host', JSON.stringify({ mode: readCompatMode().mode, source: readCompatMode().source }))
  check('③ ★ 带回一行简短原因（中英双语）', typeof switched.note?.zh === 'string' && typeof switched.note?.en === 'string' && switched.note.zh.includes('观察者'), JSON.stringify(switched.note))
  // ③-2 已是 observer → 零写盘
  {
    const snap = freeze(modeFile())
    const again = maybeSwitchToObserver(rcHosted, { force: true })
    check('③ ★ 已是 observer → 零写盘（内容与 mtime 都不变）', again.switched === false && untouched(modeFile(), snap), JSON.stringify({ reason: again.reason }))
  }
  // ③-3 用户手动设定过 → 永不动 + 零写盘
  {
    writeCompatMode('managed', { source: 'manual', reason: '用户手动切换' })
    const snap = freeze(modeFile())
    const kept = maybeSwitchToObserver(rcHosted, { force: true })
    check('③ ★ 用户手动拨过 → 不动（且零写盘）', kept.switched === false && kept.reason === 'user-set-manual' && readCompatMode().mode === 'managed' && untouched(modeFile(), snap), JSON.stringify({ reason: kept.reason, mode: readCompatMode().mode }))
  }
  // ③-4 非桌面形态 → 不动
  {
    writeCompatMode('managed', { source: 'auto:console-upgrade' })
    const snap = freeze(modeFile())
    const kept = maybeSwitchToObserver(rcStandalone, { force: true })
    check('③ 非桌面形态 → 不动（独立实例行为不变）', kept.switched === false && kept.reason === 'not-desktop-host' && untouched(modeFile(), snap), JSON.stringify({ reason: kept.reason }))
  }
  // ③-5 首次查询判定一次，之后不重复判定（与"启动/首次状态查询"的触发时机一致）
  {
    resetHostSwitchChecked()
    writeCompatMode('managed', { source: 'auto:console-upgrade', reason: '使用本控制台执行框架升级' })
    const first = maybeSwitchToObserver(rcHosted) // 首次：桌面形态 + auto → 切观察者
    writeCompatMode('managed', { source: 'auto:console-upgrade', reason: '使用本控制台执行框架升级' }) // 模拟用户之后又拨回托管
    const second = maybeSwitchToObserver(rcHosted) // 第二次：已经判定过 → 不再动
    check('③ ★ 判定只做一次（首次真的切了；之后即使又是托管也不再自动动它）', first.switched === true && second.switched === false && second.reason === 'already-checked' && readCompatMode().mode === 'managed', JSON.stringify({ first: first.switched, second: second.reason, mode: readCompatMode().mode }))
  }
}

// ── ④ 本机化纪律：新增/改动文件里 0 处本机绝对路径 / 用户名 ────────────────────
{
  const CHANGED = [
    'lib/index.js',
    'lib/client.js',
    'lib/server/domain/compat-state.js',
    'lib/server/domain/compat.js',
    'lib/server/domain/auto-preflight.js',
    'lib/server/domain/auto-preflight-run.js',
    'lib/server/domain/auto-disable.js',
    'lib/server/domain/safe-boot.js',
    'lib/server/domain/patch-yaml-check.js',
    'lib/server/routes/compat.js',
    'lib/server/routes/safe-boot.js',
    'lib/server/routes/framework-preflight.js',
    'lib/server/routes/index.js',
    'scripts/safe-boot.mjs',
    'tests/test-auto-preflight.mjs',
    'tests/test-safe-boot.mjs',
    'tests/test-desktop-host-mode.mjs',
  ]
  // 允许清单：**逐条写清理由**（都是有真机依据的通用形态，不是本机识别信息）
  const ALLOW = [
    /[A-Za-z]:\\Users\\user\b/u,          // 中性占位（本次没用到；留给后续夹具）
    /%LOCALAPPDATA%/u,                     // Windows 环境变量名（不是某台机器的路径）
    /process\.env\.LOCALAPPDATA/u,
    /OneDrive/u,
    /AppData[\\/]Local/u,                  // 通用相对形态（本机用户名不含在其中）
    /node_cache/u,                         // npm 缓存目录名（历史形态，见 CHANGELOG v0.5.31）
    /npm-cache/u,
    /_npx/u,                               // npx 缓存目录名
    /app\.asar/u,                          // Electron 打包路径片段（判据用）
    /resources[\\/]app\.asar/u,
  ]
  // 本机识别信息（**真·敏感**）：本机用户名（含中文）与其百分号编码、真实盘符下的私有目录
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const userName = home === '' ? '' : home.split(/[\\/]/u).pop()
  const PERCENT = userName === '' ? '' : encodeURIComponent(userName)
  const BANNED = [
    { name: '本机用户名（原样）', re: userName === '' || userName.length < 2 ? null : new RegExp(userName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u') },
    { name: '本机用户名（百分号编码）', re: PERCENT === '' || PERCENT === userName ? null : new RegExp(PERCENT.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u') },
    { name: '本机家目录明文', re: home === '' ? null : new RegExp(home.replace(/[\\/]/gu, '[\\\\/]').replace(/[.*+?^${}()|[\]\\]/gu, (m) => (m === '\\' || m === '/' ? m : `\\${m}`)), 'u') },
    { name: '本次工作副本绝对路径', re: new RegExp(REPO.replace(/[\\/]/gu, '[\\\\/]').replace(/[.*+?^${}()|[\]\\]/gu, (m) => (m === '\\' || m === '/' ? m : `\\${m}`)), 'u') },
    { name: '仓库外私有目录名（dsh-desktop 源码路径）', re: /dsh-desktop[\\/]resources/u },
  ].filter((b) => b.re !== null)
  const hits = []
  for (const rel of CHANGED) {
    const abs = join(REPO, rel)
    if (!existsSync(abs)) { hits.push(`${rel}（文件不存在）`); continue }
    const lines = readFileSync(abs, 'utf8').split(/\r?\n/u)
    lines.forEach((line, i) => {
      if (ALLOW.some((re) => re.test(line))) return
      for (const b of BANNED) if (b.re.test(line)) hits.push(`${rel}:${i + 1} ${b.name} → ${line.trim().slice(0, 100)}`)
    })
  }
  check(`④ ★ 本机绝对路径 / 用户名 0 出现（扫 ${CHANGED.length} 个本轮文件；允许清单 ${ALLOW.length} 条）`, hits.length === 0, hits.slice(0, 6).join(' | ') || undefined)
  check('④ 扫描断言本身有效（能抓到构造的违规串）', BANNED.some((b) => b.re.test(`x ${home} y`)) || home === '', `userName=${userName === '' ? '(空)' : '已隐去'}`)
  // 反向：允许清单不该放行"用户名"这类真敏感串
  check('④ 允许清单不放行本机用户名', !ALLOW.some((re) => userName !== '' && re.test(userName)))
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
rmSync(HOME, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
