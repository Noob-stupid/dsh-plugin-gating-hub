// L1 · domain —— install-channels.js（单个候选包的**通道尝试序列** + 版本闸；2026-10-18 从 install-job.js 搬出）
//
// 为什么单独成模块：install-job.js 贴着 600 行架构棘轮（tests/test-architecture-guard.mjs），而
// "一个候选包要按什么顺序试哪些通道、每条守卫为什么成立"本来就是一块自洽的策略。搬移只搬移未改逻辑
// （注释、判据、文案逐字保留），install-job.js 继续 re-export `tryCandidateChannels` 与
// `RELEASE_CHANNEL_BUDGET` —— **导出名与调用点一个字都没变**。
//
// 本轮（0.5.87）在这块里只改了一件事，见下方 ★ 版本号的两处注释：
//   ① 版本号（`job.version`）必须一路传到**按名下载**的通道（curl 的两条腿、pnpm 的两次重试）；
//   ② 通道说"装上了"之后要**核对落地版本**（版本闸）—— 落地版本 ≠ 点名版本不算成功。
import { cleanupStalePackageDir } from '../infra/fsx.js'
import { alreadyInstalledTarget } from './install-verify.js'
import { noteChannel, tryGitChannel } from './git-channel.js'
import { retryPnpmOnce } from './install-diagnose.js'
import { targetVersionOf, versionMissOf, versionMissText } from './install-version.js'
import { tryPresetSourceChannel } from './preset-source.js'

/** release 通道的候选预算（issue #3）：release 通道现在按包名反查发布仓库，**每个候选**至少一次
 * `releases?per_page=10` 调用（第一梯队仓库没命中还要多试几个候选仓库），而候选可能有十几个
 * （聚合仓库懒惰展开后最多 19 个）——不封顶会把 8 分钟的作业时间预算吃光。
 * 只给前 N 个候选扫 release；排在后面的候选仍照走 curl/并行竞速（按包名施工，代价小）。 */
const RELEASE_CHANNEL_BUDGET = 3

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
async function tryCandidateChannels({ job, ch, name, profileDir, registries, repoChannelAllowed, budget, baseUrl = null, expanded = false, deadline = null, expand = null, sourceDeps = {} }) {
  const installSpec = (typeof job?.version === 'string' && job.version !== '' && name === job.packageName)
    ? `${name}@${job.version}`
    : name // ★ 0.5.81：规格与身份分离 —— name 仍是身份；点名包+指定版本时规格才带 @version
  // ★ 0.5.87 改错（真机 2026-10-18）：`installSpec` 只交给了 pnpm；**curl 的两条腿拿的都是裸包名**，
  //   于是"按 dist-tags.latest 下载"——而该 tag 在镜像上可能恰恰是**旧版**（真机
  //   @deepseek-ai/dsh-experimental-auto-review 的 latest = 0.1.6-alpha.1，而目标 0.2.1-rc.2）。
  //   结果：旧版被原样铺回去，作业却报"更新成功"。版本号必须传到底（curlManualInstall 的 exactVersion）。
  const exactVersion = targetVersionOf(job, name)
  // 声明行的目标 profile（0.5.28）：框架 0.1.7-rc.x 起预设不再靠目录发现，装配后必须往这个 profile 的补丁写 `preset-<id>` 行，否则用户看不见（见 preset-declare.js 顶部）。
  // 注：0.5.87 搬出时删掉了这里的 `const patchPath = join(profileDir, 'cordis.patch.yml')` ——
  // 它是一个**从未被读过**的局部量（预设声明早已改由 preset-declare.js 自己算路径），删掉不改任何行为。
  let installedName = null
  let lastError = null
  // 哪个通道声称装上了（只用于版本闸的如实告知，不参与任何判定）
  let lastChannel = null
  // 0.5.41 接线：这次成功装上的**来源**（`{ spec, origin, kind }`）—— 取样通道（curl tarball / GitHub
  // release 资产）知道真实下载地址，收口那一步据此走 `pnpm add <spec>` 真装；registry/git 通道都不填。
  let source = null
  // 加法优化：包已在 node_modules 且名字匹配时，不再重复安装/触发 EPERM，直接进入启用流程
  // （2026-09-27 搬进 install-verify.js#alreadyInstalledTarget；install-job.js 当时贴着 600 行架构硬顶）
  const already = alreadyInstalledTarget(profileDir, name, job)
  if (already !== null) {
    job.curlNote = already
    // ★ 0.5.87：这条短路（`update !== true` 且包已在盘上）同样要过版本闸 —— 请求若点名了版本、
    //   而盘上不是那一版，"已检测到本地已安装"就不能被当成"更新完成"。
    const missText = gateVersion(job, profileDir, name, 'local')
    if (missText === null) return { installedName: name, lastError: null }
    return { installedName: null, lastError: new Error(missText) }
  }
  // 通道 0：并行竞速（pnpm 与 curl 同时启动，先成功者生效；失败方 abort，不影响后续串行通道）——守卫①
  {
    try {
      // ★ 0.5.87：竞速里的 pnpm 腿要**带版本**的规格，curl 腿要**裸包名 + 目标版本**
      //   （旧代码把带 `@版本` 的规格同时塞给 curl —— 对 curl 那是非法包名，永远 404）
      const raced = await ch.raceInstallChannels(profileDir, installSpec, registries, {}, { packageName: name, exactVersion })
      if (raced) {
        installedName = name
        lastChannel = raced.channel ?? 'race'
        if (raced.channel === 'curl') {
          const racedInfo = raced.info
          try {
            const stillMissing = await ch.backfillMissingDeps(profileDir, racedInfo.missingDeps, registries)
            job.curlNote = `已通过并行 curl 通道安装 v${racedInfo.version}${stillMissing.length > 0 ? `（依赖仍未补齐：${stillMissing.join('、')}，网络恢复后建议重新安装）` : '（捆绑依赖已补齐）'}`
          } catch (backfillError) {
            // 包已装好：补齐依赖失败只影响提示，绝不能因此把这次安装判成失败
            job.curlNote = `已通过并行 curl 通道安装 v${racedInfo.version}（捆绑依赖补齐失败：${backfillError instanceof Error ? backfillError.message : String(backfillError)}；网络恢复后建议重新安装）`
            noteChannel(job, `并行 curl 通道的依赖补齐失败（安装本身已成功）：${backfillError instanceof Error ? backfillError.message : String(backfillError)}`)
          }
          if (racedInfo.boxNote) job.curlNote += `（盒子验证：${racedInfo.boxNote}）`
          job.integrity = racedInfo.integrity ?? null // ④ 下载物摘要校验结果（加法；见 install-verify.js）
          // 0.5.41：curl tarball 是**取样通道**（物是解压铺进去的，不是包管理器装的）——
          // 真实来源规格（registry tarball URL）带回收口。registry 可解析时收口仍写版本号（不倒退）。
          source = { spec: racedInfo.sourceSpec ?? null, origin: 'sampled', kind: 'registry-tarball' }
        }
      }
    } catch (raceError) {
      lastError = raceError
      noteChannel(job, `并行竞速通道异常（已继续尝试后续串行通道）：${raceError instanceof Error ? raceError.message : String(raceError)}`)
    }
  }
  // 通道 1..n：配置的软件源依次尝试（每源 90 秒封顶）
  let pnpmError = null
  for (let ri = 0; ri < registries.length && installedName === null; ri += 1) {
    try {
      await ch.pnpmInstall(profileDir, installSpec, registries[ri])
      installedName = name
      lastChannel = 'pnpm'
      break
    } catch (error) { lastError = error; pnpmError = error }
  }
  if (installedName === null) {
    // 通道 n+1：curl 手动安装（node 网络黑洞时 pnpm 下载卡死、curl 可用）——下载 registry tarball
    // 解压到 node_modules，零依赖包可完整安装。守卫①：不判 expanded。
    try {
      // ★ 0.5.87 改错（真机事故的**决定性**那一行）：这里过去只传裸包名，curlManualInstall 于是取
      //   `dist-tags.latest` —— 镜像上的 latest 是旧版时，装完就是**降级/原地不动**，而作业报成功。
      //   现在把点名版本作为 exactVersion 传进去（没点名时仍是 null ⇒ 既有行为一字不变）。
      const info = await ch.curlManualInstall(profileDir, name, registries, null, exactVersion)
      installedName = name
      lastChannel = 'curl'
      const stillMissing = await ch.backfillMissingDeps(profileDir, info.missingDeps, registries)
      job.curlNote = `已通过 curl 通道安装 v${info.version}${stillMissing.length > 0 ? `（依赖仍未补齐：${stillMissing.join('、')}，网络恢复后建议重新安装）` : '（捆绑依赖已补齐）'}`
      if (info.boxNote) job.curlNote += `（盒子验证：${info.boxNote}）`
      job.integrity = info.integrity ?? null // ④ 下载物摘要校验结果（加法；见 install-verify.js）
      // 0.5.41：同上（取样通道 ⇒ 带真实 tarball URL 回去真装）
      source = { spec: info.sourceSpec ?? null, origin: 'sampled', kind: 'registry-tarball' }
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
        lastChannel = 'release'
        const stillMissing = await ch.backfillMissingDeps(profileDir, info.missingDeps, registries)
        // 如实记录来源：哪个仓库的哪条 release 的哪个资产（issue #3 明确要求，面板直接展示这句话）
        const from = typeof info.sourceNote === 'string' && info.sourceNote !== '' ? `（来源：${info.sourceNote}）` : ''
        job.curlNote = `已通过 GitHub release 通道安装 v${info.version ?? '?'}${from}${stillMissing.length > 0 ? `（依赖仍未补齐：${stillMissing.join('、')}，网络恢复后建议重新安装）` : '（捆绑依赖已补齐）'}`
        if (info.boxNote) job.curlNote += `（盒子验证：${info.boxNote}）`
        // 0.5.41 接线（**本轮的核心**）：GitHub release 资产（tarball URL）是取样通道 —— 把真实下载
        // 地址带回给收口，由 `pnpm add <url>` 真装（依赖与 peer 交给包管理器，与官方 dsh plugin add 同效）。
        source = { spec: info.sourceSpec ?? null, origin: 'sampled', kind: 'github-release' }
      } catch (ghError) {
        lastError = ghError
      }
    } else {
      // 预算用尽（批次 A-⑤）：原因**总是**记在 job 上供面板显示（旧代码只在 lastError === null 时写，用户看不出）
      noteChannel(job, `release 通道因预算跳过（本作业只对前 ${RELEASE_CHANNEL_BUDGET} 个候选做按包名反查+release 扫描）`)
      if (lastError === null) lastError = new Error(`release 通道候选预算已用尽（本作业只对前 ${RELEASE_CHANNEL_BUDGET} 个候选做按包名反查+release 扫描）`)
    }
  }
  // 懒惰展开（批次 A-③，2026-09-27 搬家）：**registry 类通道全部失败之后、git 通道之前**。
  // 旧顺序是"所有通道（含 git）都失败 → 才展开子包"：对"根包 private、未发布到 npm"的仓库
  // （真机 zhu1090093659/dsh-web）就是 registry 404 → 直接去 clone 那个 429 MB 的巨仓
  // （ghproxy 上 git 协议 0 B/s，白等且注定失败），而真正能装的聚合子包 @linxin666/dsh-web-all
  // （5.97 MB）连一次机会都没有。expand() 返回新增候选数；展开失败只记备注，绝不短路。
  if (installedName === null && expanded === false && typeof expand === 'function') {
    try {
      const added = await expand()
      if (added > 0) noteChannel(job, `registry 通道未命中，已自动展开仓库子包：新增 ${added} 个候选`)
    } catch (error) {
      noteChannel(job, `自动展开仓库子包失败（继续走后续通道）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (installedName === null) {
    // 通道 n+1c（批次 D-③，2026-09-27 加法）：**预设型子包的源码装配** —— 真机 dsh-routing-suite 的第三件
    // dsh-router-standard 只存在于仓库源码里（npm 双 404、release 无资产），按包名的通道全试完才轮到它。
    const preset = await tryPresetSourceChannel({ job, name, source: job.source, deps: sourceDeps })
    if (preset.installed === true) { job.presetDone = true; job.presetNote = preset.note; installedName = name; lastChannel = 'preset-source' } else if (preset.error !== null && preset.error !== undefined) lastError = preset.error
  }
  if (installedName === null) {
    // 通道 n+2：git 通道（GitHub 走加速代理+直连；Gitee 走对应平台）——守卫③
    // 2026-09-27：实现搬进 domain/git-channel.js（独立预算 + 不得超过作业剩余预算；
    // install-job.js 有 600 行硬顶，见 test-architecture-guard.mjs），此处只保留调用与错误归并。
    const git = await tryGitChannel({ job, ch, name, profileDir, repoChannelAllowed, expanded, budget, deadline })
    installedName = git.installedName
    if (git.installedName !== null) lastChannel = 'git'
    if (git.lastError !== null) lastError = git.lastError
  }
  // ③ 失败分类 → 只对网络类超时用更长超时定向重试**一次**；其余分类只写 job.diagnosis 提示（见 install-diagnose.js）
  if (installedName === null && pnpmError !== null) {
    // ★ 0.5.87：重试也必须带版本（旧代码传裸包名 ⇒ 重试装回 latest＝旧版，却报"重试成功"）
    const retry = await retryPnpmOnce({ ch, profileDir, name, spec: installSpec, registries, pnpmError, job, baseTimeoutMs: 90000 })
    installedName = retry.installedName ?? installedName
    if (retry.installedName != null) lastChannel = 'pnpm-retry'
    if (retry.error != null) lastError = retry.error
  }
  if (installedName !== null) {
    // ★ 0.5.87 版本闸（真机 2026-10-18 的根因缺口）：通道说"装上了"不算数，
    //   **落地版本 == 请求点名的版本**才算数。不相等 ⇒ 本次通道按"没装成"处理，并在 job.versionMiss
    //   上留下如实结论；一个通道都不达标时由 install-job.js 如实失败
    //   （**不清场**：清场会把用户正在用的旧版本删掉 —— 见那里的注释）。
    //   没点名版本（`job.version` 为空）时 versionMissOf 恒 null ⇒ 既有流程一字不变。
    const missText = gateVersion(job, profileDir, installedName, lastChannel)
    if (missText === null) return { installedName, lastError, source }
    installedName = null
    lastError = new Error(missText)
  }
  // Windows 原子替换失败（陈旧目录 / _tmp_ 残留）是 EPERM 类错误的根因：
  // 清理后用主源重试一次（把 AI 人工修复经验自动化，减少 AI 兜底触发）
  if (/EPERM|EACCES|rename/i.test(String(lastError?.message ?? ''))) {
    const cleaned = cleanupStalePackageDir(profileDir, name)
    if (cleaned > 0) {
      try {
        // ★ 0.5.87：同上 —— 重试一次也要带版本，否则等于"用 latest 覆盖掉用户点名的那一版"
        await ch.pnpmInstall(profileDir, installSpec, registries[0])
        // 这条重试同样是"通道声称装上了"，一样要过版本闸（口径统一，不留第二条谎报路径）
        const missText = gateVersion(job, profileDir, name, 'pnpm-retry')
        if (missText === null) {
          installedName = name
          lastChannel = 'pnpm-retry'
        } else {
          lastError = new Error(missText)
        }
      } catch (error) {
        lastError = error
      }
    }
  }
  return { installedName, lastError }
}

/** 版本闸的**唯一执行点**（通道声称"装上了"之后都要过一遍）：达标返回 null；
 * 不达标把结构化结论记在 `job.versionMiss` 上、把同一句话记进通道备注，并返回那段文案。
 * 预设源码装配（`job.presetDone`）刻意豁免：那条路本来就没有 node_modules 副本
 * （见 preset-in-package.js —— 写补丁行/声明依赖会让补丁行指向无入口模块）。 */
function gateVersion(job, profileDir, name, channel) {
  const miss = job?.presetDone === true ? null : versionMissOf(profileDir, name, job, channel)
  if (miss === null) return null
  job.versionMiss = miss
  const text = versionMissText(miss)
  noteChannel(job, text)
  return text
}

export { tryCandidateChannels, RELEASE_CHANNEL_BUDGET }
