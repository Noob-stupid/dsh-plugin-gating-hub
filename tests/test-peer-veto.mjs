// 0.5.33 加法 D-⑧：框架 peer 预检「否决」的**本地复算**（诊断缺口）
//
// 真机症状：补丁里写着启用（或压根没写 disabled）、运行时却没挂载（fiberPhase === null），
// 面板一个字都不说为什么。真实机制在框架侧（`@deepseek-ai/dsh-app-boot`）：
//   evaluatePluginCompatibility(:286-313) 只看 peerDependencies 里 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`，
//   preflight(:2063-2109) 判不满足就**只在内存里** row.disabled = true（**不写用户补丁**），原因只打 stderr。
//   本机典型现场：profile 顶层压着 `@deepseek-ai/dsh-schedule@0.0.1-rc.3` 残影，其 peer 写 `^0.0.1-rc.3`
//   → 对运行中的 0.2.0-rc.2 必然不满足。
//
// 本套钉死任务要求的四条：
//   ① peer 不满足 → **产出该原因**（短句里带"需要什么 / 当前什么"）
//   ② 满足 → **不产出**
//   ③ 包解析不到 → **另给「包不存在」原因**（与 ① 的措辞、出处都不同，绝不混为一谈）
//   ④ 0 本机路径（本轮新增/改动文件里，本机用户名 / 家目录 / 工作副本绝对路径 0 出现）
// 另加：真机残影复现（`@deepseek-ai/dsh-schedule@0.0.1-rc.3` × 0.2.0-rc.2 → 判定不满足）、
// workspace: 协议与空范围、非 dsh peer 不参与、以及**真的走一遍 GET /state**（断言 entries[].veto 下发）。
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dshHome } from '../lib/server/infra/paths.js'
import { currentFrameworkVersion } from '../lib/server/domain/framework.js'
import { peerVetoFor, unsatisfiedPeers } from '../lib/server/domain/peer-veto.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
const HOME = join(ROOT, '.testdir', 'peer-veto-home')
// 「真机残影」那一段要用**真实的** DSH 数据目录，而本套其余部分要隔离到临时目录 ——
// 所以先把真实位置按 dshHome() 的同一口径记下来，再覆盖 DSH_HOME（不写死本机路径）。
const REAL_DSH_HOME = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
process.env.DSH_HOME = HOME // 必须在 import 之前设置
rmSync(HOME, { recursive: true, force: true })

const FW_VERSION = '0.2.0-rc.2'
const profileDir = join(HOME, 'profiles', 'web')
const patchPath = join(profileDir, 'cordis.patch.yml')
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })

/** 写一个可解析的包（fixture）。 */
const writePkg = (name, manifest, source = 'export const ok = true\n') => {
  const dir = join(profileDir, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ main: 'index.js', ...manifest }, null, 2), 'utf8')
  writeFileSync(join(dir, 'index.js'), source, 'utf8')
}
// 框架版本夹具：currentFrameworkVersion 从 ctx.baseUrl（profile）解析 @deepseek-ai/dsh/package.json
writePkg('@deepseek-ai/dsh', { name: '@deepseek-ai/dsh', version: FW_VERSION })
// ① peer 不满足（真机 dsh-schedule 残影同形：0.0.1-rc.3 的包对 0.2.0-rc.2 的框架）
writePkg('@fake/stale-peer', { name: '@fake/stale-peer', version: '0.0.1-rc.3', peerDependencies: { '@deepseek-ai/dsh-agent': '^0.0.1-rc.3', '@deepseek-ai/cordis': '^4.0.1-rc.1' } })
// ② peer 满足（注意 `>=0.1.2` 这种"范围里没有 prerelease"的声明：框架用 includePrerelease，视为满足；
//    我们的本地复算走**宽松**那一支，同样视为满足 —— 保守方向是"宁可不说，不可错说"）
writePkg('@fake/peer-ok', { name: '@fake/peer-ok', version: '1.2.3', peerDependencies: { '@deepseek-ai/dsh': '>=0.1.2', '@deepseek-ai/dsh-agent': '^0.2.0-rc.1', '@deepseek-ai/dsh-session': 'workspace:*', '@deepseek-ai/cordis': '^4.0.1' } })
// 被补丁显式禁用的行（不是被框架否决的）→ 不该给"框架否决"原因
writePkg('@fake/user-off', { name: '@fake/user-off', version: '0.0.1-rc.3', peerDependencies: { '@deepseek-ai/dsh-agent': '^0.0.1-rc.3' } })

writeFileSync(patchPath, ['# user patch', '- id: user-off-row', '  disabled: true', ''].join('\n'), 'utf8')

const cordisUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
const ctx = {
  baseUrl: cordisUrl,
  loader: {
    entries: () => [
      { id: 'include', options: { name: 'cordis:include', group: true, config: { path: cordisUrl } } },
      // 补丁要求启用、运行时未挂载 —— 正是"被框架否决"的形状
      { id: 'include:stale-peer-row', options: { name: '@fake/stale-peer' }, disabled: true, fiber: undefined },
      // 正常挂载的行（不该有原因）
      { id: 'include:peer-ok-row', options: { name: '@fake/peer-ok' }, disabled: false, fiber: { state: 2 } },
      // 包解析不到
      { id: 'include:missing-row', options: { name: '@fake/missing-pkg' }, disabled: true, fiber: undefined },
      // 补丁显式禁用（不是框架否决）
      { id: 'include:user-off-row', options: { name: '@fake/user-off' }, disabled: true, fiber: undefined },
    ],
  },
  webServer: { register: (route) => { globalThis.__route = route; return () => {} } },
  effect: (fn) => { try { fn() } catch {}; return () => {} },
}

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

console.log('=== ① 纯判据：peer 不满足 / 满足 / 边界 ===')
{
  const stale = { peerDependencies: { '@deepseek-ai/dsh-agent': '^0.0.1-rc.3', '@deepseek-ai/cordis': '^4.0.1-rc.1' } }
  const bad = unsatisfiedPeers(stale, FW_VERSION)
  check('① 只挑 dsh 前缀的 peer（@deepseek-ai/cordis 不参与）', bad.length === 1 && bad[0].name === '@deepseek-ai/dsh-agent', JSON.stringify(bad))
  check('② 满足的声明一条都不产出', unsatisfiedPeers({ peerDependencies: { '@deepseek-ai/dsh': '>=0.1.2', '@deepseek-ai/dsh-agent': '^0.2.0-rc.1' } }, FW_VERSION).length === 0)
  check('② workspace:^ / ~ / * 视为"等于当前运行时"（框架语义）',
    ['workspace:^', 'workspace:~', 'workspace:*'].every((r) => unsatisfiedPeers({ peerDependencies: { '@deepseek-ai/dsh-agent': r } }, FW_VERSION).length === 0))
  check('① 空范围字符串 → 不满足（框架 requirement.trim() === "" 同款）',
    unsatisfiedPeers({ peerDependencies: { '@deepseek-ai/dsh-agent': '   ' } }, FW_VERSION).length === 1)
  check('没有 peerDependencies 字段 → 无话可说（框架 Object.hasOwn 判据同款）',
    unsatisfiedPeers({ name: 'x' }, FW_VERSION).length === 0 && unsatisfiedPeers(null, FW_VERSION).length === 0)
  check('peer 满足但运行时版本未知 → 不产出（不知道就不说）', unsatisfiedPeers(stale, null).length === 0)
}

console.log('\n=== ③ 域级：三种结局的措辞必须分得开 ===')
{
  const write = (name, manifest) => writePkg(name, manifest)
  write('@fake/dom-stale', { name: '@fake/dom-stale', version: '0.0.1-rc.3', peerDependencies: { '@deepseek-ai/dsh-agent': '^0.0.1-rc.3' } })
  const peersCase = peerVetoFor({ moduleName: '@fake/dom-stale', profileDir, frameworkVersion: FW_VERSION })
  check('③-① peer 不满足 → kind=peers，原因写明"需要什么/当前什么"',
    peersCase?.kind === 'peers' && /peer 不满足/u.test(peersCase.reason) && peersCase.reason.includes('^0.0.1-rc.3') && peersCase.reason.includes(FW_VERSION), JSON.stringify(peersCase))
  check('③-① 带出路提示（清残留 / 更新 / 精确版本豁免）',
    typeof peersCase.hint === 'string' && /更新/u.test(peersCase.hint) && /compatibility\.json/u.test(peersCase.hint))
  const okCase = peerVetoFor({ moduleName: '@fake/peer-ok', profileDir, frameworkVersion: FW_VERSION })
  check('③-② peer 满足 → null（不产出）', okCase === null, JSON.stringify(okCase))
  const missingCase = peerVetoFor({ moduleName: '@fake/missing-pkg', profileDir, frameworkVersion: FW_VERSION })
  check('③-③ 包解析不到 → kind=missing 且**措辞与 peers 不同**',
    missingCase?.kind === 'missing' && /包不存在/u.test(missingCase.reason) && !/peer 不满足/u.test(missingCase.reason), JSON.stringify(missingCase))
  check('③-③ missing 的出路也不是 peer 那条（不混为一谈）', typeof missingCase.hint === 'string' && !/compatibility\.json/u.test(missingCase.hint))
  const brokenCase = peerVetoFor({
    moduleName: '@fake/broken-manifest', profileDir, frameworkVersion: FW_VERSION,
    deps: { resolvePkg: () => join(profileDir, 'nope.json'), readText: () => '{ not json' },
  })
  check('③-③ 清单读不出来 → 也是 missing，但点名"清单读不出来"',
    brokenCase?.kind === 'missing' && /清单读不出来/u.test(brokenCase.reason), JSON.stringify(brokenCase))
  check('③ 框架版本未知 → 不产出（避免瞎猜）', peerVetoFor({ moduleName: '@fake/dom-stale', profileDir, frameworkVersion: null }) === null)
  check('③ cordis: 内置行不参与', peerVetoFor({ moduleName: 'cordis:group', profileDir, frameworkVersion: FW_VERSION }) === null)
}

console.log('\n=== ①′ 真机残影复现：@deepseek-ai/dsh-schedule@0.0.1-rc.3 × 当前框架 ===')
{
  const candidates = []
  const profilesDir = join(REAL_DSH_HOME, 'profiles')
  if (existsSync(profilesDir)) {
    for (const name of readdirSync(profilesDir)) {
      const dir = join(profilesDir, name, 'node_modules', '@deepseek-ai', 'dsh-schedule')
      if (existsSync(join(dir, 'package.json'))) candidates.push({ dir, profileDir: join(profilesDir, name) })
    }
  }
  if (candidates.length === 0) {
    console.log('SKIP ①′ 本机没有 @deepseek-ai/dsh-schedule 残影 —— 没有夹具就不假装 PASS')
  } else {
    for (const { dir, profileDir: realProfile } of candidates) {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      // 框架版本按生产同一口径解析（currentFrameworkVersion ← profile 的 baseUrl）
      const realFw = currentFrameworkVersion({ baseUrl: pathToFileURL(join(realProfile, 'cordis.yml')).href }) ?? FW_VERSION
      const bad = unsatisfiedPeers(manifest, realFw)
      check(`①′ dsh-schedule@${manifest.version} 的 dsh peer 对 ${realFw} 全部不满足（真机现场）`,
        bad.length >= 1 && bad.every((p) => p.name.startsWith('@deepseek-ai/dsh')), JSON.stringify(bad.slice(0, 2)))
      const rec = peerVetoFor({ moduleName: '@deepseek-ai/dsh-schedule', profileDir: realProfile, frameworkVersion: realFw })
      check(`①′ 走 peerVetoFor 也产出 peers 原因（真机上就是这个包解析路径，当前 ${realFw}）`,
        rec?.kind === 'peers' && rec.reason.includes(realFw), JSON.stringify(rec)?.slice(0, 200))
    }
  }
}

console.log('\n=== 接线：真的 GET /state，断言 entries[].veto 如实下发 ===')
{
  const mod = await import('../lib/index.js')
  mod.apply(ctx)
  const route = globalThis.__route
  if (!route) throw new Error('路由未注册')
  const call = async (method, path) => {
    const res = { status: 0, body: null }
    res.writeHead = (s) => { res.status = s }
    res.end = (p) => { res.body = p }
    const req = {
      method, url: path, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' },
      signal: { aborted: false, addEventListener: () => {} },
      [Symbol.asyncIterator]() { return { next: async () => ({ value: undefined, done: true }) } },
    }
    await route.handler(req, res)
    return { status: res.status, json: res.body === null ? null : JSON.parse(res.body) }
  }
  const r = await call('GET', '/plugin-console/state')
  check('GET /state 200', r.status === 200, `status=${r.status}`)
  const entries = Array.isArray(r.json?.entries) ? r.json.entries : []
  const byRow = (id) => entries.find((e) => e.rowId === id)
  check('框架版本按 ctx.baseUrl 解析到夹具的 ' + FW_VERSION, r.json?.framework?.version === FW_VERSION, JSON.stringify(r.json?.framework?.version))
  const stale = byRow('stale-peer-row')
  check('① 未挂载 + 补丁要求启用 → 下发 veto(kind=peers) 短句原因',
    stale?.fiberPhase === null && stale?.veto?.kind === 'peers' && /peer 不满足/u.test(stale.veto.reason), JSON.stringify(stale?.veto))
  check('① 同行仍如实保留 未挂载 / 未启用（加法，不改既有字段）',
    stale?.fiberPhase === null && stale?.enabled === false && stale?.userDisabled === false)
  check('② 已挂载的行不下发 veto', byRow('peer-ok-row')?.veto === null, JSON.stringify(byRow('peer-ok-row')?.veto))
  check('③ 包不存在的行下发 veto(kind=missing)，与 ① 的 kind 不同', byRow('missing-row')?.veto?.kind === 'missing', JSON.stringify(byRow('missing-row')?.veto))
  check('补丁显式禁用的行不下发 veto（那不是框架否决）', byRow('user-off-row')?.veto === null, JSON.stringify(byRow('user-off-row')?.veto))
  check('veto 只在 entries 上（没有新增常驻面板行/顶层字段）', Object.keys(r.json?.veto ?? {}).length === 0 && r.json?.veto === undefined)
}

console.log('\n=== ④ 0 本机路径（本轮新增/改动文件）===')
{
  const CHANGED = [
    'lib/client.js',
    'lib/server/domain/compat.js',
    'lib/server/domain/settings-api-scan.js',
    'lib/server/domain/peer-veto.js',
    'lib/server/routes/state.js',
    'lib/server/routes/plugins.js',
    'tests/test-settings-api-scan.mjs',
    'tests/test-peer-veto.mjs',
  ]
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const userName = home === '' ? '' : home.split(/[\\/]/u).pop()
  const PERCENT = userName === '' ? '' : encodeURIComponent(userName)
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const BANNED = [
    { name: '本机用户名（原样）', re: userName.length < 2 ? null : new RegExp(escape(userName), 'u') },
    { name: '本机用户名（百分号编码）', re: PERCENT === '' || PERCENT === userName ? null : new RegExp(escape(PERCENT), 'u') },
    { name: '本机家目录明文', re: home === '' ? null : new RegExp(escape(home).replace(/[\\/]/gu, '[\\\\/]'), 'u') },
    { name: '本次工作副本绝对路径', re: new RegExp(escape(REPO).replace(/[\\/]/gu, '[\\\\/]'), 'u') },
    { name: '仓库外私有目录（dsh-desktop 源码）', re: /dsh-desktop[\\/]resources/u },
  ].filter((b) => b.re !== null)
  const hits = []
  for (const rel of CHANGED) {
    const abs = join(REPO, rel)
    if (!existsSync(abs)) { hits.push(`${rel}（文件不存在）`); continue }
    readFileSync(abs, 'utf8').split(/\r?\n/u).forEach((line, i) => {
      for (const b of BANNED) if (b.re.test(line)) hits.push(`${rel}:${i + 1} ${b.name}`)
    })
  }
  check(`④ ★ 本机绝对路径 / 用户名 0 出现（扫 ${CHANGED.length} 个本轮文件）`, hits.length === 0, hits.slice(0, 6).join(' | ') || undefined)
  check('④ 扫描断言本身有效（能抓到构造的违规串）', BANNED.some((b) => b.re.test(`x ${home} y`)) || home === '')
}

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
