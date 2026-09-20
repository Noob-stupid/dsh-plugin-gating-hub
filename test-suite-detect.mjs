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
import { looksLikeGitmodules, readBodyOrNull, resolveInstallKind, curlText } from './lib/index.js'

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

server.close()
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
