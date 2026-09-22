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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_SOURCES, FETCH_BUDGET_MS, FETCH_NOT_FOUND, FETCH_OK, FETCH_UNREACHABLE, META_BUDGET_MS,
  cleanupAttemptedCandidates, curlText, gitBin, hasDirectNameHit, looksLikeGitmodules, packageProbeErrorText, parseRepoFromUrl,
  raceFetchOutcome, readBodyOrNull, removeDirVerified, resolveInstallKind, resolvePnpmRunners, summarizeCloneErrors,
  // issue #3：release 反查 / 产物下载 / 通道守卫 / 竞速时延（回归断言用）
  RELEASE_CHANNEL_BUDGET_MS, RELEASE_DOWNLOAD_MIRROR_PREFIXES, RELEASE_SCAN_MAX_REPOS, assetMatchInfo, downloadReleaseArtifact,
  fetchReleaseList, planReleaseInstall, raceInstallChannels, rankReleaseAssets, releaseDownloadUrls,
  resolveReleaseCandidateRepos, selectReleaseInstall, sourceTarballFallback, tryCandidateChannels,
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

// ── ⑩ 安装失败必须清场并如实汇报 ────────────────────────────────────────────────
// 真装演练（2026-09-20）：11 个子包的聚合仓库跑 19 分钟后失败，node_modules 里留着
// `@captain1275/dsh-full-stats_tmp_56272_2` 这类 pnpm 半成品和一个真包，面板只报"安装失败"。
{
  const fakeProfile = join(dirname(fileURLToPath(import.meta.url)), '.testdir', 'fake-profile')
  const pkgDir = join(fakeProfile, 'node_modules', '@drill', 'pkg-a')
  const tmpDir = join(fakeProfile, 'node_modules', '@drill', 'pkg-a_tmp_123_1')
  mkdirSync(pkgDir, { recursive: true })
  mkdirSync(tmpDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), '{"name":"@drill/pkg-a"}', 'utf8')
  const res = cleanupAttemptedCandidates(fakeProfile, ['@drill/pkg-a', '@drill/never-installed'])
  check('★ 失败清场：包目录与 pnpm `_tmp_` 半成品都被清掉',
    existsSync(pkgDir) === false && existsSync(tmpDir) === false, JSON.stringify(res))
  check('失败清场：只汇报真正清过的包（没装过的候选不算）',
    res.cleaned.includes('@drill/pkg-a') && res.failed.length === 0, JSON.stringify(res))
}

// ── ⑪ 聚合包判据：`@scope/all` 这种 scope 根形式也要认 ──────────────────────────
// 真装演练（2026-09-20）：whyihaveyou/dsh-suite 的聚合包叫 `@dsh-suite/all`，而旧判据
// `(^|-)all$ || -all-` 命中不了它 —— 那次它排第一纯属仓库目录顺序，换仓库就会先试错包。
{
  check('旧判据确实漏掉 @scope/all（这就是这次要修的那条）',
    /(^|-)all$/u.test('@dsh-suite/all') === false && /-all-/u.test('@dsh-suite/all') === false
    && /\/all$/u.test('@dsh-suite/all') === true)
  // 为什么是源码级断言：subpackageCandidates() 要联网读仓库子包列表且未导出，判据本身是内联正则。
  // 期望 3 处：subpackageCandidates 的 isAll 1 处 + 懒惰展开的排序里 a/b 各 1 处 —— 少一处就会出现
  // "列表页排序对了、懒惰展开又先试错包"。
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lib', 'index.js'), 'utf8')
  const hits = src.split('/\\/all$/u').length - 1
  check('★ 两处聚合包判据都补上了 /\\/all$/（源码级，共 3 处）', hits >= 3, `命中 ${hits} 处`)
}

// ── ⑫ GitHub release 通道按包名反查（issue #3）──────────────────────────────────
// 用户 issue 现场：装 yjh051108/dsh-routing-suite（根包 @dsh-external/dsh-super-injector，private: true）
// 时 npm registry 404 → 直接掉进 AI 兜底（约 4 分钟）。真正能装上的产物在**另一个仓库**
// yjh051108/dsh-super-injector 的 release 里（asset 形如 dsh-external-dsh-super-injector-0.3.5.tgz）；
// 旧实现只用 job.repo 找仓库、只看 releases/latest、且对同一 release 下多个 asset 不看包名。
{
  // ① asset 文件名 ↔ 包名（纯函数）
  check('★ asset 名匹配：@scope/pkg ↔ scope-pkg-1.2.3.tgz（scope 用短横线连接）',
    assetMatchInfo('scope-pkg-1.2.3.tgz', '@scope/pkg')?.version === '1.2.3')
  check('asset 名匹配：@scope/pkg ↔ pkg-1.2.3.tgz（裸包名形式）',
    assetMatchInfo('pkg-1.2.3.tgz', '@scope/pkg')?.version === '1.2.3')
  check('asset 名匹配：无版本号也算（scope-pkg.tgz / pkg.tgz）',
    assetMatchInfo('scope-pkg.tgz', '@scope/pkg') !== null && assetMatchInfo('pkg.tgz', '@scope/pkg') !== null)
  check('asset 名匹配：大小写不敏感 + 下划线/短横线互换',
    assetMatchInfo('SCOPE_PKG-1.2.3.TGZ', '@scope/pkg') !== null
    && assetMatchInfo('dsh_external_dsh_graded_mode-0.0.1-rc1.tgz', '@dsh-external/dsh-graded-mode') !== null)
  check('asset 名匹配：.tar.gz 同样认', assetMatchInfo('scope-pkg-1.2.3.tar.gz', '@scope/pkg')?.version === '1.2.3')
  check('★ asset 名匹配：别的包一律不认（other-1.0.0.tgz）', assetMatchInfo('other-1.0.0.tgz', '@scope/pkg') === null)
  check('asset 名匹配：仅以本包名开头、实为别的包也不认（scope-pkg-extra-1.0.0.tgz）',
    assetMatchInfo('scope-pkg-extra-1.0.0.tgz', '@scope/pkg') === null)
  check('asset 名匹配：非 tarball 资产不认（zip / 校验文件）',
    assetMatchInfo('scope-pkg-1.2.3.zip', '@scope/pkg') === null
    && assetMatchInfo('scope-pkg-1.2.3.tgz.sha256', '@scope/pkg') === null)
  check('★ asset 名匹配：issue 里的真实资产名命中 @dsh-external/dsh-super-injector',
    assetMatchInfo('dsh-external-dsh-super-injector-0.3.5.tgz', '@dsh-external/dsh-super-injector')?.version === '0.3.5')

  // ② 多 asset / 多 release / 多仓库的选择
  const rel = (tag, names, at) => ({ tag_name: tag, published_at: at, assets: names.map((name) => ({ name, browser_download_url: `https://example.test/${name}` })) })
  const ranked = rankReleaseAssets(rel('v1', ['pkg-1.0.0.tgz', 'scope-pkg-1.0.0.tgz', 'other-9.9.9.tgz'], '2026-01-01T00:00:00Z').assets, '@scope/pkg')
  check('★ 同一 release 多 asset：包名精确匹配（scope-pkg）优先于裸名（pkg），别的包被剔除',
    ranked.length === 2 && ranked[0].file === 'scope-pkg-1.0.0.tgz', ranked.map((r) => r.file).join('、'))
  const planPick = planReleaseInstall('@scope/pkg', [
    { repo: 'o/other-repo', releases: [rel('v1', ['other-1.0.0.tgz'], '2026-02-01T00:00:00Z')] },
    { repo: 'o/pkg-repo', releases: [rel('v1', ['scope-pkg-1.0.0.tgz'], '2025-01-02T00:00:00Z'), rel('v2', ['scope-pkg-2.0.0.tgz'], '2026-01-02T00:00:00Z')] },
  ])
  check('★ 多仓库/多 release：跳过没有匹配 asset 的仓库，在命中的仓库里选版本更高那条',
    planPick.ok === true && planPick.repo === 'o/pkg-repo' && planPick.file === 'scope-pkg-2.0.0.tgz' && planPick.version === '2.0.0',
    `repo=${planPick.repo} file=${planPick.file}`)
  const planExact = planReleaseInstall('@scope/pkg', [
    { repo: 'o/pkg-repo', releases: [rel('v3', ['pkg-3.0.0.tgz', 'scope-pkg-1.0.0.tgz'], '2026-01-01T00:00:00Z')] },
  ])
  check('★ 包名精确匹配优先于版本更高（scope-pkg-1.0.0 胜过 pkg-3.0.0）',
    planExact.ok === true && planExact.file === 'scope-pkg-1.0.0.tgz', planExact.file)
  check('候选仓库优先级：第一个命中仓库胜出，不跨仓库比版本（o/first 的 1.0.0 不被 o/second 的 9.0.0 顶掉）',
    planReleaseInstall('@scope/pkg', [
      { repo: 'o/first', releases: [rel('v1', ['scope-pkg-1.0.0.tgz'], '2025-01-01T00:00:00Z')] },
      { repo: 'o/second', releases: [rel('v9', ['scope-pkg-9.0.0.tgz'], '2026-01-01T00:00:00Z')] },
    ]).repo === 'o/first')

  // ③ 反查不到 / 挑不中：返回清单式错误，绝不抛未捕获异常
  const planNoRepo = planReleaseInstall('@scope/never', [])
  check('★ 一个候选仓库都没有 → ok:false + 清单式文案（不抛异常）',
    planNoRepo.ok === false && planNoRepo.message.includes('@scope/never') && planNoRepo.message.includes('没能反查到候选仓库'),
    planNoRepo.message.slice(0, 60))
  const groupsMiss = [{ repo: 'o/routing-suite', releases: [rel('0.0.1-rc1', ['dsh-external-dsh-graded-mode-0.0.1-rc1.tgz'], '2026-01-01T00:00:00Z'), rel('v0.1.0', [], '2026-01-02T00:00:00Z')] }]
  const planMiss = planReleaseInstall('@dsh-external/dsh-super-injector', groupsMiss)
  check('★ 全部候选都没匹配 asset → 错误里列出尝试过的仓库与每条 release 的 asset 清单',
    planMiss.ok === false
    && planMiss.message.includes('o/routing-suite')
    && planMiss.message.includes('dsh-external-dsh-graded-mode-0.0.1-rc1.tgz')
    && planMiss.message.includes('（无 asset）'), planMiss.message.replace(/\n/gu, ' | '))
  check('挑不中时仍保留老行为兜底目标（最新 tag 源码 tarball）',
    sourceTarballFallback(groupsMiss)?.repo === 'o/routing-suite' && sourceTarballFallback(groupsMiss)?.tag === '0.0.1-rc1')

  // ④ 反查顺序与容错（注入假网络：真模块逻辑 + 假响应，不碰公网）
  const probeDir = join(dirname(fileURLToPath(import.meta.url)), '.testdir', 'release-lookup-profile')
  const probePkg = join(probeDir, 'node_modules', '@probe', 'rev-lookup')
  mkdirSync(probePkg, { recursive: true })
  writeFileSync(join(probePkg, 'package.json'), JSON.stringify({
    name: '@probe/rev-lookup', version: '1.0.0',
    repository: { type: 'git', url: 'git+https://github.com/probe-org/from-pkg-json.git' },
  }), 'utf8')
  const searchQueries = []
  const fakeFetchers = {
    fetchJson: async (url) => {
      if (!url.includes('/@probe%2frev-lookup')) throw new Error('请求失败 (HTTP 404)')
      return { repository: { url: 'git+https://github.com/probe-org/from-npm.git' } }
    },
    githubJson: async (url) => {
      const q = decodeURIComponent(String(url).replace(/^.*[?&]q=/u, '').replace(/&.*$/u, ''))
      searchQueries.push(q)
      // 复现真实观测：`scope name` 查询 0 条（scope 不在仓库检索面里），裸包名才命中
      if (q.includes(' ')) return { items: [] }
      return { items: [{ full_name: 'probe-org/rev-lookup', name: 'rev-lookup', stargazers_count: 3 }] }
    },
  }
  const repos = await resolveReleaseCandidateRepos({
    repo: 'probe-org/explicit', packageName: '@probe/rev-lookup', profileDir: probeDir,
    registries: ['https://registry.fake'], token: null, fetchers: fakeFetchers,
  })
  check('★ 反查顺序：显式 repo → 已装包 package.json.repository → npm 元数据 → GitHub 搜索',
    repos.length === 4
    && repos[0].repo === 'probe-org/explicit'
    && repos[1].repo === 'probe-org/from-pkg-json'
    && repos[2].repo === 'probe-org/from-npm'
    && repos[3].repo === 'probe-org/rev-lookup',
    repos.map((r) => `${r.repo}(${r.from})`).join(' → '))
  check('★ 从包名推导：先试 `scope name`、命中为空再退回裸包名（实测该查询常为 0 条）',
    searchQueries.length === 2 && searchQueries[0] === 'probe rev-lookup' && searchQueries[1] === 'rev-lookup',
    searchQueries.join(' | '))
  const none = await resolveReleaseCandidateRepos({
    repo: null, packageName: '@probe/never-lookup', profileDir: probeDir,
    registries: ['https://registry.fake'], token: null,
    fetchers: { fetchJson: async () => { throw new Error('请求失败 (HTTP 404)') }, githubJson: async () => { throw new Error('GitHub 接口限流已用尽') } },
  })
  check('★ 四个来源全军覆没 → 返回空列表（不抛异常），交给上层出清单式文案',
    Array.isArray(none) && none.length === 0, JSON.stringify(none))
  const selNone = await selectReleaseInstall({
    repo: null, packageName: '@probe/never-lookup', profileDir: probeDir,
    registries: ['https://registry.fake'], token: null,
    fetchers: { fetchJson: async () => { throw new Error('请求失败 (HTTP 404)') }, githubJson: async () => { throw new Error('GitHub 接口限流已用尽') } },
  })
  check('★ selectReleaseInstall 全败也不抛：ok:false + 清单式 message + 无兜底目标',
    selNone.ok === false && typeof selNone.message === 'string' && selNone.sourceFallback === null && selNone.repos.length === 0)
  removeDirVerified(probeDir)

  // ⑤ 通道守卫（issue #3）：懒惰展开之后谁还被尝试
  // 旧代码 `if (!expanded)` / `if (repoChannelAllowed && !expanded)` 把展开后的所有非 npm 通道全跳过，
  // 子包候选只能靠 AI 兜底 —— 桩函数断言"谁被调用了"即可钉死新语义，不必真装。
  const guardProfile = join(dirname(fileURLToPath(import.meta.url)), '.testdir', 'guard-profile')
  const runGuard = async ({ expanded, repoChannelAllowed, budget = { release: 3 }, releaseResult = null }) => {
    const calls = []
    const ch = {
      raceInstallChannels: async () => { calls.push('race'); return null },
      pnpmInstall: async (dir, spec) => {
        calls.push(String(spec).startsWith('git+') || String(spec).startsWith('github:') ? `git:${spec}` : `pnpm:${spec}`)
        throw new Error('registry 404 / git 不可用')
      },
      curlManualInstall: async () => { calls.push('curl'); throw new Error('curl 通道：registry 404') },
      githubReleaseInstall: async (dir, repo, name, options) => {
        calls.push(`release:${repo ?? 'null'}:${name}:${options?.baseUrl ?? 'null'}`)
        if (releaseResult !== null) return releaseResult
        throw new Error('GitHub release 通道：没能找到匹配的发布产物')
      },
      backfillMissingDeps: async () => [],
    }
    const job = { id: 'guard', repo: 'probe-org/agg', packageName: '@scope/root', update: false, source: 'github' }
    const res = await tryCandidateChannels({ job, ch, name: '@scope/sub', profileDir: guardProfile, registries: ['https://registry.fake'], repoChannelAllowed, budget, baseUrl: 'file:///probe/cordis.yml', expanded })
    return { calls, job, res }
  }
  const gExpanded = await runGuard({ expanded: true, repoChannelAllowed: false })
  check('★ expanded 之后：并行竞速 / curl / release 三条通道仍会被尝试（旧代码会全部跳过）',
    ['race', 'curl'].every((c) => gExpanded.calls.includes(c)) && gExpanded.calls.some((c) => c.startsWith('release:')),
    gExpanded.calls.join(' → '))
  check('★ release 通道不受 subpackageMode 限制：子包候选也按包名反查（repo 仍传 job.repo，由反查自行扩大候选）',
    gExpanded.calls.includes('release:probe-org/agg:@scope/sub:file:///probe/cordis.yml'), gExpanded.calls.join(' → '))
  check('★ expanded 之后：git 通道不再尝试（同一个 job.repo 不重复 clone）',
    !gExpanded.calls.some((c) => c.startsWith('git:')), gExpanded.calls.join(' → '))
  const gExpandedRoot = await runGuard({ expanded: true, repoChannelAllowed: true })
  check('★ expanded 之后即使候选与请求同源，git 也不重复尝试（保留 !expanded 的级联顺序）',
    !gExpandedRoot.calls.some((c) => c.startsWith('git:')), gExpandedRoot.calls.join(' → '))
  const gBefore = await runGuard({ expanded: false, repoChannelAllowed: true })
  check('未展开时 git 通道照旧尝试（级联顺序没被破坏）',
    gBefore.calls.some((c) => c.startsWith('git:')), gBefore.calls.join(' → '))
  const gBudget = { release: 1 }
  await runGuard({ expanded: true, repoChannelAllowed: false, budget: gBudget })
  const gBudget2 = await runGuard({ expanded: true, repoChannelAllowed: false, budget: gBudget })
  check('★ release 反查有候选预算：预算用尽后不再扫 release（避免吃光 8 分钟作业时间）',
    gBudget2.calls.some((c) => c.startsWith('release:')) === false, gBudget2.calls.join(' → '))
  check('预算用尽不覆盖真实错误（面板/AI 兜底要看的是 curl·pnpm 的失败原因）',
    String(gBudget2.res.lastError?.message ?? '').includes('curl'), String(gBudget2.res.lastError?.message ?? ''))
  const gSource = await runGuard({
    expanded: true, repoChannelAllowed: false,
    releaseResult: { version: '0.3.5', missingDeps: [], boxNote: null, sourceNote: 'yjh051108/dsh-super-injector 的 release v0.3.5 的资产 dsh-external-dsh-super-injector-0.3.5.tgz' },
  })
  check('★ 成功时如实写明来源：仓库 + release + asset 都进 job.curlNote',
    gSource.res.installedName === '@scope/sub'
    && gSource.job.curlNote.includes('yjh051108/dsh-super-injector')
    && gSource.job.curlNote.includes('v0.3.5')
    && gSource.job.curlNote.includes('dsh-external-dsh-super-injector-0.3.5.tgz'),
    gSource.job.curlNote)
}

// ── ⑬ 挂起根因回归：并行竞速在"两条通道都已失败"时必须立刻收工（issue #3 收尾）─────────────
// 现场：test-suite-install.mjs 单独跑 5 分钟不结束。根因是 raceInstallChannels 只挂"成功"与
// "120 秒兜底"两个出口，失败被吞成永不 settle 的 Promise —— 包根本没发布（pnpm 与 curl 都秒级 404）时
// 也要空等满 120 秒；私有聚合根展开出 3 个候选 = 6 分钟，作业 8 分钟预算被吃光 → 掉进 AI 兜底再等 10 分钟。
// 这里用桩把两条通道换成"立刻失败"，断言收工时延；真网络（真 pnpm/curl）不参与，CI 可跑。
{
  const rejectFast = async () => { throw new Error('桩：registry 404') }
  const t = Date.now()
  const none = await raceInstallChannels(join(dirname(fileURLToPath(import.meta.url)), '.testdir'), '@probe/never-published', ['https://registry.fake'], { pnpmInstall: rejectFast, curlManualInstall: rejectFast })
  const ms = Date.now() - t
  check('★ 两条通道都失败 → 立刻返回 null（不再空等 120 秒兜底）', none === null && ms < 3000, `${ms}ms`)
  const curlWins = await raceInstallChannels(join(dirname(fileURLToPath(import.meta.url)), '.testdir'), '@probe/whatever', ['https://registry.fake'], {
    pnpmInstall: rejectFast,
    curlManualInstall: async () => ({ version: '1.0.0', missingDeps: [], boxNote: null }),
  })
  check('一条成功即胜出（竞速语义没被改坏）', curlWins?.channel === 'curl' && curlWins?.info?.version === '1.0.0', JSON.stringify(curlWins))
  const curlSlow = await raceInstallChannels(join(dirname(fileURLToPath(import.meta.url)), '.testdir'), '@probe/slow', ['https://registry.fake'], {
    pnpmInstall: rejectFast,
    curlManualInstall: () => new Promise(() => {}),
    capMs: 400, // 只给单测缩短兜底时长（生产恒为 120 秒），否则这条断言要跑 2 分钟
  })
  const slowMs = Date.now() - t - ms
  check('另一条还在跑时不提前收工（等满兜底出口才返回 null）', curlSlow === null && slowMs >= 350, `${slowMs}ms（capMs=400）`)
}

// ── ⑭ release 反查的硬预算（issue #3 收尾）：到点即放弃，绝不阻塞安装主链 ────────────────
{
  // fetchReleaseList 的预算为 0/负 → 不发起请求，直接给出"超出预算"的结论（而不是空转）
  let called = 0
  const noCall = await fetchReleaseList('probe-org/x', null, async () => { called += 1; return [] }, 10, 0)
  check('★ 预算已用尽 → 不发起 releases 请求，直接返回"超出预算"',
    called === 0 && noCall.releases.length === 0 && String(noCall.error).includes('预算'), noCall.error)
  check('预算常量合理（总 ≤ 30 秒、扫描候选 ≤ 5 个）',
    RELEASE_CHANNEL_BUDGET_MS <= 30000 && RELEASE_SCAN_MAX_REPOS >= 1 && RELEASE_SCAN_MAX_REPOS <= 5,
    `${RELEASE_CHANNEL_BUDGET_MS}ms / ${RELEASE_SCAN_MAX_REPOS} 个`)
  // 候选仓库多于扫描上限 → 只对前 N 个真的列 release，其余在清单里如实说明"预算裁剪"
  const scanned = []
  const many = await selectReleaseInstall({
    repo: 'probe-org/explicit', packageName: '@probe/never', profileDir: null, registries: ['https://registry.fake'], token: null,
    fetchers: {
      fetchJson: async () => ({ repository: { url: 'git+https://github.com/probe-org/from-npm.git' } }),
      githubJson: async (url) => {
        if (String(url).includes('/search/repositories')) {
          // 仓库名与包名逐字对上 → 按星数取前几个（同名不同 owner 的真实形态）
          return { items: ['a', 'b', 'c'].map((o, i) => ({ full_name: `probe-org-${o}/never`, name: 'never', stargazers_count: 9 - i })) }
        }
        scanned.push(String(url))
        return []
      },
    },
  })
  check('★ 候选仓库扫描有上限：只对前 N 个列 release，其余如实标注"预算裁剪"',
    many.repos.length > RELEASE_SCAN_MAX_REPOS && scanned.length === RELEASE_SCAN_MAX_REPOS && many.ok === false
    && many.groups.some((g) => String(g.error ?? '').includes('预算裁剪')),
    `共 ${many.repos.length} 个候选仓库，实际扫描 ${scanned.length} 个（上限 ${RELEASE_SCAN_MAX_REPOS}）`)
  check('release 链路的失败一律是"返回值"而不是抛出的异常（探测失败＝这个来源没有）',
    many.ok === false && typeof many.message === 'string' && many.message.includes('@probe/never'))
}

// ── ⑮ release 产物下载：直连优先 + 镜像兜底（issue #3 收尾，本机实测）────────────────────
// 现场实测（2026-09-22）：curl 直连 github.com 的 releases/download 地址是 exit 35（SSL connect error），
// node https 也报证书错误；而同一 URL 经 ghproxy.net 是 200 / 358KB。只试直连会让"反查命中 + asset 挑对"
// 之后仍然装不上。这里用可注入 runner 离线钉死"直连失败 → 走镜像 → 校验体积"的语义。
{
  const direct = 'https://github.com/o/r/releases/download/v1/pkg-1.0.0.tgz'
  const urls = releaseDownloadUrls(direct)
  check('★ 下载地址：直连优先，镜像兜底（前缀复用 raw/api 那批加速器）',
    urls.length === RELEASE_DOWNLOAD_MIRROR_PREFIXES.length + 1 && urls[0] === direct
    && urls.slice(1).every((u, i) => u === `${RELEASE_DOWNLOAD_MIRROR_PREFIXES[i]}${direct}`),
    urls.join('\n   '))
  check('空地址不产生任何请求', releaseDownloadUrls('').length === 0 && releaseDownloadUrls(null).length === 0)

  const dlDir = join(dirname(fileURLToPath(import.meta.url)), '.testdir', 'download-probe')
  mkdirSync(dlDir, { recursive: true })
  const dest = join(dlDir, 'pkg.tgz')
  const seen = []
  const fakeRunner = async (bin, args) => {
    const url = args[args.length - 1]
    seen.push(url)
    if (seen.length === 1) throw new Error('curl exit 35（SSL connect error）') // 直连必失败：复现本机现场
    writeFileSync(dest, Buffer.alloc(2048, 7)) // 镜像成功：写一个够大的假产物
  }
  const size = await downloadReleaseArtifact(direct, dest, { runner: fakeRunner })
  check('★ 直连失败自动改走镜像并成功落盘（否则 issue #3 在本机永远装不上）',
    size === 2048 && seen.length === 2 && seen[1] === `${RELEASE_DOWNLOAD_MIRROR_PREFIXES[0]}${direct}`,
    `尝试 ${seen.length} 条：${seen.map((u) => u.replace(direct, '…asset')).join(' → ')}`)

  // 全部地址都失败 → 抛出的错误必须把"试过哪几条"说清楚（排查靠它）
  let allFail = null
  try {
    await downloadReleaseArtifact(direct, dest, { runner: async () => { throw new Error('桩：全部失败') }, mirrors: true })
  } catch (error) { allFail = error }
  check('★ 所有下载地址都失败时，错误里列出尝试过的地址（含"直连"标注）',
    allFail !== null && String(allFail.message).includes('已尝试 3 条地址') && String(allFail.message).includes('（直连）'),
    String(allFail?.message).slice(0, 120))
  // 体积下限：黑洞期常见的 0 字节/错误页必须当失败，不能拿去装
  let tooSmall = null
  try {
    await downloadReleaseArtifact(direct, dest, { mirrors: false, runner: async (bin, args) => { writeFileSync(args[args.indexOf('-o') + 1], 'x') } })
  } catch (error) { tooSmall = error }
  check('★ 下载内容过小（黑洞期错误页）判失败，不拿去装', tooSmall !== null && String(tooSmall.message).includes('过小'), String(tooSmall?.message).slice(0, 90))
  removeDirVerified(dlDir)
}

server.close()
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
