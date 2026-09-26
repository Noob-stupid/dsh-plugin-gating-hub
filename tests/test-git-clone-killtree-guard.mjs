// 静态护栏（2026-09-26）：所有 git clone 调用点必须走 execFileWithKillTree（杀整棵进程树）。
// 背景：git clone 会派生 git remote-https / index-pack 孙进程；超时只杀直接子进程时，
// 它们会一直占着 .git 下的文件 → 目录删不掉 → 用户看到误导性报错（真机 2026-09-26 桌面端事故）。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILES = [
  'lib/server/domain/repoland.js',
  'lib/server/domain/ai-run.js',
  'lib/server/domain/skills.js',
  'lib/server/domain/components.js',
]
let pass = 0
let fail = 0
const check = (name, ok, info = '') => { if (ok) { pass += 1; console.log(`PASS ${name}`) } else { fail += 1; console.log(`FAIL ${name} — ${info}`) } }

for (const rel of FILES) {
  const src = readFileSync(join(ROOT, rel), 'utf8')
  const cloneLines = src.split(/\r?\n/u).filter((l) => /['"]clone['"]/u.test(l) && /execFileAsync\(|execFileWithKillTree\(/u.test(l))
  // components.js 当前没有 git clone（只 clone 在 repoland/ai-run/skills 里）→ 只要求「若有则必须走杀树版」
  const bad = cloneLines.filter((l) => /execFileAsync\(/u.test(l))
  check(`${rel}：git clone 不再用裸 execFileAsync`, bad.length === 0, bad.join(' | ').slice(0, 140))
}
// repoland.js 用的是自己的 spawn + killProcessTree（等价能力），单独断言
{
  const src = readFileSync(join(ROOT, 'lib/server/domain/repoland.js'), 'utf8')
  check('repoland.js：git 通道有杀树能力', /killProcessTree/u.test(src) && /spawnFn/u.test(src))
  check('repoland.js：杀树实现来自 infra/exec.js（单一实现）', /from '\.\.\/infra\/exec\.js'/u.test(src))
}
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
