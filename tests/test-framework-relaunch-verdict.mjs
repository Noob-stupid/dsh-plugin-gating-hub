// 「自动拉起」之后怎么办：判据 + 结局分类（2026-10-28 真机事故的回归钉子，两轮）
//
// ── 现场一（`fw-upgrade.log` 原文）─────────────────────────────────────────────
//   16:23:25 结构校验通过 / 框架本体升级完成 / 顶层可见版本校验通过
//   16:30:18 服务拉起失败 → 启动失败隔离 → 隔离分析无输出 → 尝试自动回滚
//   16:30:33 全树回滚完成：恢复 62 个版本包 + 顶层 scope
// 而 `fw-relaunch.log` 只有一行时间戳 + bin 路径。框架本体其实是好的（CLI 手动跑得出版本号，
// 之后手动 `node …\lib\bin.js web --no-open` 也能起）⇒ 一次**成功**的升级被当成失败扔掉。
//
// ── 现场二（第一轮改过之后，自相矛盾）───────────────────────────────────────────
//   18:21:37 已发起拉起（升级后，PID 15832，最多等 30 秒自证）
//   18:22:08 拉起成功（升级后）：进程已存活 30 秒（端口尚未监听）   ← ① 判据太松
//   18:23:55 服务拉起失败 → 隔离 → 隔离分析无输出                 ← ② 成功后**又查一次**
//   18:23:56 回滚判定器不可用 → 保守回滚                           ← ③ 把已起的服务回滚了
//
// ── 用户定案的最终语义（本套逐条钉死）────────────────────────────────────────────
//   ① 端口监听 ⇒ 成功 ⇒ **立即收尾**，此后禁止任何检查/判失败/回滚；
//   ② 拉起失败 / 超时 / 无输出 ⇒ `ready|框架已就位，自动拉起失败：<原因>；请手动运行
//      node "<真实 bin>" web --no-open，或点「回滚到上一版」`，**不自动回滚**（回滚交人工）；
//   ③ **框架树确认损坏**（缺包 / 模块解析失败 / 缺 bin.js / 缺 package.json）⇒ 自动回滚（保留）。
// 另外钉死缺陷 B 的修法：拉起改由 node 拉起器（fd 重定向 + detached + 状态代理），
// 判定结论写**文件**（该环境下子进程 stdout 抓不到，既有 `隔离分析无输出` 是同一个病）。
//
// 全部离线、确定性：纯函数 + 生成物文本 + 一次真实 node 子进程（转发器跑出判定 JSON）。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import {
  judgeRelaunchFailure,
  manualRelaunchCommand,
  relaunchFallbackVerdict,
  relaunchLauncherSource,
  relaunchProbeHelpers,
  relaunchVerdictBlock,
  relaunchVerdictHelperSource,
  REASON_PREFIX,
  TREE_DAMAGE_MARKERS,
  NO_OUTPUT_REASON,
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

// ── ① 端口监听 = 成功：判据只有端口，进程存活不算 ─────────────────────────────────
check('① 拉起成功（空原因）⇒ 不判定、不回滚、不写状态', () => {
  const v = judgeRelaunchFailure({ reason: '', structureVerified: true, topLevelVerified: true, binPath: BIN })
  assert.equal(v.verdict, 'ok')
  assert.equal(v.rollback, false)
  assert.equal(v.status, null, '成功分支不该写 ready')
})

// ── ② 失败 / 超时 / 无输出 ⇒ ready + 手动命令，**不自动回滚** ─────────────────────
check('② 秒退 + 无输出 ⇒ 保留框架（ready）并给出可复制的命令', () => {
  const v = judgeRelaunchFailure({ reason: `${REASON_PREFIX.exitedEarly}(exit=1,1s)`, structureVerified: true, topLevelVerified: true, binPath: BIN })
  assert.equal(v.rollback, false, '拉起失败不再自动回滚（回滚是人工动作）')
  assert.equal(v.verdict, 'keep')
  assert.equal(v.treeDamaged, false)
  assert.ok(v.status.includes('框架已就位'), v.status)
  assert.ok(v.status.includes('自动拉起失败'), v.status)
  assert.ok(v.status.includes(OK_CMD), `状态里要有原样可复制的命令：${v.status}`)
  assert.ok(v.status.includes('回滚到上一版'), `要指出人工回滚的入口：${v.status}`)
  assert.equal(v.manualCommand, OK_CMD)
})

check(`② ${REASON_PREFIX.stillStarting}（端口没通但进程还活着）⇒ 保留 + 判为超时`, () => {
  const v = judgeRelaunchFailure({ reason: `${REASON_PREFIX.stillStarting}(120s,pid=15832)`, structureVerified: true, topLevelVerified: true, binPath: BIN })
  assert.equal(v.rollback, false)
  assert.equal(v.verdict, 'keep')
  assert.ok(v.status.includes('超时'), `状态要说清是超时而不是崩溃：${v.status}`)
  assert.ok(v.status.includes(OK_CMD) && v.status.includes('回滚到上一版'))
})

check('② 「拿不到输出」⇒ 保留（真机 18:23:56 的"保守回滚"是错的）', () => {
  const v = judgeRelaunchFailure({ reason: `未捕获到输出（${NO_OUTPUT_REASON}）`, structureVerified: true, topLevelVerified: true, binPath: BIN })
  assert.equal(v.rollback, false)
  assert.ok(v.status.includes('框架已就位'))
})

check('② 判定器不可用时的兜底与判据同规则（逐字段相等）', () => {
  for (const flags of [{ structureVerified: true, topLevelVerified: true }, { structureVerified: false, topLevelVerified: true }, { structureVerified: true, topLevelVerified: false }, { structureVerified: false, topLevelVerified: false }]) {
    const fallback = relaunchFallbackVerdict({ ...flags, binPath: BIN })
    assert.deepEqual(fallback, judgeRelaunchFailure({ reason: NO_OUTPUT_REASON, ...flags, binPath: BIN }), JSON.stringify(flags))
    assert.equal(fallback.rollback, false, '兜底也必须是不回滚')
  }
  assert.equal(relaunchFallbackVerdict().rollback, false)
})

check('② 兜底文案含"未捕获到输出"与手动命令', () => {
  const v = relaunchFallbackVerdict({ structureVerified: true, topLevelVerified: true, binPath: BIN })
  assert.ok(v.status.includes('未捕获到输出'), v.status)
  assert.ok(v.status.includes(OK_CMD))
})

// 端口占用 / 超时 / 拉起器失败都不是框架树问题
for (const reason of [
  `${REASON_PREFIX.exited}(exit=1,12s)：Error: listen EADDRINUSE: address already in use 127.0.0.1:3080`,
  `${REASON_PREFIX.exited}(exit=未知,30s)`,
  `${REASON_PREFIX.spawnFailed}：拉起器启动失败：拒绝访问`,
  `${REASON_PREFIX.launcherMissing}：C:\\x\\fw-launch.mjs 不存在`,
]) {
  check(`② 非框架树类失败也不回滚（${reason.slice(0, 26)}…）`, () => {
    const v = judgeRelaunchFailure({ reason, structureVerified: true, topLevelVerified: true, binPath: BIN })
    assert.equal(v.rollback, false)
    assert.equal(v.verdict, 'keep')
  })
}

// ── ③ 框架树确认损坏 ⇒ 自动回滚（唯一保留的自动回滚情形）──────────────────────────
for (const reason of [
  "child-exited-early(exit=1,0s)：Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/cordis' imported from …",
  "child-exited-early(exit=1,0s)：Error: Cannot find package '@deepseek-ai/cordis'",
  'child-exited-early(exit=1,0s)：Error [ERR_MODULE_NOT_FOUND]: Cannot find module …',
  "child-exited-early(exit=1,0s)：Error: Cannot find module '@deepseek-ai/cordis'",
  'child-exited(exit=1,8s)：失败：顶层 @deepseek-ai\\dsh\\package.json 不存在（安装不完整）',
  '找不到 dsh 的 bin.js（node resolve / .pnpm / 顶层链接 三种方式都失败）',
]) {
  check(`③ 框架树损坏 ⇒ 自动回滚（${reason.slice(0, 34)}…）`, () => {
    const v = judgeRelaunchFailure({ reason, structureVerified: true, topLevelVerified: true, binPath: BIN })
    assert.equal(v.rollback, true, '缺包/缺文件时回滚是对的：那种树留着重启也好不了')
    assert.equal(v.verdict, 'rollback')
    assert.equal(v.treeDamaged, true)
    assert.equal(v.status, null, '回滚分支不写 ready 状态')
  })
}

check('③ 树损坏特征串清单本身没被清空（防有人把判据改软）', () => {
  for (const marker of ['Cannot find package', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'Cannot find module', '找不到 dsh 的 bin.js', 'package.json 不存在']) {
    assert.ok(TREE_DAMAGE_MARKERS.includes(marker), `缺特征串：${marker}`)
  }
})

check('③ 树损坏优先于「超时」：带 stderr 的超时若含缺包证据仍回滚', () => {
  const v = judgeRelaunchFailure({ reason: `${REASON_PREFIX.stillStarting}(120s,pid=1)：Cannot find package '@deepseek-ai/cordis'`, structureVerified: true, topLevelVerified: true, binPath: BIN })
  assert.equal(v.rollback, true)
})

// ── ④ 结构校验未过也不再回滚（语义变了：回滚只认树损坏；这里要如实提示未确认）────────
check('④ 结构校验未过 + 无树损坏证据 ⇒ 保留，但状态里如实提示未确认', () => {
  const v = judgeRelaunchFailure({ reason: `${REASON_PREFIX.exitedEarly}(exit=1,0s)`, structureVerified: false, topLevelVerified: true, binPath: BIN })
  assert.equal(v.rollback, false, '自动回滚已取消：只有树损坏才回滚')
  assert.equal(v.verdict, 'keep')
  assert.ok(v.status.includes('未能确认'), `没验过就得说清：${v.status}`)
})
check('④ 结构通过但顶层版本没验过 ⇒ 同样保留 + 提示', () => {
  const v = judgeRelaunchFailure({ reason: `${REASON_PREFIX.exitedEarly}(exit=1,0s)`, structureVerified: true, topLevelVerified: false, binPath: BIN })
  assert.equal(v.rollback, false)
  assert.ok(v.status.includes('未能确认'))
})

// ── ⑤ 幂等 / 边界 ────────────────────────────────────────────────────────────
check('⑤ 空原因 ⇒ ok（不判定、不写状态，幂等）', () => {
  for (const reason of ['', '   ', '\r\n\t', null, undefined]) {
    const v = judgeRelaunchFailure({ reason, structureVerified: true, topLevelVerified: true, binPath: BIN })
    assert.equal(v.verdict, 'ok', `reason=${JSON.stringify(reason)}`)
    assert.equal(v.rollback, false)
    assert.equal(v.status, null)
    assert.equal(v.reasonExcerpt, '')
  }
  assert.equal(judgeRelaunchFailure().verdict, 'ok')
})

check('⑤ 超长原因被截断（状态文件是单行，不能无限长）', () => {
  const v = judgeRelaunchFailure({ reason: `child-exited-early(exit=1,0s)：${'x'.repeat(5000)}`, structureVerified: true, topLevelVerified: true, binPath: BIN })
  assert.ok(v.reasonExcerpt.length <= 241, `摘录不可超过 240+1，实际 ${v.reasonExcerpt.length}`)
  assert.ok(v.reasonExcerpt.endsWith('…'))
  assert.ok(v.status.length < 480, `状态串也不可无限长，实际 ${v.status.length}`)
})

check('⑤ 原因里的换行/竖线被抹平（否则 status|message 会被切碎）', () => {
  const v = judgeRelaunchFailure({ reason: 'child-exited-early(exit=1,0s)\r\nError: a | b | c', structureVerified: true, topLevelVerified: true, binPath: BIN })
  assert.equal(/[\r\n]/u.test(v.reasonExcerpt), false)
  assert.equal(v.reasonExcerpt.includes('|'), false, '竖线必须换成 / —— 状态文件靠它分段')
  assert.ok(v.reasonExcerpt.includes('a / b / c'), v.reasonExcerpt)
})

check('⑤ 同一输入反复调用结果逐字相同（纯函数，无隐藏状态）', () => {
  const args = { reason: `${REASON_PREFIX.exitedEarly}(exit=1,1s)`, structureVerified: true, topLevelVerified: true, binPath: BIN }
  assert.deepEqual(judgeRelaunchFailure(args), judgeRelaunchFailure(args))
})

check('⑤ 拿不到 bin 路径时不编假路径', () => {
  const v = judgeRelaunchFailure({ reason: `${REASON_PREFIX.exitedEarly}(exit=1,1s)`, structureVerified: true, topLevelVerified: true, binPath: '' })
  assert.equal(v.rollback, false)
  assert.equal(v.manualCommand, null)
  assert.equal(v.status.includes('node "'), false, '不许出现半截命令')
  assert.ok(v.status.includes('未解析出来'))
  assert.equal(manualRelaunchCommand('   '), '')
})

// ── ⑥ node 拉起器（缺陷 B 的修法）：形状与关键属性 ────────────────────────────────
check('⑥ 拉起器用 node fd 重定向，不依赖 cmd/Start-Process 的重定向', () => {
  const src = relaunchLauncherSource()
  assert.ok(src.includes('openSync(outFile, "a")') && src.includes('openSync(errFile, "a")'), 'stdout/stderr 必须是文件 fd')
  assert.ok(src.includes('stdio: ["ignore", outFd, errFd]'), 'stdio 形状：ignore stdin + 两个文件 fd')
  assert.ok(src.includes('detached: true'), 'detached：脚本/计划任务退出后服务继续活着')
  assert.ok(src.includes('windowsHide: true'))
  assert.ok(/spawn\(nodePath, \[binPath, "web"\]/u.test(src), 'spawn(node, [bin, "web"])')
  assert.equal(/cmd\.exe|>>|\s2>&1/u.test(src), false, '不许再回到 cmd 重定向那条路')
})

check('⑥ 拉起器自己当状态代理（pid / 退出码 / spawn 错误都落文件）', () => {
  const src = relaunchLauncherSource()
  assert.ok(src.includes('writeFileSync(statusFile, JSON.stringify(obj)'), '状态写文件（该环境 stdout 抓不到，文件可靠）')
  assert.ok(src.includes('event: "spawned"') && src.includes('pid: child.pid'), '要留下子进程 pid')
  assert.ok(src.includes('child.on("exit"') && src.includes('process.exit(typeof code === "number" ? code : 1)'), '退出码要能被 ps1 读到')
  assert.ok(src.includes('child.on("error"'), 'spawn 失败也要留证据')
  // 刻意不 unref()+立即退出：那样 ps1 的 -PassThru 句柄立刻 HasExited，就分不清"还在启动"与"崩了"
  assert.equal(src.includes('.unref('), false, '不 unref —— 拉起器留在前台当状态代理（detached 已保证服务存活）')
})

// ── ⑦ 判据接线：ps1 只按结论分支；成功之后不许再有检查 ────────────────────────────
check('⑦ 判定器转发脚本能被 node 真的跑出判定 JSON（结论写文件，不走 stdout）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-relaunch-verdict-'))
  try {
    const helper = join(dir, 'fw-relaunch-verdict.mjs')
    const libUrl = pathToFileURL(join(process.cwd(), 'lib', 'server', 'domain', 'framework-relaunch.js')).href
    writeFileSync(helper, relaunchVerdictHelperSource({ libUrl }), 'utf8')
    const reasonFile = join(dir, 'reason.txt')
    const verdictFile = join(dir, 'verdict.json')
    const run = (structure, top, bin) => {
      rmSync(verdictFile, { force: true })
      execFileSync(process.execPath, [helper, reasonFile, structure, top, bin, verdictFile], { encoding: 'utf8', timeout: 60000 })
      return JSON.parse(readFileSync(verdictFile, 'utf8'))
    }
    writeFileSync(reasonFile, `${REASON_PREFIX.exitedEarly}(exit=1,1s)`, 'utf8')
    const keep = run('1', '1', BIN)
    assert.equal(keep.rollback, false, `无树损坏 ⇒ 不回滚：${JSON.stringify(keep)}`)
    assert.equal(keep.manualCommand, OK_CMD)
    const keepNoBin = run('1', '1', '')
    assert.equal(keepNoBin.rollback, false)
    assert.equal(keepNoBin.manualCommand, null)
    writeFileSync(reasonFile, "child-exited-early(exit=1,0s)：Error: Cannot find package '@deepseek-ai/cordis'", 'utf8')
    assert.equal(run('1', '1', BIN).rollback, true, '模块缺失 ⇒ 回滚')
    writeFileSync(reasonFile, `${REASON_PREFIX.stillStarting}(120s,pid=1)`, 'utf8')
    assert.equal(run('1', '1', BIN).rollback, false, '超时 ⇒ 不回滚')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('⑦ ps1 执行块：按结论分支，只有结论指向回滚才调 Invoke-Rollback', () => {
  const block = relaunchVerdictBlock({ ps: (s) => JSON.stringify(String(s)), nodePath: 'C:\\nodejs\\node.exe', helperPath: 'C:\\Users\\u\\.dsh\\plugin-console\\fw-relaunch-verdict.mjs', port: 3080 })
  assert.ok(block.includes('$script:structureOk') && block.includes('$script:topLevelOk'), '两个事实位要喂给判定器')
  assert.ok(block.includes('$verdictFile') && block.includes('fw-relaunch-verdict.mjs'), '结论走文件（stdout 在该环境不可靠）')
  assert.ok(block.includes('-LocalPort 3080'), '端口沿用调用方 webPort')
  assert.ok(block.includes("SetState 'ready'"), '保留分支写 ready')
  assert.ok(block.includes('回滚到上一版'), 'ready 文案里要有回滚入口')
  // 唯一一处 Invoke-Rollback 必须在 if ($verdict.rollback) 里
  const rollbackCalls = [...block.matchAll(/Invoke-Rollback/gu)].map((m) => m.index)
  assert.equal(rollbackCalls.length, 1, `Invoke-Rollback 只应出现一次，实际 ${rollbackCalls.length}`)
  const gate = block.indexOf('if ($verdict.rollback)')
  assert.ok(gate !== -1 && gate < rollbackCalls[0], 'Invoke-Rollback 必须被 $verdict.rollback 门住')
  assert.equal(block.includes('${'), false, '生成物里不许残留 JS 模板占位符')
})

check('⑦ 拉起助手：成功只认端口；三种结局都有前缀', () => {
  const helpers = relaunchProbeHelpers().join('\n')
  assert.ok(helpers.includes('Test-RelaunchPort') && helpers.includes('Get-NetTCPConnection -LocalPort $relaunchPort'))
  assert.equal(/Test-Path\s+\$/u.test(helpers), false, '助手块里不许对变量用 Test-Path（既有断言）')
  assert.equal(REASON_PREFIX.stillStarting, 'still-starting-timeout')
  assert.equal(REASON_PREFIX.exitedEarly, 'child-exited-early')
})

check('⑦ 升级/回滚脚本的调用点：成功后立刻 $ok = $true; break（不再空转 95 秒）', () => {
  const main = readFileSync(join(process.cwd(), 'lib', 'server', 'routes', 'framework-upgrade.js'), 'utf8')
  const rollback = readFileSync(join(process.cwd(), 'lib', 'server', 'routes', 'framework.js'), 'utf8')
  const settle = '$started = Note-Relaunch (Invoke-DshRelaunch '
  for (const [name, src] of [['升级', main], ['回滚', rollback]]) {
    assert.ok(src.includes(settle), `${name}脚本的拉起调用点必须走 Note-Relaunch 记账`)
    assert.ok(src.includes('if ($script:relaunchListening) { $ok = $true; break }'), `${name}脚本：判成功后必须立刻收尾`)
  }
  // 旧的"只记别再拉起、不记成功"的写法必须绝迹（缺陷 ② 的直接来源）
  assert.equal(main.includes('$lr = Invoke-DshRelaunch'), false, '旧写法（$lr 局部变量、成功不传播）必须消失')
  assert.equal(rollback.includes('$lr = Invoke-DshRelaunch'), false)
  // 隔离块与判定块都必须在 -not $ok 里 ⇒ 成功之后一个字节的后续就绪检查都不会跑
  assert.ok(main.includes('if (-not $ok -and -not $script:rolledBack) {'), '判定块被 $ok 门住')
  const quarantineGate = main.indexOf('服务拉起失败 → 先做启动失败隔离')
  const verdictGate = main.indexOf('relaunchVerdictBlock({')
  assert.ok(quarantineGate !== -1 && verdictGate !== -1 && quarantineGate < verdictGate, '先隔离、再判定（顺序）')
  assert.ok(main.includes('elseif (-not $script:keptReady)'), 'ready 终态不被收尾覆盖')
})

check('⑦ ready 是终态（自愈与 15 分钟残留清理都不许抹掉它）', () => {
  const statusRoute = readFileSync(join(process.cwd(), 'lib', 'server', 'routes', 'framework.js'), 'utf8')
  assert.ok(/status === 'ready'/u.test(statusRoute))
  assert.ok(statusRoute.includes("status.status !== 'ready'"))
  assert.ok(statusRoute.includes('keptFrame: true') && statusRoute.includes('relaunchFailed: true'))
})

console.log(process.exitCode === 1 ? `\nFAILED` : `\nALL PASS（${passed} 项）`)
process.exit(process.exitCode === 1 ? 1 : 0)
