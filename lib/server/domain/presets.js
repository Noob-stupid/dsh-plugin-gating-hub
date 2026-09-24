// L1 · domain —— presets.js（预设/agent 配置迁移：config 文件收集、persona 迁移、升级期迁移；分层 Step 6 从 lib/index.js 搬出，只搬移未改逻辑）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md 三

import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { isVersionAtLeast } from './framework.js'
import { escapeRegExp } from '../infra/mask.js'
import { dshHome } from '../infra/paths.js'

/**
 * 预设/组合文件的配置迁移门禁（2026-09-10 事故）：
 * 框架升级会改「插件配置 schema」——0.1.5 的 @deepseek-ai/dsh-persona 把 text 改名为 prefix（必填）。
 * 适配门只扫「已装插件包源码」，**预设不在其中**（~/.dsh/.agent-presets/<name>/agent.cordis.yml），
 * 于是升级后预设挂载失败 → 服务/会话起不来（这次就是这么挂的）。
 * 升级前按目标版本扫描并自动迁移（写 .bak 备份），返回迁移清单供步骤展示。
 */
const PRESET_CONFIG_MIGRATIONS = [
  { pkg: '@deepseek-ai/dsh-persona', from: 'text', to: 'prefix', since: '0.1.5' },
]

/** 待扫描的 agent 配置文件：所有预设 + profile 的 host 组合。 */
function collectAgentConfigFiles(profileDir) {
  const files = []
  const presetRoot = join(dshHome(), '.agent-presets')
  try {
    for (const entry of readdirSync(presetRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      for (const name of ['agent.cordis.yml', 'agent.cordis.yaml']) {
        const f = join(presetRoot, entry.name, name)
        if (existsSync(f)) files.push(f)
      }
    }
  } catch {}
  for (const name of ['cordis.yml', 'cordis.yaml', 'cordis.patch.yml']) {
    const f = join(profileDir, name)
    if (existsSync(f)) files.push(f)
  }
  return files
}

/** 迁移一个文件里 persona 行 config 的旧键（仅当尚无新键时改写，先写 .bak）。 */
function migratePresetPersona(file, mig) {
  let text = null
  try { text = readFileSync(file, 'utf8') } catch { return null }
  const lines = text.split(/\r?\n/u)
  let rowAt = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (new RegExp(`name:\\s*['"]?${escapeRegExp(mig.pkg)}['"]?\\s*$`, 'u').test(lines[i])) { rowAt = i; break }
  }
  if (rowAt === -1) return null
  let cfgAt = -1
  for (let i = rowAt + 1; i < lines.length; i += 1) {
    if (/^\s*config:\s*$/u.test(lines[i])) { cfgAt = i; break }
    if (/^\s*-\s+id:/u.test(lines[i])) break
  }
  if (cfgAt === -1) return null
  const cfgIndent = lines[cfgAt].match(/^\s*/u)[0].length
  let endAt = lines.length
  for (let i = cfgAt + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || /^\s*#/u.test(line)) continue
    if (line.match(/^\s*/u)[0].length <= cfgIndent) { endAt = i; break }
  }
  let hasNew = false
  let hit = -1
  for (let i = cfgAt + 1; i < endAt; i += 1) {
    if (new RegExp(`^\\s*${mig.to}:`, 'u').test(lines[i])) { hasNew = true; break }
    if (new RegExp(`^\\s*${mig.from}:`, 'u').test(lines[i])) hit = i
  }
  if (hasNew || hit === -1) return null
  lines[hit] = lines[hit].replace(new RegExp(`^(\\s*)${mig.from}:`, 'u'), `$1${mig.to}:`)
  try {
    copyFileSync(file, `${file}.bak-${Date.now()}`)
    writeFileSync(file, lines.join('\n'), 'utf8')
  } catch { return null }
  return { file, from: mig.from, to: mig.to, line: hit + 1, pkg: mig.pkg }
}

/** 升级前扫描预设/组合文件并按目标版本迁移（返回迁移清单）。导出供测试直接调用。 */
function migrateAgentConfigsForUpgrade(profileDir, targetVersion) {
  const out = []
  if (typeof targetVersion !== 'string' || targetVersion === '') return out
  for (const mig of PRESET_CONFIG_MIGRATIONS) {
    if (!isVersionAtLeast(targetVersion, mig.since)) continue
    for (const file of collectAgentConfigFiles(profileDir)) {
      const done = migratePresetPersona(file, mig)
      if (done !== null) out.push(done)
    }
  }
  return out
}

export { PRESET_CONFIG_MIGRATIONS, collectAgentConfigFiles, migratePresetPersona, migrateAgentConfigsForUpgrade }
