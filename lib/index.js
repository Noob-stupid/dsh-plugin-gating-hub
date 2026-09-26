/**
 * @deepseek-ai/dsh-plugin-console — 插件控制台宿主端。
 *
 * 提供环回 HTTP 路由（前缀 /plugin-console）：
 *   GET  /plugin-console/state    当前插件清单 + 用户补丁层状态
 *   POST /plugin-console/toggle   一键启用/停用插件（写 cordis.patch.yml，HMR 生效）
 *   POST /plugin-console/search   GitHub 仓库搜索（dsh-plugin 相关）
 *   POST /plugin-console/repo     读取仓库的 package.json，判断是否可安装
 *   POST /plugin-console/install  安装 npm 包（或 git 仓库）并追加启用条目
 *
 * 插件开关的机制：用户补丁层 cordis.patch.yml 是逐键覆盖（id-targeted patch），
 * 追加 `- id: X` + `disabled: true` 即可停用任意行（含 bundle 行与用户 insert 行），
 * 移除该块即恢复；HMR 监视器会自动重组合，无需重启。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { readFileSync, writeFileSync, existsSync, statSync, rmSync, readdirSync, mkdirSync, copyFileSync, realpathSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, basename, sep } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { request as httpsRequest } from 'node:https'
import { aiJobsFile, componentsFile, dshHome, entryPkgMeta, findPatchPath, marketIndexCacheFile, packageNameOf, pluginRoot, profileDirOf, repoLandConfFile, resolvePackageJson, rowIdOf } from './server/infra/paths.js'
import { isFrameworkVersionNewer, parseFrameworkVersion, semverRangeMatch, semverRangeMatchLoose } from './server/infra/semver.js'
import { GITHUB_API, curlJson, fetchJsonUrl, githubJson, postJsonUrl, rawTextWithFallback } from './server/infra/http.js'
import { cleanupStalePackageDir, copyTree, queuedWrite, startTrashCleanup, trashScanRoots } from './server/infra/fsx.js'
import { execFileAsync, gitEnv, processAlive } from './server/infra/exec.js'
import { escapeRegExp, maskUrl } from './server/infra/mask.js'
import { isAllowedWriteOrigin, isLoopback, readBody, sendError, sendJson } from './server/infra/httpd.js'
import { DEFAULT_SOURCES, consumeGiteeOAuthState, createGiteeOAuthState, gitCloneUrls, giteeStatusView, isAllowedGitSourceUrl, isAllowedSourceUrl, maskSources, orderedRegistries, readGiteeConfig, readSources, writeSources } from './server/domain/sources.js'
import { CORE_PATCH_ROW_IDS, appendInsert, disableEntry, enableEntry, healPatchSafety, readPatchState, removeDisableBlock, removeInsertRow, sanitizePatchText, syncNameFromNote } from './server/domain/patch.js'
import { enrichItems, fetchRepoPackage, fetchSubpackageNames, githubRepoInfo, normalizePlatformItems, readPluginDetails, subpackageCandidates } from './server/domain/market.js'
import { SKILL_TOPICS, detectSkillRepo, fetchSkillMeta, listInstalledSkills, runSkillInstallJob, setSkillEnabled } from './server/domain/skills.js'
import { autostartComponents, compFind, compStart, compStatus, compStop, compUiUrl, compUpsert, findComponents } from './server/domain/components.js'
import { getReposDir, gitCloneRepo, listLandedRepos, setReposDir } from './server/domain/repoland.js'
import { DEFAULT_BUNDLES, addBundleToManifest, backfillMissingDeps, curlManualInstall, detectBundleOnly, ensureBundlePatchIntegrity, githubReleaseInstall, installJobView, pnpmInstall, raceInstallChannels, readBundlePatchRefNames, readExtraBundleOwners, readGithubAuth, syncAggregateSubpackageVersions } from './server/domain/install.js'
import { findPresetDirs, readGitmodules } from './server/domain/suite.js'
import { FIBER_PHASE, SUPPORTED_WEB_APP_PATTERN, checkPluginFrameworkCompat, frameworkCheckPromptText, isFrameworkOwnedPackage, probePluginImport, readCompatGate, readCompatPending, writeCompatGate, writeCompatPending } from './server/domain/compat.js'
import { logQuarantineMergeError, markPendingAdopted, mergeQuarantineRecord, planQuarantine, readQuarantineRecord, reconcileCompatPending } from './server/domain/quarantine.js'
import { FRAMEWORK_BACKUP_ROOT, FRAMEWORK_STATE_FILE, applyFrameworkTolerancePatchOnce, checkpointFrameworkTree, cleanupStaleFwTasks, relaunchPrelude, resolveDshBin, resolveFrameworkRootNodeModules } from './server/domain/framework.js'
import { migrateAgentConfigsForUpgrade } from './server/domain/presets.js'
import { GITEE_AUTH_URL, GITEE_TOKEN_URL } from './server/domain/sources.js'
import { aiEmpowerPresetFor, aiJobs, builtinPlanFor, isAllowedWritePath, isSafeRunCmd, loadAiJobs, parsePlanJson, resolvePlaceholders, resolvePythonPath, saveAiJobs } from './server/domain/ai.js'
import { jobLog, waitHealth } from './server/domain/jobs.js'
import { fwCheckCache, installJobs, marketIndexCache, nextAiJobSeq, nextInstallJobSeq, patchHealAt, patchHealReport, setFwCheckCache, setMarketIndexCache, setPatchHealAt, setPatchHealReport } from './server/state.js'
import { routeStateGet, routeDetails } from './server/routes/state.js'
import {routeFrameworkUpgradeStatusGet, routeFrameworkRelaunch, routeFrameworkCheck, routeCompatGate, routeCheckUpdate, routeFrameworkRollback, routeRestart } from './server/routes/framework.js'
import { routeFrameworkUpgrade } from './server/routes/framework-upgrade.js'
import { routeToggle, routeUninstall, routeAdaptUnlock, routeAdaptUnlockAll, routeCleanResiduals, routeSelfUpdate } from './server/routes/plugins.js'
import { routeSearch, routeEnrich, routeRepo, routeSubpackages, routeMarketIndex } from './server/routes/market.js'
import { routeAiConsent, routeAiEmpowerPlan, routeAiEmpowerStatus, routeAiEmpowerList, routeAiEmpowerRun, routeAiEmpowerCancel } from './server/routes/ai.js'
import { routeComponents, routeRepoClone, routeRepoList, routeRepoLandConfig, routeRepoRemove, routeRepoOpen, routeComponentAutostart, routeComponentStart, routeComponentStop, routeComponentStatus } from './server/routes/components.js'
import { routeSourcesGet, routeGiteeOauthUrlGet, routeGiteeOauthCallbackGet, routeRegistryScan, routeSources } from './server/routes/sources.js'
import { routeSkillsInstalledGet, routeSkillRemove, routeSkillToggle } from './server/routes/skills.js'
import { routeInstall, routeInstallStatus } from './server/routes/install.js'
import { detectAdoptablePending, detectCompat, frameworkCompatReportFor, maybeAutoAdaptCompat, rowIdModuleMap } from './server/domain/compat.js'
import { backupProfileSnapshot, currentFrameworkVersion, detectFrameworkUpgrade, preflightDisableIncompatible } from './server/domain/framework.js'
import { listEntries, webPort } from './server/domain/runtime.js'
import { isProtectedModule } from './server/domain/runtime.js'
import { aiEmpowerExecute, aiEmpowerPlan } from './server/domain/ai-run.js'
import { runInstallJob } from './server/domain/install-job.js'
import { runSuiteInstallJob } from './server/domain/suite.js'
import { pnpmRemove, readExtraBundleRows } from './server/domain/install-job.js'
import { DEFAULT_SEARCH } from './server/domain/sources.js'
import { ROUTE_PREFIX, handle } from './server/routes/index.js'

/** Cordis 插件元信息。 */
export const name = '@noob-stupid/dsh-plugin-console'
export const inject = ['webServer', 'loader']

/**
 * 后台安装任务注册表：请求立即返回，安装继续在服务端执行；
 * 面板通过 /install-status 轮询进度（stage + status），离开面板不中断。
 */
/** 静态插件索引内存缓存（/market-index 用）。 */

// ============================================================
// AI 赋能：文档驱动的通用组件部署（读文档 → 出计划 → 确认 → 执行 → 组件控制）
// ============================================================

/** 应用插件：注册 /plugin-console 路由。 */
export function apply(ctx) {
  // 恢复 AI 赋能任务（restart 后 running 置失败，plan-ready/结果保留）
  loadAiJobs()
  // 升级脚本的「启动失败隔离」记录并入适配门清单（让用户看到谁被自动关了）
  // v0.3.44：这里的 catch 不再静默 —— 2026-09-11 那次隔离记录（20 行）就是这样凭空消失的：
  // 合并函数在中途抛错、catch 吞掉，界面只剩一个没有解释的【停用】。失败必须留痕。
  try { mergeQuarantineRecord(ctx) } catch (error) { logQuarantineMergeError(error) }
  // v0.3.45：清单与现实对账 —— 补 moduleName（否则「全家桶一键启用已适配」永远匹配不到），
  // 以及把「已经启用、却还挂着 pending」的记录转成已适配（用户实测：启用后重启又变【待适配】）
  try {
    const fixed = reconcileCompatPending(ctx)
    if (fixed.backfilled > 0 || fixed.adopted > 0) {
      try { writeFileSync(join(dshHome(), 'plugin-console', 'fw-merge-error.log'), `${new Date().toISOString()} 清单对账：补 moduleName ${fixed.backfilled} 行，已启用转已适配 ${fixed.adopted} 行\n`, { flag: 'a' }) } catch {}
    }
  } catch (error) { logQuarantineMergeError(error) }
  // 启动时清掉上次升级/回滚/重启留下的僵尸计划任务（脚本被强杀时来不及自删）+ 后台清掉 `.trash-*` 降级目录（2026-09-26 加法；覆盖 tmpdir / profile node_modules / skills / repos，即发即忘、绝不阻塞启动）
  try { cleanupStaleFwTasks(); startTrashCleanup({ roots: trashScanRoots({ profileDir: profileDirOf(ctx) ?? '', extra: [join(dshHome(), 'skills'), getReposDir()] }) }) } catch {}
  // DSH 启动时自动拉起标记了「自启动」的服务器组件（幂等，不阻塞启动）
  autostartComponents().catch(() => {})
  ctx.effect(() => {
    const route = {
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        if (!isLoopback(req.socket?.remoteAddress ?? '')) {
          sendError(res, 403, '仅允许本机访问')
          return
        }
        const port = webPort(ctx)
        const host = typeof req.headers?.host === 'string' ? req.headers.host : ''
        if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) {
          sendError(res, 403, 'Host 校验失败（仅允许本机访问）')
          return
        }
        // 安全护栏（issue #9）：写路由必须是本机同源请求，防止恶意网页跨站驱动敏感操作。
        const method = req.method ?? 'GET'
        if (method !== 'GET' && method !== 'HEAD' && !isAllowedWriteOrigin(req, port)) {
          sendError(res, 403, '跨站请求被拒绝（Origin/Sec-Fetch-Site 校验）')
          return
        }
        try {
          await handle(ctx, req, res)
        } catch (error) {
          sendError(res, 500, error instanceof Error ? error.message : String(error))
        }
      },
    }
    return ctx.webServer.register(route)
  }, 'plugin-console: routes')
}

// ── 路由表（分层 Step 8b：表驱动分发，替代逐条 if 分支）─────────────────────────
// 方法限定且位于 405 守卫之前的分支（只读接口）

/** 路由处理器需要的宿主服务（仍住在 index.js 的 ctx 相关函数）—— ports 注入点（方案 §四）。
 *  用函数而不是模块级常量：这些是函数声明（会提升），但用惰性函数可以彻底避免初始化顺序问题。 */

/** 框架版本检查缓存（功能包 → 框架 面板用；5 分钟 TTL，避免每次打开面板都打 registry）。 */

