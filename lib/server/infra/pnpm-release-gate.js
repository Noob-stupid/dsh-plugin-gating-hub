// L0 · infra —— pnpm 供应链闸门（minimumReleaseAge）的**判据与错误翻译**（0.5.48 加法）
//
// 为什么单开一个模块：这两个函数的归属是自洽的（"把 pnpm 的闸门原文翻译成用户能照着做的错误"），
// 而 infra/exec.js 贴着 tests/test-architecture-guard.mjs 的 **单文件 ≤ 600 行**硬顶（0.5.48 实测
// 723 行被棘轮拦下）⇒ 抽出来是**只搬移与新增**，exec.js 只留调用点。
//
// 现场（用户实测，装 ds-bot 时撞出来）：
//   pnpm 的 minimumReleaseAge 闸门拦下了太新的版本，而它在**可交互**时会弹提问等人回答；
//   桌面壳/服务进程给的是**永不关闭的 stdin 管道** ⇒ 不抛错、不超时，**永久挂住**
//   （实测两次分别挂到 90s / 180s 被杀）。
//
// ★ 2026-10-14（实测更正上面这段"现场描述"，**本模块行为未动**）：
//   上述因果链里"pnpm 弹提问 ⇒ 读 stdin 到 EOF ⇒ 挂住"这一段**实测不成立**：
//     · pnpm 的 canPrompt = `!inCi && Boolean(process.stdin.isTTY)`（L194277-278）；
//       管道下 isTTY 恒假 ⇒ pnpm **从不**走 prompt 分支，直接 `throw failOnImmature`。
//     · 实测（pnpm 11.7.0，minimumReleaseAge 设成天文数字 + 管道 stdin）：无 ci 位 / CI=true /
//       npm_config_ci=true / --config.ci=true / 两者齐上 —— **五种配置全部快速失败，无一挂住**。
//     · 真正读 stdin 等人的是 **corepack 的下载提问**（corepack.cjs L22083：
//       `if (process.stdin.isTTY && !process.env.CI) { stderr.write('? Do you want to continue?');
//        stdin.resume(); await once(stdin,'data') }`）—— 判据恰恰是 `process.env.CI`。
//   ⇒ 本模块的定位不变（**识别 + 翻译成可操作错误**，绝不绕过闸门），仍然有价值；
//     只是"为什么会挂住"要记在 corepack 头上，不是 pnpm 的供应链闸。
//     顺带更正另两处（详见 infra/exec.js#pnpmEnvOverrides 上方的完整说明）：
//       · `npm_config_ci=true` 对 pnpm 自己的配置项是**空操作**（只认 `pnpm_config_*`）；
//       · `CI=true` **确实**点亮 ci 位（pnpm 配置默认值 `ci: isCI`，L145865）。
//
// 闸门实现（本机 pnpm 11.7.0 `dist/pnpm.mjs`，只读反编译取证）：
//   L194277  const inCi = opts3.ci ?? isCI
//   L194278  const canPrompt = !inCi && Boolean(process.stdin.isTTY)
//   L194305  if (canPrompt) { await promptForApproval(immature) }
//   L194307  else { throw failOnImmature(immature) }   ← 我们要走的分支
//   L194330    confirmed = await dist_default5({ message, default: false })  ← prompt 库读 stdin 到 EOF
//   L63849   MINIMUM_RELEASE_AGE_VIOLATION_CODE = 'MINIMUM_RELEASE_AGE_VIOLATION'
//
// ★ 红线：本模块只做"识别 + 翻译成可操作错误"，**绝不**提供任何绕过闸门的手段
//   （不使用忽略锁文件校验 / 强制安装一类开关）。闸门该拦还是拦，只是把"等人回答"换成"立刻报错并给解法"。
//
// 分层：L0 · infra（不得 import domain/routes/index —— tests/test-architecture-guard.mjs 断言②）。

/** 命中 pnpm 供应链闸门的**判据**（纯函数，单测覆盖）。
 * 两代真实文案都要认（照 exec.js#unknownPnpmOption 的教训：缺一条就等于"闸门命中被当成普通失败"，
 * 用户拿不到"怎么加白名单"的解法）：
 *   · pnpm 11.7.0 的违规码 `MINIMUM_RELEASE_AGE_VIOLATION` / `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`；
 *   · 严格模式不可交互时 pnpm 抛 `NO_MATURE_MATCHING_VERSION`（同文件 194308 的 failOnImmature）；
 *   · 用户在提问处拒绝时是 `MINIMUM_RELEASE_AGE_DENIED`（同文件 194340）。 */
function releaseAgeGateHit(message) {
  const text = String(message ?? '')
  return /MINIMUM_RELEASE_AGE_VIOLATION|MINIMUM_RELEASE_AGE_DENIED|NO_MATURE_MATCHING_VERSION|ERR_PNPM_MINIMUM_RELEASE_AGE/iu.test(text)
}

/** 从 pnpm 原始输出里抠出"被闸门拦下的 `包@版本`"清单（尽力而为，抠不到就返回 []）。
 * 两种真实排版：`  <name>@<version> <reason>`（failOnImmature）与裸 `<name>@<version>`。 */
function releaseAgeBlockedSpecs(message) {
  const found = new Set()
  for (const line of String(message ?? '').split(/\r?\n/u)) {
    const m = line.match(/(@?[A-Za-z0-9][\w.@/-]*?)@(\d+\.\d+\.\d+(?:-[\w.]+)?)/u)
    if (m) found.add(`${m[1]}@${m[2]}`)
  }
  return [...found]
}

/** 把"命中供应链闸门"翻译成**用户能照着做**的错误（纯函数，单测覆盖）。
 * 需求红线：**必须快速如实失败并给出解法**。所以这里只说三件事：
 *   ① 哪个包被拦下 ② 命中哪条闸 ③ 怎么加白名单。 */
function releaseAgeGateError({ spec, profileDir, message } = {}) {
  const blocked = releaseAgeBlockedSpecs(message)
  const who = blocked.length > 0 ? blocked.join('、') : String(spec ?? '（未能从 pnpm 输出解析出包名）')
  const lines = [
    `pnpm 供应链闸门（minimumReleaseAge）拦下了 ${who}：该版本发布时间还没满 pnpm 配置的最短"冷静期"。`,
    '这不是网络故障。闸门是安全特性，本控制台**不会绕过它**（既不忽略锁文件校验，也不强制装），',
    '所以这里选择**立刻如实失败**，并把解法交给你：',
    '解法（任选其一）：',
    `  ① 加白名单：在 profile 的 pnpm-workspace.yaml 里把该版本追加进 minimumReleaseAgeExclude，例如`,
    `     minimumReleaseAgeExclude:\n       - '${blocked[0] ?? '<包名>@<版本>'}'`,
    '     ★ 该清单是**逐版本**匹配的（pnpm 只认 `包名@精确版本`，不支持范围）⇒ 每发一个新版本都要加一行。',
    '  ② 等：过了冷静期后重试同一操作即可，无需改配置。',
    '  ③ 调低/关闭该策略：不推荐，等于放弃这道供应链保护。',
  ]
  if (typeof profileDir === 'string' && profileDir !== '') lines.push(`目标 profile：${profileDir}`)
  const error = new Error(lines.join('\n'))
  error.name = 'PnpmSupplyChainGateError'
  error.code = 'DSH_PNPM_RELEASE_AGE_GATE'
  error.gate = 'minimumReleaseAge'
  error.blocked = blocked
  error.pnpmMessage = String(message ?? '')
  return error
}

export { releaseAgeGateHit, releaseAgeBlockedSpecs, releaseAgeGateError }
