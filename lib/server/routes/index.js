// L2 · routes —— 路由装配：前缀常量 + 两张路由表 + 宿主服务注入（ports）+ 分发入口 handle()
//
// 分层 Step 8c-3 从 lib/index.js 搬出，至此 index.js 只剩「插件元信息 + apply 装配」。
// 两个分发点的原因（勿合并）：ROUTES_EARLY 在 405 守卫**之前**（方法限定的只读接口，
// 如 GET /state —— 原实现里它们就在守卫前 return），ROUTES 在守卫 + readBody **之后**（能吃 body）。

import { aiEmpowerExecute, aiEmpowerPlan } from '../domain/ai-run.js'
import { detectAdoptablePending, detectCompat, frameworkCompatReportFor, rowIdModuleMap } from '../domain/compat.js'
import { backupProfileSnapshot, currentFrameworkVersion, detectFrameworkUpgrade, preflightDisableIncompatible } from '../domain/framework.js'
import { pnpmRemove, readExtraBundleRows, runInstallJob } from '../domain/install-job.js'
import { isProtectedModule, listEntries, webPort } from '../domain/runtime.js'
import { DEFAULT_SEARCH } from '../domain/sources.js'
import { runSuiteInstallJob } from '../domain/suite.js'
import { readBody, sendError } from '../infra/httpd.js'
import { routeAiConsent, routeAiEmpowerCancel, routeAiEmpowerList, routeAiEmpowerPlan, routeAiEmpowerRun, routeAiEmpowerStatus } from './ai.js'
import { routeComponentAutostart, routeComponentStart, routeComponentStatus, routeComponentStop, routeComponents, routeRepoClone, routeRepoLandConfig, routeRepoList, routeRepoOpen, routeRepoRemove } from './components.js'
import { routeCompatMode, routeCompatStamp, routeCompatStatusGet, routeDeclareInstalled } from './compat.js'
import { routeFrameworkUpgrade } from './framework-upgrade.js'
import { routeFrameworkPreflight, routeFrameworkPreflightPatch } from './framework-preflight.js'
import { routeCheckUpdate, routeCompatGate, routeFrameworkCheck, routeFrameworkRelaunch, routeFrameworkRollback, routeFrameworkStatusClear, routeFrameworkUpgradeStatusGet, routeRestart } from './framework.js'
import { routeGithubLogin, routeGithubOpenLogin } from './github-login.js'
import { routeInstall, routeInstallStatus } from './install.js'
import { routeEnrich, routeMarketIndex, routeRepo, routeSearch, routeSubpackages } from './market.js'
import { routeAdaptUnlock, routeAdaptUnlockAll, routeCleanResiduals, routeSelfUpdate, routeToggle, routeUninstall } from './plugins.js'
import { routeSkillRemove, routeSkillToggle, routeSkillsInstalledGet } from './skills.js'
import { routeGiteeOauthCallbackGet, routeGiteeOauthUrlGet, routeRegistryScan, routeSources, routeSourcesGet } from './sources.js'
import { routeDetails, routeStateGet } from './state.js'

const ROUTE_PREFIX = '/plugin-console'

const ROUTES_EARLY = [
  { methods: ['GET'], path: `${ROUTE_PREFIX}/state`, handler: routeStateGet },
  { methods: ['GET'], path: `${ROUTE_PREFIX}/sources`, handler: routeSourcesGet },
  { methods: ['GET'], path: `${ROUTE_PREFIX}/gitee-oauth-url`, handler: routeGiteeOauthUrlGet },
  { methods: ['GET'], path: `${ROUTE_PREFIX}/gitee-oauth-callback`, handler: routeGiteeOauthCallbackGet },
  { methods: ['GET'], path: `${ROUTE_PREFIX}/skills-installed`, handler: routeSkillsInstalledGet },  { methods: ['GET'], path: `${ROUTE_PREFIX}/framework-upgrade-status`, handler: routeFrameworkUpgradeStatusGet },
  { methods: ['GET'], path: `${ROUTE_PREFIX}/compat-status`, handler: routeCompatStatusGet },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/framework-relaunch`, handler: routeFrameworkRelaunch },

]

function routeDeps() {
  return { runInstallJob, runSuiteInstallJob, webPort, readExtraBundleRows, detectAdoptablePending, listEntries, detectCompat, detectFrameworkUpgrade, DEFAULT_SEARCH, aiEmpowerExecute, aiEmpowerPlan, backupProfileSnapshot, currentFrameworkVersion, frameworkCompatReportFor, isProtectedModule, pnpmRemove, preflightDisableIncompatible, rowIdModuleMap }
}

async function handle(ctx, req, res) {
  const url = new URL(req.url ?? '/', 'http://x')
  const pathname = url.pathname
  const method = req.method ?? 'GET'

  // GET 兼容白名单：只读且无副作用的接口允许 GET 调用
  // （market-index 曾被客户端以 GET 调用，落进 405 后错误被静默吞掉，导致静态索引长期未生效）
  const GET_COMPAT = new Set([`${ROUTE_PREFIX}/market-index`])
  // 守卫之前先命中「方法限定」的路由（原实现里它们就在 405 守卫之前返回）
  const earlyHit = ROUTES_EARLY.find((r) => r.methods.includes(method) && r.path === pathname)
  if (earlyHit) {
    await earlyHit.handler(req, res, { ctx, url, pathname, method, deps: routeDeps() })
    return
  }

  if (method !== 'POST' && !(method === 'GET' && GET_COMPAT.has(pathname))) {
    sendError(res, 405, '不支持的方法')
    return
  }

  const body = await readBody(req)

// ── 其余路由表（位于 405 守卫 + readBody 之后）──────────────────────────────

  // 守卫之后命中其余路由（这些能吃 body）
  const hit = ROUTES.find((r) => r.methods.includes(method) && r.path === pathname)
  if (hit) {
    await hit.handler(req, res, { ctx, url, pathname, method, body, deps: routeDeps() })
    return
  }

  // 软件源扫描：并发探测每个 npm 源的「可达性 / 延迟 / 该源上的最新版本」。
  // 用于判断主源是否最优（内网私服 vs 公共镜像），结果直接在前端软件源列表里显示。

  sendError(res, 404, `未知接口 ${pathname}`)
}

const ROUTES = [
  { methods: ['POST'], path: `${ROUTE_PREFIX}/details`, handler: routeDetails },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/registry-scan`, handler: routeRegistryScan },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/sources`, handler: routeSources },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/skill-remove`, handler: routeSkillRemove },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/skill-toggle`, handler: routeSkillToggle },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/install`, handler: routeInstall },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/install-status`, handler: routeInstallStatus },  { methods: ['POST'], path: `${ROUTE_PREFIX}/framework-check`, handler: routeFrameworkCheck },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/compat-gate`, handler: routeCompatGate },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/check-update`, handler: routeCheckUpdate },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/framework-upgrade`, handler: routeFrameworkUpgrade },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/framework-preflight`, handler: routeFrameworkPreflight },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/framework-preflight-patch`, handler: routeFrameworkPreflightPatch },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/framework-status-clear`, handler: routeFrameworkStatusClear },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/compat-mode`, handler: routeCompatMode },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/compat-stamp`, handler: routeCompatStamp },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/declare-installed`, handler: routeDeclareInstalled },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/framework-rollback`, handler: routeFrameworkRollback },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/restart`, handler: routeRestart },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/toggle`, handler: routeToggle },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/uninstall`, handler: routeUninstall },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/adapt-unlock`, handler: routeAdaptUnlock },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/adapt-unlock-all`, handler: routeAdaptUnlockAll },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/clean-residuals`, handler: routeCleanResiduals },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/self-update`, handler: routeSelfUpdate },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/search`, handler: routeSearch },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/enrich`, handler: routeEnrich },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/repo`, handler: routeRepo },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/subpackages`, handler: routeSubpackages },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/market-index`, handler: routeMarketIndex },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/github-login`, handler: routeGithubLogin },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/github-open-login`, handler: routeGithubOpenLogin },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/ai-consent`, handler: routeAiConsent },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/ai-empower/plan`, handler: routeAiEmpowerPlan },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/ai-empower/status`, handler: routeAiEmpowerStatus },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/ai-empower/list`, handler: routeAiEmpowerList },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/ai-empower/run`, handler: routeAiEmpowerRun },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/ai-empower/cancel`, handler: routeAiEmpowerCancel },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/components`, handler: routeComponents },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/repo-clone`, handler: routeRepoClone },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/repo-list`, handler: routeRepoList },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/repo-land-config`, handler: routeRepoLandConfig },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/repo-remove`, handler: routeRepoRemove },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/repo-open`, handler: routeRepoOpen },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/component/autostart`, handler: routeComponentAutostart },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/component/start`, handler: routeComponentStart },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/component/stop`, handler: routeComponentStop },
  { methods: ['POST'], path: `${ROUTE_PREFIX}/component/status`, handler: routeComponentStatus },

]

export { ROUTE_PREFIX, handle }
