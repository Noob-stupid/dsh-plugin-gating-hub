// L1 · domain —— install-job.js（安装任务编排：多通道安装 + 套装补丁 + 适配门 + 收尾）。
// 分层 Step 8c-2 从 lib/index.js 搬出；形参由 ctx 收窄为 ports（调用方注入的窄接口），只搬移未改逻辑。
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md 三

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { aiRepair } from './ai-run.js'
import { maybeAutoAdaptCompat } from './compat.js'
import { DEFAULT_BUNDLES, AI_CONSENT_TIMEOUT_MS, addBundleToManifest, backfillMissingDeps, curlManualInstall, detectBundleOnly, ensureBundlePatchIntegrity, githubReleaseInstall, pnpmInstall, raceInstallChannels, readBundlePatchRefNames, readGithubAuth, syncAggregateSubpackageVersions } from './install.js'
import { fetchRepoPackage, fetchRepoPackageEx, fetchSubpackageNames, packageProbeErrorText, subpackageCandidates } from './market.js'
import { declareProfileDependency } from './manifest.js'
import { appendInsert, readPatchState, syncNameFromNote } from './patch.js'
import { deriveEntryId, listEntries } from './runtime.js'
import { detectSkillRepo, runSkillInstallJob } from './skills.js'
import { gitCloneUrls, orderedRegistries, readSources } from './sources.js'
import { reconcileLockfile } from './selfupdate.js'
import { probeGitmodules, resolveInstallKind, runSuiteInstallJob } from './suite.js'
import { execFileAsync, runPnpmWithFallback } from '../infra/exec.js'
import { cleanupStalePackageDir, removeDirVerified } from '../infra/fsx.js'
import { GITHUB_API, META_BUDGET_MS, curlJson, githubJson } from '../infra/http.js'
import { findPatchPath, packageNameOf, resolvePackageJson } from '../infra/paths.js'

/** 安装失败清场：把本次尝试过的候选包目录与 pnpm `_tmp_` 半成品一起清掉，并**如实汇报**清了什么、
 * 什么没清掉。为什么需要（2026-09-20 真装演练）：11 个子包的聚合仓库跑 19 分钟后失败，node_modules 里
 * 留着 `@captain1275/dsh-full-stats_tmp_56272_2` 这类半成品和一个真包，而面板只报"安装失败"——
 * 用户既不知道有东西被落盘，也不知道要不要手动清。删除一律走 removeDirVerified（本机 C 盘/`%TEMP%`
 * 下 rmSync 会静默落空，不核实就会谎报干净）。 */
function cleanupAttemptedCandidates(profileDir, candidates) {
  const cleaned = []
  const failed = []
  for (const name of candidates) {
    const dir = join(profileDir, 'node_modules', ...String(name).split('/'))
    const parent = dirname(dir)
    const base = basename(dir)
    let touched = 0
    if (existsSync(dir)) {
      const result = removeDirVerified(dir)
      if (result.ok) touched += 1
      else failed.push({ name, path: dir, error: result.error })
    }
    try {
      for (const entry of readdirSync(parent)) {
        if (!entry.startsWith(`${base}_tmp_`)) continue
        const tmpPath = join(parent, entry)
        const result = removeDirVerified(tmpPath)
        if (result.ok) touched += 1
        else failed.push({ name: `${name}（临时目录）`, path: tmpPath, error: result.error })
      }
    } catch {}
    if (touched > 0) cleaned.push(name)
  }
  return { cleaned, failed }
}

/** 授权被拒/超时后的失败文案（纯函数，单测覆盖）：说清为什么失败、清理了什么、什么没清掉。
 * 时长取自 AI_CONSENT_TIMEOUT_MS —— 文案里的"10 分钟"不能与实际等待时间脱节。 */
function aiConsentFailureText(decision, leftovers) {
  const base = decision?.timeout === true
    ? `等待授权超时（${Math.round(AI_CONSENT_TIMEOUT_MS / 60000)} 分钟），已取消本地 AI 兜底（该操作会调用模型 API 产生费用）`
    : '用户取消本地 AI 兜底（该操作会调用模型 API 产生费用）'
  const cleaned = leftovers?.cleaned ?? []
  const failed = leftovers?.failed ?? []
  const cleanedNote = cleaned.length > 0 ? `；已清理本次落盘残留：${cleaned.join('、')}` : ''
  const failedNote = failed.length > 0
    ? `；**有 ${failed.length} 项没能清理**（当前环境可能禁止删除，请手动删除）：${failed.map((f) => f.path).join('、')}`
    : ''
  return `${base}${cleanedNote}${failedNote}`
}

/** release 通道的候选预算（issue #3）：release 通道现在按包名反查发布仓库，**每个候选**至少一次
 * `releases?per_page=10` 调用（第一梯队仓库没命中还要多试几个候选仓库），而候选可能有十几个
 * （聚合仓库懒惰展开后最多 19 个）——不封顶会把 8 分钟的作业时间预算吃光。
 * 只给前 N 个候选扫 release；排在后面的候选仍照走 curl/并行竞速（按包名施工，代价小）。 */
const RELEASE_CHANNEL_BUDGET = 3

/** 安装通道实现集合（默认真实实现；`ctx.get('installChannels')` 可覆盖 —— 只走可选读取，不走属性访问）。
 * 为什么留这个缝：通道守卫（哪些通道在懒惰展开之后仍应被尝试）正是 issue #3 的核心语义，
 * 用真实通道无法离线断言"谁被调用了"——单测注入桩函数即可把语义钉死（见 test-suite-detect.mjs ⑯）。
 * 注：注入桩在测试里必须以「provide 但未 inject」的方式喂进来（见 strict-ctx.mjs 的严格替身），
 * 否则替身与 cordis 语义不一致，这类缺陷还会再溜过去一次。 */
function channelImpls(ports) {
  const real = { pnpmInstall, curlManualInstall, raceInstallChannels, githubReleaseInstall, backfillMissingDeps }
  // 测试注入缝（2026-09-22 事故的修法，**别改回属性访问**）：
  //   生产路径上 ports 就是 cordis 的 ctx 代理，属性式读取未 inject 的名字会**同步抛**
  //   `cannot get property "installChannels" without inject` —— 0.3.59 因此每一次安装都在这里失败。
  //   正规写法是 ctx.get('installChannels')（Cordis 的可选读取，未声明也不抛，与本文件其它
  //   ports.get('subagents') / ports.get('agents') 一致）；普通对象（测试替身/窄接口）才回退属性访问。
  //   try/catch 保留 0.3.61 的兜底语义：万一还有别的 ctx 形状，宁可回落真实实现也不要炸掉安装。
  let override = null
  try {
    override = typeof ports?.get === 'function' ? (ports.get('installChannels') ?? null) : (ports?.installChannels ?? null)
  } catch { override = null }
  return override !== null && typeof override === 'object' ? { ...real, ...override } : real
}

/** 单个候选包的通道尝试序列（通道实现由 ch 注入；job.curlNote 等展示字段在此更新）。
 * 返回 { installedName, lastError }。三条守卫语义及理由（issue #3 要求逐条写清）：
 *
 * ① 并行竞速（pnpm‖curl）与 curl 手动通道：**始终可试，不判 expanded**。
 *    这两条都按 name 走 registry，与 job.repo、根包是否 private 毫无关系；懒惰展开只是让候选变多，
 *    没有任何理由让展开后的候选失去这两条通道。旧代码的 `!expanded` 会让展开后的所有候选
 *    直接跳到最后 → 子包只能靠 AI 兜底，正是 issue 报的"四分钟才装上"。
 *
 * ② GitHub release 通道：**不判 expanded，也不判 subpackageMode**（只受"是否反查到候选仓库"限制）。
 *    issue #3 之后它会按包名反查真实发布仓库——子包的产物常常发布在**另一个仓库**的 release 里
 *    （实测：dsh-routing-suite 的私根包 @dsh-external/dsh-super-injector，产物在 dsh-super-injector
 *    仓库的 release 资产里）。按 job.repo 判断"该不该试 release"因此不再成立，代价用预算封顶。
 *
 * ③ git 通道：**保留 repoChannelAllowed**（它只 clone `job.repo`，候选是子包时 clone 根仓库装不出子包，
 *    属无意义尝试）**并保留 !expanded**（同一作业里对同一个 job.repo 反复 clone 纯属浪费时间，
 *    级联顺序也不该被破坏）。 */
async function tryCandidateChannels({ job, ch, name, profileDir, registries, repoChannelAllowed, budget, baseUrl = null, expanded = false }) {
  let installedName = null
  let lastError = null
  // 加法优化：包已在 node_modules 且名字匹配时，不再重复安装/触发 EPERM，直接进入启用流程
  const existingTarget = join(profileDir, 'node_modules', name, 'package.json')
  if (existsSync(existingTarget)) {
    try {
      const existingPkg = JSON.parse(readFileSync(existingTarget, 'utf8'))
      if (existingPkg && existingPkg.name === name && job.update !== true) {
        job.curlNote = `已检测到本地已安装 ${name}@${existingPkg.version ?? '?'}，跳过重复下载`
        return { installedName: name, lastError: null }
      }
    } catch {}
  }
  // 通道 0：并行竞速（pnpm 与 curl 同时启动，先成功者生效；失败方 abort，不影响后续串行通道）——守卫①
  {
    const raced = await ch.raceInstallChannels(profileDir, name, registries)
    if (raced) {
      installedName = name
      if (raced.channel === 'curl') {
        const racedInfo = raced.info
        const stillMissing = await ch.backfillMissingDeps(profileDir, racedInfo.missingDeps, registries)
        job.curlNote = `已通过并行 curl 通道安装 v${racedInfo.version}${stillMissing.length > 0 ? `（依赖仍未补齐：${stillMissing.join('、')}，网络恢复后建议重新安装）` : '（捆绑依赖已补齐）'}`
        if (racedInfo.boxNote) job.curlNote += `（盒子验证：${racedInfo.boxNote}）`
      }
    }
  }
  // 通道 1..n：配置的软件源依次尝试（每源 90 秒封顶）
  for (let ri = 0; ri < registries.length && installedName === null; ri += 1) {
    try {
      await ch.pnpmInstall(profileDir, name, registries[ri])
      installedName = name
      break
    } catch (error) {
      lastError = error
    }
  }
  if (installedName === null) {
    // 通道 n+1：curl 手动安装（node 网络黑洞时 pnpm 下载卡死、curl 可用）——下载 registry tarball
    // 解压到 node_modules，零依赖包可完整安装。守卫①：不判 expanded。
    try {
      const info = await ch.curlManualInstall(profileDir, name, registries)
      installedName = name
      const stillMissing = await ch.backfillMissingDeps(profileDir, info.missingDeps, registries)
      job.curlNote = `已通过 curl 通道安装 v${info.version}${stillMissing.length > 0 ? `（依赖仍未补齐：${stillMissing.join('、')}，网络恢复后建议重新安装）` : '（捆绑依赖已补齐）'}`
      if (info.boxNote) job.curlNote += `（盒子验证：${info.boxNote}）`
    } catch (curlError) {
      lastError = curlError
    }
  }
  if (installedName === null) {
    // 通道 n+1b：GitHub release 下载安装（npm 上不存在的包，例如只发 GitHub release 的社区插件）——
    // 按包名反查发布仓库 → 遍历最近 ≤10 条 release 的 assets 按包名挑产物 → 盒子验证 → 覆盖。
    // 守卫②：不判 expanded / subpackageMode（理由见本函数顶部注释）；预算封顶避免吃光作业时间。
    if (budget.release > 0) {
      budget.release -= 1
      try {
        const info = await ch.githubReleaseInstall(profileDir, job.repo ?? null, name, { baseUrl })
        installedName = name
        const stillMissing = await ch.backfillMissingDeps(profileDir, info.missingDeps, registries)
        // 如实记录来源：哪个仓库的哪条 release 的哪个资产（issue #3 明确要求，面板直接展示这句话）
        const from = typeof info.sourceNote === 'string' && info.sourceNote !== '' ? `（来源：${info.sourceNote}）` : ''
        job.curlNote = `已通过 GitHub release 通道安装 v${info.version ?? '?'}${from}${stillMissing.length > 0 ? `（依赖仍未补齐：${stillMissing.join('、')}，网络恢复后建议重新安装）` : '（捆绑依赖已补齐）'}`
        if (info.boxNote) job.curlNote += `（盒子验证：${info.boxNote}）`
      } catch (ghError) {
        lastError = ghError
      }
    } else if (lastError === null) {
      // 预算用尽：不覆盖真实错误（面板/AI 兜底要看的是 curl·pnpm 的失败原因），只在无更具体错误时说明
      lastError = new Error(`release 通道候选预算已用尽（本作业只对前 ${RELEASE_CHANNEL_BUDGET} 个候选做按包名反查+release 扫描）`)
    }
  }
  if (installedName === null) {
    // 通道 n+2：git 通道（GitHub 走加速代理+直连；Gitee 走对应平台；各 60 秒封顶）——守卫③
    if (repoChannelAllowed && !expanded) {
      const gitSpecs = job.source === 'gitee'
        ? [`git+https://gitee.com/${job.repo}.git`]
        : [
            ...gitCloneUrls(job.repo).map((u) => `git+${u}`),
            `github:${job.repo}`,
          ]
      for (const spec of gitSpecs) {
        try {
          await ch.pnpmInstall(profileDir, spec, undefined, 60000)
          installedName = name
          break
        } catch (gitError) {
          lastError = gitError
        }
      }
    }
  }
  if (installedName !== null) return { installedName, lastError }
  // Windows 原子替换失败（陈旧目录 / _tmp_ 残留）是 EPERM 类错误的根因：
  // 清理后用主源重试一次（把 AI 人工修复经验自动化，减少 AI 兜底触发）
  if (/EPERM|EACCES|rename/i.test(String(lastError?.message ?? ''))) {
    const cleaned = cleanupStalePackageDir(profileDir, name)
    if (cleaned > 0) {
      try {
        await ch.pnpmInstall(profileDir, name, registries[0])
        installedName = name
      } catch (error) {
        lastError = error
      }
    }
  }
  return { installedName, lastError }
}

async function runInstallJob(job, ports) {
  try {
    job.stage = 'preparing'
    // 2026-09-06 事故（室友机器）：对 deepseek-ai/deepseek-harness（框架本体仓库）点「添加到本地/安装」
    // 会按 bundle 规则注册其 patch，其中 deepseek-ai-dsh-root 等框架级行的包只存在于 npx 缓存/框架树，
    // profile node_modules 不存在 → 整服务启动崩溃。直接拦截。
    const repoNorm = String(job.repo ?? '').toLowerCase().replace(/^git\+/u, '').replace(/\.git$/u, '')
    if (repoNorm === 'deepseek-ai/deepseek-harness') {
      job.status = 'failed'
      job.error = '这是 DSH 框架本体仓库，不能按插件安装（其组件引用框架内部包，安装后会导致服务启动失败）。如需升级框架请用「框架升级」按钮；如需生态插件请选择 dsh-plugin 插件仓库。'
      return
    }
    let candidates = [job.packageName].filter((name) => typeof name === 'string' && name !== '')
    let subpackageMode = false
    if (candidates.length === 0) {
      // 套装兜底：submodule 聚合仓库（根 .gitmodules 内容校验通过）→ 自动转套装安装，
      // 不依赖前端标记（搜索结果 enrich 是异步的、索引浏览条目无 enrich）。
      // 判据是**内容**（resolveInstallKind），不是"探测非 null"：后者会把代理/CDN 对不存在文件回的
      // 2xx 空 body、垃圾页当成套装（2026-09-19 用户反馈的「未找到 .gitmodules」事故根因）。
      if (resolveInstallKind(job.kind, await probeGitmodules(job.repo)) === 'suite') {
        job.kind = 'suite'
        const suiteResult = await runSuiteInstallJob(job, ports)
    // 套装装配出的普通插件是 copyTree 铺进去的（不在 lock 里）→ 同样对账，避免之后被 pnpm 还原/清理
    if (Array.isArray(job.suiteInstalled) && job.suiteInstalled.length > 0 && suiteResult?.notASuite !== true) {
      try {
        const lock = await reconcileLockfile({ profileDir, packages: job.suiteInstalled.map((name) => ({ name })), registries })
        job.lockUpdated = lock.lockUpdated
        job.lockVersion = lock.lockVersion
        job.lockMethod = lock.method
        job.lockPackages = lock.packages
        if (lock.lockNote !== null) job.lockNote = lock.lockNote
        if (lock.depNote !== null) job.depNote = lock.depNote
      } catch {}
    }
        // clone 后才发现没有 .gitmodules（探测假阳性 / 仓库已重构）→ 回落普通安装，不给用户一个失败
        if (suiteResult?.notASuite !== true) return
        job.kind = 'plugin'
        job.suiteNote = '探测到的 .gitmodules 与仓库实际内容不符（不是 submodule 套装仓库），已自动回落普通插件安装'
      }
      // 兜底：宿主端自行拉取仓库元数据（githubJson 与 curl 竞速 + 8s 超时降级，黑洞期不卡 40s）。
      // 8s 而非旧值 3s：IPv6 无路由的环境里单条通道就要 5.4s，3s 预算必输 → branch 恒为 main，
      // 默认分支为 dev 的仓库会取错分支（2026-09-20 另一位用户实测）。
      const meta = await Promise.race([
        Promise.any([
          githubJson(`${GITHUB_API}/repos/${job.repo}`),
          curlJson(`${GITHUB_API}/repos/${job.repo}`, 12000, {}, { ipv4: true }),
        ]),
        new Promise((resolve) => setTimeout(() => resolve(null), META_BUDGET_MS)),
      ]).catch(() => null)
      const branch = meta?.default_branch ?? 'main'
      const { pkg, reason } = await fetchRepoPackageEx(job.repo, branch)
      if (pkg === null) {
        // 无 package.json：先探测是否技能仓库（含 SKILL.md）→ 自动转技能安装；
        // 否则标记 hint=repo-land，前端给出「仓库落地」一键入口（克隆到本地目录）。
        const skillProbe = await detectSkillRepo(job.repo, branch)
        if (skillProbe.hasSkill) {
          job.kind = 'skill'
          await runSkillInstallJob(job, ports)
          return
        }
        job.status = 'failed'
        job.hint = 'repo-land'
        // 文案区分「抓取超时/不可达」与「真的没有」——旧代码两者共用一个出口，报错永远说"文件不存在"
        job.error = packageProbeErrorText(job.repo, branch, reason)
        job.probeReason = reason
        return
      }
      if (pkg.private === true) {
        // 私有 monorepo 根：自动列出子包作为候选（把人工修复经验自动化），聚合包优先
        subpackageMode = true
        // 2026-09-20 事故（用户点装 zhu1090093659/dsh-web，报"未发现子包"）：该仓库根包确实
        // private: true，但 main/dev 各有 22 个子包目录。失败原因是当时市场索引源全挂、网络受限，
        // subpackageCandidates() 读不到列表 —— 旧代码只有"有没有子包"一个出口，把**没读到**
        // 报成了**不存在**，直接把用户带偏。教训：探测失败必须与确定性结论分开表达。
        let subs = await subpackageCandidates(job.repo, branch)
        if (subs.length === 0) {
          // 读不到时先换一条分支重试：meta 探测失败时 branch 恒为 main，而默认分支为 dev 的仓库
          // （本例 dsh-web 就是 dev 为默认分支）main 上的子包布局可能不同/为空；
          // 换分支几乎零成本，却能把"分支取错"这一类假失败挡在报错之前。
          const altBranch = branch === 'main' ? 'dev' : 'main'
          subs = await subpackageCandidates(job.repo, altBranch)
          if (subs.length > 0) job.subpackageNote = `子包列表取自 ${altBranch} 分支（默认分支探测可能失败）`
        }
        if (subs.length === 0) {
          job.status = 'failed'
          // 文案要点：说清"这是读不到、不是没有"，并给出可直接复制的安装命令 ——
          // 用户看到"未发现子包"会去翻仓库找，而真相多半只是本次网络没读成。
          // 2026-09-20 演练发现：这里曾把示例写成固定包名 `@linxin666/dsh-web-all`，
          // 于是**任何**私有根仓库（如社区皮肤插件）报错都让用户去装别人家的全家桶 ——
          // 示例必须来自本次仓库（子包名占位或该仓库的 git 规格），不能借别人的包名。
          job.error = `仓库 ${job.repo} 的根包未发布到 npm（private: true：${pkg.name}），且本次没能读到它的子包列表（多为网络受限/超时，不代表没有子包）。请重试；或在「查看」详情里确认子包名后直接安装，例如：dsh plugin --profile web add <子包名>；若该仓库根包本身即可作为插件，也可直接：dsh plugin --profile web add github:${job.repo}`
          job.probeReason = 'subpackages-unreadable'
          return
        }
        candidates = subs
        job.subpackages = candidates
      } else {
        candidates = [pkg.name]
      }
      job.packageName = pkg.name
    }
    // 给了根包名但根包实际是 private 聚合仓库（如直接填 dsh-web-ui）：
    // 与仓库模式同路径——直接展开子包（聚合包优先），跳过 git 装根包的无意义尝试
    if (!subpackageMode && job.repo && job.packageName !== null) {
      const rootPkg = await fetchRepoPackage(job.repo, 'main')
      if (rootPkg !== null && rootPkg.private === true) {
        subpackageMode = true
        const subs = await subpackageCandidates(job.repo, 'main', readGithubAuth().token)
        if (subs.length > 0) {
          candidates = [...subs.filter((name) => !candidates.includes(name)), ...candidates]
          job.subpackages = subs
        }
      }
    }
    job.stage = 'installing'
    const patchPath = findPatchPath(ports)
    const profileDir = dirname(patchPath)
    const taken = new Set(listEntries(ports).map((entry) => entry.rowId))
    const patch = await readPatchState(patchPath)
    for (const id of [...patch.inserts, ...patch.disables, ...patch.forced]) taken.add(id)
    let installedName = null
    let lastError = null
    let expanded = false
    // 可配置软件源：主→备依次尝试（默认 npmmirror → npmjs，可增删自定义/内网源）
    const registries = orderedRegistries(readSources())
    const deadline = Date.now() + 8 * 60 * 1000
    // 子包级进度（2026-09-20 真装实测：11 个子包的聚合仓库跑了 19 分钟，job.stage 一直停在
    // installing，面板只有一个不动的进度条）。candidateTotal/Index/Name 每轮开始时更新，
    // 由 installJobView 折算成 progress{index,total,name} 下发给面板。
    job.candidateTotal = candidates.length
    job.candidateDone = false
    // 通道实现与 release 反查预算（三条守卫各自的理由见 tryCandidateChannels 顶部注释）
    const ch = channelImpls(ports)
    const budget = { release: RELEASE_CHANNEL_BUDGET }
    for (let index = 0; index < candidates.length && installedName === null; index += 1) {
      if (Date.now() > deadline) break
      const name = candidates[index]
      job.candidateIndex = index + 1
      job.candidateName = name
      // Issue（2026-09-21/#3）：subpackageMode 只表达"优先装子包"，不再连坐禁用其它通道；
      // 它现在只服务 git 通道（release/curl/竞速都按包名施工，见 tryCandidateChannels 注释②）。
      // ⚠️ 本行必须在 `const name` **之后**求值：旧代码把它写在 name 声明之前，`name === job.packageName`
      // 一被求值就命中 TDZ（ReferenceError: Cannot access 'name' before initialization）——
      // 私有聚合根（subpackageMode=true 且 packageName 非空）安装必失败，且报错文案完全指不到真正原因。
      const repoChannelAllowed = !subpackageMode || job.packageName === null || name === job.packageName
      const attempt = await tryCandidateChannels({ job, ch, name, profileDir, registries, repoChannelAllowed, budget, baseUrl: ports.baseUrl ?? null, expanded })
      installedName = attempt.installedName
      lastError = attempt.lastError
      if (installedName !== null) break
      // 懒惰展开：registry 与 git 通道都失败时，自动发现仓库子包继续尝试（聚合包优先），
      // 覆盖"给了根包名但根包未发布"的场景——AI 兜底只处理真正无解的案例
      if (!expanded && job.repo) {
        expanded = true
        let subs = await fetchSubpackageNames(job.repo, 'main', readGithubAuth().token)
        if (subs.length === 0) subs = await fetchSubpackageNames(job.repo, 'master', readGithubAuth().token)
        if (subs.length > 0) {
          const extra = subs
            .slice()
            .sort((a, b) => Number(/(^|-)all$/u.test(b.name) || /-all-/u.test(b.name)) - Number(/(^|-)all$/u.test(a.name) || /-all-/u.test(a.name)))
            .map((sub) => sub.name)
            .filter((n) => !candidates.includes(n))
            .slice(0, 8)
          if (extra.length > 0) {
            candidates = [...candidates, ...extra]
            // 懒惰展开后候选变多：总数要跟着更新，否则面板会显示"第 9/1 个"
            job.candidateTotal = candidates.length
            if (!Array.isArray(job.subpackages)) job.subpackages = []
            for (const e of extra) if (!job.subpackages.includes(e)) job.subpackages.push(e)
          }
        }
      }
    }
    if (installedName === null) {
      // 本地 AI 兜底会调用模型 API、产生费用：挂起等待用户明确同意后再执行
      job.stage = 'ai-consent'
      job.aiPending = { lastError: lastError?.message ?? null }
      // 等授权期间要能展示"为什么卡住、还能等多久"：请求时间 + 超时上限 + 最后一个确定性错误
      job.aiPendingSince = Date.now()
      job.aiConsentTimeoutMs = AI_CONSENT_TIMEOUT_MS
      job.lastError = lastError?.message ?? null
      job.aiWait = new Promise((resolve) => { job.aiPending.resolver = resolve })
      const decision = await Promise.race([
        job.aiWait,
        new Promise((resolve) => setTimeout(() => resolve({ approved: false, timeout: true }), AI_CONSENT_TIMEOUT_MS)),
      ])
      job.aiPending = null
      job.aiWait = null
      if (decision.approved === true) {
        await aiRepair(job, ports, profileDir, candidates, lastError?.message ?? null)
      } else {
        job.status = 'failed'
        // 失败/取消时清场并如实汇报（见 cleanupAttemptedCandidates 注释）：
        // 不能让用户面对"面板说失败、磁盘上却留了半个包和 _tmp_ 残留"的糊涂账。
        const leftovers = cleanupAttemptedCandidates(profileDir, candidates)
        job.leftovers = leftovers
        job.error = aiConsentFailureText(decision, leftovers)
      }
      return
    }
    // 装成功：进度标记完成（index 停在真正装上的那一轮，前端显示"第 i/n 个：<包名>"即为成功项）
    job.candidateDone = true
    job.candidateName = installedName
    job.packageName = installedName
    // 聚合包子包版本对齐（确保更新后所有子包也到新版声明版本）
    let syncedNames = []
    try {
      const synced = await syncAggregateSubpackageVersions(profileDir, installedName, registries)
      if (synced.length > 0) {
        syncedNames = synced.map(syncNameFromNote).filter((n) => n !== null)
        job.bundleNote = (job.bundleNote ? job.bundleNote + '；' : '') + `子包版本对齐：更新 ${synced.length} 个（${synced.join('、')}）`
      }
    } catch {}
    // 聚合包完整性保障（防崩）：bundle patch 引用的包缺失 → 补装；仍缺自动禁用该行。
    // 本次作业刚同步过版本的包（syncedNames）处于更新瞬时态，跳过"缺失自动禁用"判定。
    try {
      const integrity = await ensureBundlePatchIntegrity(profileDir, installedName, patchPath, [...syncedNames, installedName])
      if (integrity.checked > 0) {
        job.bundleNote = `聚合包完整性：检查 ${integrity.checked} 个引用`
          + (integrity.installed.length > 0 ? `，补装 ${integrity.installed.length} 个（${integrity.installed.join('、')}）` : '')
          + (integrity.disabled.length > 0 ? `，自动禁用缺失行 ${integrity.disabled.length} 个（${integrity.disabled.join('、')}）` : '')
          + (integrity.pending.length > 0 ? `，本次已同步包跳过缺失判定 ${integrity.pending.length} 个（${integrity.pending.join('、')}）` : '')
          + (integrity.missing.length > 0 ? `，仍缺失 ${integrity.missing.join('、')}（网络恢复后建议重新更新）` : '')
      }
    } catch {}
    // 框架升级适配门：更新完成后自动校验兼容性，通过则移除禁用块解锁启用
    try {
      const adapt = await maybeAutoAdaptCompat({ profileDir, packageName: installedName, syncedNames, patchPath, ports })
      if (adapt !== null && adapt.ran === true) job.compatNote = adapt.note
    } catch {}
    // lock 对账（2026-09-21，用户报告的自更新缺陷同源）：主包 + 本次被补装/对齐的聚合子包一起核对，
    // 一次 pnpm add 把漂移的包全写进 lock；对不上就留 lockNote，让面板如实告知（不假装成功）。
    try {
      const lock = await reconcileLockfile({
        profileDir,
        packages: [installedName, ...syncedNames].map((name) => ({ name })),
        registries,
      })
      job.lockUpdated = lock.lockUpdated
      job.lockVersion = lock.lockVersion
      job.lockMethod = lock.method
      job.lockPackages = lock.packages
      if (lock.lockNote !== null) job.lockNote = lock.lockNote
      // 非常规来源（link:）写回说明：必须让用户看见（缺陷②最阴的地方就是"装完完全看不出问题"）
      if (lock.depNote !== null) job.depNote = lock.depNote
    } catch {}
    job.stage = 'configuring'
    // 2026-09-06 事故（i18n 更新变重复行）：@linxin666/dsh-i18n 声明了 dsh.bundle.patch，
    // 更新流程按「bundle 安装规则」把它追加进 bundles → 与全家桶内的 web-ui-i18n 行（同包）重复。
    // 防护：该包已被现有行提供 → 只更新包，不注册任何新行/bundle。
    const alreadyServed = listEntries(ports).some((e) => String(e.moduleName).startsWith(installedName)
      || String(e.moduleName) === installedName
      || packageNameOf(e.moduleName) === installedName)
    if (await detectBundleOnly(profileDir, installedName)) {
      // 官方 dsh plugin add 行为：声明 dsh.bundle 的包追加为 profile bundle 层，
      // 其 cordis.patch.yml 在下次启动时参与组合（含皮肤包与 web-ui-settings 这类有入口的包）
      if (!alreadyServed) {
        // 通用防线（2026-09-06 事故：装 dsh-desktop 类插件时,其 bundle patch 引用 @deepseek-ai/dsh-root 等
        // 框架级行,包不在 profile node_modules → 注册后整服务启动崩溃）：
        // 注册前校验 bundle patch 引用的行模块全部可解析（**含 @deepseek-ai/* —— 正是室友崩塌的那些框架级包**）,
        // 缺失即拒绝注册并给出清单。
        const refs = readBundlePatchRefNames(profileDir, installedName)
        const missing = refs.filter((n) => resolvePackageJson(n, profileDir) === null)
        if (missing.length > 0) {
          job.status = 'failed'
          job.error = `该聚合包（${installedName}）的插件组引用以下未安装模块：${missing.join('、')}。若这些是框架内部包（@deepseek-ai/*）,该包不能作为插件安装（会导致服务启动失败）；若为本应随包安装的依赖,请重试或检查网络。已取消注册。`
          return
        }
        await addBundleToManifest(profileDir, installedName)
        job.bundle = true
      } else {
        job.bundleNote = (job.bundleNote ? job.bundleNote + '；' : '') + `${installedName} 已由已安装聚合包提供，仅更新包本身，不再注册重复行`
      }
      // 安装即声明（2026-09-24）：装到哪版就把它写进 profile 清单的 dependencies，
      // **并立刻同步 pnpm-lock.yaml**（declareProfileDependency 内部已含对账）——只写清单不写 lock
      // 会让之后任何 pnpm 操作硬失败（ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS）。
      // 对账失败只记 note，不让已经装好的包变成"安装失败"。
      const declaredBundle = await declareProfileDependency(profileDir, installedName)
      if (declaredBundle.changed) job.declared = declaredBundle.version
      if (declaredBundle.lockSynced === false && declaredBundle.lockNote !== null) job.lockNote = declaredBundle.lockNote
      job.status = 'done'
      return
    }
    if (alreadyServed) {
      job.note = `${installedName} 已由已安装条目提供，仅更新包本身，不重复注册`
      const declaredServed = await declareProfileDependency(profileDir, installedName)
      if (declaredServed.changed) job.declared = declaredServed.version
      if (declaredServed.lockSynced === false && declaredServed.lockNote !== null) job.lockNote = declaredServed.lockNote
      job.status = 'done'
      return
    }
    const entryId = deriveEntryId(installedName, taken)
    await appendInsert(patchPath, entryId, installedName)
    job.entryId = entryId
    const declared = await declareProfileDependency(profileDir, installedName)
    if (declared.changed) job.declared = declared.version
    if (declared.lockSynced === false && declared.lockNote !== null) job.lockNote = declared.lockNote
    job.status = 'done'
  } catch (error) {
    job.status = 'failed'
    job.error = error instanceof Error ? error.message : String(error)
  } finally {
    job.finishedAt = Date.now()
  }
}

/** 用 corepack pnpm 移除包（与安装同一管理器与凭据抑制环境）。
 * 注意：pnpm remove 不支持 --registry 选项，去掉避免静默失败。 */
async function pnpmRemove(profileDir, packageName) {
  const args = ['remove', packageName]
  const opts = {
    cwd: profileDir,
    timeout: 120000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, COREPACK_NPM_REGISTRY: 'https://registry.npmmirror.com', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  }
  // 与 pnpmInstall 同一套跨平台定位（Linux 的 corepack 不在 <node bin>/node_modules 下）
  await runPnpmWithFallback(args, { execOpts: opts })
}

/** 读取用户额外 bundle（非官方模板）的补丁插入行 id 与包名，用于"额外插件"判定。 */
async function readExtraBundleRows(profileDir) {
  const rows = new Set()
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    const bundles = manifest.dsh?.profile?.bundles ?? []
    for (const pkg of bundles) {
      if (DEFAULT_BUNDLES.includes(pkg)) continue
      try {
        const pk = resolvePackageJson(pkg, profileDir)
        const dir = dirname(pk ?? join(profileDir, 'node_modules', ...String(pkg).split('/'), 'package.json'))
        const text = await readFile(join(dir, 'cordis.patch.yml'), 'utf8')
        const lines = text.split(/\r?\n/u)
        let inInsert = false
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]
          if (/^- insert:\s*$/u.test(line)) {
            inInsert = true
            continue
          }
          if (/^- /u.test(line)) inInsert = false
          if (!inInsert) continue
          const idMatch = line.match(/^ {4}- id: ([A-Za-z0-9_.-]+)\s*$/u)
          if (!idMatch) continue
          rows.add(idMatch[1])
          const nameMatch = (lines[index + 1] ?? '').match(/^ {6}name: ['"]([^'"]+)['"]\s*$/u)
          if (nameMatch) rows.add(nameMatch[1])
        }
      } catch {}
    }
  } catch {}
  return rows
}
export { runInstallJob, pnpmRemove, readExtraBundleRows, cleanupAttemptedCandidates, aiConsentFailureText, tryCandidateChannels, channelImpls, RELEASE_CHANNEL_BUDGET }
