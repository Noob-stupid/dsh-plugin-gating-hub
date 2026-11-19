#!/usr/bin/env node
// scripts/boot-recover.mjs —— 桌面端启动失败后的**进程外**第一轮恢复（0.5.113 加法）
//
// 为什么需要它：门控跑在 DSH 里，host 在启动审计阶段就退出时，门控根本没机会运行。
// 这个脚本在进程外读 crash log，只禁用被点名的失败行（不会碰 plugin-console / 核心行），
// 备份补丁后可选地重新拉起桌面端。
//
// 用法：
//   node scripts/boot-recover.mjs --profile "C:\Users\<you>\.dsh\profiles\desktop" --dry-run
//   node scripts/boot-recover.mjs --profile "...\desktop" --launch
//   node scripts/boot-recover.mjs --log <crash.log> --profile ... --dry-run
//
// 边界：只做第一轮“点名行禁用”；第二轮安全启动仍走 `safe-boot.mjs --disable-suspects`
// （它会跳过 plugin-console 自身与框架自带/受保护行）。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { disableSuspects } from '../lib/server/domain/safe-boot.js'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const value = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}

function findLatestCrashLog() {
  const explicit = value('log')
  if (explicit !== null) return explicit
  const roots = [
    join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), '@deepseek-ai', 'dsh-desktop', 'logs'),
    join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'DeepSeek Harness', 'logs'),
  ]
  for (const root of roots) {
    if (!existsSync(root)) continue
    const files = readdirSync(root).filter((n) => /^crash-.*-host\.log$/u.test(n)).sort().reverse()
    // 优先选带 “Failed plugins” 段的日志；只有客户端 TypeError 的日志跳过。
    for (const name of files) {
      const file = join(root, name)
      try {
        if (/Failed plugins \(\d+\):/u.test(readFileSync(file, 'utf8'))) return file
      } catch {}
    }
    for (const name of files) {
      const file = join(root, name)
      try {
        const text = readFileSync(file, 'utf8')
        if (/required plugin did not activate|service "shell" has been registered|Only one tool executor/u.test(text)) return file
      } catch {}
    }
    if (files.length > 0) return join(root, files[0])
  }
  return null
}

/** 从 crash log 提取被点名的失败 row id（只提取明确的启动审计失败，不猜）。 */
function parseFailedRows(log) {
  const rows = new Set()
  const block = log.match(/Failed plugins \(\d+\):\n([\s\S]*?)(?:\n\n|$)/u)
  if (block !== null) {
    for (const line of block[1].split('\n')) {
      const m = line.match(/^\s{2}([A-Za-z0-9@/._-]+)\s*$/u)
      if (m !== null) rows.add(m[1])
    }
  }
  // 常见服务冲突没有稳定的 “Failed plugins” 段落，按错误文本点名到行。
  if (/Only one tool executor may be registered/u.test(log)) rows.add('tool-executor-ptc')
  if (/Missing services[\s\S]{0,200}workflowEngine/u.test(log)) rows.add('tool-workflow')
  if (/service "shell" has been registered/u.test(log)) {
    // 两个 shell 执行器只留一个；优先保留 bash（桌面端现有组合），关掉 pwsh。
    rows.add('pwsh-sandbox')
  }
  return [...rows]
}

const profileDir = value('profile', join(homedir(), '.dsh', 'profiles', 'desktop'))
const patchPath = join(profileDir, 'cordis.patch.yml')
const logPath = findLatestCrashLog()
if (logPath === null || !existsSync(logPath)) {
  console.error('没有找到 crash log；用 --log 指定。')
  process.exit(2)
}
const log = readFileSync(logPath, 'utf8')
const rowIds = parseFailedRows(log)
const dryRun = flag('dry-run')
console.log(JSON.stringify({ ok: true, logPath, profileDir, patchPath, rowIds, dryRun }, null, 2))
if (rowIds.length === 0) {
  console.log('没有从日志里点名出可禁用的行；不做改动。第二轮请用 safe-boot.mjs。')
  process.exit(0)
}
if (dryRun) process.exit(0)

const result = disableSuspects({ patchPath, rowIds })
console.log(JSON.stringify(result, null, 2))
if (result.ok !== true) process.exit(1)
if (flag('launch')) {
  const app = value('app', 'D:\\dsh-desktop\\DeepSeek Harness.exe')
  const exe = existsSync(app) ? app : 'D:\\dsh-desktop\\DeepSeek Harness.exe'
  if (!existsSync(exe)) {
    console.error(`找不到桌面端可执行文件：${exe}`)
    process.exit(3)
  }
  spawn(exe, [], { detached: true, stdio: 'ignore' }).unref()
  console.log(`已重新拉起：${exe}`)
}
