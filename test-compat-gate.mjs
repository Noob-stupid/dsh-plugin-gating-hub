#!/usr/bin/env node
/**
 * 框架升级适配门单元测试：semver 范围匹配 + 插件兼容判定。
 *
 * Step 1 重构后（L0 分层）：semver 函数已搬进 `lib/server/infra/semver.js`，
 * 适配判定仍在 index.js（Step 6 才抽 compat 域），**直接 import 真模块**——
 * 不再"按注释标记从 index.js 切片 + vm 沙箱重放"（那种写法一挪文件就断）。
 * 用法：node test-compat-gate.mjs
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
// index.js 顶层会按 DSH_HOME 解析路径常量：先指向临时目录，避免碰真实 ~/.dsh
const HOME = join(ROOT, '.testdir', 'compat-gate-home')
process.env.DSH_HOME = HOME
rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })

const { semverRangeMatch, semverRangeMatchLoose } = await import('./lib/server/infra/semver.js')
const { checkPluginFrameworkCompat } = await import('./lib/server/domain/compat.js')

let pass = 0, fail = 0
function eq(name, got, want) {
  const ok = got === want
  if (ok) pass++; else { fail++; console.log('FAIL', name, 'got', got, 'want', want) }
}
eq('^0.1.1-rc.2 excludes 0.1.2-rc.1 (npm prerelease rule)', semverRangeMatch('0.1.2-rc.1', '^0.1.1-rc.2'), false)
eq('^0.1.2-rc.1 includes 0.1.2-rc.1', semverRangeMatch('0.1.2-rc.1', '^0.1.2-rc.1'), true)
eq('>=0.1.2 excludes 0.1.2-rc.1 (npm strict, deps)', semverRangeMatch('0.1.2-rc.1', '>=0.1.2'), false)
eq('loose: >=0.1.2 includes 0.1.2-rc.1 (declared)', semverRangeMatchLoose('0.1.2-rc.1', '>=0.1.2'), true)
eq('^0.1.1 includes 0.1.2', semverRangeMatch('0.1.2', '^0.1.1'), true)
eq('^0.1.1 excludes 0.2.0', semverRangeMatch('0.2.0', '^0.1.1'), false)
eq('~1.2.0 includes 1.2.9', semverRangeMatch('1.2.9', '~1.2.0'), true)
eq('~1.2.0 excludes 1.3.0', semverRangeMatch('1.3.0', '~1.2.0'), false)
eq('1.2.3-rc.1 excluded by ^1.2.0', semverRangeMatch('1.2.3-rc.1', '^1.2.0'), false)
eq('^1.2.0 includes 1.9.0', semverRangeMatch('1.9.0', '^1.2.0'), true)
eq('check fail on old dsh-settings range', checkPluginFrameworkCompat({ dependencies: { '@deepseek-ai/dsh-settings': '^0.1.1-rc.2' } }, '0.1.2-rc.1').decision, 'fail')
eq('check unknown when range satisfied', checkPluginFrameworkCompat({ dependencies: { '@deepseek-ai/dsh-settings': '^0.1.2-rc.1' } }, '0.1.2-rc.1').decision, 'unknown')
eq('check pass on declared engines', checkPluginFrameworkCompat({ dsh: { engines: { framework: '>=0.1.2' } } }, '0.1.2-rc.1').decision, 'pass')
eq('check fail on declared engines mismatch', checkPluginFrameworkCompat({ dsh: { engines: { framework: '0.1.1.x' } } }, '0.1.2-rc.1').decision, 'fail')
eq('check unknown on no deps', checkPluginFrameworkCompat({}, '0.1.2-rc.1').decision, 'unknown')

rmSync(HOME, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
