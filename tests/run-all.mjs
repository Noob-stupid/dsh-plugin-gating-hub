// 本机全量测试运行器（与 .github/workflows/test.yml 的四步一一对应；只在本机用，不进 CI）
// 用法：node tests/run-all.mjs
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const all = readdirSync(join(ROOT, 'tests')).filter((f) => f.startsWith('test-') && f.endsWith('.mjs')).sort()

const UNIT = all.filter((f) => !/test-real-|test-install-smoke|test-framework-upgrade|test-bundle-guard|test-issue15-resolve|test-suite-install|test-registry-scan|test-preset-migration|test-upgrade-script-syntax|test-preflight-disable|test-lockfile-repair/u.test(f))
const ENV = all.filter((f) => /test-framework-upgrade|test-bundle-guard|test-issue15-resolve|test-suite-install|test-registry-scan|test-preset-migration|test-upgrade-script-syntax|test-preflight-disable|test-lockfile-repair/u.test(f))
const REAL = all.filter((f) => /test-real-|test-install-smoke/u.test(f))

const suites = [
  ['unit（DSH_TEST_SKIP_NETWORK=1）', UNIT, { DSH_TEST_SKIP_NETWORK: '1' }],
  ['real smoke（真网络）', REAL, { DSH_TEST_SKIP_NETWORK: '' }],
  ['env-dependent（本机有 profile 就真跑）', ENV, { DSH_TEST_SKIP_NETWORK: '1' }],
]

let failed = 0
let total = 0
for (const [name, files, env] of suites) {
  console.log(`\n===== ${name}：${files.length} 套 =====`)
  for (const f of files) {
    total += 1
    const t = Date.now()
    const r = spawnSync(process.execPath, [join(ROOT, 'tests', f)], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, ...env },
      maxBuffer: 32 * 1024 * 1024,
    })
    const ms = Date.now() - t
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    const tail = out.trim().split('\n').slice(-1)[0] ?? ''
    // 失败判据：非零退出码，或输出里出现"FAIL <断言名>"、"N FAILED"、"N FAILED（…）"
    const bad = r.status !== 0 || /^FAIL /mu.test(out) || /\d+ FAILED/mu.test(out) || /ALL PASS/u.test(out) === false
    if (bad) failed += 1
    console.log(`${bad ? '❌' : '✅'} ${f}  exit=${r.status}  ${(ms / 1000).toFixed(1)}s  ${tail.slice(0, 120)}`)
    if (bad) console.log(out.split('\n').filter((l) => /FAIL/u.test(l)).slice(0, 12).join('\n'))
  }
}
console.log(`\n全量：${total} 套，失败 ${failed} 套`)
process.exit(failed === 0 ? 0 : 1)
