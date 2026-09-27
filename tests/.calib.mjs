import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { validateAgentConfig } from '../lib/server/domain/preset-yaml.js'

const roots = []
const main = join(homedir(), '.dsh', '.agent-presets')
roots.push(main)
const backup = join(main, '_backup-20260910-155744')
if (existsSync(backup)) roots.push(backup)
// 夹具目录也一起扫（仓库里的测试夹具同样是"真文件"）
roots.push(join('tests', '.testhome-preset'))
roots.push(join('..', '.testhome-preset'))

const files = []
for (const r of roots) {
  if (!existsSync(r)) continue
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/^agent\.cordis\.ya?ml$/u.test(e.name)) files.push(p)
    }
  }
  walk(r)
}
// 仓库内所有夹具里的 agent.cordis.yml
const walkRepo = (d) => {
  let entries = []
  try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = join(d, e.name)
    if (e.isDirectory()) walkRepo(p)
    else if (/^agent\.cordis\.ya?ml$/u.test(e.name)) files.push(p)
  }
}
walkRepo('tests')
walkRepo('lib')

const uniq = [...new Set(files)]
console.log(`扫描到 ${uniq.length} 个 agent.cordis.yml/.yaml 真文件\n`)
let falsePositives = 0
for (const f of uniq) {
  const text = readFileSync(f, 'utf8')
  const r = validateAgentConfig(text)
  const tag = r.ok ? 'OK  ' : 'REJECT'
  if (!r.ok) falsePositives += 1
  console.log(`${tag}  ${f}`)
  if (!r.ok) for (const p of r.problems.slice(0, 4)) console.log(`        - ${p}`)
}
console.log(`\n误杀（真文件被判非法）：${falsePositives} / ${uniq.length}`)
