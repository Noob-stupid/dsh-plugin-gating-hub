// 0.5.48 · 供应链闸门（minimumReleaseAge）在**非交互**下必须快速如实失败，而不是挂住。
//
// 现场（用户实测，装 ds-bot 时撞出来）：
//   pnpm 的 minimumReleaseAge 闸门拦下 @noob-stupid/dsh-plugin-console@0.5.47（版本太新）⇒
//   pnpm **弹交互提问**等人回答；而桌面壳/e服务进程给的是**永不关闭的 stdin 管道**
//   ⇒ 不抛错、不超时，**永久挂住**（实测两次分别挂到 90s / 180s 被杀）。
//
// 闸门实现（本机 pnpm 11.7.0 dist/pnpm.mjs，只读反编译取证）：
//   L194277  const inCi = opts3.ci ?? isCI
//   L194278  const canPrompt = !inCi && Boolean(process.stdin.isTTY)
//   L194305  if (canPrompt) { await promptForApproval(immature) }   ← 挂在这里
//   L194330    confirmed = await dist_default5({ message, default: false })  ← prompt 库读 stdin 到 EOF
//   L194307  else { throw failOnImmature(immature) }                ← 我们要走的分支
//
// 本套钉死的语义（**全离线**：不 spawn 真 pnpm、不出网、不碰任何 profile）：
//   ① `pnpm add` 的 env 与 argv 都带 pnpm 自己的非交互位（npm_config_ci / --config.ci=true）；
//   ② 命中闸门 ⇒ 抛出的错误含三要素：**哪个包** · **命中哪条闸** · **怎么加白名单**；
//   ③ 命中闸门 ⇒ **不重试**（重试只会再挂一轮），第一次抛错就收工；
//   ④ 红线：产出里**绝不**出现 --trust-lockfile 一类绕过闸门的手段；
//   ⑤ 非闸门的普通失败 ⇒ 语义不变（原样抛出，不被包装成闸门错误）。
import { strict as assert } from 'node:assert'
import {
  pnpmAddArgs, pnpmEnvOverrides, buildPnpmEnv, releaseAgeGateHit,
  releaseAgeBlockedSpecs, releaseAgeGateError, runPnpmAdd,
} from '../lib/server/infra/exec.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

// ── ① 非交互开关：env 与 argv 两条线索都要有 ───────────────────────────────────
{
  const env = pnpmEnvOverrides(null)
  check('★ env 带 pnpm 自己的 ci 位（npm_config_ci=true）—— 只给 CI=true 不够',
    env.npm_config_ci === 'true' && env.CI === 'true', JSON.stringify({ CI: env.CI, npm_config_ci: env.npm_config_ci }))
  const args = pnpmAddArgs('ds-bot', 'https://registry.example/', { fetchFlags: false })
  check('★ argv 带官方非交互开关 --config.ci=true',
    args.includes('--config.ci=true'), JSON.stringify(args))
  check('registry 为空串时不拼 --registry（老语义不变）',
    !pnpmAddArgs('ds-bot', '', { fetchFlags: false }).includes('--registry'))
  check('buildPnpmEnv 真的把 ci 位带进最终 env',
    buildPnpmEnv(null, {}).npm_config_ci === 'true')
}

// ── ② 闸门判据：两代真实文案都要认 ─────────────────────────────────────────────
{
  check('★ 认 pnpm 11.7.0 的违规码 MINIMUM_RELEASE_AGE_VIOLATION',
    releaseAgeGateHit('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION') === true)
  check('★ 认严格模式不可交互时的 NO_MATURE_MATCHING_VERSION（failOnImmature 抛的那个）',
    releaseAgeGateHit('pnpm error NO_MATURE_MATCHING_VERSION') === true)
  check('认用户拒绝时的 MINIMUM_RELEASE_AGE_DENIED', releaseAgeGateHit('MINIMUM_RELEASE_AGE_DENIED') === true)
  check('★ 普通网络失败**不得**被误判成闸门',
    releaseAgeGateHit('ETIMEDOUT registry.example') === false
    && releaseAgeGateHit('Unknown options: fetch-timeout') === false
    && releaseAgeGateHit('') === false)
  check('从 pnpm 原始输出里抠出 包@版本',
    JSON.stringify(releaseAgeBlockedSpecs('1 version does not meet the minimumReleaseAge constraint:\n  @noob-stupid/dsh-plugin-console@0.5.47 (published 2026-10-13)'))
      === JSON.stringify(['@noob-stupid/dsh-plugin-console@0.5.47']))
  check('抠不出包名时安全返回空数组（不抛）', Array.isArray(releaseAgeBlockedSpecs('')) && releaseAgeBlockedSpecs('').length === 0)
}

// ── ③ 错误的三要素 + 不绕过红线 ───────────────────────────────────────────────
{
  const raw = 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION  1 version does not meet the minimumReleaseAge constraint:\n'
    + '  @noob-stupid/dsh-plugin-console@0.5.47 (published 2026-10-13T00:00:00.000Z)'
  const err = releaseAgeGateError({ spec: '@noob-stupid/dsh-plugin-console@0.5.48', profileDir: 'C:\\p\\web', message: raw })
  const text = err.message
  check('★ 要素一「哪个包」：错误里点名被拦下的包@版本',
    text.includes('@noob-stupid/dsh-plugin-console@0.5.47'), err.blocked.join(','))
  check('★ 要素二「命中哪条闸」：写明 minimumReleaseAge',
    text.includes('minimumReleaseAge'))
  check('★ 要素三「怎么加白名单」：给出 minimumReleaseAgeExclude 的具体写法',
    text.includes('minimumReleaseAgeExclude') && text.includes('- \'@noob-stupid/dsh-plugin-console@0.5.47\''))
  check('说清"逐版本匹配"这个坑（否则用户加了 0.5.47 下次仍会撞）',
    text.includes('逐版本'))
  check('带上目标 profile 便于定位', text.includes('C:\\p\\web'))
  check('结构化字段可断言（name/code/gate/blocked）',
    err.name === 'PnpmSupplyChainGateError' && err.code === 'DSH_PNPM_RELEASE_AGE_GATE'
    && err.gate === 'minimumReleaseAge' && Array.isArray(err.blocked))
  check('★ 红线：产出里**绝不**含 --trust-lockfile / --no-verify 一类绕过闸门的手段',
    !/trust-lockfile|trustLockfile|--no-verify|--force\b/u.test(text))
}

// ── ④ 端到端（注入 run，零进程/零网络）：命中闸门 ⇒ 快速失败、不重试、不挂住 ──────
{
  // 「不挂住」的可失败断言：注入的 run 立刻抛闸门错误 ⇒ runPnpmAdd 必须**立即**返回（抛错），
  // 而不是等一个永不 resolve 的 promise。用超时护栏把"挂住"变成红色而不是把测试卡死。
  const withTimeout = (p, ms) => Promise.race([
    p.then(() => 'resolved', (e) => e),
    new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), ms)),
  ])
  const gateMsg = 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION  1 version does not meet the minimumReleaseAge constraint:\n'
    + '  @noob-stupid/dsh-plugin-console@0.5.47 (published 2026-10-13T00:00:00.000Z)'
  let calls = 0
  const gateResult = await withTimeout(runPnpmAdd({
    profileDir: 'C:\\p\\web', spec: '@noob-stupid/dsh-plugin-console@0.5.48',
    deps: { run: async () => { calls += 1; throw new Error(gateMsg) } },
  }), 3000)
  check('★ 闸门命中 ⇒ 不挂住（3 秒护栏内返回）', gateResult !== 'TIMEOUT')
  check('★ 闸门命中 ⇒ 抛出带解法的专用错误（不是原样 pnpm 文本）',
    gateResult instanceof Error && gateResult.code === 'DSH_PNPM_RELEASE_AGE_GATE',
    gateResult === 'TIMEOUT' ? 'TIMEOUT' : String(gateResult?.code ?? gateResult))
  check('★ 闸门命中 ⇒ **不重试**（只调用了一次 pnpm）', calls === 1, `calls=${calls}`)
  if (gateResult instanceof Error) {
    check('★ 快速失败的错误三要素齐全',
      gateResult.message.includes('@noob-stupid/dsh-plugin-console@0.5.47')
      && gateResult.message.includes('minimumReleaseAge')
      && gateResult.message.includes('minimumReleaseAgeExclude'))
  } else {
    check('★ 快速失败的错误三要素齐全', false, 'no error thrown')
  }
}

// ── ⑤ 普通失败语义不变：原样抛出，不被包装；Unknown options 仍会降级重试一次 ────
{
  let calls = 0
  const plain = await runPnpmAdd({
    profileDir: 'C:\\p\\web', spec: 'ds-bot',
    deps: { run: async () => { calls += 1; throw new Error('ETIMEDOUT registry.example') } },
  }).then(() => 'resolved', (e) => e)
  check('★ 非闸门失败 ⇒ 原样抛出（不包装成闸门错误）',
    plain instanceof Error && plain.code !== 'DSH_PNPM_RELEASE_AGE_GATE' && String(plain.message).includes('ETIMEDOUT'))
  check('非闸门失败不重试', calls === 1, `calls=${calls}`)

  let downgradeCalls = 0
  const seenArgs = []
  const seenOpts = []
  const okResult = await runPnpmAdd({
    profileDir: 'C:\\p\\web', spec: 'ds-bot',
    deps: {
      run: async (args, opts) => {
        downgradeCalls += 1
        seenArgs.push(args)
        seenOpts.push(opts)
        if (downgradeCalls === 1) throw new Error("Unknown options: 'fetch-timeout', 'fetch-retries'")
      },
    },
  }).then(() => 'resolved', (e) => e)
  check('Unknown options ⇒ 去掉加固选项重试一次（加固不变成"装不上"）',
    okResult === 'resolved' && downgradeCalls === 2, `calls=${downgradeCalls}`)
  check('降级重试时**保留**非交互开关（不能因降级把 ci 位丢了 ⇒ 又挂住）',
    seenArgs.length === 2 && seenArgs[1].includes('--config.ci=true')
    && !seenArgs[1].some((a) => String(a).startsWith('--fetch-timeout')),
    JSON.stringify(seenArgs[1] ?? []))
  check('★ 两次调用都**显式**带 profileDir（版本判据不依赖 cwd 隐式兜底）',
    seenOpts.length === 2 && seenOpts.every((o) => o.profileDir === 'C:\\p\\web'),
    JSON.stringify(seenOpts.map((o) => o.profileDir)))
}

// ── ⑥ 并发一次 runPnpmWithFallback：闸门错误要能从真实 runner 层冒上来 ──────────
{
  const { runPnpmWithFallback } = await import('../lib/server/infra/exec.js')
  const err = await runPnpmWithFallback(['add', 'ds-bot', '--config.ci=true'], {
    profileDir: 'C:\\p\\web',
    runners: [{ kind: 'probe', note: 'probe', run: () => ({ bin: 'node', argv: [] }) }],
    exec: async () => { throw new Error('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION ... @x/y@1.2.3') },
  }).then(() => null, (e) => e)
  check('runPnpmWithFallback 会把闸门原文如实带出来（供上层翻译）',
    err !== null && releaseAgeGateHit(err.message) === true, String(err?.message ?? '').slice(0, 90))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(`${fail} FAILED`); process.exit(1) }
