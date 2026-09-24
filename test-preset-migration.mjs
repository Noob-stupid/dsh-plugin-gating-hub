// 预设配置迁移门禁测试（2026-09-10 事故的回归防线）：
// 0.1.5 的 @deepseek-ai/dsh-persona 把 config.text 改名为 prefix（必填），旧字段会让预设挂载失败、
// 服务/会话起不来。适配门只扫已装插件包，扫不到预设 —— 这里验证升级前的自动迁移：
//   1) persona 行的 text → prefix（值保留、留 .bak）
//   2) 已有 prefix 的预设不动
//   3) 非 persona 行的 text 不动（不能误伤别的插件配置）
//   4) 无 config 的行不动
//   5) 目标版本低于引入版本（0.1.5）时不迁移
//   6) 迁移后 YAML 仍可解析
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'preset-home')
process.env.DSH_HOME = HOME // 必须在 import 之前：模块顶层常量按 DSH_HOME 求值

rmSync(HOME, { recursive: true, force: true })
const presetRoot = join(HOME, '.agent-presets')
const write = (name, lines) => {
  mkdirSync(join(presetRoot, name), { recursive: true })
  const f = join(presetRoot, name, 'agent.cordis.yml')
  writeFileSync(f, lines.join('\n'), 'utf8')
  return f
}

const legacy = write('legacy', [
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    text: hello prefix world',
  '',
  '- id: other',
  "  name: '@x/y'",
  '  config:',
  '    text: 不要动这行',
  '',
])
const already = write('already', [
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    prefix: already migrated',
  '',
])

const { migrateAgentConfigsForUpgrade } = await import('./lib/server/domain/presets.js')
const require2 = createRequire(join(ROOT, 'package.json'))
let YAML = null
try { YAML = require2('yaml') } catch {}
if (YAML === null) {
  try { YAML = createRequire('C:/Users/花火/.dsh/profiles/web/package.json')('yaml') } catch {}
}

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

// 1) 低于引入版本 → 不迁移
const none = migrateAgentConfigsForUpgrade(join(HOME, 'profiles', 'web'), '0.1.2-rc.1')
check('目标版本低于 0.1.5 时不迁移', none.length === 0, `migrations=${none.length}`)

// 2) 目标 0.1.5 → 迁移 legacy，跳过 already
const done = migrateAgentConfigsForUpgrade(join(HOME, 'profiles', 'web'), '0.1.5-rc.1')
check('迁移 1 个文件', done.length === 1, JSON.stringify(done))
check('迁移的是 legacy 预设', done[0]?.file === legacy, done[0]?.file)
check('迁移的是 text → prefix', done[0]?.from === 'text' && done[0]?.to === 'prefix')

const legacyText = readFileSync(legacy, 'utf8')
check('persona 行已改为 prefix', /^\s{4}prefix: hello prefix world$/mu.test(legacyText), legacyText.split('\n')[3])
check('非 persona 行的 text 未动', /^\s{4}text: 不要动这行$/mu.test(legacyText))
check('留下 .bak 备份', readdirSync(join(presetRoot, 'legacy')).some((n) => n.includes('.bak-')))

const alreadyText = readFileSync(already, 'utf8')
check('已有 prefix 的预设未被改写', /prefix: already migrated/u.test(alreadyText) && !alreadyText.includes('.bak-'))

if (YAML !== null) {
  for (const [name, f] of [['legacy', legacy], ['already', already]]) {
    try {
      const doc = YAML.parse(readFileSync(f, 'utf8'))
      const row = (doc ?? []).find((r) => r && r.id === 'persona')
      check(`${name} 迁移后 YAML 可解析且 persona 有值`, typeof Object.values(row?.config ?? {})[0] === 'string')
    } catch (error) {
      check(`${name} YAML 解析`, false, error.message)
    }
  }
} else {
  console.log('SKIP YAML 校验（未找到 yaml 包）')
}

// 3) 幂等：再跑一次不应重复迁移
const again = migrateAgentConfigsForUpgrade(join(HOME, 'profiles', 'web'), '0.1.5-rc.1')
check('幂等（第二次无迁移）', again.length === 0, `migrations=${again.length}`)

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
