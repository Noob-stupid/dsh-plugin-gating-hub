// issue #28：官方更新器绕过升级流程后，核心行被 DSH 版本闸禁用 → 只读诊断。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = join(HERE, '.testdir', 'framework-diagnosis')
rmSync(HOME, { recursive: true, force: true })
const profile = join(HOME, 'profiles', 'desktop')
mkdirSync(join(profile, 'vendor', 'controller'), { recursive: true })
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'desktop-profile', private: true,
  dependencies: { '@deepseek-ai/dsh-api-session-controller': 'file:./vendor/controller' },
}, null, 2), 'utf8')
writeFileSync(join(profile, 'vendor', 'controller', 'package.json'), JSON.stringify({
  name: '@deepseek-ai/dsh-api-session-controller', version: '0.2.2-rc.3-retain5',
  peerDependencies: { '@deepseek-ai/dsh-session': '0.2.2-rc.3' },
}, null, 2), 'utf8')
const patch = '- id: session-controller\n  disabled: true\n'
writeFileSync(join(profile, 'cordis.patch.yml'), patch, 'utf8')

const { diagnoseFrameworkCoreRows, latestDiagnosis, vendoredCoreDeps } = await import('../lib/server/domain/framework-diagnosis.js')
const entries = [
  { rowId: 'session-controller', moduleName: '@deepseek-ai/dsh-api-session-controller', version: '0.2.2-rc.3-retain5', enabled: false, fiberPhase: 'failed' },
  { rowId: 'agent', moduleName: '@deepseek-ai/dsh-agent', version: '0.2.2-rc.5', enabled: true, fiberPhase: 'active' },
]
let failed = 0
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
check('① 识别 vendored file: 核心依赖', vendoredCoreDeps(profile).some((d) => d.name.endsWith('session-controller') && d.version === '0.2.2-rc.3-retain5'), JSON.stringify(vendoredCoreDeps(profile)))
const result = diagnoseFrameworkCoreRows({
  entries, framework: { version: '0.2.2-rc.5', from: '0.2.2-rc.3', upgraded: true }, profileDir: profile, home: HOME, now: 1700000000000,
})
check('② 判定 critical', result.ok === true && result.critical === true, JSON.stringify(result))
check('③ 点名版本不一致的核心行', result.blockedCoreRows.some((r) => r.rowId === 'session-controller'), JSON.stringify(result.blockedCoreRows))
check('④ 给出换到当前框架版本的恢复命令', result.recovery.some((r) => r.command.includes('@deepseek-ai/dsh-api-session-controller@0.2.2-rc.5')), JSON.stringify(result.recovery))
check('⑤ 写 diagnosis 文件', typeof result.diagnosisPath === 'string' && existsSync(result.diagnosisPath), result.diagnosisPath)
check('⑥ 只读：补丁内容不变', readFileSync(join(profile, 'cordis.patch.yml'), 'utf8') === patch)
check('⑦ safe-boot 能读到最新诊断', latestDiagnosis({ home: HOME })?.currentVersion === '0.2.2-rc.5')
const clean = diagnoseFrameworkCoreRows({
  entries: [{ rowId: 'agent', moduleName: '@deepseek-ai/dsh-agent', version: '0.2.2-rc.3-retain5', enabled: true, fiberPhase: 'active' }],
  framework: { version: '0.2.2-rc.3-retain5', from: '0.2.2-rc.3-retain5', upgraded: false }, profileDir: profile, home: HOME, now: 1700000000001,
})
check('⑧ 版本一致时不误报', clean.critical === false && clean.blockedCoreRows.length === 0 && clean.vendoredCoreDeps.length === 0, JSON.stringify(clean))
const noise = diagnoseFrameworkCoreRows({
  entries: [
    { rowId: 'agent', moduleName: '@deepseek-ai/dsh-agent', version: '0.2.2-rc.3-retain5', enabled: true, fiberPhase: 'active' },
    { rowId: 'schedule', moduleName: '@deepseek-ai/dsh-schedule', version: '0.2.0-rc.2', enabled: false, fiberPhase: null, disableSource: 'patch' },
    { rowId: 'auto-review', moduleName: '@deepseek-ai/dsh-experimental-auto-review', version: '0.2.1-rc.2', enabled: false, fiberPhase: null, disableSource: 'bundle' },
    { rowId: 'speech', moduleName: '@deepseek-ai/dsh-experimental-speech-to-text', version: '0.2.1-rc.2', enabled: false, fiberPhase: null, disableSource: 'bundle' },
  ],
  framework: { version: '0.2.2-rc.3-retain5', from: '0.2.2-rc.3', upgraded: true }, profileDir: profile, home: HOME, now: 1700000000002,
})
check('⑨ 旧版本但被 bundle 默认禁用 / 主动 patch 禁用的行不算 critical', noise.critical === false && noise.blockedCoreRows.length === 0, JSON.stringify(noise.blockedCoreRows))
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1
