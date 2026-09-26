// ② pnpm 健壮性注入（env + add 选项），2026-09-26
//
// 交付三件事：
//   ① env 构造函数可测：pnpmEnvOverrides / buildPnpmEnv（在既有 env 之上**追加**
//      npm_config_fetch_timeout=60000 / npm_config_fetch_retries=1 / CI=true，不动 registry 与 gitEnv 逻辑）
//   ② 参数构造函数可测：pnpmAddArgs / pnpmFetchArgs（`pnpm add` 追加 --fetch-timeout/--fetch-retries）
//   ③ 加固不会变成"装不上"：某版本 pnpm 不认这两个选项（`Unknown options: 'fetch-timeout'…`）时，
//      pnpmInstall 自动去掉加固选项重试一次
// 并且**真跑一次 pnpm**（本地"只挂连接、永不响应"的假 registry，全离线）做 A/B：
//   带 --fetch-timeout=4000 会早退（实测 ~4.8s），不带就一直挂着（我们 12s 砍掉它）。
//   这一条同时是"仅靠 npm_config_fetch_* env 无效"的证据来源（见 infra/exec.js 注释与本仓报告）。
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { removeDirVerifiedAsync } from '../lib/server/infra/fsx.js'
import { buildPnpmEnv, pnpmAddArgs, pnpmEnvOverrides, pnpmFetchArgs, resolvePnpmRunners, unknownPnpmOption } from '../lib/server/infra/exec.js'
import { pnpmInstall } from '../lib/server/domain/install.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

// ── ① env 构造（纯函数）─────────────────────────────────────────────────────
{
  const reg = 'https://registry.npmmirror.com'
  const o = pnpmEnvOverrides(reg)
  check('pnpmEnvOverrides：三个健壮性键 + registry 镜像',
    o.npm_config_fetch_timeout === '60000' && o.npm_config_fetch_retries === '1' && o.CI === 'true' && o.COREPACK_NPM_REGISTRY === reg,
    JSON.stringify(o))
  const nomirror = pnpmEnvOverrides(undefined)
  check('pnpmEnvOverrides：没传 registry 时不写 COREPACK_NPM_REGISTRY（不塞 undefined）',
    !('COREPACK_NPM_REGISTRY' in nomirror) && nomirror.CI === 'true')

  process.env.__DSH_ENV_SENTINEL__ = 'keep-me'
  const base = { ...process.env, GIT_ASKPASS: 'echo', CUSTOM_VAR: 'x' }
  const env = buildPnpmEnv(reg, base)
  // 注意：Windows 上 process.env 的键名大小写原样保留（`Path` 不是 `PATH`），所以逐键比对而不是比 PATH
  const overridden = new Set(['GIT_TERMINAL_PROMPT', 'GCM_INTERACTIVE', 'CI', 'npm_config_fetch_timeout', 'npm_config_fetch_retries', 'COREPACK_NPM_REGISTRY'])
  const kept = Object.entries(base).filter(([k, v]) => !overridden.has(k) && env[k] !== v)
  check('buildPnpmEnv：既有 env 原样保留（只追加覆盖项）',
    kept.length === 0 && env.CUSTOM_VAR === 'x' && env.GIT_ASKPASS === 'echo' && env.__DSH_ENV_SENTINEL__ === 'keep-me',
    kept.map(([k]) => k).join(',') || `keys base=${Object.keys(base).length} env=${Object.keys(env).length}`)
  check('buildPnpmEnv：git 禁交互语义不变（GIT_TERMINAL_PROMPT=0 / GCM_INTERACTIVE=never）',
    env.GIT_TERMINAL_PROMPT === '0' && env.GCM_INTERACTIVE === 'never')
  check('buildPnpmEnv：registry 镜像走 COREPACK_NPM_REGISTRY（与旧实现一致）', env.COREPACK_NPM_REGISTRY === reg)
  delete process.env.__DSH_ENV_SENTINEL__
}

// ── ② 参数构造（纯函数）─────────────────────────────────────────────────────
{
  const args = pnpmAddArgs('left-pad', 'https://registry.npmmirror.com')
  check('pnpmAddArgs：add <spec> --registry <reg> 前缀不变（既有语义）',
    args[0] === 'add' && args[1] === 'left-pad' && args[2] === '--registry' && args[3] === 'https://registry.npmmirror.com', args.join(' '))
  check('pnpmAddArgs：追加 --fetch-timeout=60000 / --fetch-retries=1',
    args.includes('--fetch-timeout=60000') && args.includes('--fetch-retries=1'))
  check('pnpmFetchArgs：可参数化（真实验证时要缩短超时）', pnpmFetchArgs(4000, 0).join(' ') === '--fetch-timeout=4000 --fetch-retries=0')
  const bare = pnpmAddArgs('left-pad', undefined)
  check('pnpmAddArgs：registry 为空时不拼 `--registry undefined`（旧实现的垃圾参数）',
    !bare.includes('--registry') && !bare.join(' ').includes('undefined'), bare.join(' '))
  check('pnpmAddArgs：fetchFlags=false 时只留原参数（降级用）',
    pnpmAddArgs('left-pad', 'https://r', { fetchFlags: false }).join(' ') === 'add left-pad --registry https://r')
  check('unknownPnpmOption：认 pnpm 的真实报错文案',
    unknownPnpmOption("[ERROR] Unknown options: 'fetch-timeout', 'fetch-retries'") === true
    && unknownPnpmOption('ERR_PNPM_FETCH_404') === false)
}

// ── ③ pnpmInstall 接线（注入 run，离线断言"参数/env 真的传下去了"）──────────
{
  const calls = []
  const okRun = async (args, opts) => { calls.push({ args, opts }) }
  const res = await pnpmInstall('C:/tmp/profile', 'left-pad', 'https://registry.npmmirror.com', 12345, null, { run: okRun })
  check('pnpmInstall：成功路径返回值仍是 undefined（未改公开语义）', res === undefined)
  check('pnpmInstall：只跑一次，参数含 registry 与两个加固选项',
    calls.length === 1 && calls[0].args.includes('--fetch-timeout=60000') && calls[0].args.includes('--fetch-retries=1'), calls[0]?.args.join(' '))
  check('pnpmInstall：env 真带上了三个健壮性键 + 镜像 + 禁交互',
    calls[0]?.opts?.execOpts?.env?.npm_config_fetch_timeout === '60000'
    && calls[0]?.opts?.execOpts?.env?.npm_config_fetch_retries === '1'
    && calls[0]?.opts?.execOpts?.env?.CI === 'true'
    && calls[0]?.opts?.execOpts?.env?.COREPACK_NPM_REGISTRY === 'https://registry.npmmirror.com'
    && calls[0]?.opts?.execOpts?.env?.GIT_TERMINAL_PROMPT === '0')
  check('pnpmInstall：timeout 原样透传（失败路径语义不变）', calls[0]?.opts?.execOpts?.timeout === 12345)

  // 不认加固选项的 pnpm → 去掉加固重试一次（且只重试一次）
  const downgrade = []
  const pickyRun = async (args) => {
    downgrade.push(args.join(' '))
    if (args.includes('--fetch-timeout=60000')) throw new Error("[ERROR] Unknown options: 'fetch-timeout', 'fetch-retries'")
  }
  let downgradeError = null
  try { await pnpmInstall('C:/tmp/profile', 'left-pad', 'https://r', 1000, null, { run: pickyRun }) } catch (error) { downgradeError = error }
  check('加固选项不被支持时：去掉后重试一次并成功（加固不导致装不上）',
    downgradeError === null && downgrade.length === 2 && !downgrade[1].includes('--fetch-timeout'), downgrade.join(' || '))

  // 真实安装失败（非 Unknown option）→ 原样抛出，不重试（不改变既有失败语义）
  const realFail = []
  const failingRun = async (args) => { realFail.push(args.join(' ')); throw new Error('ERR_PNPM_FETCH_404  left-pad: Not found') }
  const caught = await pnpmInstall('C:/tmp/profile', 'left-pad', 'https://r', 1000, null, { run: failingRun }).then(() => null, (error) => error)
  check('普通失败：只跑一次、原样抛出（不吞错、不加试）',
    realFail.length === 1 && /ERR_PNPM_FETCH_404/u.test(caught?.message ?? ''), caught?.message)
}

// ── 真实 pnpm A/B：加固选项真的有效（本地假 registry，离线）───────────────────
if (process.env.DSH_TEST_SKIP_NETWORK === '1') {
  console.log('SKIP 真实 pnpm A/B（DSH_TEST_SKIP_NETWORK=1）')
} else {
  const runners = resolvePnpmRunners()
  const runner = runners[0]
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pnpm-env-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe', private: true, version: '1.0.0' }, null, 2), 'utf8')
  const server = createServer(() => { /* 只挂连接、永不响应 */ })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const stall = `http://127.0.0.1:${server.address().port}`
  /** 用真实 runner 跑一次 `pnpm add`（args 由被测的 pnpmAddArgs 生成），返回耗时/退出码。 */
  const runPnpm = (args, env, capMs) => new Promise((resolve) => {
    const started = Date.now()
    const { bin, argv } = runner.run(args)
    const child = spawn(bin, argv, { cwd: dir, env: { ...process.env, ...env }, windowsHide: true })
    let stderr = ''
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    const timer = setTimeout(() => { try { child.kill() } catch {} }, capMs)
    child.on('close', (code) => { clearTimeout(timer); resolve({ ms: Date.now() - started, code, capped: Date.now() - started >= capMs, stderr: stderr.slice(-200) }) })
  })
  try {
    const withFlags = await runPnpm(pnpmAddArgs('left-pad', stall, { fetchTimeoutMs: 4000, fetchRetries: 0 }), buildPnpmEnv(stall), 20000)
    check('真 pnpm：带 --fetch-timeout=4000 时早退（选项真的被读到了）',
      withFlags.capped === false && withFlags.ms < 20000, `${withFlags.ms}ms code=${withFlags.code} ${withFlags.stderr.replace(/\s+/gu, ' ').slice(0, 80)}`)

    const runArgv = runner.run(pnpmAddArgs('left-pad', stall, { fetchFlags: false })).argv
    const noFlags = await runPnpm(pnpmAddArgs('left-pad', stall, { fetchFlags: false }), buildPnpmEnv(stall), 12000)
    check('真 pnpm：不带选项时 12s 内不会自己退出（证明早退来自我们的选项，而不是环境）',
      noFlags.capped === true, `${noFlags.ms}ms code=${noFlags.code} argv=${runArgv.join(' ')}`)

    const envOnly = await runPnpm(pnpmAddArgs('left-pad', stall, { fetchFlags: false }), { ...buildPnpmEnv(stall), npm_config_fetch_timeout: '4000', npm_config_fetch_retries: '0' }, 12000)
    check('真 pnpm：只注入 npm_config_fetch_* env 时同样不会早退（pnpm 11 不读这两个键 —— 如实记录，不假装有效）',
      envOnly.capped === true, `${envOnly.ms}ms code=${envOnly.code}`)
  } finally {
    server.close()
    // 本机实测 rmSync 会静默落空（目录仍在、不抛错）→ 用仓库自己的"删除+核实"助手
    try {
      const cleaned = await removeDirVerifiedAsync(dir, { attempts: 1, pollMs: 400 })
      if (cleaned.ok !== true) console.log(`（提示：临时目录未能删除：${dir} — ${cleaned.error ?? '未知'}）`)
    } catch {}
  }
}

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
