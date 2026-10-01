// L1 · domain —— peer-veto.js（框架 peer 预检「否决」的**本地复算**；0.5.33 加法，诊断缺口 D-⑧）
// 分层分组：L1 · domain（边界由 tests/test-architecture-guard.mjs 断言）
//
// ── 要解决什么 ────────────────────────────────────────────────────────────────────
// 真机症状：「补丁里明明写着启用（或压根没写 disabled）、运行时却没挂载（fiberPhase === null），
// 面板上一个字都不说为什么」。真实机制（框架侧，不是我们的 bug）：
//   `@deepseek-ai/dsh-app-boot/lib/index.js`
//     · `evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)`（:286-313）
//       —— 只看 **peerDependencies**，只看 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`，
//          `workspace:^|~|*` 视为「等于当前运行时」，其余按 semver（includePrerelease）判；
//     · `preflight()`（:2063-2109）—— 判不满足就在**内存里** `row.disabled = true`（**不写用户补丁**），
//       原因只 `process.stderr.write` 一行。
//   本机典型现场：profile 顶层压着 `@deepseek-ai/dsh-schedule@0.0.1-rc.3` 残影，它的 peer 写
//   `@deepseek-ai/dsh-agent@^0.0.1-rc.3` 等 7 项 → 对运行中的 0.2.0-rc.2 **必然不满足** → 启动即被否决，
//   而补丁尾部还是 `- id: schedule / disabled: false`，面板只显示「未挂载」。
//
// ── 本模块做什么（**加法**：不改任何既有判据与开关，只补一句原因 + 一条出路）────────────
// 在同一判据下本地复算一遍：读该行**实际解析到的包** manifest 的 peerDependencies × 当前框架版本。
// 判定不满足 → 给短句原因 + 出路；包解析不到 → **另给**「包不存在」原因（两者绝不混为一谈）。
//
// ── 保守性（宁可不说，不可错说）────────────────────────────────────────────────
// 框架用的是 node-semver 的 `{ includePrerelease: true }`；仓库既有的 semver 工具里，
// `semverRangeMatchLoose` 与它最接近但**偏宽松**（把它当"满足"的少数情形，框架可能判不满足）。
// 这里**故意用宽松的那一支**：只有连宽松读法都不满足时才说话 —— 与 ①-1「不误报」同一纪律。
// 代价是可能漏报少数否决（表现回退成"什么都不显示"，不会错说原因）。

import { readFileSync } from 'node:fs'
import { resolvePackageJson } from '../infra/paths.js'
import { semverRangeMatchLoose } from '../infra/semver.js'

/** 框架预检只看这个前缀的 peer（与 dsh-app-boot 的 `name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')` 对齐）。 */
const PEER_PREFIX = '@deepseek-ai/dsh'

/** `workspace:^` / `workspace:~` / `workspace:*` 在框架里等价于「当前运行时版本」→ 永远满足。 */
const WORKSPACE_RANGES = new Set(['workspace:^', 'workspace:~', 'workspace:*'])

/**
 * 纯判据：返回**不满足**的 peer 列表（空数组 = 没有相关 peer 声明，或全部满足）。
 * 与 `dsh-app-boot` 的 `evaluatePluginCompatibility` 逐条对齐（见文件头）。
 */
function unsatisfiedPeers(manifest, runtimeVersion) {
  if (manifest === null || typeof manifest !== 'object') return []
  if (!Object.hasOwn(manifest, 'peerDependencies')) return []
  const deps = manifest.peerDependencies
  if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) return []
  if (typeof runtimeVersion !== 'string' || runtimeVersion === '') return []
  const out = []
  for (const [name, range] of Object.entries(deps)) {
    if (name !== PEER_PREFIX && !name.startsWith(`${PEER_PREFIX}-`)) continue
    if (typeof range !== 'string') { out.push({ name, range: String(range) }); continue }
    const requirement = WORKSPACE_RANGES.has(range) ? runtimeVersion : range
    if (requirement.trim() === '' || !semverRangeMatchLoose(runtimeVersion, requirement)) out.push({ name, range })
  }
  return out
}

/** 短句化的「需要什么」：一项给全名，多项给首项 + 总数（面板一行放得下）。 */
function describePeers(peers) {
  const first = `${peers[0].name}@${peers[0].range}`
  return peers.length === 1 ? first : `${first} 等 ${peers.length} 项`
}

/**
 * 行级复算（IO 可注入，便于离线断言）。
 *
 * 入参：`{ moduleName, profileDir, frameworkVersion }`
 * 返回：`null`（无话可说）｜`{ kind:'peers'|'missing', reason, hint }`
 *   · `kind:'peers'`   —— 本地复算判定 peer 不满足（大概率就是框架否决它的原因）
 *   · `kind:'missing'` —— 包解析不到 / 清单读不出来（**另一种原因**，措辞与出路都不同）
 */
function peerVetoFor({ moduleName, profileDir, frameworkVersion, deps = {} } = {}) {
  const { resolvePkg = resolvePackageJson, readText = (p) => readFileSync(p, 'utf8') } = deps
  if (typeof moduleName !== 'string' || moduleName === '' || moduleName.startsWith('cordis:')) return null
  if (typeof profileDir !== 'string' || profileDir === '') return null
  if (typeof frameworkVersion !== 'string' || frameworkVersion === '') return null
  let pkgPath = null
  try { pkgPath = resolvePkg(moduleName, profileDir) } catch { pkgPath = null }
  if (pkgPath === null) {
    return {
      kind: 'missing',
      reason: `被框架否决：包不存在（${moduleName} 在本 profile 解析不到）`,
      hint: `出路：这一行指向的包已经不在本 profile 里（升级/卸载后的残留行）——重装或更新该插件即可；确实不需要它时，在补丁里删掉或禁用它。`,
    }
  }
  let manifest = null
  try { manifest = JSON.parse(readText(pkgPath)) } catch { manifest = null }
  if (manifest === null || typeof manifest !== 'object') {
    return {
      kind: 'missing',
      reason: `被框架否决：包清单读不出来（${moduleName}）`,
      hint: '出路：重装该插件——package.json 读不出来时框架自己也无法校验它，只能按最坏情况跳过挂载。',
    }
  }
  const peers = unsatisfiedPeers(manifest, frameworkVersion)
  if (peers.length === 0) return null
  return {
    kind: 'peers',
    reason: `被框架否决：peer 不满足（需要 ${describePeers(peers)}，当前 ${frameworkVersion}）`,
    hint: `出路：把 ${moduleName} 更新到兼容当前框架的版本（首选）；若它是升级后残留的旧包，从 profile 里清掉；要保留这个精确版本，就得用框架的精确版本豁免（dsh plugin allow-version / 插件管理器 → profile 的 compatibility.json）。`,
  }
}

export { PEER_PREFIX, WORKSPACE_RANGES, unsatisfiedPeers, peerVetoFor }
