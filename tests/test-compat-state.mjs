// 门控常驻化（domain/compat-state.js + routes/compat.js）回归测试 —— 2026-09-24 桌面端冲击复盘推动。
//
// 要钉死的三件事：
//   ① **纯加法**：没设置过运行模式的机器，行为必须与之前完全一致（默认 managed）；
//   ② **触发源不再是我们的升级按钮**：环境指纹（框架版本 / 运行时位置 / 框架树包数）任一变化
//      都必须被判成「环境变更事件」——官方桌面端自带升级器、官方只发桌面端、手动 pnpm 都算；
//   ③ **不给假承诺**：回滚记录还在但框架树路径没了 → `applicable=false` 且带原因，不能骗用户。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'compat-state-home')
process.env.DSH_HOME = HOME
process.env.DSH_TEST_SKIP_NETWORK = '1'
rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })
mkdirSync(join(HOME, 'profiles', 'web'), { recursive: true })

const {
  compareFingerprint, computeFingerprint, readCompatMode, readFingerprint, readRollbackRecord, stampFingerprint, writeCompatMode,
} = await import('../lib/server/domain/compat-state.js')
const { routeCompatMode, routeCompatStamp, routeCompatStatusGet } = await import('../lib/server/routes/compat.js')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

/** 造一棵假的框架树：<root>/.pnpm/@deepseek-ai+xxx 实体 n 个。 */
function fakeFrameworkTree(root, count) {
  for (let i = 0; i < count; i += 1) mkdirSync(join(root, '.pnpm', `@deepseek-ai+pkg-${i}@0.0.${i}`), { recursive: true })
  return root
}

/** 极简 res 桩：把 sendJson 的产物收下来。 */
function makeRes() {
  const captured = { status: null, json: null }
  return {
    captured,
    writeHead(status) { captured.status = status },
    end(payload) { try { captured.json = JSON.parse(payload) } catch { captured.json = null } },
  }
}
const callRoute = async (handler, body = {}) => {
  const res = makeRes()
  await handler({ method: 'POST', url: '/x' }, res, { ctx: {}, body, url: new URL('http://x/x'), pathname: '/x', method: 'POST', deps: {} })
  return res.captured
}

// ① 纯加法：默认托管
const boot = readCompatMode()
check('默认运行模式 = observer（用户 2026-09-24 定：默认只守门、不接管升级）', boot.mode === 'observer' && boot.source === 'default', JSON.stringify(boot))

// ② 模式白名单 + 往返
check('切到 managed 成功', writeCompatMode('managed').ok === true && readCompatMode().mode === 'managed')
const rejected = writeCompatMode('god-mode')
check('非法模式被拒、模式保持不变（不静默失效）', rejected.ok === false && typeof rejected.error === 'string' && readCompatMode().mode === 'managed', JSON.stringify(rejected))
check('切回 observer 成功（可来回切换）', writeCompatMode('observer').ok === true && readCompatMode().mode === 'observer')

// ③ 指纹：计入框架树包数
const treeA = fakeFrameworkTree(join(HOME, 'runtime-a'), 3)
const fpA = computeFingerprint({ frameworkVersion: '0.1.7-rc.1', pnpmRoot: treeA })
check('指纹计入框架树里的 @deepseek-ai 实体数', fpA.pnpmEntities === 3, JSON.stringify(fpA))
check('树不存在时包数为 null 而不是抛错', computeFingerprint({ frameworkVersion: 'x', pnpmRoot: join(HOME, 'nope') }).pnpmEntities === null)

// ④ 基线一致 → 不算变更；基线缺失 → 只记录不报变更
stampFingerprint(fpA)
const same = compareFingerprint(fpA, readFingerprint())
check('指纹与基线一致时不算环境变更', same.changed === false && same.reasons.length === 0, JSON.stringify(same))
check('没有基线时不谎报变更（首次运行）', compareFingerprint(fpA, null).changed === false)

// ⑤ 三种真实变更都能被抓到
const byVersion = compareFingerprint(computeFingerprint({ frameworkVersion: '0.1.8-rc.1', pnpmRoot: treeA }), readFingerprint())
check('框架版本变化 → 环境变更事件', byVersion.changed === true && byVersion.reasons.some((r) => r.includes('框架版本')), JSON.stringify(byVersion.reasons))
const byRoot = compareFingerprint(computeFingerprint({ frameworkVersion: '0.1.7-rc.1', pnpmRoot: join(HOME, 'desktop-runtime') }), readFingerprint())
check('换安装根（桌面端自带运行时）→ 环境变更事件', byRoot.changed === true && byRoot.reasons.some((r) => r.includes('运行时位置')), JSON.stringify(byRoot.reasons))
const bySize = compareFingerprint(computeFingerprint({ frameworkVersion: '0.1.7-rc.1', pnpmRoot: fakeFrameworkTree(join(HOME, 'runtime-b'), 2) }), readFingerprint())
check('框架树包数变化（半装/损坏）→ 环境变更事件', bySize.changed === true && bySize.reasons.some((r) => r.includes('包数')), JSON.stringify(bySize.reasons))

// ⑥ 回滚点：记录在但树没了 → 不给假承诺
writeFileSync(join(HOME, 'plugin-console', 'framework-rollback.json'), JSON.stringify({ from: '0.1.5-rc.2', to: '0.1.7-rc.1', fwRoot: join(HOME, 'gone-tree'), at: Date.now() }), 'utf8')
const missing = readRollbackRecord()
check('回滚记录指向不存在的框架树 → applicable=false 且带真实原因', missing.applicable === false && typeof missing.reason === 'string' && missing.reason.length > 0, JSON.stringify(missing))
writeFileSync(join(HOME, 'plugin-console', 'framework-rollback.json'), JSON.stringify({ from: '0.1.5-rc.2', to: '0.1.7-rc.1', fwRoot: treeA, at: Date.now() }), 'utf8')
check('框架树还在 → applicable=true', readRollbackRecord().applicable === true)
rmSync(join(HOME, 'plugin-console', 'framework-rollback.json'), { force: true })
check('没有回滚记录 → applicable=false（不是崩溃）', readRollbackRecord().applicable === false)

// ⑦ 路由层：三条接口都能应答且字段齐全
const status = await callRoute(routeCompatStatusGet)
check('GET /compat-status 200 且带 mode/fingerprint/rollback', status.status === 200 && status.json?.ok === true && typeof status.json?.mode === 'string' && status.json?.fingerprint !== undefined && status.json?.rollback !== undefined, JSON.stringify(status.json)?.slice(0, 160))
check('status 里指纹是现场算的（含 frameworkVersion 字段）', status.json?.fingerprint?.current !== undefined && 'frameworkVersion' in status.json.fingerprint.current)
const modeCall = await callRoute(routeCompatMode, { mode: 'observer' })
check('POST /compat-mode 200 且真的写进去了', modeCall.status === 200 && modeCall.json?.mode === 'observer' && readCompatMode().mode === 'observer')
const modeBad = await callRoute(routeCompatMode, { mode: 'nope' })
check('POST /compat-mode 非法值 → 400', modeBad.status === 400)
const stampCall = await callRoute(routeCompatStamp)
check('POST /compat-stamp 200 且基线已更新', stampCall.status === 200 && stampCall.json?.ok === true && readFingerprint() !== null)

// ⑧ 防呆：路由确实接在路由表上（漏接线是这类新增最常见的失误）
const indexSrc = readFileSync(join(ROOT, '..', 'lib', 'server', 'routes', 'index.js'), 'utf8')
check('三条路由已接线到路由表', ['/compat-status', '/compat-mode', '/compat-stamp'].every((p) => indexSrc.includes(p)))

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
