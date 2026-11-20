// issue #29：系统 tmpdir 不再进默认 trash 扫描根。
// 这钉住的是“启动不再同步遍历 %TEMP%”，同时保留 profile node_modules / repos 的清理能力。
import { strict as assert } from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trashScanRoots } from '../lib/server/infra/fsx.js'

const profile = 'C:/dsh/profiles/desktop'
const roots = trashScanRoots({ profileDir: profile, extra: ['C:/dsh/repos', 'C:/dsh/skills'] })
assert.equal(roots.includes(tmpdir()), false, '系统 tmpdir 不应出现在默认扫描根里')
assert.equal(roots.some((r) => r.endsWith(join('profiles', 'desktop', 'node_modules'))), true, 'profile node_modules 必须保留')
assert.equal(roots.includes('C:/dsh/repos'), true)
assert.equal(roots.includes('C:/dsh/skills'), true)
assert.deepEqual(trashScanRoots({}), [], '没有 profile/extra 时不应默认扫 tmpdir')
console.log('PASS ① 默认扫描根不含系统 tmpdir')
console.log('PASS ② profile node_modules / extra 仍保留')
console.log('PASS ③ 空参数返回空根（不扫 tmpdir）')
console.log('\nALL PASS')
