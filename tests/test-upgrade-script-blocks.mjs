// 脚本块抽取器的可用性门禁（2026-09-27；替代原来的诊断脚本 tests/diag-blocks.mjs）
//
// ── 为什么有这个测试 ─────────────────────────────────────────────────────────
// `tests/diag-blocks.mjs` 是一个**诊断脚本**（只 console.log 事实、没有任何断言），
// 它读的 `lib/server/domain/framework-install-script.js` **从未入库**（`git log -- <路径>` 查无此文件，
// 它在 `lib/server/infra/fw-integrity-check.js` 之前的历史阶段就不存在）——于是它每次运行都抛 ENOENT，
// 全量测试长期停在 35/36。这不是"少了一个文件"，而是抽取器的一类真实退化：
//   **读不到的源文件会被静默跳过**（`if (from !== -1)` / `out.push` 缺失），
//   下游 `test-upgrade-script-syntax.mjs` 只能看到"找不到升级脚本块"这种二手结论。
//
// 本测试把抽取器的三个前提变成硬断言：
//   ① 抽取器读的源文件必须**真实存在**（缺一个就红，绝不 SKIP、绝不静默）；
//   ② 每个「结束标记」都必须能配对到前面的「开始标记」（配不上 = 脚本块被静默丢掉）；
//   ③ 升级脚本 / 一键回滚脚本 / 安装后结构校验生成器 / 重启脚本 四类块各就各位。
// 另外加一条通用护栏：**tests/*.mjs 里静态引用的仓库路径必须存在** —— 这正是 diag-blocks 那类事故的机制化拦网。
//
// 全部离线、确定性：只读源码文本，不跑 PowerShell（真跑与语法校验仍归 test-upgrade-script-syntax.mjs）。
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

/** 与 test-upgrade-script-syntax.mjs 同款归一化：仓库工作区是 CRLF，抽取标记按 LF 写。 */
const readSrc = (rel) => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/gu, '\n')

// ── ① 源文件必须真实存在（diag-blocks 事故的直接原因）────────────────────────────
// 抽取器扫这三处找 `.filter((l) => l !== '').join('\r\n')`（升级 / 回滚 / 重启），
// 外加 infra 里的结构校验生成器（`return [ … ].join('\r\n')`）。
const SOURCES = [
  'lib/index.js',
  'lib/server/routes/framework-upgrade.js',
  'lib/server/routes/framework.js',
  'lib/server/infra/fw-integrity-check.js',
]
const missingSources = SOURCES.filter((rel) => !existsSync(join(REPO, rel)))
check(`抽取器读的 ${SOURCES.length} 个源文件都在仓库里`,
  missingSources.length === 0,
  missingSources.length === 0 ? SOURCES.join(', ') : `缺失（缺文件必须红，不许静默跳过）: ${missingSources.join(', ')}`)

const SRC = readSrc(SOURCES[0])
const SRC_RFU = readSrc(SOURCES[1])
const SRC_FR = readSrc(SOURCES[2])
const SRC_FWIS = readSrc(SOURCES[3])

// ── ② 开始/结束标记必须一一配对（配不上 = 整段脚本被静默丢弃）────────────────────
const END_MARKER = ".filter((l) => l !== '').join('\\r\\n')"
const START_MARKER = 'const lines = ['
const countOf = (text, needle) => text.split(needle).length - 1

/** 从源码中抽出全部脚本块：以结束标记为锚点**回推**最近的开始标记（与真测试同一套逻辑）。 */
function extractBlocks(sources) {
  const out = []
  const orphans = []
  for (const [name, source] of sources) {
    let at = source.indexOf(END_MARKER)
    while (at !== -1) {
      const from = source.lastIndexOf(START_MARKER, at)
      if (from === -1) orphans.push(`${name}@${at}`)
      else out.push({ name, block: source.slice(from + START_MARKER.length - 1, at) + END_MARKER })
      at = source.indexOf(END_MARKER, at + END_MARKER.length)
    }
  }
  return { out, orphans }
}

const scan = [['routes/framework-upgrade.js', SRC_RFU], ['routes/framework.js', SRC_FR], ['lib/index.js', SRC]]
const { out: blocks, orphans } = extractBlocks(scan)
check('每个结束标记都能配对到开始标记（没有块被静默丢弃）',
  orphans.length === 0, orphans.length === 0 ? `共 ${blocks.length} 块` : `孤立结束标记: ${orphans.join(', ')}`)
const markerPairs = scan.every(([, source]) => countOf(source, END_MARKER) <= countOf(source, START_MARKER))
check('结束标记数不超过开始标记数（配对关系成立）', markerPairs,
  scan.map(([name, source]) => `${name}: start=${countOf(source, START_MARKER)} end=${countOf(source, END_MARKER)}`).join(' | '))

// ── ③ 四类块各就各位 ──────────────────────────────────────────────────────────
const installBlock = blocks.find((b) => b.block.includes('function Install-Framework')) ?? null
const rollbackBlock = blocks.find((b) => b.block.includes('一键回滚脚本启动')) ?? null
check('源码里能找到升级脚本块（function Install-Framework）', installBlock !== null, `共 ${blocks.length} 块`)
check('源码里能找到一键回滚脚本块（一键回滚脚本启动）', rollbackBlock !== null, `共 ${blocks.length} 块`)
check('两个脚本块不是同一段（避免"覆盖假象"）',
  installBlock !== null && rollbackBlock !== null && installBlock.block !== rollbackBlock.block)
for (const [name, found] of [['升级脚本', installBlock], ['一键回滚脚本', rollbackBlock]]) {
  check(`${name}：块以数组字面量开头、以 join('\\r\\n') 结尾且长度合理`,
    found !== null && found.block.trimStart().startsWith('[') && found.block.trimEnd().endsWith(END_MARKER) && found.block.length > 400,
    found === null ? '（未找到）' : `${found.block.length} 字符（来自 ${found.name}）`)
}

// 安装后结构校验生成器（2026-09-24 事故后加的）：源文件是 infra/fw-integrity-check.js，
// 历史上曾被错误地记成 domain/framework-install-script.js —— 这里把**真实位置**钉死。
const fwisStart = SRC_FWIS.indexOf('function fwIntegrityCheck')
const fwisBody = fwisStart === -1 ? '' : SRC_FWIS.slice(fwisStart)
check('安装后结构校验生成器在 infra/fw-integrity-check.js 里（不是已消失的 framework-install-script.js）',
  fwisStart !== -1 && fwisBody.includes('return [') && fwisBody.includes(".join('\\r\\n')"),
  fwisStart === -1 ? '未找到 function fwIntegrityCheck' : `函数体 ${fwisBody.length} 字符`)
// 回归钉死：那个从未入库的路径不得再被任何测试引用（本文件自身只允许在文档/负断言里提到它）。
const staleRefTests = readdirSync(ROOT)
  .filter((f) => f.endsWith('.mjs') && f !== 'test-upgrade-script-blocks.mjs')
  .filter((f) => readFileSync(join(ROOT, f), 'utf8').includes('framework-install-script.js'))
check('没有别的测试再引用从未入库的 framework-install-script.js',
  staleRefTests.length === 0, staleRefTests.join('、') || '（无）')
check('该路径在仓库里确实不存在（现状钉死，防止有人"补一个空壳文件"骗绿）',
  !existsSync(join(REPO, 'lib', 'server', 'domain', 'framework-install-script.js')))

// 重启脚本（v0.3.43）：两个数组字面量直接 `writeFile`，没有 join 结束标记 —— 用下标扫描抽。
const extractArray = (marker) => {
  const from = SRC_FR.indexOf(marker)
  if (from === -1) return ''
  const lines = SRC_FR.slice(from).split('\n')
  const out = []
  for (const line of lines) {
    out.push(line)
    if (out.length > 1 && line.trim() === ']') break
  }
  return out.length > 1 ? out.slice(1).join('\n') : ''
}
for (const [name, marker] of [['重启主脚本', 'const mainLines = ['], ['重启守护脚本', 'const guardLines = [']]) {
  const body = extractArray(marker)
  check(`${name}：数组块能抽出来且非空`, body !== '' && body.length > 300, `${body.length} 字符`)
}

// ── ④ 通用护栏：tests/*.mjs 静态引用的仓库路径必须存在 ───────────────────────────
// 事故形态：测试写了 `join(ROOT, '..', 'lib', 'server', 'domain', 'framework-install-script.js')`，
// 那个文件从未入库 —— 测试不是"红得有意义"，而是抛 ENOENT，看起来像环境问题。
// 这里把"引用了不存在的仓库路径"变成一条明确的 FAIL（只查字面量路径，动态拼的不误报）。
const PATH_REF_RE = /join\(ROOT,\s*'\.\.'\s*,\s*((?:'[^']*'\s*,\s*)*'[^']*')\)/gu
const missingRefs = []
for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue
  const text = readFileSync(join(ROOT, entry.name), 'utf8').replace(/^\s*\/\/.*$/gmu, '')
  for (const m of text.matchAll(PATH_REF_RE)) {
    // `existsSync(join(…))` 是**存在性探测**（负断言/能力探测），不是"假设它存在"，跳过不误报
    if (/existsSync\($/u.test(text.slice(Math.max(0, m.index - 11), m.index))) continue
    const literal = m[1].match(/'[^']*'/gu) ?? []
    const segs = literal.map((s) => s.slice(1, -1))
    const last = segs[segs.length - 1] ?? ''
    if (!/\.[A-Za-z0-9]+$/u.test(last)) continue // 只看"像文件"的引用（目录引用不查）
    if (!existsSync(join(REPO, ...segs))) missingRefs.push(`${entry.name}: ${segs.join('/')}`)
  }
}
check('tests/*.mjs 里静态引用的仓库文件都存在（防"引用从未入库的文件"复发）',
  missingRefs.length === 0, missingRefs.length === 0 ? '全部存在' : `缺失: ${missingRefs.join('、')}`)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
