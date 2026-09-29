#!/usr/bin/env node
// scripts/safe-boot.mjs —— **服务起不来时的唯一出路**（0.5.32 加法 D3-②）
//
// 为什么要一个独立脚本（用户 2026-09-29 诉求：「能挽救改完打不开的局面」）：
//   框架被别的通道（官方桌面端更新器 / 手动 pnpm / npx 缓存变化）换坏之后，**服务本身已经打不开**，
//   此时任何"控制台里有按钮"的方案都等于没有 —— 需要在服务之外直接跑一条命令。
//
// 三条硬约束：
//   · **零依赖**：只用 Node 内置模块 + 本插件自己的 domain 纯函数（不装任何包、不联网、不 spawn）；
//   · **服务未运行也能跑**：不读端口、不连 webServer、不需要 profile 正在被使用（只读写补丁文件与快照目录）；
//   · **可解释**：`--help` 里写清"打不开时怎么用"，每个动作都打印影响面与备份路径。
//
// 用法（在插件目录下，或 `node <插件目录>/scripts/safe-boot.mjs`）：
//   node scripts/safe-boot.mjs --list                  列快照（含可复制命令）
//   node scripts/safe-boot.mjs --restore-last-good     恢复到最近一份"良好/最新"快照（改前再备份）
//   node scripts/safe-boot.mjs --disable-suspects      只给可疑行追加 disabled: true（不删任何行）
//   node scripts/safe-boot.mjs --mark-good             把某份快照标记为"良好"（永不随保留策略删除）
//   可选：--id <snapshot-id> 指定快照；--home <DSH_HOME>；--profile <profile 名或目录>；--json
//
// 判据与路由（POST /plugin-console/safe-boot）**共用同一个 domain 模块** —— 两处不会分叉。

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome } from '../lib/server/infra/paths.js'
import { readStore } from '../lib/server/domain/auto-preflight.js'
import { readCompatMode } from '../lib/server/domain/compat-state.js'
import { CORE_PATCH_ROW_IDS } from '../lib/server/domain/patch.js'
import { validatePatchYaml } from '../lib/server/domain/patch-yaml-check.js'
import { applyRetention, disableSuspects, listSnapshots, markSnapshotGood, readSafeBootState, restoreLastGood, safeBootDir } from '../lib/server/domain/safe-boot.js'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COMMANDS = {
  list: 'node scripts/safe-boot.mjs --list',
  restore: 'node scripts/safe-boot.mjs --restore-last-good',
  disable: 'node scripts/safe-boot.mjs --disable-suspects',
  markGood: 'node scripts/safe-boot.mjs --mark-good',
}

const HELP = `安全启动材料（safe-boot）—— 服务打不开时用这个脚本，不需要服务在跑。

用法：
  node scripts/safe-boot.mjs --list
      列出全部 last-known-good 快照（时间 / 框架版本 / 行数 / 备份命令）。
  node scripts/safe-boot.mjs --restore-last-good [--id <id>]
      把 profile 补丁恢复成快照的**逐字节**内容：改前先把当前补丁另存备份（*.bak-safe-boot-<时间戳>），
      写入用「临时文件 + rename」原子落盘，写后读回核实（sha256 + 内容比对）。
      不带 --id 时：优先「标记为良好」的那份，否则用最新一份。
  node scripts/safe-boot.mjs --disable-suspects [--row <rowId>]... [--all-plan]
      只给**点名**的可疑行追加 \`disabled: true\`（沿用补丁既有写法，**不删任何行**，核心行永不写）。
      点名来源：① \`--row\` 显式给出 ② 不带 --row 时用自动预检（D1）落下的隔离计划。
  node scripts/safe-boot.mjs --mark-good [--id <id>]
      把某份快照标记为「良好」—— 这份永不随保留策略（默认只留最近 3 份）删除。
  node scripts/safe-boot.mjs --list --json
      机器可读输出（面板/子代理可直接解析）。

可选参数：
  --home <dir>      DSH_HOME（默认取环境变量 DSH_HOME，再退到用户主目录下的 .dsh）
  --profile <name>  profile 名（web / desktop）或 profile 目录；默认取环境变量 DSH_PROFILE，
                    再退到 <DSH_HOME>/profiles/web
  --row <rowId>     只对这一行执行 --disable-suspects（可重复）
  --all-plan        配合 --disable-suspects：忽略显式 --row，直接用自动预检计划里的全部点名行
  --dry-run         只打印将要发生什么，**一个字节都不写**
  --help            显示本帮助

"改完打不开"的三步：
  ① node scripts/safe-boot.mjs --list                 看清有哪些快照、哪份是好状态
  ② node scripts/safe-boot.mjs --restore-last-good     整份恢复（推荐先试这个）
     或 node scripts/safe-boot.mjs --disable-suspects  只关掉被点名的可疑行（保守做法）
  ③ 重启服务，确认能打开

说明：**完全自动**救活（服务崩了自动恢复）需要服务之外的看门狗（计划任务 / 启动器钩子）——
本脚本不安装任何计划任务、不改启动器，是否要那个能力请用户单独决定（见 README「改完打不开怎么办」）。
`

/** 极简参数解析（零依赖；只认白名单形状，未知参数直接报错退出）。 */
function parseArgs(argv) {
  const out = { rows: [], flags: new Set(), values: new Map() }
  const known = new Set(['home', 'profile', 'id', 'row'])
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`无法识别的参数：${arg}（用 --help 看用法）`)
    const [rawKey, inline] = arg.slice(2).split('=')
    const key = rawKey.trim()
    if (known.has(key)) {
      const value = inline !== undefined ? inline : argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`参数 --${key} 需要一个值`)
      if (inline === undefined) i += 1
      if (key === 'row') out.rows.push(value)
      else out.values.set(key, value)
      continue
    }
    out.flags.add(key)
  }
  return out
}

/** profile 目录推导（**只看环境变量与我们自己的派生**，不写死任何本机路径）。
 *  `--profile` 优先；给的是目录（绝对路径 / 带分隔符）就直接用。 */
function profileDirOf({ home, profile, envProfileDir }) {
  const name = profile ?? process.env.DSH_PROFILE ?? null
  if (name !== null && name !== '' && (isAbsolute(name) || name.includes('/') || name.includes('\\'))) return resolve(name)
  if (profile === undefined && typeof envProfileDir === 'string' && envProfileDir.trim() !== '') return resolve(envProfileDir.trim())
  return join(home, 'profiles', (name !== null && name !== '' ? name : 'web'))
}

/** 最近一次「done」的自动预检记录（同一份记录面板也在用）。 */
function latestPlan() {
  try {
    const records = readStore().records
    return records.find((r) => r.state === 'done' && Array.isArray(r.suspects)) ?? null
  } catch { return null }
}

const line = (text = '') => process.stdout.write(`${text}\n`)
const zh = (pair) => (pair === null || pair === undefined ? '' : pair.zh)

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.flags.has('help') || args.flags.size === 0) { process.stdout.write(HELP); return 0 }
  const ACTIONS = ['list', 'restore-last-good', 'disable-suspects', 'mark-good']
  const picked = ACTIONS.filter((a) => args.flags.has(a))
  if (picked.length === 0) { process.stdout.write(HELP); line(`\n没有可执行的动作（可选：${ACTIONS.join(' / ')}）`); return 1 }
  if (picked.length > 1) { line(`一次只能做一个动作（收到：${picked.join(' + ')}）`); return 1 }
  const home = resolve(args.values.get('home') ?? dshHome())
  // ★ 必须在**读取任何状态之前**把 DSH_HOME 对齐到本次的 --home：本脚本自身的 domain 模块
  //   （auto-preflight / safe-boot 的默认路径）走 dshHome() 读环境变量，不对齐就会去读真实用户目录。
  process.env.DSH_HOME = home
  const profileDir = profileDirOf({ home, profile: args.values.get('profile'), envProfileDir: process.env.DSH_PROFILE_DIR })
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const asJson = args.flags.has('json')
  const dryRun = args.flags.has('dry-run')

  if (args.flags.has('list')) {
    const snapshots = listSnapshots({ home })
    const state = readSafeBootState({ home })
    const plan = latestPlan()
    const retention = applyRetention(snapshots.map((s) => ({ id: s.id, at: s.at, kind: s.kind })))
    if (asJson) {
      line(JSON.stringify({
        ok: true, action: 'list', home, safeBootDir: safeBootDir(home), profileDir, patchPath,
        patchExists: existsSync(patchPath), snapshots, lastGoodId: state.lastGoodId, lastAutoId: state.lastAutoId,
        retention, plan: plan === null ? null : { at: plan.at, state: plan.state, suspects: (plan.suspects ?? []).map((s) => s.rowId) },
        mode: readCompatMode().mode, commands: COMMANDS,
      }, null, 2))
      return 0
    }
    line(`安全启动材料目录：${safeBootDir(home)}`)
    line(`profile：${profileDir}`)
    line(`补丁：${patchPath}${existsSync(patchPath) ? '' : '（**文件不存在**）'}`)
    if (existsSync(patchPath)) {
      const check = validatePatchYaml(readFileSync(patchPath, 'utf8'))
      line(`当前补丁结构校验：${check.ok ? '通过' : `**不通过** —— ${check.problems.slice(0, 3).join('；')}`}`)
    }
    line(`运行模式：${readCompatMode().mode}`)
    line('')
    if (snapshots.length === 0) {
      line('还没有任何快照（服务从未在"正常 + 环境未变"的状态下记录过）。')
      line('能做的：先把服务拉起来（或用上一版框架），起来后本控制台会自动记录第一份安全启动材料。')
    } else {
      line(`快照（新 → 旧，共 ${snapshots.length} 份，保留最近 ${retention.keep.length} 份）：`)
      for (const s of snapshots) {
        const badge = s.kind === 'good' ? '【良好·永不删】' : ''
        line(`  ${s.id} ${badge}`)
        line(`     时间 ${s.createdAt ?? '?'} · 框架 ${s.frameworkVersion ?? '未知'} · 行 ${s.rowCount}（启用 ${s.enabledCount} / 禁用 ${s.disabledCount}）`)
        line(`     sha256 ${String(s.patchSha256 ?? '').slice(0, 16)}…${s.patchPath === patchPath ? '' : ` · 补丁 ${s.patchPath ?? '?'}`}`)
      }
      if (state.lastGoodId !== null) line(`\n已标记为良好的快照：${state.lastGoodId}`)
      line(`\n恢复整份：${COMMANDS.restore}`)
      line(`只禁可疑行：${COMMANDS.disable}`)
    }
    if (plan !== null) {
      const suspects = (plan.suspects ?? []).map((s) => s.rowId)
      line(`\n自动预检计划（${new Date(Number(plan.at ?? 0)).toISOString()}）：点名 ${suspects.length} 行${suspects.length > 0 ? ` — ${suspects.join('、')}` : ''}`)
    } else {
      line('\n自动预检还没有结论（服务起来后第一次状态查询会自动跑一次）。')
    }
    return 0
  }

  if (args.flags.has('restore-last-good')) {
    const id = args.values.get('id') ?? null
    if (dryRun) {
      const snapshots = listSnapshots({ home })
      line(`[dry-run] 将恢复：${id ?? '（自动挑选：优先良好，其次最新）'} → ${patchPath}`)
      line(`[dry-run] 可用快照：${snapshots.map((s) => `${s.id}${s.kind === 'good' ? '(good)' : ''}`).join(', ') || '（无）'}`)
      return 0
    }
    const result = restoreLastGood({ patchPath, id, home })
    if (asJson) { line(JSON.stringify(result, null, 2)); return result.ok === true ? 0 : 1 }
    if (result.ok !== true) {
      line(`恢复失败（${result.code ?? 'error'}）：${result.error ?? '未知原因'}`)
      line(`先看清有什么：${COMMANDS.list}`)
      return 1
    }
    line(`恢复${result.changed === true ? '完成' : '无需进行（已一致）'}：快照 ${result.snapshot?.id ?? '?'}（${result.snapshot?.createdAt ?? '?'}）`)
    line(`补丁：${result.patchPath}`)
    if (result.backupPath !== null && result.backupPath !== undefined) line(`改前备份：${result.backupPath}`)
    line(`sha256：${result.sha256 ?? '?'}`)
    line(zh(result.note))
    line('下一步：重启服务，确认能打开。')
    return 0
  }

  if (args.flags.has('disable-suspects')) {
    const plan = latestPlan()
    const fromPlan = args.flags.has('all-plan') || args.rows.length === 0
    const rowIds = fromPlan ? ((plan?.suspects ?? []).map((s) => s.rowId)) : args.rows
    if (rowIds.length === 0) {
      line('没有可点名的行：自动预检还没跑出计划，且没有给 --row。')
      line(`可以先跑一次状态查询让自动预检出结论，或显式点名：${COMMANDS.disable} --row <rowId>`)
      return 1
    }
    if (dryRun) {
      line(`[dry-run] 将给以下行追加 disabled: true（不删任何行）：${rowIds.join('、')}`)
      line(`[dry-run] 补丁：${patchPath}`)
      return 0
    }
    const result = disableSuspects({ patchPath, rowIds, home })
    if (asJson) { line(JSON.stringify(result, null, 2)); return result.ok === true ? 0 : 1 }
    if (result.ok !== true) {
      line(`禁用失败（${result.code ?? 'error'}）：${result.error ?? '未知原因'}`)
      return 1
    }
    if (result.changed !== true) {
      line(zh(result.note))
      for (const s of result.skipped ?? []) line(`  跳过 ${s.rowId}：${s.reason}`)
      return 0
    }
    line(`已只给 ${result.added.length} 行追加 disabled: true（未删任何行）：${result.added.join('、')}`)
    for (const s of result.skipped ?? []) line(`  跳过 ${s.rowId}：${s.reason}`)
    line(`改前备份：${result.backupPath}`)
    line(`剩余部分逐字节未变：${result.prefixSame === true ? '是' : '**否（请检查）**'}`)
    line('下一步：重启服务，确认能打开。')
    line(`仍未打开 → 改用整份恢复：${COMMANDS.restore}`)
    return 0
  }

  if (args.flags.has('mark-good')) {
    const id = args.values.get('id') ?? null
    if (dryRun) { line(`[dry-run] 将把 ${id ?? '（最新一份）'} 标记为良好`); return 0 }
    const result = markSnapshotGood({ id, home })
    if (asJson) { line(JSON.stringify(result, null, 2)); return result.ok === true ? 0 : 1 }
    if (result.ok !== true) { line(`标记失败：${result.error ?? '未知原因'}`); return 1 }
    line(`已标记为良好：${result.snapshot?.id ?? '?'}（${result.snapshot?.createdAt ?? '?'}）`)
    line(zh(result.note))
    return 0
  }

  process.stdout.write(HELP)
  line(`\n未识别的动作（核心行保护名单示例：${[...CORE_PATCH_ROW_IDS].slice(0, 3).join('、')}…）`)
  return 1
}

try {
  process.exitCode = main()
} catch (error) {
  line(`safe-boot 执行失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}
