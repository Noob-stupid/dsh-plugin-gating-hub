// 启动失败进程外恢复：只读解析 crash log，点名失败行；dry-run 不动补丁。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const HOME = join(HERE, '.testdir', 'boot-recover')
rmSync(HOME, { recursive: true, force: true })
mkdirSync(HOME, { recursive: true })
const patch = [
  '- id: plugin-console',
  '  disabled: false',
  '- id: pwsh-sandbox',
  '  disabled: false',
  '- id: tool-executor-ptc',
  '  disabled: false',
  '',
].join('\n')
writeFileSync(join(HOME, 'cordis.patch.yml'), patch, 'utf8')
const log = [
  'Failed plugins (2):',
  '  pwsh-sandbox',
  '    Package: @deepseek-ai/dsh-pwsh-sandbox',
  '    Error: service "shell" has been registered at <SandboxBashExecutor>',
  '  tool-executor-ptc (required)',
  '    Error: Only one tool executor may be registered in each scope',
  '',
].join('\n')
writeFileSync(join(HOME, 'crash.log'), log, 'utf8')

const run = spawnSync(process.execPath, [join(REPO, 'scripts', 'boot-recover.mjs'), '--profile', HOME, '--log', join(HOME, 'crash.log'), '--dry-run'], { encoding: 'utf8' })
const out = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
let failed = 0
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
check('① 脚本退出 0', run.status === 0, out)
check('② 点名 tool-executor-ptc', out.includes('tool-executor-ptc'), out)
check('③ 点名 pwsh-sandbox', out.includes('pwsh-sandbox'), out)
check('④ dry-run 不改补丁', readFileSync(join(HOME, 'cordis.patch.yml'), 'utf8') === patch)
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1
