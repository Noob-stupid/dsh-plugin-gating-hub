// 批次 B-⑥（2026-09-27 改错）：读子包列表**不能写死分支**。
//
// 真机背景：zhu1090093659/dsh-web 的默认分支是 **dev**（不是 main）。
// 旧代码在"懒惰展开"里写死 `fetchSubpackageNames(repo, 'main')`（读不到才手工换 master），
// meta 探测在黑洞期失败时 branch 恒为 main → 子包永远读不到 → 又是"未发现子包"的假失败。
// 现在：以**已拿到的 meta.default_branch** 打头，再回退 main / master（去重保序）。
//
// 三个分支各有子包的场景都要覆盖（dev-only / main-only / master-only），全部离线注入。
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fetchSubpackageNames, subpackageBranchOrder } from '../lib/server/domain/market.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

// ── ① 分支顺序（纯函数）──────────────────────────────────────────────────────
{
  check('默认分支打头，其后回退 main / master',
    JSON.stringify(subpackageBranchOrder('dev')) === JSON.stringify(['dev', 'main', 'master']), JSON.stringify(subpackageBranchOrder('dev')))
  check('分支就是 main 时去重（不重复请求同一条分支）',
    JSON.stringify(subpackageBranchOrder('main')) === JSON.stringify(['main', 'master']), JSON.stringify(subpackageBranchOrder('main')))
  check('分支是 master 时同样去重', JSON.stringify(subpackageBranchOrder('master')) === JSON.stringify(['master', 'main']))
  check('拿不到默认分支（null/空）时退化成 main → master（旧行为不变）',
    JSON.stringify(subpackageBranchOrder(null)) === JSON.stringify(['main', 'master']) && JSON.stringify(subpackageBranchOrder('  ')) === JSON.stringify(['main', 'master']))
}

// ── ② 三分支覆盖：只有某一条分支上放着 packages/*/package.json ─────────────────
const tree = (names) => ({ tree: names.map((n) => ({ type: 'blob', path: `packages/${n}/package.json` })) })

async function read({ branch, subpackagesOn }) {
  const asked = []
  const subs = await fetchSubpackageNames('probe-org/agg', branch, null, {
    githubJson: async (url) => {
      const b = decodeURIComponent(String(url).split('/git/trees/')[1].split('?')[0])
      asked.push(b)
      return b === subpackagesOn ? tree(['agg-all']) : { tree: [] }
    },
    rawText: async (repo, b, path) => JSON.stringify({ name: `@probe/${path.split('/')[1]}` }),
  })
  return { subs, asked }
}

{
  const dev = await read({ branch: 'dev', subpackagesOn: 'dev' })
  check('★ dev-only 子包：以默认分支 dev 一次命中（旧代码只问 main → 读不到）',
    dev.subs.length === 1 && dev.asked[0] === 'dev' && dev.asked.length === 1, `问过 ${dev.asked.join(' → ')}`)

  const main = await read({ branch: 'dev', subpackagesOn: 'main' })
  check('★ main-only 子包：dev 读空后自动回退 main 命中（不需要调用方手工换分支）',
    main.subs.length === 1 && main.asked.join(',') === 'dev,main', `问过 ${main.asked.join(' → ')}`)

  const master = await read({ branch: 'main', subpackagesOn: 'master' })
  check('★ master-only 子包：main 读空后回退 master 命中',
    master.subs.length === 1 && master.asked.join(',') === 'main,master', `问过 ${master.asked.join(' → ')}`)

  const none = await read({ branch: 'dev', subpackagesOn: 'none' })
  check('三条分支都没有子包 → 返回空数组（如实"读不到"，不假装有）',
    none.subs.length === 0 && none.asked.join(',') === 'dev,main,master', `问过 ${none.asked.join(' → ')}`)

  const explicit = await read({ branch: ['dev'], subpackagesOn: 'none' })
  check('显式传分支数组时按数组顺序试（并把兜底分支也带上）',
    explicit.asked.join(',') === 'dev,main,master', `问过 ${explicit.asked.join(' → ')}`)
}

// ── ③ 子包名与目录解析不变（回归保护：这次只改分支选择，没动解析）─────────────────
{
  const { subs } = await read({ branch: 'dev', subpackagesOn: 'dev' })
  check('返回结构仍是 { dir, path, name }（上层 subpackageCandidates 依赖它）',
    subs[0]?.dir === 'agg-all' && subs[0]?.path === 'packages/agg-all' && subs[0]?.name === '@probe/agg-all', JSON.stringify(subs[0]))
}

// ── ④ 默认分支从 meta 来：install-job 会把 meta.default_branch 记进 job.defaultBranch ──
{
  const src = readFileSync(fileURLToPath(new URL('../lib/server/domain/install-job.js', import.meta.url)), 'utf8')
  check('★ install-job 记录 job.defaultBranch 并把它交给读子包的那一步',
    /job\.defaultBranch = branch/u.test(src)
    && /fetchSubpackageNames\(job\.repo, job\.defaultBranch \?\? 'main'/u.test(src)
    && !/fetchSubpackageNames\(job\.repo, 'main'/u.test(src),
    `defaultBranch=${/job\.defaultBranch = branch/u.test(src)} / 写死 main=${/fetchSubpackageNames\(job\.repo, 'main'/u.test(src)}`)
}

assert.ok(pass > 0)
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
