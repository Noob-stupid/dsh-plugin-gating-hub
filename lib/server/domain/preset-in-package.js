// L1 · domain —— preset-in-package.js（批次 D-⑥：**预设随包分发** —— 装出来的包体里带 agent.cordis.yml 时按预设装配）
//
// 真机事故（2026-09-27，官方桌面端实例、0.5.25 实测，卡片"子包"列表第三件的等价调用）：
//   POST /install {repo:'yjh051108/dsh-routing-suite', packageName:'dsh-router-standard'}
//   → release 通道按包名反查到**它自己的仓库** yjh051108/dsh-router-standard 的 release v0.3.0 资产
//     （dsh-router-standard-0.3.0.tgz）→ 装成 node_modules/dsh-router-standard@0.3.0。
//   而那个包体里**没有 main/exports、也没有 dsh.bundle**，只有 `preset/`（三个预设目录）+ docs/。
//   于是出现两个后果（都在用户的验收点上）：
//     ① 预设**一个字节都没进** `~/.dsh/.agent-presets` → 用户依然用不上（预设才是他要的东西）；
//     ② 却照样 `appendInsert` 了一行 `- insert: {id: dsh-router-standard}` → 注册一个**加载不了的模块行**
//        （2026-09-06「装 dsh-desktop 后服务崩」事故同族：补丁行指向的模块没有入口）。
//   根因是判据只按**仓库**（有没有 .gitmodules / 是不是预设型子包名）分类，没按**落地物**分类：
//   预设可以随包分发（registry tarball / release 资产 / git 规格三条路都会发生），
//   而"包里带 agent.cordis.yml"是**装完之后一定能看到**的事实。
//
// 本模块补上缺的那一步：**任何通道装成功之后、写补丁行/声明依赖之前**，先看落地物里有没有预设；
// 有 → 走 preset-install.js#assemblePreset（**复用**既有装配：只补不覆盖 / 校验 / 备份 / 读回核实），
// 并按 `presetDone` 收口 —— **绝不写补丁行、绝不声明依赖**（预设不是 npm 插件）。
//
// 与 preset-source.js#tryPresetSourceChannel 的分工：那条通道是"按包名的通道都失败后，从仓库源码取"；
// 本模块是"包已经装下来了，落地物里带预设"。两条路共用同一份装配实现与同一份"预设目录"判据。

import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { findPresetDirs, isPresetDir } from './preset-source.js'
import { assemblePreset, recordPresetSource, suggestedOverwritePresetAction } from './preset-install.js'
import { noteChannel } from './git-channel.js'
import { dshHome } from '../infra/paths.js'

/** 扫一个已装包的目录树找预设（深度 ≤2，与套装路径 / 候选源码路径**同一份判据**）。
 * 返回预设目录绝对路径数组（有序、去重）；包里没有预设时返回空数组。 */
function findCarriedPresets(packageDir, maxDepth = 2) {
  if (typeof packageDir !== 'string' || packageDir === '' || !existsSync(packageDir)) return []
  const found = findPresetDirs(packageDir, maxDepth)
  // 兜底：包根自己就是预设（有的作者把 agent.cordis.yml 直接放在包根）
  if (found.length === 0 && isPresetDir(packageDir)) found.push(packageDir)
  return [...new Set(found)]
}

/** 已装包的目录（支持 scoped 包名）。找不到返回 null。 */
function installedPackageDir(profileDir, name) {
  const dir = join(profileDir, 'node_modules', ...String(name ?? '').split('/'))
  return existsSync(dir) ? dir : null
}

/**
 * 「落地物里带预设」的唯一入口（install-job 在装成功后、appendInsert/declareProfileDependency 之前调用）。
 * 返回 { handled, installed, presets, note, error }：
 *   · handled=false → 这个包里没有预设，调用方照旧按普通插件收口（行为一个字不变）；
 *   · installed=true → 已按预设装配并**由本函数把 job 收口**（status/stage/presetDone/presetNote…），
 *     调用方必须直接 return，**不要**再写补丁行/声明依赖。
 * 副作用与既有预设通道一致：`job.presetInstalled / job.presetSource / job.presetNote / channelNotes`，
 * 并调用 recordPresetSource 记下来源（这样面板上的「覆盖该预设」能按记录重新取源码）。
 */
async function installPresetsCarriedByPackage({ job, name, profileDir, repo = null, deps = {} } = {}) {
  const packageName = String(name ?? '').trim()
  if (packageName === '' || profileDir === null || profileDir === undefined) return { handled: false, installed: false, error: null }
  const packageDir = deps.packageDir ?? installedPackageDir(profileDir, packageName)
  if (packageDir === null) return { handled: false, installed: false, error: null }
  const presets = findCarriedPresets(packageDir, Number.isFinite(deps.maxDepth) ? deps.maxDepth : 2)
  if (presets.length === 0) return { handled: false, installed: false, error: null }

  const presetsRoot = deps.presetsRoot ?? join(dshHome(), '.agent-presets')
  noteChannel(job, `装出来的包 ${packageName} 里带着预设（${presets.map((p) => basename(p)).join('、')}）：按预设装配，不注册为插件（它没有插件入口）`)
  const limit = Number.isFinite(deps.limit) ? deps.limit : 8
  const reports = []
  for (const p of presets.slice(0, limit)) {
    // eslint-disable-next-line no-await-in-loop
    const report = assemblePreset(p, basename(p), {
      presetsRoot,
      overwrite: deps.overwrite === true, // 默认**只补不覆盖**（与 0.5.26 的语义一致）
      ...(deps.now === undefined ? {} : { now: deps.now }),
    })
    reports.push({ ...report, srcDir: p })
  }
  const okReports = reports.filter((r) => r.ok === true)
  const failed = reports.filter((r) => r.ok !== true)
  // 同名冲突（默认只补不覆盖时的正常结局）：某个预设的现有文件被跳过
  const conflicted = okReports.filter((r) => (r.skipped?.length ?? 0) > 0).map((r) => r.name)
  const summary = reports.map((r) => ({
    name: r.name, dest: r.dest ?? null, ok: r.ok === true, error: r.error ?? null,
    added: r.added?.length ?? 0, skipped: r.skipped?.length ?? 0, overwritten: r.overwritten?.length ?? 0,
    identical: r.identical?.length ?? 0, backup: r.backup ?? null, bytes: r.bytes ?? 0,
    marker: r.ok === true ? 'agent.cordis.yml' : null, carriedBy: packageName,
  }))
  if (job !== null && job !== undefined) {
    job.presetInstalled = summary
    job.presetSource = { repo, packageName, mode: 'in-package', root: packageDir, presets: reports.map((r) => r.name) }
    // 同名冲突（只补不覆盖时的正常结局）→ 面板给**显式**的「覆盖该预设」动作（复用既有动作构造器）
    if (conflicted.length > 0) {
      job.presetOverwriteCandidates = conflicted
      job.suggestedAction = suggestedOverwritePresetAction({
        presetName: conflicted[0],
        repo,
        reason: `已存在同名预设 ${conflicted.join('、')}：默认只补不覆盖（现有文件一个字节都没动）。要用仓库版本覆盖请点这个动作`,
      })
    }
    job.presetNote = `预设已装配：${okReports.map((r) => r.name).join('、') || '（无）'}`
      + `（落盘 ${presetsRoot}；**新建会话时选择**）`
      + `；来源：包 ${packageName} 自带的预设目录（该包没有插件入口，已按预设装配、未注册为插件）`
      + (conflicted.length > 0 ? `；同名预设 ${conflicted.join('、')} 默认只补不覆盖（缺的文件已补、现有文件未改动），如需覆盖请点「覆盖该预设」` : '')
      + (failed.length > 0 ? `；${failed.length} 个预设未装配：${failed.map((r) => `${r.name}（${r.error}）`).join('、')}` : '')
    job.presetDone = okReports.length > 0
    if (okReports.length > 0) {
      job.status = 'done'
      job.stage = 'done'
      job.candidateDone = true
      job.packageName = packageName
    }
  }
  // 记下来源（面板的「覆盖该预设」要按记录重新取源码）：repo 为空时记 null，动作侧会如实告知"没有源码出处"
  try {
    recordPresetSource(
      okReports.map((r) => ({ name: r.name, repo, candidateName: packageName, subdir: null, sparse: false, dest: r.dest })),
      deps.now === undefined ? {} : { now: deps.now },
    )
  } catch {}
  if (okReports.length === 0) {
    return { handled: true, installed: false, presets: summary, error: new Error(`包 ${packageName} 自带预设，但装配全部失败：${failed.map((r) => `${r.name}（${r.error}）`).join('、')}`) }
  }
  return {
    handled: true,
    installed: true,
    presets: summary,
    conflicted,
    note: job?.presetNote ?? null,
    error: failed.length > 0 ? new Error(`${failed.length} 个预设未装配：${failed.map((r) => `${r.name}（${r.error}）`).join('、')}`) : null,
  }
}

/** 装成功后（或预设源码通道成功后）的**唯一收口**（install-job 只调这一行，它贴着 600 行架构硬顶）：
 *   · `job.presetDone`（源码通道已装配好）→ 把 job 收口并返回 true；
 *   · 落地物里带预设 → 走 installPresetsCarriedByPackage 装配，成功则收口并返回 true；
 *   · 其余 → 返回 false（调用方照旧按普通插件收口，行为一个字不变）。 */
async function settlePresetOutcome({ job, installedName, profileDir, repo = null, deps = {} } = {}) {
  if (job !== null && job !== undefined && job.presetDone === true) {
    job.status = 'done'
    job.stage = 'done'
    job.candidateDone = true
    job.packageName = job.candidateName ?? job.packageName
    return true
  }
  if (typeof installedName !== 'string' || installedName === '') return false
  const carried = await installPresetsCarriedByPackage({ job, name: installedName, profileDir, repo, deps })
  return carried.installed === true
}

export { findCarriedPresets, installedPackageDir, installPresetsCarriedByPackage, settlePresetOutcome }
