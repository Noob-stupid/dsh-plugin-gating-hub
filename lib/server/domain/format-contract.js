// L1 · domain —— format-contract.js：会话格式契约预检（Step 1 · 契约抓取）
//
// 背景（2026-09-24 真机事故）：框架 0.1.5-rc.2 → 0.1.7-rc.1 把会话消息格式升到 V4，
// 要求每条被解释的消息 source 带「producer-owned kind」（非空、且不等于字面量 'plugin'）。
// 框架自带的 @deepseek-ai/dsh-session-format-v3-to-v4 只迁移**磁盘上的历史会话**；
// 运行期新产生的消息由本地生产方（agent-presets + 插件运行时代码）自己构造——它们仍写
// V3 老形状 `{ kind: 'plugin', plugin: X }`，于是「一发消息就报错、整个会话不可用」。
// 现有的包级适配门（peerDependencies / 版本号）**看不到**这类运行期契约破坏 ——
// 生产方（预设文件、插件 runtime）根本没有版本元数据。
//
// 发现路径（实网探明，2026-09-24）：顶层 @deepseek-ai/dsh 只挂中间包，**迁移边全集挂在
// @deepseek-ai/dsh-session-format-catalog 的 dependencies 上**——所以先问 catalog（一次请求拿到
// 该版本的全部边），catalog 缺失时退回扫顶层 dsh 依赖。核心信号：
//   **目标版本的迁移边集合 比 当前已装版本的 多出一条** ⇒ 这就是一次会打在运行期生产方身上的契约变更。
//
// 本模块全部网络 I/O 可注入（离线可测）：抓取失败不抛，返回 error 让上层降级成「只用内置规则扫描」。

import { parseFrameworkVersion } from '../infra/semver.js'

/** 会话格式迁移边包名：@deepseek-ai/dsh-session-format-v3-to-v4。 */
const FORMAT_EDGE_RE = /^@deepseek-ai\/dsh-session-format-v(\d+)-to-v(\d+)$/u

/** 迁移边全集的权威载体（实网确认：0.1.7-rc.1 的 catalog 依赖里含 v0→v1…v3→v4 四条）。 */
const CATALOG_PKG = '@deepseek-ai/dsh-session-format-catalog'

/** 一次预检最多为几条边拉 README（按 to 从高到低，最高那条才带准入规则）。 */
const README_BUDGET = 3

/** npm 源上的包名编码（scope 斜杠要转义，npmmirror 与 registry.npmjs.org 都吃 %2f）。 */
function encodePkgName(name) {
  return String(name).replace('/', '%2f')
}

/** 解析一条迁移边包名；不是迁移边返回 null。 */
function parseFormatEdge(pkgName) {
  const m = FORMAT_EDGE_RE.exec(String(pkgName))
  if (m === null) return null
  return { name: pkgName, from: Number(m[1]), to: Number(m[2]) }
}

/** 从依赖表里挑出全部迁移边（按 to 升序；同一 from/to 只留一条）。 */
function formatEdgesFromDependencies(dependencies) {
  const edges = []
  for (const name of Object.keys(dependencies ?? {})) {
    const edge = parseFormatEdge(name)
    if (edge !== null) edges.push(edge)
  }
  return edges.sort((a, b) => (a.to - b.to) || (a.from - b.from))
}

/** 依赖里的版本区间（`^0.1.7-rc.1` / `~1.2.3`）→ 具体版本字符串。 */
function concreteVersionOf(range) {
  const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u.exec(String(range ?? ''))
  return m === null ? null : m[1]
}

/**
 * 取 README 里某个小节（到下一个二级/三级标题或锚点为止）；找不到返回 null。
 * ★ 必须锚定「标题行」而不是 `indexOf`：README 顶部的目录（ToC）里也会出现同样的小节名，
 *   用 indexOf 会命中目录那一行，切出来的段落里没有表格 → 规则静默丢失（实网复验抓到过）。
 */
function sectionOf(readme, heading) {
  const escaped = String(heading).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const m = new RegExp(`^#{2,3}\\s+${escaped}\\s*$`, 'mu').exec(readme)
  if (m === null) return null
  const rest = readme.slice(m.index + m[0].length)
  const end = rest.search(/^#{2,3}\s|\n<a id=/mu)
  return end === -1 ? rest : rest.slice(0, end)
}

/**
 * 取小节里「V3 plugin → V4 kind」那张映射表的行。
 * 同一个小节内还有别的表（事件位置表 `| \`user/message\` | \`data\` |` 等），形状一模一样，
 * 所以必须先认表头（同时含 `plugin` 与 `kind` 的那一行），只吃它下面连续的行。
 */
function mappingRowsFromSection(section) {
  const rows = []
  let inTable = false
  for (const line of section.split(/\r?\n/u)) {
    if (!inTable) {
      if (/^\|/u.test(line) && /`plugin`/u.test(line) && /`kind`/u.test(line)) inTable = true
      continue
    }
    if (!/^\|/u.test(line)) break
    if (/^\|\s*:?-{2,}/u.test(line)) continue
    rows.push(line)
  }
  return rows
}

/**
 * 从迁移包 README 抽规则。只认语义明确的两处，抽不到就如实留空（宁可少报，不乱报）：
 *   · `| Producer attribution | … a nonempty, non-`plugin` kind … |`
 *   · `| Any other plugin name | `plugin:` followed by the complete original name |`
 *   · 重命名表**只在「Message-source conversion」小节、且只在认得出表头的那张表里**解析 ——
 *     README 里表格形状高度雷同，全局解析会混进 `user/message → data` 这类噪音（实网抓到过）。
 */
function extractContractRules(readme) {
  const rules = {
    producerKindRequired: false,
    forbiddenKinds: ['plugin'],
    pluginPrefix: null,
    renames: {},
    attributionExcerpt: null,
  }
  if (typeof readme !== 'string' || readme === '') return rules
  const attribution = /\|\s*Producer attribution\s*\|([^|]*)\|/u.exec(readme)
  if (attribution !== null) {
    // 注意要去掉反引号之后再判断：原文是 non-`plugin`
    const cleaned = attribution[1].replace(/`/gu, '').replace(/\s+/gu, ' ').trim()
    rules.attributionExcerpt = cleaned
    rules.producerKindRequired = /non-?plugin/u.test(cleaned) || /producer-owned/u.test(cleaned)
  }
  const prefix = /Any other plugin name\s*\|\s*`([^`]+)`/u.exec(readme)
  if (prefix !== null) rules.pluginPrefix = prefix[1].trim()
  const sourceSection = sectionOf(readme, 'Message-source conversion')
  if (sourceSection !== null) {
    // 只收「首列是单个代码片段」的行（跳过 `x, on a system-role message` 这类角色敏感行）
    for (const row of mappingRowsFromSection(sourceSection)) {
      const m = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/u.exec(row)
      if (m !== null && !m[1].includes(',')) rules.renames[m[1]] = m[2]
    }
  }
  return rules
}

/**
 * 纯函数：把「目标版本依赖表 + 各迁移边 README」组装成契约对象。
 * @param dependencies        目标版本的依赖表（来自 catalog 或顶层 dsh manifest）
 * @param currentDependencies 当前已装版本的依赖表（用于算「新增了哪条边」）
 */
function buildContract({ targetVersion = null, currentVersion = null, dependencies = {}, currentDependencies = {}, edgeSource = 'dsh', edgeReadmes = {}, now = () => Date.now() } = {}) {
  const edges = formatEdgesFromDependencies(dependencies).map((edge) => {
    const readme = typeof edgeReadmes[edge.name] === 'string' ? edgeReadmes[edge.name] : null
    return {
      name: edge.name,
      from: edge.from,
      to: edge.to,
      version: concreteVersionOf(dependencies[edge.name]),
      readme: { available: readme !== null },
      rules: readme === null ? null : extractContractRules(readme),
    }
  })
  const sessionFormatVersion = edges.reduce((max, edge) => (edge.to > max ? edge.to : max), 0) || null
  const currentKeys = new Set(formatEdgesFromDependencies(currentDependencies).map((e) => `${e.from}->${e.to}`))
  const edgesAdded = currentVersion === null || currentVersion === targetVersion
    ? []
    : edges.filter((e) => !currentKeys.has(`${e.from}->${e.to}`)).map((e) => ({ name: e.name, from: e.from, to: e.to }))
  // 规则取「最高那条边」（最新格式的准入规则才是要适配的目标）
  const latest = edges.filter((e) => e.to === sessionFormatVersion).pop() ?? null
  const rules = latest?.rules ?? { producerKindRequired: false, forbiddenKinds: ['plugin'], pluginPrefix: null, renames: {}, attributionExcerpt: null }
  return {
    targetVersion,
    currentVersion,
    sessionFormatVersion,
    edgeSource,
    edges,
    edgesAdded,
    rules,
    fetchedAt: now(),
  }
}

/** README 文本的多通道候选（jsDelivr npm CDN 优先，npmmirror files API 兜底）。 */
function readmeUrls(name, version, registry) {
  const urls = []
  if (typeof version === 'string' && version !== '') {
    urls.push(`https://cdn.jsdelivr.net/npm/${name}@${version}/README.md`)
    urls.push(`${registry}/${encodePkgName(name)}/${version}/files/README.md`)
  }
  urls.push(`${registry}/${encodePkgName(name)}/files/README.md`)
  return urls
}

/**
 * 问一个版本「它带哪些会话格式迁移边」：catalog 优先（一次拿全），缺失则退回顶层 dsh 依赖。
 * @returns { dependencies, edgeSource }；版本不存在时抛错（由上层兜住）。
 */
async function edgesForVersion({ version, fetchJson, registry }) {
  const catalogUrl = `${registry}/${encodePkgName(CATALOG_PKG)}/${version}`
  try {
    const catalog = await fetchJson(catalogUrl)
    const fromCatalog = formatEdgesFromDependencies(catalog?.dependencies)
    if (fromCatalog.length > 0) return { dependencies: catalog.dependencies ?? {}, edgeSource: 'catalog', manifest: catalog }
  } catch {}
  const manifest = await fetchJson(`${registry}/${encodePkgName('@deepseek-ai/dsh')}/${version}`)
  return { dependencies: manifest?.dependencies ?? {}, edgeSource: 'dsh', manifest }
}

/**
 * 抓取目标版本的会话格式契约。
 * 任何一步失败都不抛出：返回 { contract, error }，让上层降级成「只看内置规则」的扫描。
 */
async function discoverFormatContract({ targetVersion, currentVersion = null, fetchJson, fetchText, registry = 'https://registry.npmmirror.com', now = () => Date.now() } = {}) {
  if (typeof targetVersion !== 'string' || targetVersion === '') return { contract: null, error: '缺少目标版本' }
  if (typeof fetchJson !== 'function') return { contract: null, error: '缺少 fetchJson 注入' }
  let target = null
  try {
    target = await edgesForVersion({ version: targetVersion, fetchJson, registry })
  } catch (error) {
    return { contract: null, error: `拉取目标版本信息失败：${error instanceof Error ? error.message : String(error)}` }
  }
  let currentDependencies = {}
  if (typeof currentVersion === 'string' && currentVersion !== '' && currentVersion !== targetVersion) {
    try {
      currentDependencies = (await edgesForVersion({ version: currentVersion, fetchJson, registry })).dependencies
    } catch {}
  }
  // README 只拉「最高 to 的几条边」（准入规则在高位边里；低位边规则对本次适配没有指导意义）
  const edges = formatEdgesFromDependencies(target.dependencies)
  const edgeReadmes = {}
  const warnings = []
  if (typeof fetchText === 'function') {
    for (const edge of [...edges].sort((a, b) => b.to - a.to).slice(0, README_BUDGET)) {
      const version = concreteVersionOf(target.dependencies[edge.name])
      let got = null
      for (const url of readmeUrls(edge.name, version, registry)) {
        try {
          const text = await fetchText(url)
          if (typeof text === 'string' && text.trim() !== '') { got = text; break }
        } catch {}
      }
      if (got === null) warnings.push(`${edge.name}: README 拉取失败（契约规则未知）`)
      else edgeReadmes[edge.name] = got
    }
  }
  const contract = buildContract({
    targetVersion,
    currentVersion,
    dependencies: target.dependencies,
    currentDependencies,
    edgeSource: target.edgeSource,
    edgeReadmes,
    now,
  })
  return { contract, error: null, warnings }
}

/** 契约摘要（面板/日志用的一句话）。 */
function summarizeContract(contract) {
  if (contract === null || contract === undefined) return '契约未知'
  if (contract.sessionFormatVersion === null) return '目标版本没有会话格式迁移包（格式未变更）'
  const all = contract.edges.map((e) => `v${e.from}→v${e.to}`).join('、')
  if ((contract.edgesAdded ?? []).length > 0) {
    const added = contract.edgesAdded.map((e) => `v${e.from}→v${e.to}`).join('、')
    return `会话格式 v${contract.sessionFormatVersion}，本次新增迁移边 ${added} —— 契约变更，必须先预检本地生产方（全部边：${all}）`
  }
  return `会话格式 v${contract.sessionFormatVersion}（迁移边：${all}；相比当前版本无新增）`
}

export {
  FORMAT_EDGE_RE,
  CATALOG_PKG,
  README_BUDGET,
  encodePkgName,
  parseFormatEdge,
  formatEdgesFromDependencies,
  concreteVersionOf,
  extractContractRules,
  buildContract,
  readmeUrls,
  edgesForVersion,
  discoverFormatContract,
  summarizeContract,
}
