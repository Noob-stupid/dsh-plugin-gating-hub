// 修复 0.1.2-rc.1 Session API 变更：session.events → snapshotEvents()
// 背景：0.1.2-rc.1 的 Session 移除了 `.events` 属性（事件改为 snapshotEvents() 方法），
// 用户 router 预设插件读取 session.events.some(...) 报
// 「Cannot read properties of undefined (reading 'some')」导致运行失败。
// 兼容修复：helper 优先 snapshotEvents()，旧版回退 session.events ?? []。
// 用法：node fix-router-session-events.mjs [预设根目录]（默认 <DSH_HOME 或 ~/.dsh>/.agent-presets）
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// 默认值由用户目录派生（DSH_HOME 优先，与 host 端 dshHome() 同一判据）——不写死任何机器路径。
const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const root = process.argv[2] ?? join(dshHome, '.agent-presets')
if (!existsSync(root)) {
  console.error(`预设根目录不存在：${root}\n用法：node patches/fix-router-session-events.mjs [预设根目录]（默认 ${join(dshHome, '.agent-presets')}）`)
  process.exit(1)
}
const files = []
for (const dir of readdirSync(root)) {
  const p = join(root, dir)
  if (!existsSync(join(p, 'agent.cordis.yml'))) continue
  for (const f of readdirSync(p)) if (f.endsWith('.mjs')) files.push(join(p, f))
}

const HELPER = `function sessionEvents(s) { return typeof s?.snapshotEvents === 'function' ? s.snapshotEvents() : (s?.events ?? []) }\n`

let touched = 0
for (const file of files) {
  let text = readFileSync(file, 'utf8')
  const orig = text
  if (text.includes('session.events')) {
    if (!text.includes('function sessionEvents')) {
      const idx = text.indexOf('\n\n')
      text = text.slice(0, idx) + '\n' + HELPER + text.slice(idx)
    }
    text = text.replace(/session\.events\.some\(/gu, 'sessionEvents(session).some(')
    text = text.replace(/const events = session\.events\b/gmu, 'const events = sessionEvents(session)')
    text = text.replace(/session\.events\.(find|filter|map|at|length|slice|forEach)\(|session\.events\.at\b/gu, (m) => 'sessionEvents(session).' + m.slice('session.events.'.length))
  }
  if (text !== orig) {
    writeFileSync(file, text, 'utf8')
    touched += 1
    console.log('patched:', file)
  }
}
console.log('touched files:', touched)
