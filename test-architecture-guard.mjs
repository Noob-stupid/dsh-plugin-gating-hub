// Step 1 机制化护栏（防退化）：分层拆分如果没强制边界，半年后又会变回 7000 行单文件。
//
// 九道断言：
//   ① 行数棘轮 —— lib/index.js 只能变小（每完成一步就把上限往下调）；lib/server/** 单文件 ≤ 600 行
//   ② 依赖方向 —— infra 不得 import domain/routes/index（只能向下依赖）；不得出现循环 import
//   ③ 包根唯一 —— 只有 lib/server/infra/paths.js 可以用 import.meta.url 算包根，且 pluginRoot() 必须指向包根
//   ④ 搬运不回潮 —— 已搬进 lib/server/** 的函数不得在 index.js 里重新出现定义
//   ⑤ 分层规则 —— domain 层不得出现 cordis ctx
//   ⑥ 接线完整 —— 相对 import 目标存在、不自引用、导入名在目标文件里确有导出
//   ⑦ 无自由变量 —— 模块里引用的插件命名空间标识符必须有本地声明或 import（node --check 抓不到）
//   ⑧ 导入绑定只读 —— 没有文件给别的模块导出的绑定赋值（node --check 也抓不到）
//   ⑨ 宿主访问白名单 —— ctx/ports 的属性式访问只能是 inject 声明过的名字或 cordis 核心成员
//      （2026-09-22 事故：`ports?.installChannels` 属性式读取未声明的名字 → 真实 ctx 同步抛，安装全灭）
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const lineCount = (p) => readFileSync(p, 'utf8').split('\n').length

const stripCode = (src) => {
  let out = ''
  let i = 0
  const prevMeaningful = () => { for (let k = out.length - 1; k >= 0; k -= 1) if (!/\s/u.test(out[k])) return out[k]; return '' }
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i += 1 } i += 2; continue }
    if (c === "'" || c === '"' || c === '`') { const q = c; out += ' '; i += 1; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i += 1; if (src[i] === '\n') out += '\n'; i += 1 } i += 1; continue }
    if (c === '/' && /[(,=:[!&|?{};\n]/u.test(prevMeaningful() || '\n')) {
      out += ' ' // 正则字面量（前一个有效字符说明这里不可能是除法）
      i += 1
      let inClass = false
      while (i < src.length) {
        const ch = src[i]
        if (ch === '\\') { i += 2; continue }
        if (ch === '[') inClass = true
        else if (ch === ']') inClass = false
        else if (ch === '/' && !inClass) { i += 1; break }
        else if (ch === '\n') break
        i += 1
      }
      continue
    }
    // 展开运算符 `...x`：x 的前一个字符也是 '.'，会被自由变量扫描的 (?<![\w$.]) 当成属性访问而漏掉。
    // 真实事故（2026-09-19）：`sendJson(res, 200, { ok: true, ...installJobView(job) })` 漏了 import
    // → 守卫全绿、而 live 的 /install-status 恒 500。用等长空格替换（保持行/列偏移不变），
    // 让展开位置的标识符重新对断言 ⑦/⑧ 可见。
    if (c === '.' && n === '.' && src[i + 2] === '.') { out += '   '; i += 3; continue }
    out += c
    i += 1
  }
  return out
}

// ── 公共助手：把源码里的注释/字符串/正则剥离（断言 ⑤⑦ 都要用，否则注释里提到 ctx 也会误报）──
const declaredIn = (src) => {
  const set = new Set()
  const addBindings = (text) => { for (const m of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)/gu)) set.add(m[1]) }
  const addParams = (list) => {
    let depth = 0
    let cur = ''
    const parts = []
    for (const ch of list) {
      if ('([{'.includes(ch)) depth += 1
      if (')]}'.includes(ch)) depth -= 1
      if (ch === ',' && depth === 0) { parts.push(cur); cur = '' } else cur += ch
    }
    parts.push(cur)
    for (const part of parts) addBindings(part.split('=')[0].replace(/:[^,]*$/u, ''))
  }
  // 声明（含 for (const x of …)；`(` 前的 const 也要认）+ 解构声明（const { a, b: c } =）
  for (const m of src.matchAll(/(?:const|let|var)\s+([^\n=;){]{1,80})/gu)) addBindings(m[1])
  for (const m of src.matchAll(/(?:^|[\s(,;{[])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/gu)) { set.add(m[1]); addParams(m[2]) }
  for (const m of src.matchAll(/\(([^)]*)\)\s*=>/gu)) addParams(m[1])
  for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/gu)) set.add(m[1])
  for (const m of src.matchAll(/catch\s*\(([^)]*)\)/gu)) addParams(m[1])
  for (const m of src.matchAll(/(?:^|\s)class\s+([A-Za-z_$][\w$]*)/gu)) set.add(m[1])
  return set
}
const importedIn = (src) => {
  const set = new Set()
  for (const m of src.matchAll(/^import\s*\{([^}]*)\}\s*from/gmu)) for (const part of m[1].split(',')) { const t = part.trim(); if (t) set.add((t.match(/\sas\s+([A-Za-z_$][\w$]*)$/u) ?? [null, t])[1]) }
  for (const m of src.matchAll(/^import\s+([A-Za-z_$][\w$]*)\s+from/gmu)) set.add(m[1])
  return set
}

// ── ① 行数棘轮 ────────────────────────────────────────────────────────────────
// Step 8c-3（ctx→ports 收尾：job runner 全搬 + 路由装配独立成模块）完成时 index.js = 142 行。
// Step 1 之前是 7637 行 —— 方案终点是 ≤200 行，已达到。**这个数字只允许下调**。
// 注：Step 6 的 4590 → 4594 是 patchHealAt/patchHealReport 从 patch.js 回搬（routes 层节流状态，被 index.js 赋值，见 bug 6-2）
const INDEX_LIMIT = 142
const indexLines = lineCount(join(ROOT, 'lib', 'index.js'))
check(`行数棘轮：lib/index.js ≤ ${INDEX_LIMIT}（当前 ${indexLines}）`, indexLines <= INDEX_LIMIT, indexLines > INDEX_LIMIT ? 'index.js 变大了 —— 新功能应该进 lib/server/**' : undefined)

const serverDir = join(ROOT, 'lib', 'server')
const serverFiles = []
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.js')) serverFiles.push(p)
  }
}
if (existsSync(serverDir)) walk(serverDir)
// 受限例外：路由拆分刚搬出来的"遗留巨块"允许到 700 行（**只此一个，有期限**）。
// routes/framework-upgrade.js = 单个 661 行 handler（内置大段 PowerShell 升级脚本模板），
// 待抽包阶段把模板挪进 domain/framework-script.js 后撤销例外。
const SIZE_EXCEPTIONS = { '/lib/server/routes/framework-upgrade.js': 700 }
const limitOf = (p) => SIZE_EXCEPTIONS[p.replace(ROOT, '').replace(/\\/gu, '/')] ?? 600
const oversized = serverFiles.filter((p) => lineCount(p) > limitOf(p)).map((p) => `${p.replace(ROOT, '')}(${lineCount(p)} > ${limitOf(p)})`)
check(`lib/server/** 单文件 ≤ 600 行（共 ${serverFiles.length} 个文件）`, oversized.length === 0, oversized.join(', ') || undefined)

// ── ② 依赖方向 ────────────────────────────────────────────────────────────────
const importLinesOf = (p) => [...readFileSync(p, 'utf8').matchAll(/^import\s[^\n]*from\s+'([^']+)'/gmu)].map((m) => m[1])
const badDirection = []
for (const p of serverFiles) {
  const rel = p.replace(ROOT, '').replace(/\\/gu, '/')
  for (const spec of importLinesOf(p)) {
    if (rel.includes('/infra/') && /domain|routes|\/index\.js$/u.test(spec)) badDirection.push(`${rel} → ${spec}`)
    if (/\.\.\/\.\.\/index\.js|\.\.\/index\.js/u.test(spec)) badDirection.push(`${rel} → ${spec}（循环）`)
  }
}
check('依赖方向：infra 不依赖 domain/routes/index', badDirection.length === 0, badDirection.join(', ') || undefined)

// ── ③ 包根唯一 + pluginRoot 契约 ──────────────────────────────────────────────
const metaUsers = []
for (const p of [join(ROOT, 'lib', 'index.js'), ...serverFiles]) {
  const rel = p.replace(ROOT, '').replace(/\\/gu, '/')
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.includes('import.meta.url')) continue
    if (/^\s*(\*|\/\/)/u.test(line)) continue // 注释不算
    metaUsers.push(`${rel}: ${line.trim().slice(0, 60)}`)
  }
}
check('只有 infra/paths.js 用 import.meta.url 算包根', metaUsers.every((m) => m.startsWith('/lib/server/infra/paths.js')), metaUsers.join(' | ') || undefined)

const { pluginRoot } = await import('./lib/server/infra/paths.js')
check('pluginRoot() 指向包根（含 package.json 与 lib/index.js）',
  resolve(pluginRoot()) === resolve(ROOT) && existsSync(join(pluginRoot(), 'package.json')) && existsSync(join(pluginRoot(), 'lib', 'index.js')),
  `${pluginRoot()} vs ${ROOT}`)
// 脚本生成器必须走 pluginRoot（错了会让升级脚本找不到插件目录）
const indexSrc = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
// 路由拆分后 relaunchPrelude 的调用点会落在 lib/server/routes/** —— 整棵源码一起扫
const allSrc = [indexSrc, ...serverFiles.map((p) => readFileSync(p, 'utf8'))].join('\n')
const generatorCalls = [...allSrc.matchAll(/relaunchPrelude\(\{([^}]*)\}/gu)].map((m) => m[1])
  .filter((c) => !/\bpluginDir,/u.test(c)) // 排除函数定义本身（形参是裸 pluginDir）
check(`脚本生成器的 pluginDir 走 pluginRoot（${generatorCalls.length} 处调用）`,
  generatorCalls.length >= 3 && generatorCalls.every((c) => c.includes('pluginDir: pluginRoot()')),
  generatorCalls.map((c) => c.match(/pluginDir: [^,]*/u)?.[0] ?? '（无 pluginDir）').join(' | '))

// ── ④ 搬运不回潮 ──────────────────────────────────────────────────────────────
const MOVED = ['dshHome', 'defaultPatchPath', 'findPatchPath', 'profileDirOf', 'baseDirOf', 'resolvePackageJson', 'entryPkgMeta', 'packageNameOf', 'includePrefix', 'rowIdOf',
  'parseSemverText', 'compareSemverText', 'semverCompareOne', 'semverRangeMatch', 'semverRangeMatchLoose', 'parseFrameworkVersion', 'isFrameworkVersionNewer',
  'githubRequest', 'githubJson', 'githubText', 'curlJson', 'curlText', 'fetchJsonUrl', 'rawTextWithFallback', 'postJsonUrl', 'githubViaGh', 'githubRequestOnce', 'raceFirst2xx', 'collectBody',
  'copyTree', 'queuedWrite', 'cleanupStalePackageDir', 'gitEnv', 'processAlive', 'maskUrl', 'escapeRegExp',
  'isLoopback', 'isAllowedWriteOrigin', 'sendJson', 'sendError', 'readBody',
  // Step 2：路径函数归位 infra + 两个 domain 模块
  'sourcesFile', 'sourcesSecretsFile', 'marketIndexCacheFile', 'componentsFile', 'aiJobsFile', 'repoLandConfFile',
  'readSources', 'writeSources', 'maskSources', 'readSourceSecrets', 'writeSourceSecrets', 'isAllowedSourceUrl', 'isAllowedGitSourceUrl',
  'readGiteeConfig', 'giteeStatusView', 'orderedRegistries', 'createGiteeOAuthState', 'consumeGiteeOAuthState', 'DEFAULT_SOURCES', 'GITEE_OAUTH_STATES',
  'readPatchState', 'disableEntry', 'enableEntry', 'appendInsert', 'removeInsertRow', 'removeDisableBlock', 'sanitizePatchText', 'parseInsertNames',
  'healPatchSafety', 'syncNameFromNote', 'CORE_PATCH_ROW_IDS', 'disableBlock',
  // Step 3：市场/富化 + skills 两个 domain 模块 + 缓存路径常量 + git 地址归一
  'ENRICH_CACHE_FILE', 'gitCloneUrls',
  'readEnrichCache', 'writeEnrichCache', 'enrichItemOne', 'enrichItems', 'normalizePlatformItems', 'githubRepoInfo',
  'fetchRepoPackage', 'summarizeReadme', 'readPluginDetails', 'fetchSubpackageNames', 'subpackageCandidates', 'ENRICH_CACHE_TTL',
  'detectSkillRepo', 'summarizeSkillFrontmatter', 'fetchSkillMeta', 'runSkillInstallJob', 'skillFrontmatterBounds',
  'isSkillDisabled', 'setSkillEnabled', 'listInstalledSkills', 'SKILL_TOPICS', 'SKILL_DISABLE_LINES',
  // Step 4：仓库落地 + 服务器组件
  'reposDirCache', 'getReposDir', 'setReposDir', 'listLandedRepos', 'gitCloneRepo',
  'findComponents', 'saveComponents', 'compFind', 'compUiUrl', 'compUpsert', 'compRemove',
  'compStart', 'compStop', 'compStatus', 'autostartComponents',
  // Step 5：安装/卸载全链路 + 聚合套装（runInstallJob / runSuiteInstallJob 含 ctx，留到 Step 8）
  'GH_BIN_CANDIDATES', 'DEFAULT_BUNDLES', 'detectBundleOnly', 'addBundleToManifest', 'removeBundleFromManifest',
  'readExtraBundleOwners', 'readGithubAuth', 'pnpmInstall', 'curlManualInstall', 'raceInstallChannels', 'verifyPackageBox',
  'parseBundlePatchRefs', 'backfillMissingDeps', 'githubReleaseInstall', 'readBundlePatchRefNames', 'ensureBundlePatchIntegrity',
  'installBundleFromRelease', 'syncAggregateSubpackageVersions', 'installJobView',
  'readGitmodules', 'findPresetDirs', 'packageEntryExists',
  // Step 6：兼容判定 + 框架升级可搬部分 + 预设迁移（ctx 相关的留到 Step 8）
  'COMPAT_PENDING_FILE', 'COMPAT_GATE_FILE', 'COMPAT_GATE_DEFAULTS', 'REMOVED_SETTINGS_SYMBOLS', 'FIBER_STATE', 'FIBER_PHASE',
  'SUPPORTED_WEB_APP_PATTERN', 'referencesRemovedSymbol', 'scanSettingsApiUsage', 'isFrameworkOwnedPackage', 'probePluginImport',
  'readCompatPending', 'writeCompatPending', 'readCompatGate', 'writeCompatGate', 'markPendingAdopted', 'readQuarantineRecord',
  'logQuarantineMergeError', 'analyzeBootFailure', 'planQuarantine', 'frameworkCheckPromptText',
  'FRAMEWORK_STATE_FILE', 'FRAMEWORK_BACKUP_ROOT', 'cleanupStaleFwTasks', 'resolveDshBin', 'locateAppBootFile',
  'applyFrameworkTolerancePatchOnce', 'resolveFrameworkRootNodeModules', 'checkpointFrameworkTree', 'relaunchPrelude', 'isVersionAtLeast',
  'PRESET_CONFIG_MIGRATIONS', 'collectAgentConfigFiles', 'migratePresetPersona', 'migrateAgentConfigsForUpgrade',
  'GITEE_AUTH_URL', 'GITEE_TOKEN_URL',
  // Step 7：AI 赋能的纯逻辑部分 + 任务辅助（ctx 相关的 aiEmpower*/runAiStep/aiRepair 留到 Step 8）
  'aiJobs', 'saveAiJobs', 'loadAiJobs', 'aiJobView', 'deepseekKeyCache', 'readDeepSeekKey', 'readAiEmpowerConfig',
  'resolveVlmForOpenViking', 'resolvePlaceholders', 'resolvePythonPath', 'isAllowedWritePath', 'ALLOWED_RUN_FILES',
  'DESTRUCTIVE_RE', 'isSafeRunCmd', 'builtinPlanFor', 'aiEmpowerPresetFor', 'parsePlanJson',
  'jobLog', 'waitHealth',
  // Step 8c-1：ctx → ports 第一批（compat/framework 只读簇 + runtime）
  'CONSOLE_VERSION', 'detectCompat', 'detectAdoptablePending', 'rowIdModuleMap', 'mergeQuarantineRecord', 'reconcileCompatPending', 'frameworkCompatReportFor', 'maybeAutoAdaptCompat', 'currentFrameworkVersion', 'backupProfileSnapshot', 'detectFrameworkUpgrade', 'preflightDisableIncompatible', 'listEntries', 'webPort', 'PROTECTED_MODULE_PATTERNS', 'isProtectedModule',
  // Step 8c-2/8c-3：job runner 全搬 + routes/index.js 装配层
  'runInstallJob', 'runSuiteInstallJob', 'aiEmpowerPlan', 'runAiStep', 'aiRepair', 'aiEmpowerExecute', 'deriveEntryId', 'ROUTE_PREFIX', 'DEFAULT_SEARCH', 'pnpmRemove', 'readExtraBundleRows', 'handle']
const rehomed = MOVED.filter((n) => new RegExp(`^(?:export )?(?:async )?function ${n}\\s*\\(`, 'mu').test(indexSrc))
  .concat(MOVED.filter((n) => new RegExp(`^(?:export )?(?:const|let|var) ${n}\\s*=`, 'mu').test(indexSrc)))
check(`已搬走的声明没有在 index.js 里回潮（共 ${MOVED.length} 个）`, rehomed.length === 0, rehomed.join(', ') || undefined)

// ── ⑤ L1 规则：domain 层不认识 cordis ctx（方案 §二 三条硬规则之一）────────────
const domainFiles = serverFiles.filter((p) => p.replace(/\\/gu, '/').includes('/server/domain/'))
const ctxUsers = domainFiles.filter((p) => /(?<![\w$.])ctx(?![\w$])/u.test(stripCode(readFileSync(p, 'utf8')))).map((p) => p.replace(ROOT, ''))
check(`domain 层不出现 ctx（${domainFiles.length} 个模块）`, ctxUsers.length === 0, ctxUsers.join(', ') || undefined)

// ── ⑥ import 落地 + 不自引用 + 导入名真的被导出 ────────────────────────────────
// Step 3 的 codemod 连续踩了三个坑（相对路径算错、模块 import 自己、模块被搬空），
// 全都是"语法能过、跑起来才炸（甚至要跑整套测试才炸）"的类型。这条断言把它们变成静态可查：
//   · 相对 import 目标文件必须存在（挡住 ./paths.js 这种同层假设）
//   · 模块不得 import 自己
//   · import 的每个具名符号，必须在目标文件里真的有导出（挡住"搬空了 / 导出丢了"）
const exportedNamesOf = (p) => {
  const src = readFileSync(p, 'utf8')
  const names = new Set()
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gmu)) names.add(m[1])
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gmu)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim()
      if (!seg) continue
      const asMatch = seg.match(/\sas\s+([A-Za-z_$][\w$]*)$/u)
      names.add(asMatch ? asMatch[1] : seg.split(/\s+/u)[0])
    }
  }
  return names
}
const namedImportsOf = (p) => [...readFileSync(p, 'utf8').matchAll(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)'/gmu)]
  .map((m) => ({ names: m[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => (s.match(/\sas\s+([A-Za-z_$][\w$]*)$/u) ?? [null, s])[1]), spec: m[2] }))
const importIssues = []
for (const p of [...serverFiles, join(ROOT, 'lib', 'index.js')]) {
  const rel = p.replace(ROOT, '').replace(/\\/gu, '/')
  for (const { spec } of namedImportsOf(p)) {
    if (!spec.startsWith('.')) continue
    const target = resolve(dirname(p), spec)
    if (!existsSync(target)) { importIssues.push(`${rel} → ${spec}（目标不存在）`); continue }
    if (resolve(target) === resolve(p)) { importIssues.push(`${rel} → ${spec}（自引用）`); continue }
    if (!target.endsWith('.js')) continue
    const exported = exportedNamesOf(target)
    for (const { names } of namedImportsOf(p).filter((x) => x.spec === spec)) {
      for (const n of names) if (!exported.has(n)) importIssues.push(`${rel} → ${spec} 里没有导出 ${n}`)
    }
  }
}
check('相对 import 落地、无自引用、导入名确有导出', importIssues.length === 0, [...new Set(importIssues)].join(', ') || undefined)

// ── ⑦ 自由变量（node --check 永远抓不到的一类）─────────────────────────────────
// 真实教训（Step 1 埋下、Step 5 才发现）：`githubViaGh` 被搬进 infra/http.js，但它用的常量
// `GH_BIN_CANDIDATES` 留在了 index.js → 模块里成了**未定义的自由变量**：语法合法、import 合法、
// 17 套测试全绿、部署冒烟也过，只有运行到那一行才 ReferenceError，而且被 gh 兜底的 try/catch 吞掉
// → 表现为"GitHub 通道静默失效"。断言：模块里出现的、属于本插件命名空间的标识符，必须有本地声明或 import。
const namespaceNames = new Set()
for (const p of serverFiles) for (const n of exportedNamesOf(p)) namespaceNames.add(n)
for (const m of indexSrc.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gmu)) namespaceNames.add(m[1] ?? m[2])
const freeVars = []
for (const p of [...serverFiles, join(ROOT, 'lib', 'index.js')]) {
  const rel = p.replace(ROOT, '').replace(/\\/gu, '/')
  const src = readFileSync(p, 'utf8')
  const declared = declaredIn(src)
  const imported = importedIn(src)
  const lines = stripCode(src).split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    for (const m of lines[i].matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)/gu)) {
      const id = m[1]
      if (!namespaceNames.has(id) || declared.has(id) || imported.has(id)) continue
      const after = lines[i].slice(m.index + id.length).match(/^\s*(.)/u)?.[1] ?? ''
      const before = lines[i].slice(0, m.index).match(/(.)\s*$/u)?.[1] ?? ''
      if (after === ':' && before !== '?') continue // 对象字面量的键，不是引用
      freeVars.push(`${rel}:${i + 1} ${id}`)
    }
  }
}
check(`模块内引用的命名空间标识符都有声明或 import（已知 ${namespaceNames.size} 个名字）`, freeVars.length === 0, [...new Set(freeVars)].slice(0, 8).join(', ') || undefined)

// ── ⑧ 不得给"属于别的模块的绑定"赋值（ESM 导入绑定只读）──────────────────────
// 这个坑咬了两次：
//   · Step 5：`installJobSeq++` 在 handle 里 → 搬进 install.js 就变成"给导入绑定赋值"
//   · Step 6：`fwCheckCache = …` 在 detectFrameworkUpgrade（含 ctx，留在 index.js）里 →
//     搬进 framework.js 后 framework-check 直接 500："Assignment to constant variable."
// 两次都是静态检查（node --check）与常规测试都看不到的类型；这条断言把它变成静态可查。
const ownerOf = new Map()
for (const p of serverFiles) for (const n of exportedNamesOf(p)) ownerOf.set(n, p)
const mutatedImports = []
for (const p of [...serverFiles, join(ROOT, 'lib', 'index.js')]) {
  const rel = p.replace(ROOT, '').replace(/\\/gu, '/')
  const lines = stripCode(readFileSync(p, 'utf8')).split('\n')
  for (const [n, owner] of ownerOf) {
    if (resolve(owner) === resolve(p)) continue
    for (let i = 0; i < lines.length; i += 1) {
      // 声明形态（`const X = …` / `const { X } = …`）是"定义"，不是给导入绑定赋值 —— 先排除
      const escaped = n.replace(/\$/gu, '\\$')
      if (new RegExp(`(?:const|let|var)\\s+(?:\\{[^}]*\\}\\s*=|\\[[^\\]]*\\]\\s*=|)\\s*${escaped}\\s*=`, 'u').test(lines[i])) continue
      if (new RegExp(`(?<![\\w$.])${escaped}\\s*(?:\\+\\+|--|[+\\-*/%&|^]?=(?!=))`, 'u').test(lines[i])) mutatedImports.push(`${rel}:${i + 1} 给 ${n} 赋值`)
    }
  }
}
check('没有文件给别的模块导出的绑定赋值（导入绑定只读）', mutatedImports.length === 0, [...new Set(mutatedImports)].slice(0, 6).join(', ') || undefined)

// ── ⑨ ctx/ports 属性式访问的白名单（2026-09-22 事故的**静态**防线）────────────────
// 事故：为单测留的注入缝写成 `ports?.installChannels` —— 属性式读取一个没写进 inject 的名字。
// 真实 cordis 的 ctx 代理会**同步抛** `cannot get property "installChannels" without inject`
// （0.3.59 每一次安装都失败），而单测喂的手写普通对象不会拒绝任何属性 → 全绿。
// 动态防线在 test-suite-detect.mjs ⑯ / test-suite-install.mjs（strict-ctx.mjs 严格替身 + 账本）；
// 这条静态防线覆盖全树：lib/** 里出现 `ctx.X` / `ports.X` 时，X 只能是
//   ① 插件 `inject` 声明过的服务名（真实 ctx 上属性访问合法）
//   ② cordis ctx 自身成员（baseUrl 是 Context 的 own property；effect/get 等在原型上）
//   ③ 极少数"只在普通对象上走"的已知例外（见 EXEMPT，逐条写清理由）
// 新的可选读取一律用 `ctx.get('名字')` 或显式传参 —— 绝不要靠往 inject 里加名字绕过（除非它真是服务）。
const injectDecl = [...(indexSrc.match(/export const inject = \[([^\]]*)\]/u)?.[1] ?? '').matchAll(/'([^']+)'/gu)].map((m) => m[1])
const CTX_MEMBER_ALLOW = new Set([
  ...injectDecl,
  // cordis Context 的 own/prototype 成员（属性访问不需要 inject，不会抛）
  'baseUrl', 'effect', 'get', 'set', 'provide', 'accessor', 'isolate', 'extend', 'inject',
  'on', 'once', 'off', 'emit', 'parallel', 'waterfall', 'bail', 'serial', 'start', 'stop',
  'root', 'fiber', 'scope', 'name', 'config', 'logger', 'reflect', 'registry', 'events',
])
// 已知例外：channelImpls 的**普通对象回退**分支 —— 它只在 `typeof ports?.get !== 'function'` 时执行，
// 也就是"根本不可能是 cordis ctx"的老式窄接口/测试替身；cordis ctx 一定先走 ctx.get 主路径。
// 这条例外本身由 test-suite-detect.mjs ⑯ 的动态断言兜住（改回属性访问 → 注入桩取不到 → 红）。
const CTX_PROPERTY_EXEMPT = new Set(['installChannels'])
const hostAccessIssues = []
for (const p of [...serverFiles, join(ROOT, 'lib', 'index.js')]) {
  const rel = p.replace(ROOT, '').replace(/\\/gu, '/')
  const lines = stripCode(readFileSync(p, 'utf8')).split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    for (const m of lines[i].matchAll(/(?<![\w$.])(?:ctx|ports)(\??)\.([A-Za-z_$][\w$]*)/gu)) {
      const prop = m[2]
      if (CTX_MEMBER_ALLOW.has(prop) || CTX_PROPERTY_EXEMPT.has(prop)) continue
      hostAccessIssues.push(`${rel}:${i + 1} ${m[0]}`)
    }
  }
}
check(`ctx/ports 的属性式访问都在白名单内（inject: ${injectDecl.join('/')} + cordis 核心成员 + ${CTX_PROPERTY_EXEMPT.size} 条已知例外）`,
  hostAccessIssues.length === 0,
  hostAccessIssues.length === 0 ? undefined : `${[...new Set(hostAccessIssues)].join(', ')} —— 可选读取请改用 ctx.get('名字') 或显式传参`)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
