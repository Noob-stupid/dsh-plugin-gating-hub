// 「自动拉起失败 → 该不该回滚」判据（2026-10-28 真机事故的回归钉子）
//
// ── 现场（`<DSH_HOME>/plugin-console/fw-upgrade.log` 原文）─────────────────────
//   16:23:25 结构校验通过：package.json + bin.js 就位，CLI 自报 0.2.1-rc.4
//   16:23:25 框架本体升级完成
//   16:23:25 顶层可见版本校验通过
//   16:30:18 服务拉起失败 → 先做启动失败隔离（隔离肇事者后重试，不直接回滚）
//   16:30:18 隔离分析无输出
//   16:30:18 服务拉起失败，尝试自动回滚到升级前版本…
//   16:30:33 全树回滚完成：恢复 62 个版本包 + 顶层 scope
// 而 `fw-relaunch.log` 里**只有一行时间戳 + bin 路径，没有任何子进程输出**。
// 用户判断（我认同）：**是「自动拉起」这条脚本路径有问题，不是框架装坏了** ——
// 装是装好了（CLI 手动跑得出版本号，之后手动 `node …/lib/bin.js web --no-open` 也能起），
// 拉起失败就回滚，等于把一次**成功**的升级连同一个说不清的原因一起扔掉。
//
// ── 本套钉死的四件事 ─────────────────────────────────────────────────────────
//   ① 结构校验通过 + 顶层版本校验通过 + 拉起失败且**没有**模块错误文本 ⇒ **不回滚**，
//      状态是一条明确的 ready + 手动启动提示（含真实 bin 路径与 `web --no-open`）；
//   ② 失败输出里有 `Cannot find package '@deepseek-ai/cordis'` / `ERR_MODULE_NOT_FOUND` ⇒ 回滚（真坏树）；
//   ③ 结构校验**未**通过 + 拉起失败 ⇒ 回滚（证据不足时保守，绝不把来路不明的树留成"已就位"）；
//   ④ 幂等/边界：空原因（无需判定）、超长原因截断、`|`/换行抹平（状态文件是 `status|message` 单行）。
// 另加两条接线钉子：判定器转发脚本**真的能被 node 跑出 JSON**（不是只有源码字符串），
// 以及 ps1 执行块真的把"结构/顶层两个事实位"喂给判定器（不是让 PS 自己判）。
//
// 全部离线、纯函数级：不 spawn、不联网、不碰真实 profile（需要落盘的地方一律用临时目录）。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import {
  judgeRelaunchFailure,
  manualRelaunchCommand,
  relaunchProbeHelpers,
  relaunchVerdictBlock,
  relaunchVerdictHelperSource,
  TREE_DAMAGE_MARKERS,
} from '../lib/server/domain/framework-relaunch.js'

let passed = 0
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`PASS ${name}`) } catch (error) {
    console.log(`FAIL ${name}`)
    console.log(`     ${error?.message ?? error}`)
    process.exitCode = 1
  }
}

const BIN = 'D:\\node_cache\\_npx\\1e7f6d9597241db0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const OK_CMD = `node "${BIN}" web --no-open`

// ── ① 结构 + 顶层都过、失败原因里没有模块错误 ⇒ 不回滚 ──────────────────────────
{
  const verdict = judgeRelaunchFailure({
    reason: 'child-exited-early(exit=1,1s)',
    structureVerified: true,
    topLevelVerified: true,
    binPath: BIN,
  })
  check('① 结构校验通过 + 拉起失败（无模块错误）⇒ 不回滚', () => {
    assert.equal(verdict.rollback, false, '这一类必须保留框架（真机就是它）')
    assert.equal(verdict.verdict, 'keep')
    assert.equal(verdict.treeDamaged, false)
  })
  check('① 状态里含手动启动提示（真实 bin 路径 + web --no-open）', () => {
    assert.equal(typeof verdict.status, 'string')
    assert.ok(verdict.status.includes('框架已就位'), `状态应明说框架已就位：${verdict.status}`)
    assert.ok(verdict.status.includes('自动拉起失败'), `状态应明说拉起失败：${verdict.status}`)
    assert.ok(verdict.status.includes(OK_CMD), `状态里要能直接复制手动命令：${verdict.status}`)
    assert.ok(verdict.status.includes('重启服务'), '还要指出控制台里的另一条出路')
  })
  check('① manualCommand 就是用户手动救回来的那条命令', () => {
    assert.equal(verdict.manualCommand, OK_CMD)
  })
}

// 「没输出」也算无模块错误：这次事故的原文就是一个字都没有
check('① 失败原因为「stdout/stderr 均为空」时同样不回滚', () => {
  const v = judgeRelaunchFailure({
    reason: 'child-exited-early(exit=未知,1s)',
    structureVerified: true,
    topLevelVerified: true,
    binPath: BIN,
  })
  assert.equal(v.rollback, false)
})

// 端口占用 / 超时 / spawn 失败都不是框架树问题
for (const reason of [
  'child-exited(exit=1,12s)：Error: listen EADDRINUSE: address already in use 127.0.0.1:3080',
  'child-exited(exit=未知,30s)',
  'spawn-failed：拉起进程启动失败：拒绝访问',
]) {
  check(`① 非框架树类失败也不回滚（${reason.slice(0, 28)}…）`, () => {
    assert.equal(judgeRelaunchFailure({ reason, structureVerified: true, topLevelVerified: true, binPath: BIN }).rollback, false)
  })
}

// ── ② 失败输出里有明确的框架树损坏证据 ⇒ 回滚 ──────────────────────────────────
for (const reason of [
  "child-exited-early(exit=1,0s)：Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/cordis' imported from D:\\x\\dsh-app-boot\\lib\\index.js",
  'child-exited-early(exit=1,0s)：Error: Cannot find package \'@deepseek-ai/cordis\' imported from …',
  'child-exited-early(exit=1,0s)：Error [ERR_MODULE_NOT_FOUND]: Cannot find module …',
  'child-exited-early(exit=1,0s)：Error: Cannot find module \'@deepseek-ai/cordis\'',
  'child-exited(exit=1,8s)：失败：顶层 @deepseek-ai\\dsh\\package.json 不存在（安装不完整）',
  '找不到 dsh 的 bin.js（node resolve / .pnpm / 顶层链接 三种方式都失败）',
]) {
  check(`② 框架树损坏证据 ⇒ 回滚（${reason.slice(0, 34)}…）`, () => {
    const v = judgeRelaunchFailure({ reason, structureVerified: true, topLevelVerified: true, binPath: BIN })
    assert.equal(v.rollback, true, '缺包/缺文件时回滚是对的：那种树留着重启也好不了')
    assert.equal(v.verdict, 'rollback')
    assert.equal(v.treeDamaged, true)
    assert.equal(v.status, null, '回滚分支不写 ready 状态')
  })
}

check('② 树损坏特征串清单本身没被清空（防有人把判据改软）', () => {
  assert.ok(TREE_DAMAGE_MARKERS.includes('Cannot find package'))
  assert.ok(TREE_DAMAGE_MARKERS.includes('ERR_MODULE_NOT_FOUND'))
  assert.ok(TREE_DAMAGE_MARKERS.length >= 5)
})

// ── ③ 结构校验未通过 + 拉起失败 ⇒ 回滚（保守） ────────────────────────────────
check('③ 结构校验未通过 ⇒ 回滚', () => {
  const v = judgeRelaunchFailure({ reason: 'child-exited-early(exit=1,0s)', structureVerified: false, topLevelVerified: true, binPath: BIN })
  assert.equal(v.rollback, true)
  assert.equal(v.treeDamaged, false, '这不是"证明树坏了"，只是证据不足 —— 两者要分得开')
})
check('③ 结构通过但顶层版本没验过 ⇒ 回滚（证据不足）', () => {
  const v = judgeRelaunchFailure({ reason: 'child-exited-early(exit=1,0s)', structureVerified: true, topLevelVerified: false, binPath: BIN })
  assert.equal(v.rollback, true)
})
check('③ 两个事实位都缺省（老调用方只传 reason）⇒ 回滚', () => {
  assert.equal(judgeRelaunchFailure({ reason: 'child-exited-early(exit=1,0s)' }).rollback, true)
})

// ── ④ 幂等 / 边界 ─────────────────────────────────────────────────────────────
check('④ 空原因 ⇒ 不判定（既不回滚也不写状态，幂等）', () => {
  for (const reason of ['', '   ', '\r\n\t', null, undefined]) {
    const v = judgeRelaunchFailure({ reason, structureVerified: true, topLevelVerified: true, binPath: BIN })
    assert.equal(v.verdict, 'ok', `reason=${JSON.stringify(reason)} 应走 ok 分支`)
    assert.equal(v.rollback, false)
    assert.equal(v.status, null)
    assert.equal(v.reasonExcerpt, '')
  }
  // 无参调用也不能抛（幂等边界）
  assert.equal(judgeRelaunchFailure().verdict, 'ok')
})

check('④ 超长原因被截断（状态文件是单行，不能无限长）', () => {
  const long = `child-exited-early(exit=1,0s)：${'x'.repeat(5000)}`
  const v = judgeRelaunchFailure({ reason: long, structureVerified: true, topLevelVerified: true, binPath: BIN })
  assert.ok(v.reasonExcerpt.length <= 241, `摘录不可超过 240+1，实际 ${v.reasonExcerpt.length}`)
  assert.ok(v.reasonExcerpt.endsWith('…'), '截断要有省略号，别让人以为全文就这么长')
  assert.ok(v.status.length < 400, `状态串也不可无限长，实际 ${v.status.length}`)
})

check('④ 原因里的换行/竖线被抹平（否则 /framework-upgrade-status 的 status|message 会被切碎）', () => {
  const v = judgeRelaunchFailure({ reason: 'child-exited-early(exit=1,0s)\r\nError: a | b | c', structureVerified: true, topLevelVerified: true, binPath: BIN })
  assert.equal(v.reasonExcerpt.includes('\n'), false)
  assert.equal(v.reasonExcerpt.includes('\r'), false)
  assert.equal(v.reasonExcerpt.includes('|'), false, '竖线必须换成 / —— 状态文件靠它分段')
  assert.ok(v.reasonExcerpt.includes('a / b / c'), `摘录内容别被吃掉：${v.reasonExcerpt}`)
})

check('④ 同一输入反复调用结果逐字相同（纯函数，无隐藏状态）', () => {
  const args = { reason: 'child-exited-early(exit=1,1s)', structureVerified: true, topLevelVerified: true, binPath: BIN }
  assert.deepEqual(judgeRelaunchFailure(args), judgeRelaunchFailure(args))
})

check('④ 拿不到 bin 路径时不编假路径，状态里如实说"没解析出来"', () => {
  const v = judgeRelaunchFailure({ reason: 'child-exited-early(exit=1,1s)', structureVerified: true, topLevelVerified: true, binPath: '' })
  assert.equal(v.rollback, false)
  assert.equal(v.manualCommand, null)
  assert.equal(v.status.includes('node "'), false, '不许出现半截命令')
  assert.ok(v.status.includes('未解析出来'))
  assert.equal(manualRelaunchCommand('   '), '', '空白路径同样不许编命令')
})

// ── ⑤ 接线钉子：转发脚本真的能跑出 JSON（PS↔node 这一棒）──────────────────────
check('⑤ 判定器转发脚本能被 node 真的跑出判定 JSON（含 --no-open 的手动命令）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-relaunch-verdict-'))
  try {
    const helper = join(dir, 'fw-relaunch-verdict.mjs')
    const libUrl = pathToFileURL(join(process.cwd(), 'lib', 'server', 'domain', 'framework-relaunch.js')).href
    writeFileSync(helper, relaunchVerdictHelperSource({ libUrl }), 'utf8')
    const reasonFile = join(dir, 'reason.txt')
    writeFileSync(reasonFile, 'child-exited-early(exit=1,1s)', 'utf8')
    const run = (...args) => JSON.parse(execFileSync(process.execPath, [helper, ...args], { encoding: 'utf8', timeout: 60000 }))
    const keep = run(reasonFile, '1', '1', BIN)
    assert.equal(keep.rollback, false, `结构+顶层都过、无模块错误 ⇒ 不回滚：${JSON.stringify(keep)}`)
    assert.equal(keep.manualCommand, OK_CMD)
    // 空 binPath：结论不变（不回滚），但绝不编命令
    const keepNoBin = run(reasonFile, '1', '1', '')
    assert.equal(keepNoBin.rollback, false)
    assert.equal(keepNoBin.manualCommand, null)
    assert.equal(String(keepNoBin.status).includes('node "'), false)
    writeFileSync(reasonFile, "child-exited-early(exit=1,0s)：Error: Cannot find package '@deepseek-ai/cordis'", 'utf8')
    const damaged = run(reasonFile, '1', '1', BIN)
    assert.equal(damaged.rollback, true, '模块缺失 ⇒ 回滚')
    const unverified = run(reasonFile, '0', '1', BIN)
    assert.equal(unverified.rollback, true, '结构校验没过 ⇒ 保守回滚')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('⑤ ps1 执行块把两个事实位喂给判定器，而不是让 PowerShell 自己判', () => {
  const block = relaunchVerdictBlock({ ps: (s) => JSON.stringify(String(s)), nodePath: 'C:\\nodejs\\node.exe', helperPath: 'C:\\Users\\u\\.dsh\\plugin-console\\fw-relaunch-verdict.mjs', port: 3080 })
  assert.ok(block.includes('$script:structureOk'), '结构校验事实位必须参与判定')
  assert.ok(block.includes('$script:topLevelOk'), '顶层版本校验事实位必须参与判定')
  assert.ok(block.includes('$reasonFile'), '原因文本要走文件，别塞进命令行')
  assert.ok(block.includes('fw-relaunch-verdict.mjs'), '必须调用判定器转发脚本（判据不在 ps1 里）')
  assert.ok(block.includes('-LocalPort 3080'), '回滚后重试的端口必须沿用调用方 webPort')
  assert.ok(block.includes("SetState 'ready'"), '保留分支要写明确的 ready 终态')
  assert.ok(block.includes('$verdict.rollback'), '分支必须按判定结论走')
  assert.equal(block.includes('${'), false, '生成物里不许残留 JS 模板占位符')
})

check('⑤ 拉起助手改成"拿句柄 + 等一小段 + 给结论"（不再是 fire-and-forget）', () => {
  const helpers = relaunchProbeHelpers().join('\n')
  assert.ok(helpers.includes('Get-TailText'), '要能读输出尾部')
  assert.ok(helpers.includes('Test-RelaunchPort') && helpers.includes('Get-NetTCPConnection -LocalPort $relaunchPort'), '端口判据沿用 webPort 结果')
  assert.equal(/Test-Path\s+\$/.test(helpers), false, '助手块里不许对变量用 Test-Path（既有断言：只允许 Resolve-DshBin 的归一化变量）')
})

// ── ⑥ 路由侧接线（静态）：判据接上了、事实位初始化了、ready 不会被收尾覆盖 ────────────
{
  const REPO = join(process.cwd())
  const routeSrc = readFileSync(join(REPO, 'lib', 'server', 'routes', 'framework-upgrade.js'), 'utf8')
  const statusRoute = readFileSync(join(REPO, 'lib', 'server', 'routes', 'framework.js'), 'utf8')
  check('⑥ 升级脚本的回滚分支改成"先判定"（路由里不再无条件回滚）', () => {
    assert.ok(routeSrc.includes('relaunchVerdictBlock({ ps, nodePath, helperPath: rvHelperPath, port })'), '必须调用判据生成器')
    const legacy = routeSrc.includes("`  Log '服务拉起失败，尝试自动回滚到升级前版本…'`")
    assert.equal(legacy, false, '旧的无条件回滚链条（Log + Invoke-Rollback）必须消失')
  })
  check('⑥ 三个事实位都在脚本里初始化（结构 / 顶层 / 保留标记）', () => {
    assert.ok(routeSrc.includes('$script:structureOk = $false; $script:topLevelOk = $false; $script:keptReady = $false'), '初始化行')
    assert.ok(routeSrc.includes('$script:topLevelOk = $true'), '顶层版本校验通过时要置位')
  })
  check('⑥ 收尾不覆盖 ready 终态（否则又变成整列红叉）', () => {
    assert.ok(routeSrc.includes('elseif (-not $script:keptReady)'), 'failed 只在"没保留"时写')
  })
  check('⑥ ready 是终态（自愈与 15 分钟残留清理都不许抹掉它）', () => {
    assert.ok(/status === 'ready'/u.test(statusRoute), 'terminal 判定里必须包含 ready')
    assert.ok(statusRoute.includes("status.status !== 'ready'"), '残留清理必须排除 ready')
    assert.ok(statusRoute.includes('keptFrame: true') && statusRoute.includes('relaunchFailed: true'), '对客户端要带标记字段')
  })
}

console.log(process.exitCode === 1 ? `\nFAILED` : `\nALL PASS（${passed} 项）`)
process.exit(process.exitCode === 1 ? 1 : 0)
