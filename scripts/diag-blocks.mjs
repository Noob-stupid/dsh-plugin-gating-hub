// 诊断工具（**不是测试**，不进 tests/ 目录、不进 CI 门禁）：打印升级/回滚脚本块的实际切分结果。
//
// 来历：原先它在 tests/ 下叫 diag-blocks.mjs，读 `lib/server/domain/framework-install-script.js`
// ——那是**从未入库**的路径（生成器现在在 lib/server/infra/fw-integrity-check.js），
// 于是它每次运行都抛 ENOENT，把全量测试拖成 35/36。诊断脚本没有断言，本就不该占测试名额；
// 正确的位置是 scripts/，而且**读不到文件时必须明说"跳过 + 原因"**，不能假装成功、也不能崩。
//
// 用法：node scripts/diag-blocks.mjs
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const readSrc = (rel) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/gu, '\n')

const SOURCES = [
  ['RFU', 'lib/server/routes/framework-upgrade.js'],
  ['FR', 'lib/server/routes/framework.js'],
  ['IDX', 'lib/index.js'],
  ['FWIS', 'lib/server/infra/fw-integrity-check.js'],
]
const endMarker = ".filter((l) => l !== '').join('\\r\\n')"
const startMarker = 'const lines = ['
let blocks = 0

for (const [name, rel] of SOURCES) {
  if (!existsSync(join(REPO, rel))) {
    // 明确跳过：打印原因（不许静默）
    console.log(`SKIP ${name} ${rel} —— 文件不在仓库里（该来源无法诊断）`)
    continue
  }
  const source = readSrc(rel)
  let at = source.indexOf(endMarker)
  while (at !== -1) {
    const from = source.lastIndexOf(startMarker, at)
    if (from === -1) {
      console.log(`WARN ${name} ${rel}@${at} —— 结束标记前找不到 'const lines = ['（该块会被抽取器静默丢弃）`)
    } else {
      const block = source.slice(from + startMarker.length - 1, at) + endMarker
      blocks += 1
      const flags = [
        `Install-Framework=${block.includes('function Install-Framework')}`,
        `Invoke-Quarantine=${block.includes('Invoke-Quarantine')}`,
        `一键回滚=${block.includes('一键回滚脚本启动')}`,
      ].join(' ')
      console.log(`#${blocks} [${name}] 长度=${block.length} ${flags}`)
      console.log(`    首行: ${JSON.stringify(block.split('\n')[0].slice(0, 90))}`)
      console.log(`    末行: ${JSON.stringify(block.split('\n').slice(-1)[0].slice(0, 90))}`)
    }
    at = source.indexOf(endMarker, at + endMarker.length)
  }
  // FWIS 用的是 `return [ … ].join('\r\n')`（没有 .filter 结束标记），单独报一次
  if (name === 'FWIS') {
    const fwStart = source.indexOf('function fwIntegrityCheck')
    console.log(fwStart === -1
      ? `WARN FWIS ${rel} —— 找不到 function fwIntegrityCheck`
      : `OK   FWIS ${rel} —— fwIntegrityCheck 在（生成"安装后结构校验"那段脚本）`)
  }
}
console.log(`共 ${blocks} 块（抽取标记：${JSON.stringify(startMarker)} → ${JSON.stringify(endMarker)}）`)
