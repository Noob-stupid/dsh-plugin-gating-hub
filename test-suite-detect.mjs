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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_SOURCES, FETCH_BUDGET_MS, FETCH_NOT_FOUND, FETCH_OK, FETCH_UNREACHABLE, META_BUDGET_MS,
  curlText, gitBin, hasDirectNameHit, looksLikeGitmodules, packageProbeErrorText, parseRepoFromUrl,
  raceFetchOutcome, readBodyOrNull, removeDirVerified, resolveInstallKind, resolvePnpmRunners, summarizeCloneErrors,
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

// ── ⑦ 搜索可达性：只存在于「npm 包名 / README / 仓库文件」里的名字 ────────────────
// 事故（2026-09-20，另一位用户）：搜 `web-all` 搜不到 `zhu1090093659/dsh-web`（★7800 全家桶）。
// 实测：`web-all` 既不在该仓库的名字/描述/topics 里（仓库名是 dsh-web），GitHub 仓库搜索 32 条不含它；
// 它是 npm 包 `@linxin666/dsh-web-all`，代码在 packages/dsh-web-all/package.json（代码搜索需登录）。
check('索引源默认 ≥ 4 个（只有 2 个源时同时挂掉＝市场退化成只能搜 GitHub 实时结果）',
  DEFAULT_SOURCES.indexSources.length >= 4, `共 ${DEFAULT_SOURCES.indexSources.length} 个`)
check('索引源 URL 全是 https 且指向 marketplace/index.json',
  DEFAULT_SOURCES.indexSources.every((s) => /^https:\/\/\S+$/u.test(s.url) && s.url.includes('marketplace/index.json')))
check('索引源有且只有一个主源', DEFAULT_SOURCES.indexSources.filter((s) => s.primary === true).length === 1)

check('parseRepoFromUrl：https / git+https / .git 后缀',
  parseRepoFromUrl('https://github.com/zhu1090093659/dsh-web.git') === 'zhu1090093659/dsh-web'
  && parseRepoFromUrl('git+https://github.com/Noob-stupid/dsh-plugin-hub.git') === 'Noob-stupid/dsh-plugin-hub')
check('parseRepoFromUrl：npm 老式简写 github:o/r', parseRepoFromUrl('github:zhu1090093659/dsh-web') === 'zhu1090093659/dsh-web')
check('parseRepoFromUrl：带 monorepo 子路径锚点', parseRepoFromUrl('https://github.com/o/r#packages/x/package.json') === 'o/r')
check('parseRepoFromUrl：非 GitHub/Gitee → null', parseRepoFromUrl('https://gitlab.com/o/r.git') === null && parseRepoFromUrl('') === null)

check('hasDirectNameHit：名字逐词命中 → 不再重查', hasDirectNameHit([{ fullName: 'zhu1090093659/dsh-web' }], 'dsh-web') === true)
check('★ hasDirectNameHit：web-all 在结果里没有名字命中 → 触发 in:readme 重查',
  hasDirectNameHit([{ fullName: 'bradeGithub/DSH-Plugins-Marketplace' }, { fullName: 'Amakurai/dsh-liketavern' }], 'web-all') === false)
check('hasDirectNameHit：查询词太短（<3 字符）不做二次查询', hasDirectNameHit([], 'we') === true)

// ── ⑧ 克隆重试：报「首个错误」，不被次生的"目录非空"掩盖 ────────────────────────
// 事故（2026-09-20，另一位用户截图）：`git clone 失败：… fatal: destination path '…' already exists
// and is not an empty directory.` —— 第一次（ghproxy 镜像）失败留下半成品目录，第二次立刻以
// "目录非空"失败，旧代码把这条当 lastError 抛出去 → 真实原因（镜像/网络不可达）被完全掩盖。
const cloneMsg = summarizeCloneErrors([
  { url: 'https://ghproxy.net/https://github.com/o/r.git', message: 'fatal: unable to access: Failed to connect' },
  { url: 'https://github.com/o/r.git', message: "fatal: destination path 'C:/t/x' already exists and is not an empty directory." },
])
check('★ 克隆失败报「首个错误」（真实原因）而不是次生错误',
  cloneMsg.includes('首个错误') && cloneMsg.includes('Failed to connect'), cloneMsg.slice(0, 80))
check('克隆失败列出尝试过的源，并把"目录非空"那条标出来',
  cloneMsg.includes('已尝试 2 个源') && cloneMsg.includes('（目录非空）'))
check('单源失败也能正常汇总', summarizeCloneErrors([{ url: 'a', b: 1, message: 'boom' }]).includes('boom'))
// 2026-09-20 演练：套装子模块失败只看到 `Command failed: git clone …`，git 自己说的原因全丢。
check('★ 汇总里带上 git 自己的话（stderr），而不是只有 Command failed',
  summarizeCloneErrors([{
    url: 'https://ghproxy.net/https://github.com/o/r.git',
    message: 'Command failed: git clone --depth 1 --quiet u d\n',
    stderr: 'fatal: unable to access \'u\': The requested URL returned error: 502\n',
  }]).includes('git 说：') === true)
// 半成品目录清不掉时（本机 %TEMP% 下删除被静默忽略）：要么说清"清不掉"，要么别再多试一个源
// 换来一条毫无信息量的"目录非空"。
const uncleanMsg = summarizeCloneErrors([
  { url: 'https://ghproxy.net/https://github.com/o/r.git', message: 'Command failed: git clone u d' },
  { url: 'https://github.com/o/r.git', message: '克隆目标目录无法清理（环境禁止删除）：C:/t/x', unclean: true },
])
check('★ 清理失败时明确说"目录清不掉、多源重试无效"，而不是让用户看到"目录非空"',
  uncleanMsg.includes('清不掉') && uncleanMsg.includes('无法清理'))

// ── 删除必须核实：rmSync 在本机某些环境下会「静默落空」（不抛错、目录仍在） ──────────
// 演练实测（2026-09-20）：同一个 rmSync 在 D:\dsh\repos 删得掉，在 C:\Users\<user>\.dsh\… 下
// 返回成功但目录原封不动；旧代码删完直接 {ok:true} → 对用户撒谎（技能删不掉、残留清理假装清干净）。
{
  const probe = join(dirname(fileURLToPath(import.meta.url)), '.testdir', 'rm-verify-probe')
  mkdirSync(probe, { recursive: true })
  writeFileSync(join(probe, 'a.txt'), 'x', 'utf8')
  const okResult = removeDirVerified(probe)
  check('★ removeDirVerified：存在目录删掉后回 ok:true 且目录真的没了',
    okResult.ok === true && existsSync(probe) === false, JSON.stringify(okResult))
  check('removeDirVerified：目标本来就不存在也算成功（幂等）',
    removeDirVerified(probe).ok === true)
}

server.close()
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
