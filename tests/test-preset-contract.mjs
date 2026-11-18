// 会话预设契约每日体检（A 方案；0.5.111 加法）
//
// 钉住：24h 内命中缓存、force 重算、声明行计数、契约解析失败如实报错、不写预设/补丁。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'preset-contract-home')
process.env.DSH_HOME = HOME
rmSync(HOME, { recursive: true, force: true })
const profileDir = join(HOME, 'profiles', 'web')
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
mkdirSync(join(HOME, '.agent-presets', 'demo'), { recursive: true })
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })
writeFileSync(join(HOME, '.agent-presets', 'demo', 'agent.cordis.yml'), '- id: persona\n  name: "@deepseek-ai/dsh-persona"\n', 'utf8')
writeFileSync(join(HOME, '.agent-presets', 'demo', 'preset.yml'), 'name: Demo\n', 'utf8')
const patchPath = join(profileDir, 'cordis.patch.yml')
writeFileSync(patchPath, [
  '- insert:',
  '    - id: preset-demo',
  "      name: '@deepseek-ai/dsh-agent-preset'",
  '      config:',
  '        id: demo',
  '        plugins: []',
  '    - id: preset-other',
  "      name: '@deepseek-ai/dsh-agent-preset'",
  '      config:',
  '        id: other',
  '        plugins: []',
].join('\n') + '\n', 'utf8')

const { cacheFile, declarationCount, readCache, readContract, runPresetContractCheck } = await import('../lib/server/domain/preset-contract.js')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

check('① 声明行计数只数 agent-preset 行', declarationCount(patchPath) === 2, String(declarationCount(patchPath)))
check('① 官方包解析不到时如实返回 error（不猜）', (() => {
  const c = readContract({ baseUrl: `file:///${profileDir.replace(/\\/gu, '/')}/cordis.yml`, profileDir })
  return c.ok === false && typeof c.error === 'string' && c.error.length > 0
})(), JSON.stringify(readContract({ baseUrl: `file:///${profileDir.replace(/\\/gu, '/')}/cordis.yml`, profileDir })))

const first = runPresetContractCheck({ profileDir, presetsRoot: join(HOME, '.agent-presets'), patchPath, force: true })
check('② 首次检查写缓存 + 返回 drift 结构', first.cached === false && readCache() !== null && typeof first.drift === 'object', JSON.stringify(first.drift))
check('② 缓存里有 checkedAt/nextDueAt', Number.isFinite(first.checkedAt) && first.nextDueAt > first.checkedAt)
const second = runPresetContractCheck({ profileDir, presetsRoot: join(HOME, '.agent-presets'), patchPath, force: false, now: first.checkedAt + 1000 })
check('③ 24h 内命中缓存（cached=true）', second.cached === true && second.checkedAt === first.checkedAt)
const forced = runPresetContractCheck({ profileDir, presetsRoot: join(HOME, '.agent-presets'), patchPath, force: true, now: first.checkedAt + 2000 })
check('③ force=1 重算（cached=false）', forced.cached === false && forced.checkedAt !== first.checkedAt)
const rawPatch = readFileSync(patchPath, 'utf8')
check('④ 体检不写用户补丁', rawPatch.includes('preset-demo') && rawPatch.includes('preset-other'))
check('④ 体检不写预设目录', readFileSync(join(HOME, '.agent-presets', 'demo', 'agent.cordis.yml'), 'utf8').includes('persona'))

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1
