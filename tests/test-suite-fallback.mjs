// 套装链修复（0.5.19）· 改错①：**套装仓库克隆失败必须回落普通通道**，不再把作业判成 failed。
//
// 真机事故（2026-09-27，用户点装 zhu1090093659/dsh-web 全家桶 429 MB）：套装的第一步就是 clone
// 整个仓库，而它必然失败（429 MB 巨仓 + ghproxy 的 git 协议 0 B/s）。旧代码整个 runSuiteInstallJob
// 只有一个 try/catch → 克隆一失败就 job.status='failed'；而 notASuite（把决定权交回普通通道）
// **只在"克隆成功但 .gitmodules 为空"时才返回** —— 克隆失败等于没有任何回落，用户只看到一个失败的任务。
// 本文件把两条回落路径都钉死（都不联网：克隆实现由 deps.gitClone 注入）。
import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runSuiteInstallJob } from '../lib/server/domain/suite.js'
import { disposeDir } from '../lib/server/infra/fsx.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const HOME = join(tmpdir(), `dsh-suite-fallback-${process.pid}`)
disposeDir(HOME)
mkdirSync(join(HOME, 'profiles', 'web'), { recursive: true })
const savedHome = process.env.DSH_HOME
process.env.DSH_HOME = HOME
const ports = { get: () => undefined }

// ── ① 根克隆失败 → notASuite（旧代码在这里把作业判成 failed，且没有任何回落）────────────────
{
  const job = { id: 'job-clone-fail', repo: 'probe-org/suite-clone-fail', source: 'github', status: 'installing', stage: 'preparing', kind: 'suite' }
  let thrown = null
  let result = null
  try {
    result = await runSuiteInstallJob(job, ports, { gitClone: async () => { throw new Error('桩：克隆必败（429 MB 巨仓 / 源 0 B/s）') } })
  } catch (error) { thrown = error }
  check('① 根克隆抛错 → 不抛出、返回 notASuite（不再把作业判 failed）',
    thrown === null && result !== null && result.notASuite === true && job.status !== 'failed',
    `thrown=${thrown === null ? 'null' : String(thrown.message).slice(0, 80)} result=${JSON.stringify(result)} status=${job.status}`)
  check('① 回落原因带上了克隆错误原文（面板可见，不再谎报成"内容不符"）',
    /克隆失败/u.test(String(result?.reason ?? '')) && /桩：克隆必败/u.test(String(result?.reason ?? '')), String(result?.reason ?? '').slice(0, 140))
  check('① 作业没有被写成 error（旧的 job.error / job.status=failed 分支不再命中）',
    job.status !== 'failed' && (job.error === undefined || job.error === null), `status=${job.status} error=${String(job.error ?? '')}`)
}

// ── ② 克隆成功但 .gitmodules 为空 → 仍走原回落路径（不回归）──────────────────────────────
{
  const job = { id: 'job-empty-gitmodules', repo: 'probe-org/suite-empty', source: 'github', status: 'installing', stage: 'preparing', kind: 'suite' }
  const result = await runSuiteInstallJob(job, ports, { gitClone: async () => {} })
  check('② 克隆成功 + .gitmodules 为空 → notASuite（原有回落路径不变）',
    result?.notASuite === true && job.status !== 'failed', `notASuite=${result?.notASuite} status=${job.status}`)
}

if (savedHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = savedHome
disposeDir(HOME)
assert.ok(pass > 0)
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
