// 0.5.37 更新候选判据：唯一判据 pickNewerSemver ——「反向更新（降级按钮）」的回归钉子（全离线）
//
// 真机缺陷（2026-10-03 用户实测）：插件卡片上已装 `@deepseek-ai/dsh-time-context` **0.2.0-rc.2**，
// 却提示「发现新版本 0.2.0-rc.2 → **0.1.1-rc.1**」（更低！）并给出「更新」按钮 ⇒ 按下去是**降级**。
// 现场数据：npm 侧 dist-tags = { latest: 0.0.1-rc.1, next: 0.2.0-rc.2, alpha: 0.2.1-alpha.1 }；
// 镜像源 registry.npmmirror.com 的 latest = 0.1.1-rc.1（同样陈旧，低于已装版本）。
//
// 根因（两半，都要钉住）：
//   · 客户端普通插件行只判 `data.latest` 与 `entry.version` **字符串不相等** —— 没有大小比较；
//   · 框架特判路径那份正确的比较结论，被后执行的普通行**覆盖**成错的（两条路径写同一个 map）。
//
// 本套断言（全离线，不出网）：
//   ① 真实回归用例：current=0.2.0-rc.2 + 候选 [0.1.1-rc.1, 0.0.1-rc.1, 0.2.0-rc.2] ⇒ **null**
//   ② 预发布序正确：current=0.1.7-rc.2 + [0.1.1-rc.1, 0.2.0-rc.2] ⇒ 0.2.0-rc.2
//   ③ 正式版高于同号预发布（0.1.1 > 0.1.1-rc.2）/ 相同版本 ⇒ null / 垃圾串（''、latest、1.2）⇒ null
//   ④ 双份实现逐字一致：服务端 lib/server/infra/semver.js ↔ 浏览器单文件产物 lib/client.js
//   ⑤ 源码级防回退：client.js 里**不再存在**"只判字符串不相等"的那个判据；两处调用点都只调唯一判据
//   ⑥ 服务端兜底：/check-update 把"严格低于已装版本"的候选清成 null（字段名不变）
//   ⑦ 本机化纪律：本轮新增/改动文件里 0 处本机绝对路径 / 用户名
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// 私有 DSH_HOME + 私有 profile：服务端兜底要读"已装版本"，用桩 profile 钉住真机数据
// （已装 0.2.0-rc.2），既不碰真实 profile、也不依赖本机装了什么。
const HOME = join(ROOT, '.testdir', 'update-pick-home')
rmSync(HOME, { recursive: true, force: true })
const PROFILE = join(HOME, 'profiles', 'web')
mkdirSync(join(PROFILE, 'node_modules', '@deepseek-ai', 'dsh-time-context'), { recursive: true })
writeFileSync(join(PROFILE, 'node_modules', '@deepseek-ai', 'dsh-time-context', 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/dsh-time-context', version: '0.2.0-rc.2' }, null, 2), 'utf8')
process.env.DSH_HOME = HOME
// 服务端净化模块只收"已解开的" baseUrl / profileDir（domain 层不认识 cordis ctx）：直接喂桩 profile 目录
const BASE_URL = 'file:///'

const { pickNewerSemver } = await import('../lib/server/infra/semver.js')
const { dropStaleUpdateCandidates } = await import('../lib/server/domain/update-candidates.js')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

const clientSrc = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
const semverSrc = readFileSync(join(ROOT, 'lib', 'server', 'infra', 'semver.js'), 'utf8')
const frameworkSrc = readFileSync(join(ROOT, 'lib', 'server', 'routes', 'framework.js'), 'utf8')

// ── ①-③ 唯一判据的行为（含真机回归用例）────────────────────────────────────────
// 期望值就是"面板该不该提示更新、提示哪个版本"：null = 不提示（绝不提示低版本）。
const CASES = [
  // ① 真机回归钉子：镜像 latest（0.1.1-rc.1）比已装（0.2.0-rc.2）低 ⇒ 必须 null
  ['真机回归：已装 0.2.0-rc.2 × 候选 [0.1.1-rc.1, 0.0.1-rc.1, 0.2.0-rc.2]（都 ≤ 已装）', '0.2.0-rc.2', ['0.1.1-rc.1', '0.0.1-rc.1', '0.2.0-rc.2'], null],
  // 真机同场的其它 dist-tag：next 等于已装 ⇒ 不提示；alpha 严格更高 ⇒ 提示
  ['真机同场：next = 已装 0.2.0-rc.2 ⇒ null', '0.2.0-rc.2', ['0.2.0-rc.2'], null],
  ['真机同场：alpha = 0.2.1-alpha.1（严格更高）⇒ 0.2.1-alpha.1', '0.2.0-rc.2', ['0.2.1-alpha.1'], '0.2.1-alpha.1'],
  // ② 预发布序：0.1.7-rc.2 < 0.2.0-rc.2（跨 minor），0.1.1-rc.1 更低
  ['预发布跨 minor：已装 0.1.7-rc.2 × [0.1.1-rc.1, 0.2.0-rc.2] ⇒ 0.2.0-rc.2', '0.1.7-rc.2', ['0.1.1-rc.1', '0.2.0-rc.2'], '0.2.0-rc.2'],
  ['预发布同号：已装 0.1.7-rc.2 × 0.1.7-rc.3 ⇒ 0.1.7-rc.3', '0.1.7-rc.2', ['0.1.7-rc.3'], '0.1.7-rc.3'],
  ['预发布数字序（不是字典序）：已装 1.0.0-rc.9 × 1.0.0-rc.10 ⇒ 1.0.0-rc.10', '1.0.0-rc.9', ['1.0.0-rc.10'], '1.0.0-rc.10'],
  ['预发布比正式版低：已装 0.1.1-rc.2 × 0.1.1-rc.1（更低）⇒ null', '0.1.1-rc.2', ['0.1.1-rc.1'], null],
  // ③ 正式版 > 同号预发布；相同版本 / 不可解析 ⇒ null
  ['正式版高于同号预发布：已装 0.1.1-rc.2 × 0.1.1 ⇒ 0.1.1', '0.1.1-rc.2', ['0.1.1'], '0.1.1'],
  ['反向：已装正式版 0.1.1 × 0.1.1-rc.2（同号预发布更低）⇒ null', '0.1.1', ['0.1.1-rc.2'], null],
  ['相同版本 ⇒ null', '0.1.7', ['0.1.7'], null],
  ['多个候选取**严格更高的最高者**', '1.0.0', ['1.0.1-rc.1', '1.0.1', '1.2.0', '2.0.0'], '2.0.0'],
  ['候选里的垃圾串被跳过，仍取合格者', '1.0.0', ['', 'latest', '1.2', '1.0.5'], '1.0.5'],
  ['容忍 v 前缀（返回归一化后的版本）', 'v1.0.0', ['v1.0.1'], '1.0.1'],
  ['忽略 build 元数据（只比较语义版本）', '1.0.0', ['1.0.1+build.7'], '1.0.1+build.7'],
  ['垃圾串 current：空串 ⇒ null', '', ['1.0.0'], null],
  ['垃圾串 current：latest ⇒ null', 'latest', ['1.0.0'], null],
  ['垃圾串 current：1.2（缺 patch）⇒ null', '1.2', ['1.0.0'], null],
  ['全部候选都是垃圾串 ⇒ null', '1.0.0', ['', 'latest', '1.2'], null],
  ['候选缺省 / null / 非数组 ⇒ null', '1.0.0', null, null],
  ['候选数组里混 null/undefined ⇒ 跳过', '1.0.0', [null, undefined, ''], null],
]
let caseFailed = 0
for (const [name, current, candidates, want] of CASES) {
  const got = pickNewerSemver(current, candidates)
  if (got !== want) {
    caseFailed += 1
    check(`② 判据用例：${name}`, false, `期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`)
  }
}
check(`①②③ 唯一判据 pickNewerSemver 的 ${CASES.length} 条用例全部符合期望（含真机回归：低版本 ⇒ null）`,
  caseFailed === 0, caseFailed === 0 ? undefined : `${caseFailed} 条不符`)
check('② 判据是纯函数：同输入重复调用结果一致（无隐藏状态）',
  pickNewerSemver('0.2.0-rc.2', ['0.1.1-rc.1']) === pickNewerSemver('0.2.0-rc.2', ['0.1.1-rc.1'])
  && pickNewerSemver('0.1.7-rc.2', ['0.2.0-rc.2']) === '0.2.0-rc.2')

// ── ④ 双份实现逐字一致（唯一判据是**可验证的事实**，不是口头约定）────────────────
/** 取标记块（含 begin/end 两行），去掉行首缩进 + 统一 LF。 */
function pickBlockOf(source) {
  const lines = source.replace(/\r\n/gu, '\n').split('\n')
  const begin = lines.findIndex((l) => l.trimStart().startsWith('// <<<update-pick:begin>>>'))
  const end = lines.findIndex((l) => l.trimStart().startsWith('// <<<update-pick:end>>>'))
  if (begin < 0 || end <= begin) return null
  return lines.slice(begin, end + 1).map((l) => l.replace(/^[ \t]*/u, '')).join('\n').trim()
}
const serverBlock = pickBlockOf(semverSrc)
const clientBlock = pickBlockOf(clientSrc)
check('④ 两端都有更新判据标记块（服务端 infra/semver.js / 浏览器单文件产物 lib/client.js）',
  serverBlock !== null && clientBlock !== null,
  `server=${serverBlock === null ? '缺失' : `${serverBlock.split('\n').length} 行`} client=${clientBlock === null ? '缺失' : `${clientBlock.split('\n').length} 行`}`)
check('④ ★ 两份实现**去缩进后逐字相等**（改一边必须改另一边）',
  serverBlock !== null && serverBlock === clientBlock,
  serverBlock === clientBlock ? '一致' : '不一致 —— 唯一判据被分叉了')
check('④ 判据块里确实只有**一个** pickNewerSemver 入口（不许冒出第二份比较实现）',
  serverBlock !== null
  && [...serverBlock.matchAll(/function pickNewerSemver\(/gu)].length === 1
  && [...serverBlock.matchAll(/function updateParseVersion\(/gu)].length === 1
  && [...serverBlock.matchAll(/function updateCompareVersion\(/gu)].length === 1)
check('④ 服务端模块确实导出 pickNewerSemver（路由兜底 import 它）',
  /export \{[^}]*pickNewerSemver[^}]*\}/u.test(semverSrc))

// ── ⑤ 客户端源码级防回退（真 bug 的判据 + 两条路径的覆盖问题）──────────────────
check('⑤ ★ lib/client.js 里再也没有"只判字符串不相等"那个判据（防回退）',
  !clientSrc.includes('data.latest !== entry.version'),
  clientSrc.includes('data.latest !== entry.version') ? '旧判据又回来了 —— 反向更新会复发' : undefined)
check('⑤ ★ 普通插件行改成"严格更高才提示"（唯一判据）',
  clientSrc.includes('const better = data && data.error === null ? pickNewerSemver(entry.version, [data.latest]) : null;'))
check('⑤ ★ 框架特判路径改用同一判据，并删掉了自己的局部 verNum/isNewer 副本',
  clientSrc.includes('const target = pickNewerSemver(current, [data.latest, data.next]);')
  && !clientSrc.includes('const verNum = (v) =>') && !clientSrc.includes('const isNewer = (a, b) =>'))
check('⑤ ★ 两条写入路径都不得把已有目标换低（prev 更高就保持不动）',
  [...clientSrc.matchAll(/if \(typeof existing === "string" && pickNewerSemver\(/gu)].length === 2,
  `命中 ${[...clientSrc.matchAll(/if \(typeof existing === "string" && pickNewerSemver\(/gu)].length} 处（应为 2）`)
check('⑤ 卡片按钮判据没被削弱：updateMap 命中仍显示「更新 → vX」（不是恒显示/恒隐藏）',
  clientSrc.includes(': updateMap[item.fullName] !== undefined') && clientSrc.includes('t("update") + " → v" + updateMap[item.fullName]'))

// ── ⑥ 服务端兜底：低于已装版本的候选不当作"新版"（字段名不变）──────────────────
const candidatesSrc = readFileSync(join(ROOT, 'lib', 'server', 'domain', 'update-candidates.js'), 'utf8')
check('⑥ framework.js 的 /check-update 兜底调用了净化模块（字段名不变）',
  /import \{ dropStaleUpdateCandidates \} from '\.\.\/domain\/update-candidates\.js'/u.test(frameworkSrc)
  && frameworkSrc.includes("dropStaleUpdateCandidates({ latest, next, beta }, packageName, ctx.baseUrl ?? 'file:///', profileDirOf(ctx))")
  && frameworkSrc.includes('sendJson(res, 200, { ok: true, packageName, latest, next, beta, depsOutdated, error, source, migrate })'))
check('⑥ 净化模块只收已解开的 baseUrl / profileDir（domain 层不认识 cordis ctx，架构守卫 ⑤）',
  /import \{ entryPkgMeta \} from '\.\.\/infra\/paths\.js'/u.test(candidatesSrc)
  && !/(?<![\w$.])ctx(?![\w$])/u.test(candidatesSrc.replace(/\/\/[^\n]*/gu, '').replace(/\/\*[\s\S]*?\*\//gu, '')))
check('⑥ 净化模块复用唯一判据（不写第二份比较实现）',
  /import \{ pickNewerSemver \} from '\.\.\/infra\/semver\.js'/u.test(candidatesSrc)
  && !/parseInt|split\('\.'\)/u.test(candidatesSrc))
check('⑥ ★ 真机数据（桩 profile 已装 0.2.0-rc.2）：镜像 latest 0.1.1-rc.1 被清成 null；'
  + '等于已装的 next 0.2.0-rc.2 保留；更高的 beta 0.2.1-alpha.1 保留',
  JSON.stringify(dropStaleUpdateCandidates({ latest: '0.1.1-rc.1', next: '0.2.0-rc.2', beta: '0.2.1-alpha.1' }, '@deepseek-ai/dsh-time-context', BASE_URL, PROFILE))
  === JSON.stringify({ latest: null, next: '0.2.0-rc.2', beta: '0.2.1-alpha.1' }))
check('⑥ 未安装的包（读不到已装版本）⇒ 候选原样保留（既有行为一字不动）',
  JSON.stringify(dropStaleUpdateCandidates({ latest: '0.1.0', next: null, beta: null }, '@noob-stupid/not-installed-xyz', BASE_URL, PROFILE))
  === JSON.stringify({ latest: '0.1.0', next: null, beta: null }))

// ── ⑦ 本机化纪律：本轮新增/改动文件里 0 处本机绝对路径 / 用户名（与既有同类扫描同口径）──
{
  const CHANGED = [
    'tests/test-update-version-pick.mjs',
    'lib/server/infra/semver.js',
    'lib/server/domain/update-candidates.js',
  ]
  const ALLOW = [
    /[A-Za-z]:\\Users\\user\b/u,   // 中性占位
    /%LOCALAPPDATA%/u,
    /node_cache/u,                 // npm 缓存目录名（历史形态）
    /_npx/u,                       // npx 缓存目录名
    /app\.asar/u,                  // Electron 打包路径片段
  ]
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const userName = home === '' ? '' : home.split(/[\\/]/u).pop()
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const asPath = (s) => new RegExp(`(?:[\\\\/]|[A-Za-z]:|\\$HOME[\\\\/]|~[\\\\/])${esc(s)}`, 'u')
  const BANNED = [
    { name: '本机用户名（路径位置，原样）', re: userName.length < 2 ? null : asPath(userName) },
    { name: '本机家目录明文', re: home === '' ? null : new RegExp(home.replace(/[\\/]/gu, '[\\\\/]').replace(/[.*+?^${}()|[\]\\]/gu, (m) => (m === '\\' || m === '/' ? m : `\\${m}`)), 'u') },
    { name: '本次工作副本绝对路径', re: new RegExp(ROOT.replace(/[\\/]/gu, '[\\\\/]').replace(/[.*+?^${}()|[\]\\]/gu, (m) => (m === '\\' || m === '/' ? m : `\\${m}`)), 'u') },
  ].filter((b) => b.re !== null)
  const hits = []
  for (const rel of CHANGED) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/u)
    lines.forEach((line, i) => {
      if (ALLOW.some((re) => re.test(line))) return
      for (const b of BANNED) if (b.re.test(line)) hits.push(`${rel}:${i + 1} ${b.name}`)
    })
  }
  check(`⑦ ★ 本轮文件里本机绝对路径 / 用户名 0 出现（扫 ${CHANGED.length} 个文件；允许清单 ${ALLOW.length} 条）`,
    hits.length === 0, hits.slice(0, 5).join(' | ') || undefined)
}

console.log(failed === 0 ? '\nALL PASS（更新候选：严格更高才提示 —— 反向更新/降级按钮的回归钉子）' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
