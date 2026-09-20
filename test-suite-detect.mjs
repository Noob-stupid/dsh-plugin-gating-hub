// 套装判定回归测试（纯函数 + 本地 HTTP，不走公网、不需要 profile）
//
// 事故（2026-09-19，用户反馈）：装 MeteorNOX/DeepSeek-Balance-Whale-Widget（普通 bundle 插件，
// main/For-Windows/For-Codex 各分支根目录都没有 .gitmodules）被判成「submodule 聚合套装」，
// 走套装通道 clone 后报「未找到 .gitmodules（不是 submodule 套装仓库）」。
//
// 根因：套装判定只看「探测结果 !== null」，而本机加速器/代理（如把 raw.githubusercontent.com
// 劫持到 127.0.0.1 的 Watt Toolkit）会对**不存在的文件**回 2xx + 空 body；旧代码把空串当成
// "文件存在"，同时 package.json 走 JSON.parse 硬校验失败 → hasSuite=true 且 hasPackageJson=false，
// 正好是前端显示「套装仓库（非 npm 包）+ 安装套装」的条件。
//
// 本测试把三条口径钉死：
//   ① 空/纯空白 body 不算"读到文件"（readBodyOrNull）
//   ② .gitmodules 必须内容像 gitmodules（含 [submodule "x"] 段）才算套装（looksLikeGitmodules）
//   ③ 安装类型决策以内容为准，前端标记/缓存误判不能把普通插件送进套装通道（resolveInstallKind）
import { createServer } from 'node:http'
import { join } from 'node:path'
import {
  FETCH_BUDGET_MS, FETCH_NOT_FOUND, FETCH_OK, FETCH_UNREACHABLE, META_BUDGET_MS,
  curlText, gitBin, looksLikeGitmodules, packageProbeErrorText, raceFetchOutcome, readBodyOrNull, resolveInstallKind, resolvePnpmRunners,
} from './lib/index.js'

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

// ── ① 空 body 不算读到文件 ────────────────────────────────────────────────────
check('空串 → null（代理 200 空 body 的真实形态）', readBodyOrNull('') === null)
check('纯空白 → null', readBodyOrNull(' \r\n\t ') === null)
check('null / undefined → null', readBodyOrNull(null) === null && readBodyOrNull(undefined) === null)
check('非空内容原样返回', readBodyOrNull('x') === 'x' && readBodyOrNull('  x  ') === '  x  ')

// ── ② .gitmodules 内容校验 ───────────────────────────────────────────────────
const REAL = '[submodule "injector"]\n\tpath = packages/injector\n\turl = https://github.com/x/y.git\n'
check('真 .gitmodules → true', looksLikeGitmodules(REAL) === true)
check('带前导空白的真 .gitmodules → true', looksLikeGitmodules(`\n\n  ${REAL}`) === true)
check('空串 → false', looksLikeGitmodules('') === false)
check('HTML 垃圾页 → false', looksLikeGitmodules('<!DOCTYPE html><html><body>404</body></html>') === false)
check('代理的 "404: Not Found" 文本 → false', looksLikeGitmodules('404: Not Found') === false)
check('jsDelivr 的找不到文件文案 → false', looksLikeGitmodules("Couldn't find the requested file /.gitmodules in x/y.") === false)
check('非字符串 → false', looksLikeGitmodules(null) === false && looksLikeGitmodules(undefined) === false)
check('普通文本（非 gitmodules）→ false', looksLikeGitmodules('node_modules/\n*.log\n') === false)

// ── ③ 安装类型决策：内容说了算（事故那一行）────────────────────────────────────
check('★ 显式 suite + 空 body → 回落 plugin（事故复现点）', resolveInstallKind('suite', '') === 'plugin')
check('★ 显式 suite + 垃圾页 → 回落 plugin', resolveInstallKind('suite', '<html>proxy</html>') === 'plugin')
check('显式 suite + 真 .gitmodules → suite', resolveInstallKind('suite', REAL) === 'suite')
check('自动识别（plugin）+ 真 .gitmodules → suite', resolveInstallKind('plugin', REAL) === 'suite')
check('自动识别（plugin）+ 空 body → plugin', resolveInstallKind('plugin', '') === 'plugin')
check('技能请求不受影响', resolveInstallKind('skill', '') === 'skill' && resolveInstallKind('skill', REAL) === 'skill')

// ── ④ 传输层口径：本地起一个"坏代理"，复现不存在的文件回 200 + 空 body ──────────
// 真实事故里 raw.githubusercontent.com 被本机代理接管，对不存在的 .gitmodules 回 200 空 body；
// 这里用本地服务器把那种响应固定下来，验证「读到空 body」不会再被当成"文件存在"。
const server = createServer((req, res) => {
  if (req.url === '/empty-200') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(''); return }
  if (req.url === '/junk-200') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!DOCTYPE html><html>proxy interstitial</html>'); return }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('404: Not Found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const emptyBody = await curlText(`${origin}/empty-200`, 5000)
check('curlText 拿到 200 空 body（传输层如实返回空串）', emptyBody === '')
check('★ 200 空 body 归一为 null → 不会判成套装置仓库', readBodyOrNull(emptyBody) === null
  && resolveInstallKind('suite', readBodyOrNull(emptyBody)) === 'plugin')

const junkBody = await curlText(`${origin}/junk-200`, 5000)
check('★ 200 垃圾页不算套装', looksLikeGitmodules(junkBody) === false
  && resolveInstallKind('suite', junkBody) === 'plugin')

let notFoundThrew = ''
try { await curlText(`${origin}/missing`, 5000) } catch (error) { notFoundThrew = error.message }
check('★ 404 抛 HTTP 404（被 rawTextWithFallback 归一为 null）', /HTTP 404/u.test(notFoundThrew), notFoundThrew || '（没有抛错）')

// ── ⑤ 抓取预算 与「超时 ≠ 404」────────────────────────────────────────────────
// 另一位用户的 issue（2026-09-20）：Android + proot Ubuntu 容器里域名解析出 IPv6 但无 IPv6 路由，
// 4 条通道最快也要 5.4s（node:https 5435ms / jsDelivr 5564ms / curl 被 -m 6 掐死），
// 旧的 5000ms 外层预算**必然先超时** → 抓取失败被当成"文件不存在" → 报「仓库没有 package.json」，
// 而且 3s 的默认分支探测同样必输 → branch 恒为 main（默认分支 dev 的仓库取错分支）。
check('raw 抓取预算 ≥ 8s（旧值 5s 必输）', FETCH_BUDGET_MS >= 8000, `FETCH_BUDGET_MS=${FETCH_BUDGET_MS}`)
check('默认分支探测预算 ≥ 8s（旧值 3s 必输）', META_BUDGET_MS >= 8000, `META_BUDGET_MS=${META_BUDGET_MS}`)

const notFoundOutcome = await raceFetchOutcome(Promise.resolve(null), 1000)
check('通道报 404（resolve null）→ not-found', notFoundOutcome.state === FETCH_NOT_FOUND && notFoundOutcome.body === null, notFoundOutcome.state)
const okOutcome = await raceFetchOutcome(Promise.resolve('{"name":"x"}'), 1000)
check('通道拿到内容 → ok', okOutcome.state === FETCH_OK && okOutcome.body === '{"name":"x"}', okOutcome.state)
const deadOutcome = await raceFetchOutcome(Promise.reject(new Error('网络不可达')), 1000)
check('★ 通道全灭 → unreachable（不再混同"文件不存在"）', deadOutcome.state === FETCH_UNREACHABLE, deadOutcome.state)
const slowStarted = Date.now()
const slowOutcome = await raceFetchOutcome(new Promise(() => {}), 60)
check('★ 超出预算 → unreachable（按预算返回，不悬挂）',
  slowOutcome.state === FETCH_UNREACHABLE && Date.now() - slowStarted < 1500, `${Date.now() - slowStarted}ms`)

const timeoutText = packageProbeErrorText('owner/repo', 'main', FETCH_UNREACHABLE)
const missingText = packageProbeErrorText('owner/repo', 'main', FETCH_NOT_FOUND)
check('★ 超时文案与「没有 package.json」文案必须不同', timeoutText !== missingText)
check('超时文案点明超时/网络，并给出重试 + 仓库落地两条出路',
  /超时|网络/u.test(timeoutText) && timeoutText.includes('重试') && timeoutText.includes('仓库落地'), timeoutText.slice(0, 60))
check('404 文案保持原文案（含"没有 package.json"）', missingText.includes('没有 package.json'))

// ── ⑥ 跨平台：git 可执行名 与 pnpm/corepack 定位 ──────────────────────────────
// 另一位用户同一批截图里的另外两个报错：
//   · 「仓库落地」克隆 `spawn git.exe ENOENT`（Linux 上根本没有 git.exe）
//   · AI 赋能 install-npm `Cannot find module '/usr/local/bin/node_modules/corepack/dist/corepack.js'`
check('git 可执行名跨平台（Linux 不能是 git.exe）', gitBin() === (process.platform === 'win32' ? 'git.exe' : 'git'), gitBin())
const linuxGlobalCorepack = join('/usr/local/bin', '..', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js')
const linuxNoCorepack = resolvePnpmRunners({ platform: 'linux', execPath: '/usr/local/bin/node', exists: () => false })
check('Linux 找不到 corepack.js 时兜底 corepack → pnpm（不再生成 MODULE_NOT_FOUND 命令）',
  linuxNoCorepack.map((r) => r.kind).join(',') === 'corepack,pnpm',
  linuxNoCorepack.map((r) => r.note).join(' → '))
const linuxGlobal = resolvePnpmRunners({ platform: 'linux', execPath: '/usr/local/bin/node', exists: (p) => p === linuxGlobalCorepack })
check('★ 能认出 Linux npm 全局布局（<prefix>/lib/node_modules/corepack）',
  linuxGlobal[0]?.kind === 'node-corepack' && linuxGlobal[0].run(['add', 'x']).argv[0] === linuxGlobalCorepack,
  linuxGlobal[0]?.note)
const winNoCorepack = resolvePnpmRunners({ platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe', comspec: 'C:\\Windows\\System32\\cmd.exe', exists: () => false })
check('Windows 找不到 corepack.js 时经 cmd /c 调用（execFile 不能直接跑 .cmd）',
  winNoCorepack[0]?.kind === 'cmd-corepack' && winNoCorepack[0].run(['add', 'x']).bin.endsWith('cmd.exe'),
  winNoCorepack[0]?.note)

server.close()
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
