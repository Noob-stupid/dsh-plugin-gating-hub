/**
 * 给已提交的 marketplace/index.json 就地补 npmName（批次 C-⑪）。
 *
 * 为什么单独有这个脚本：build-index.cjs 需要 gh CLI + 网络（本机 github 不可达时跑不了），
 * 而"补 npmName"这件事**完全离线** —— 映射来自 marketplace/npm-name-hints.json（人工核对）。
 * 用法：
 *   node scripts/apply-npm-names.cjs                     # 就地更新 marketplace/index.json
 *   node scripts/apply-npm-names.cjs --dry-run           # 只报告会改哪几条
 *   node scripts/apply-npm-names.cjs --file=<index.json> # 指定索引文件
 * 幂等：已经带 npmName 的条目内容不变；映射里没有的仓库保持原样（老索引兼容）。
 */
const fs = require('node:fs')
const path = require('node:path')
const { readNpmNameHints, withNpmNames } = require('./build-index.cjs')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const fileArg = args.find((a) => a.startsWith('--file='))
const hintsArg = args.find((a) => a.startsWith('--hints='))
const indexFile = fileArg ? fileArg.split('=')[1] : path.join(__dirname, '..', 'marketplace', 'index.json')
const hints = readNpmNameHints(hintsArg ? hintsArg.split('=')[1] : undefined)

const raw = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
const before = Array.isArray(raw.items) ? raw.items : []
const after = withNpmNames(before, hints)
const changed = after.filter((it, i) => typeof it.npmName === 'string' && before[i]?.npmName !== it.npmName)

console.log(`映射条目 ${Object.keys(hints).length} 条；索引 ${before.length} 条命中 ${changed.length} 条`)
for (const it of changed) console.log(`  ${it.fullName} → ${it.npmName}`)

if (dryRun) {
  console.log('（dry-run：未写入）')
  process.exit(0)
}
fs.writeFileSync(indexFile, JSON.stringify({ ...raw, items: after }, null, 2) + '\n', 'utf8')
console.log(`已写入 ${indexFile}`)
