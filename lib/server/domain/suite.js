// L1 · domain —— suite.js（聚合套装：.gitmodules 解析 / 预设目录发现 / 包入口存在性；分层 Step 5 从 lib/index.js 搬出，只搬移未改逻辑。注：runSuiteInstallJob 含 ctx，留到 Step 8）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md 三

import { readFileSync, existsSync, rmSync, readdirSync, mkdirSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { appendInsert } from './patch.js'
import { gitCloneRepo } from './repoland.js'
import { deriveEntryId, listEntries } from './runtime.js'
import { noteChannel } from './git-channel.js'
import { orderedRegistries, readSources } from './sources.js'
import { copyTree } from '../infra/fsx.js'
import { GITHUB_API, META_BUDGET_MS, curlJson, fetchJsonUrl, githubJson, looksLikeGitmodules, rawTextWithFallback } from '../infra/http.js'
import { dshHome, findPatchPath } from '../infra/paths.js'

/** 解析 .gitmodules：返回 [{name, path, url}]（submodule 套装识别用）。 */
function readGitmodules(dir) {
  const file = join(dir, '.gitmodules')
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  const subs = []
  let cur = null
  for (const line of text.split(/\r?\n/u)) {
    const m = line.match(/^\[submodule\s+"([^"]+)"\]/u)
    if (m) {
      cur = { name: m[1], path: '', url: '' }
      subs.push(cur)
      continue
    }
    if (!cur) continue
    const pm = line.match(/^\s*path\s*=\s*(.+)$/u)
    if (pm) { cur.path = pm[1].trim(); continue }
    const um = line.match(/^\s*url\s*=\s*(.+)$/u)
    if (um) cur.url = um[1].trim()
  }
  return subs.filter((s) => s.path !== '' && s.url !== '')
}

/** 递归找含 preset.yml + agent.cordis.yml 的 agent 预设目录（深度 ≤ maxDepth）。 */
function findPresetDirs(root, maxDepth = 2) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    if (existsSync(join(dir, 'preset.yml')) && existsSync(join(dir, 'agent.cordis.yml'))) {
      out.push(dir)
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      walk(join(dir, e.name), depth + 1)
    }
  }
  walk(root, 0)
  return out
}

/** 包是否有构建产物（main/module/exports/bin 或 lib/index.js 任一存在）。
 * 排除类型声明（.d.ts）与 package.json 自身——exports 的 "./package.json" 是合法导出但不是运行时入口。 */
function packageEntryExists(dir, pkg) {
  const isEntry = (p) => typeof p === 'string' && p !== '' && !p.endsWith('.d.ts') && p !== './package.json' && p !== 'package.json'
  const candidates = []
  if (isEntry(pkg.main)) candidates.push(pkg.main)
  if (isEntry(pkg.module)) candidates.push(pkg.module)
  if (isEntry(pkg.bin)) candidates.push(pkg.bin)
  if (pkg.bin && typeof pkg.bin === 'object') Object.values(pkg.bin).forEach((v) => { if (isEntry(v)) candidates.push(v) })
  if (pkg.exports && typeof pkg.exports === 'object') {
    const collect = (v) => {
      if (typeof v === 'string') { if (isEntry(v)) candidates.push(v) }
      else if (v && typeof v === 'object') Object.values(v).forEach(collect)
    }
    collect(pkg.exports)
  }
  candidates.push('lib/index.js', 'dist/index.js')
  return candidates.some((c) => existsSync(join(dir, c)))
}

/** 套装探测（唯一入口）：main → master，且**必须内容像 .gitmodules**（含 [submodule "x"] 段）才算套装。
 * 判据是内容、不是"探测非 null"：2026-09-19 用户反馈装 dsh-whale-widget 被判成 submodule 套装置仓库、
 * clone 后报「未找到 .gitmodules」——根因就是代理/CDN 对**不存在的文件**回 2xx（空 body 也算"读到"）。 */
async function probeGitmodules(repo) {
  const main = await rawTextWithFallback(repo, 'main', '.gitmodules')
  if (looksLikeGitmodules(main)) return main
  const master = await rawTextWithFallback(repo, 'master', '.gitmodules')
  return looksLikeGitmodules(master) ? master : null
}

/** 安装类型决策（纯函数，单测覆盖）：`.gitmodules` 的**内容**说了算——
 * 显式 suite 请求若探测内容不像 .gitmodules 也回落普通插件安装（前端标记可能来自 24h 缓存的误判，
 * 不能当判据）；技能请求不受影响。 */
function resolveInstallKind(requestKind, probeText) {
  if (requestKind === 'skill') return 'skill'
  return looksLikeGitmodules(probeText) ? 'suite' : 'plugin'
}

/** 仓库元数据（默认分支）探测：githubJson 与 curlJson 竞速 + META_BUDGET_MS 降级（黑洞期不卡 40s）。
 * 0.5.19 从 install-job.js 原样搬来（**只搬移，表达式一字未改**）：套装判定前要先读根包名
 * （见 shouldRunSuiteInstall），这次探测的结果缓存在 job.repoMeta 上供下游复用，同一个作业不重复联网。
 * 8s 而非旧值 3s：IPv6 无路由的环境里单条通道就要 5.4s，3s 预算必输 → branch 恒为 main，
 * 默认分支为 dev 的仓库会取错分支（2026-09-20 另一位用户实测）。 */
async function fetchRepoMeta(repo) {
  const meta = await Promise.race([
    Promise.any([
      githubJson(`${GITHUB_API}/repos/${repo}`),
      curlJson(`${GITHUB_API}/repos/${repo}`, 12000, {}, { ipv4: true }),
    ]),
    new Promise((resolve) => setTimeout(() => resolve(null), META_BUDGET_MS)),
  ]).catch(() => null)
  return meta ?? null
}

/** 这个包名在 registry 上**确实存在**吗？只有确定性命中才算"存在"：404 / 超时 / 不可达一律当"查不到"。
 * 口径必须这么窄的理由：查不到不能推翻 .gitmodules 判据 —— 网络问题不该把套装安装变成插件安装。
 * 用既有 npm 元数据能力（与 market.js 读 packument 同一套：配置里的软件源顺序 + fetchJsonUrl），
 * 最多看前 2 个源、每源 6 秒封顶；测试用 probes.namePublished 替换（见 test-suite-fallback.mjs）。 */
async function namePublishedOnRegistry(name) {
  const encoded = name.startsWith('@')
    ? `@${encodeURIComponent(name.slice(1).split('/')[0])}%2f${encodeURIComponent(name.split('/').slice(1).join('/'))}`
    : encodeURIComponent(name)
  for (const reg of orderedRegistries(readSources()).slice(0, 2)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const data = await fetchJsonUrl(`${reg}/${encoded}`, 6000)
      const hasLatest = typeof data?.['dist-tags']?.latest === 'string'
      const hasVersions = data !== null && typeof data === 'object' && data.versions !== null && typeof data.versions === 'object' && Object.keys(data.versions).length > 0
      if (hasLatest || hasVersions) return true
    } catch {}
  }
  return false
}

/** 套装判定（唯一入口，0.5.19 改错）：**先看根包是否已发布，再决定要不要按 .gitmodules 走套装**。
 * 真机事故（2026-09-27，用户点装 zhu1090093659/dsh-web 全家桶）：市场卡片点「添加到本地」只带 owner/repo、
 * 不带包名 → candidates=[] → 旧流程直接探 .gitmodules（该仓库根目录确实有一份）→ 第一步就 clone 整个仓库
 * （429 MB），而真正能装上的子包 @linxin666/dsh-web-all（5.97 MB）根本没机会被尝试。
 * 判据顺序（每一步都只做"确认"，不做"猜测"）：
 *   ① 读根 package.json（下游本来也要读，结果缓存进 job 复用）→ 有 name 且 registry 上存在 → **插件通道**；
 *   ② 否则按 .gitmodules **内容**判（内容不像 gitmodules 就不是套装 —— 2026-09-19 事故的口径不变）；
 *   ③ 判成套装后再问一句 registry：根包没发布、但**子包**已发布（真机 dsh-web 就是这种）→ 插件通道。
 *      理由：仓库里有已发布的可安装单元时，按包名装才是"装得上 + 能随 lock 更新"的那条路；
 *      子包也都没发布（子模块是纯 git 组件）→ 照旧走套装装配，能力一点没少。
 * 返回 true = 走套装安装。副作用：job.repoMeta / job.defaultBranch / job.rootPkgProbe / job.subpackageProbe
 * 缓存本次探测结果，下游候选循环直接复用（install-job.js 里带 `??` 的那几行）。 */
async function shouldRunSuiteInstall(job, probes = {}) {
  // 同一作业只判一次：缓存下来后 install-job（判定套装分支）与套装作业入口（显式「安装套装」）
  // 共用同一个结论，第二次调用零联网 —— 见 runSuiteInstallJob 顶部的同一道判据。
  if (job.suiteDecision !== undefined) return job.suiteDecision
  const decide = (value, reason) => {
    job.suiteDecision = value
    job.suiteDecisionReason = reason
    return value
  }
  if (job.kind === 'skill') return decide(false, '技能请求不走套装通道')
  const gmProbe = typeof probes.probeGitmodules === 'function' ? probes.probeGitmodules : probeGitmodules
  const meta = await fetchRepoMeta(job.repo).catch(() => null)
  job.repoMeta = meta
  const branch = meta?.default_branch ?? 'main'
  job.defaultBranch = branch
  let root = null
  if (typeof probes.fetchRepoPackageEx === 'function') {
    // 探测异常不改变结论：回落成"按 .gitmodules 判"（旧行为），不让一次探测把安装打挂
    try { root = await probes.fetchRepoPackageEx(job.repo, branch) } catch { root = null }
    job.rootPkgProbe = root
  }
  const rootPkg = root !== null && root !== undefined && root.pkg !== null && typeof root.pkg === 'object' ? root.pkg : null
  const name = rootPkg !== null && typeof rootPkg.name === 'string' ? rootPkg.name : ''
  const published = async (pkgName) => (typeof probes.namePublished === 'function'
    ? (await probes.namePublished(pkgName)) === true
    : namePublishedOnRegistry(pkgName))
  if (name !== '' && (await published(name)) === true) {
    job.rootPublished = name
    noteChannel(job, `根包 ${name} 已发布到 npm：优先插件通道（不判套装、不克隆仓库）`)
    return decide(false, `根包 ${name} 已发布到 npm`)
  }
  if (resolveInstallKind(job.kind, await gmProbe(job.repo)) !== 'suite') return decide(false, '仓库根目录没有有效的 .gitmodules（不是 submodule 套装仓库）')
  if (name !== '' && typeof probes.subpackageCandidates === 'function') {
    let subs = []
    try { subs = await probes.subpackageCandidates(job.repo, branch) } catch { subs = [] }
    if (Array.isArray(subs) && subs.length > 0) {
      job.subpackageProbe = subs
      for (const cand of subs.slice(0, 3)) {
        // eslint-disable-next-line no-await-in-loop
        if ((await published(cand)) === true) {
          job.subpackagePreferred = cand
          noteChannel(job, `根包未发布到 npm，但子包 ${cand} 已发布：优先插件通道（跳过套装克隆，避免白拉整个仓库）`)
          return decide(false, `根包未发布到 npm，但子包 ${cand} 已发布到 npm`)
        }
      }
    }
  }
  return decide(true, '')
}

/** 套装安装（submodule 聚合仓库）：照仓库 install.ps1/README 语义——
 * clone 套装 → 手动镜像拉取子模块 → 按类型装配（bundle 插件含 Release tgz 兜底 / 普通插件 / 技能 / agent 预设）。
 * 不执行第三方脚本本体（安全护栏：脚本型只读语义不运行）。 */
async function runSuiteInstallJob(job, ports, deps = {}) {
  // 根克隆的实现可注入（测试注入缝，沿用 runInstallJob 的 deps 风格：生产调用方不传第三个参数）
  const gitClone = typeof deps.gitClone === 'function' ? deps.gitClone : gitCloneRepo
  // 0.5.19：套装作业入口的**同一道判据** —— 前端 hasSuite=true 的卡片点「添加到本地」时发的是
  // kind=suite，路由会直接调到这里（routes/install.js 的 runSuiteThenFallback），根本不经过 install-job
  // 的候选循环；真机 dsh-web 的 429 MB 就是这条路拉起来的。判定结论缓存在 job.suiteDecision 上：
  // install-job 已经判过（并注入过探测桩）时这里零联网直接复用；路由调用时由它把真实探测传进来。
  const decided = job.suiteDecision === undefined
    ? await shouldRunSuiteInstall(job, deps.probes ?? {})
    : job.suiteDecision
  if (decided === false) {
    job.stage = 'detecting'
    return { notASuite: true, reason: `${job.suiteDecisionReason ?? '该仓库有已发布到 npm 的可安装包'}，已自动回落普通插件安装` }
  }
  const tmpDir = join(tmpdir(), `dsh-suite-${job.id}-${Date.now()}`)
  const report = []
  try {
    job.stage = 'preparing'
    mkdirSync(tmpDir, { recursive: true })
    try {
      await gitClone(job.repo, tmpDir, job.source)
    } catch (cloneError) {
      // 0.5.19（改错）：套装仓库**克隆失败**不再把作业判 failed。
      // 旧代码整个函数只有一个 try/catch → 根克隆一失败就 job.status='failed'（真机 dsh-web：429 MB 巨仓、
      // ghproxy 的 git 协议 0 B/s，必然失败），而 notASuite（把决定权交回普通通道）**只在"克隆成功但
      // .gitmodules 为空"时才返回** → 克隆失败等于没有任何回落，用户只看到一个失败的任务。
      // 克隆失败只证明"这条路走不通"，不证明"装不上"：回落普通通道（npm → Release → git，按包名施工）。
      job.stage = 'detecting'
      return {
        notASuite: true,
        reason: `套装仓库克隆失败（${cloneError instanceof Error ? cloneError.message : String(cloneError)}），已自动回落普通插件安装`,
      }
    }
    const subs = readGitmodules(tmpDir)
    if (subs.length === 0) {
      // 探测与仓库实际内容不符（假阳性 / 仓库已重构）：**不报失败**，把决定权交回调用方
      // 回落普通插件安装（npm → Release → git 规格），用户不该因为一次误判装不上插件。
      job.stage = 'detecting'
      return { notASuite: true }
    }
    job.stage = 'detecting'
    const patchPath = findPatchPath(ports)
    const profileDir = dirname(patchPath)
    // 手动拉取子模块（git 的 insteadOf 重写对 submodule 不生效，按镜像 URL 逐个 clone）
    // 套装级进度：套装动辄几分钟（clone 每个子模块 + 逐个装配），面板要能显示"第 i/n 个子模块"
    for (let si = 0; si < subs.length; si += 1) {
      const sub = subs[si]
      job.suiteProgress = { phase: 'clone', index: si + 1, total: subs.length, name: sub.name, done: false }
      const subRepo = sub.url.replace(/^https?:\/\/[^/]+\//u, '').replace(/\.git$/u, '')
      const dest = join(tmpDir, sub.path)
      try {
        mkdirSync(dirname(dest), { recursive: true })
        await gitCloneRepo(subRepo, dest, sub.url.includes('gitee.com') ? 'gitee' : 'github', 120000)
      } catch (error) {
        report.push({ component: sub.name, type: 'clone', ok: false, note: `子模块拉取失败：${error.message}` })
      }
    }
    for (let pi = 0; pi < subs.length; pi += 1) {
      const sub = subs[pi]
      job.suiteProgress = { phase: 'assemble', index: pi + 1, total: subs.length, name: sub.name, done: false }
      const subDir = join(tmpDir, sub.path)
      if (!existsSync(subDir)) continue
      const subRepo = sub.url.replace(/^https?:\/\/[^/]+\//u, '').replace(/\.git$/u, '')
      let pkg = null
      try {
        const pkgPath = join(subDir, 'package.json')
        if (existsSync(pkgPath)) pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      } catch {}
      let handled = false
      // a. bundle 型插件（如 injector）：自动装配默认**跳过**并给出官方装配指引——
      // 第三方 bundle 需与当前 DSH 版本严格兼容（peer 依赖、client inject 模块、patch 语义），
      // 自动写入 bundles 曾导致启动崩溃；预设/技能/普通插件不受影响。
      if (pkg && typeof pkg.name === 'string' && pkg.dsh?.bundle) {
        report.push({ component: sub.name, type: 'bundle', ok: false, note: `${pkg.name} 是 bundle 型插件，自动装配已跳过（避免 bundle 不兼容导致启动失败）；请按详情面板「官方安装方式」命令手动装配（clone 套装后运行 install.ps1，或构建后加入 profile 的 dsh.profile.bundles）` })
        handled = true
      }
      // b. 技能（根或第一层子目录 SKILL.md）
      if (!handled) {
        let skillDir0 = ''
        if (existsSync(join(subDir, 'SKILL.md'))) {
          skillDir0 = ''
        } else {
          let found = null
          try {
            found = readdirSync(subDir, { withFileTypes: true })
              .find((d) => d.isDirectory() && existsSync(join(subDir, d.name, 'SKILL.md')))
          } catch {}
          skillDir0 = found ? found.name : null
        }
        if (skillDir0 !== null) {
          const skillsRoot = join(dshHome(), 'skills')
          mkdirSync(skillsRoot, { recursive: true })
          const dest = join(skillsRoot, sub.name)
          if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
          copyTree(join(subDir, skillDir0), dest)
          report.push({ component: sub.name, type: 'skill', ok: true, note: `已安装技能 ~/.dsh/skills/${sub.name}` })
          handled = true
        }
      }
      // c. agent 预设（含 preset.yml + agent.cordis.yml 的目录；预设优先于普通 npm 包——
      // 如 dsh-router-standard 既是 npm 包又带预设目录，install.ps1 意图是复制预设）
      const presets = findPresetDirs(subDir, 2)
      for (const p of presets) {
        const pname = basename(p)
        const presetsRoot = join(dshHome(), '.agent-presets')
        mkdirSync(presetsRoot, { recursive: true })
        const dest = join(presetsRoot, pname)
        if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
        copyTree(p, dest)
        report.push({ component: sub.name, type: 'preset', ok: true, note: `已安装预设 ${pname}（新建会话可选）` })
        handled = true
      }
      // d. 普通 npm 插件（无 bundle 且无预设/技能）
      if (!handled && pkg && typeof pkg.name === 'string') {
        const target = join(profileDir, 'node_modules', pkg.name)
        if (existsSync(target)) rmSync(target, { recursive: true, force: true })
        mkdirSync(dirname(target), { recursive: true })
        copyTree(subDir, target)
        const taken = new Set(listEntries(ports).map((e) => e.rowId))
        const entryId = deriveEntryId(pkg.name, taken)
        await appendInsert(patchPath, entryId, pkg.name)
        // 记下套装装配出的包名：它们是 copyTree 铺进去的、不在 pnpm-lock.yaml 里，交给调用方统一对账
        if (!Array.isArray(job.suiteInstalled)) job.suiteInstalled = []
        if (!job.suiteInstalled.includes(pkg.name)) job.suiteInstalled.push(pkg.name)
        report.push({ component: sub.name, type: 'plugin', ok: true, note: `已安装 ${pkg.name}（HMR 生效）` })
        handled = true
      }
      if (!handled) {
        report.push({ component: sub.name, type: 'unknown', ok: false, note: '未识别组件类型（无 package.json / SKILL.md / 预设）' })
      }
    }
    job.status = 'done'
    job.stage = 'done'
    job.suiteReport = report
    // 装配全部走完：进度标记完成（保留最后一轮的 i/n 与名字，前端显示"已完成 n/n 个子模块"）
    if (job.suiteProgress) job.suiteProgress = { ...job.suiteProgress, done: true }
    const okCount = report.filter((r) => r.ok).length
    const failCount = report.filter((r) => !r.ok).length
    const bundleCount = report.filter((r) => r.type === 'bundle' && r.ok).length
    job.suiteNote = `套装安装完成：${okCount} 个组件成功${failCount > 0 ? `，${failCount} 个失败（详见报告）` : ''}${bundleCount > 0 ? '。bundle 组件需重启服务生效' : ''}；预设需新建会话时选择。`
  } catch (error) {
    job.status = 'failed'
    job.error = error instanceof Error ? error.message : String(error)
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    job.finishedAt = Date.now()
  }
}
export { readGitmodules, findPresetDirs, packageEntryExists, runSuiteInstallJob, probeGitmodules, resolveInstallKind, fetchRepoMeta, shouldRunSuiteInstall }
