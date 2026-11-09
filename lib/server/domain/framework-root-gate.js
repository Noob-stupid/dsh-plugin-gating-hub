// L1 · domain —— 「框架安装根」判据（2026-11-06 真机放宽；纯函数，可单测）
//
// 真机现场（2026-11-06，用户点「框架升级」直接失败，零副作用）：
//   「无法定位框架安装根（期望含 .pnpm 与 @deepseek-ai/dsh 的顶层 node_modules，实际：未找到）
//      —— 已取消升级，请修复框架安装后重试」
// 实测的四个候选目录（`node -e` 逐个探过，不是推测）：
//   D:\node_cache\_npx\<hash>\node_modules        .pnpm=**无**  @deepseek-ai/dsh=有（0.2.1-rc.5，真实目录含 lib/bin.js）
//   ~\.dsh\profiles\node_modules                  .pnpm=无      @deepseek-ai/dsh=有
//   ~\.dsh\profiles\desktop\node_modules          .pnpm=有      @deepseek-ai/dsh=无
//   ~\.dsh\profiles\web\node_modules              .pnpm=有      @deepseek-ai/dsh=无
//   ⇒ **没有任何一个目录同时满足两个条件**，所以旧门闸永远过不去：框架明明装好了、版本确实有新版，
//     用户却只能看到"请修复框架安装"。这不是用户的安装坏了，是我们的判据把布局当成了必要条件。
//
// 判据改正（用户定案）：「`@deepseek-ai/dsh/lib/bin.js` 在就说明框架装好了」。
//   · `bin.js` 是**服务的入口**，缺了根本拉不起来 ⇒ 它才是真正的安全网（必须保留）；
//   · `.pnpm` 只是 **pnpm 布局**的特征 —— npm / npx 的扁平（hoisted）安装本来就没有它，
//     它的存在与否**不能**决定"框架有没有装好"。
//   ⇒ `.pnpm` 从「必要条件」降级为「布局标签」：layout = 'pnpm' | 'hoisted'。
//
// 纪律：本模块是纯函数（判据只用注入的 `exists`），不读全局、不写盘、不抛错，
// 让调用方（routes/framework-upgrade.js，那文件有 700 行硬顶）保持精简。
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 框架入口（相对框架安装根 = 顶层 node_modules）。缺它 = 真的没装好。 */
const FRAMEWORK_BIN_SEGMENTS = ['@deepseek-ai', 'dsh', 'lib', 'bin.js']
/** pnpm 布局的 store 目录名（只是布局特征，**不再**是必要条件）。 */
const PNPM_STORE_DIR = '.pnpm'

/** 框架入口的绝对路径（用于日志/报错里点名到底缺了哪个文件）。 */
function frameworkBinPath(fwRoot) {
  return join(fwRoot, ...FRAMEWORK_BIN_SEGMENTS)
}

/**
 * 该目录里有没有可执行的框架入口（`@deepseek-ai/dsh/lib/bin.js`）。
 * 框架安装根识别的唯一硬判据 —— 解析器（domain/framework.js#resolveFrameworkRootNodeModules）
 * 与门闸（judgeFrameworkRoot）共用这一份，避免"两处判据各写一半"。
 */
function hasFrameworkBin(fwRoot, { exists = existsSync } = {}) {
  if (typeof fwRoot !== 'string' || fwRoot === '') return false
  try {
    return exists(frameworkBinPath(fwRoot)) === true
  } catch {
    return false
  }
}

/**
 * 判定一个「顶层 node_modules」是不是可用的框架安装根。
 *
 * @param {string|null} fwRoot 框架安装根（顶层 node_modules）；null/空 ⇒ 没找到
 * @param {{ exists?: (p: string) => boolean }} [opts] 注入探测函数（测试用；默认 fs.existsSync）
 * @returns {{ ok: boolean, layout: 'pnpm'|'hoisted'|null, reason: 'root-not-found'|'bin-missing'|null }}
 *   · root-not-found：压根没找到候选 node_modules（或传入 null/空串）
 *   · bin-missing   ：目录找到了，但缺 `@deepseek-ai/dsh/lib/bin.js`（框架没装全 —— 真安全网）
 *   · layout        ：'pnpm'（有 .pnpm store）/ 'hoisted'（扁平安装，无 .pnpm）；失败时 null
 */
function judgeFrameworkRoot(fwRoot, { exists = existsSync } = {}) {
  if (typeof fwRoot !== 'string' || fwRoot === '') return { ok: false, layout: null, reason: 'root-not-found' }
  if (!hasFrameworkBin(fwRoot, { exists })) return { ok: false, layout: null, reason: 'bin-missing' }
  let hasStore = false
  try {
    hasStore = exists(join(fwRoot, PNPM_STORE_DIR)) === true
  } catch {
    hasStore = false // store 探测不了就当扁平布局：判定权在 bin.js（已在上面确认过）
  }
  return { ok: true, layout: hasStore ? 'pnpm' : 'hoisted', reason: null }
}

/**
 * 把判定的否决结果翻成路由可用的报错载荷（**如实**区分两种情况）。
 * 文案纪律：扁平布局下**不要**再提 `.pnpm`（那不是用户的安装问题）；
 * `bin.js` 缺失才需要说"框架没装全"，并点名缺的文件。
 *
 * @returns {{ error: string, details: object }}
 */
function frameworkRootRefusal(verdict, fwRoot) {
  const reason = verdict?.reason ?? 'root-not-found'
  if (reason === 'bin-missing') {
    const bin = frameworkBinPath(String(fwRoot))
    return {
      error: `框架安装根 ${fwRoot} 存在，但缺框架入口 ${bin}（框架没装全）—— 已取消升级，请重新安装框架后重试`,
      details: { code: 'framework-bin-missing', reason, fwRoot: fwRoot ?? null, missing: bin },
    }
  }
  return {
    error: '无法定位框架安装根：没找到含 @deepseek-ai/dsh/lib/bin.js 的顶层 node_modules（实际：未找到）—— 已取消升级，请修复框架安装后重试',
    details: { code: 'framework-root-not-found', reason: 'root-not-found', fwRoot: fwRoot ?? null },
  }
}

/**
 * 升级步骤日志里的一条「读得懂的」布局说明（pnpm / hoisted 都要写出来，不许沉默）。
 * 用户与排查者一眼就能看出这次升级是在哪种安装布局上跑的。
 */
function frameworkRootLayoutStep(verdict, fwRoot) {
  const layout = verdict?.layout === 'pnpm' ? 'pnpm（含 .pnpm store）' : 'hoisted（扁平安装，无 .pnpm store —— 有 lib/bin.js 即视为装好）'
  return `框架安装根：${fwRoot ?? '未找到'}；布局：${layout}`
}

export { FRAMEWORK_BIN_SEGMENTS, PNPM_STORE_DIR, frameworkBinPath, hasFrameworkBin, judgeFrameworkRoot, frameworkRootRefusal, frameworkRootLayoutStep }
