// L1 · domain —— selfupdate-read.js（自更新/对账共用的**只读**读数：spec 判定、已装版本、lock 里被钉住的版本）
//
// 为什么单独一个模块（2026-11-04 加法）：domain/selfupdate.js 贴着 600 行架构棘轮
// （tests/test-architecture-guard.mjs），而本轮要给"pnpm 卡住/失败后立刻手铺 + 补 lock"腾出空间。
// 这几个函数本来就是自洽的一族"只读、纯函数式、不认识 cordis"的读数，搬出来只换绑定来源：
//   · 名字与语义**一个字节都没改**；selfupdate.js 继续 import 它们并**原样 re-export**
//     （外部 persist.js / plugin-actions.js / unpin-dev-dir.js / install-version.js 与 6 个测试套件
//      都还从 selfupdate.js 取这几个名字，导出面一个字不能少）；
//   · 真值只有一份：lock 的键判据仍然只来自 lock-importer.js#lockEntryKeyMatches
//     （见下面 lockVersion 的长注释 —— 两处各写一份必然再次分叉，0.5.38 就是那个现场）。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lockEntryKeyMatches } from './lock-importer.js'

/** spec 是否是 registry 版本范围（`^1.2.3` / `~1.2.3` / `1.2.3` / `>=1` / `=1`）。
 * 只有这种才能用 `pnpm update` 在**不改写 spec**的前提下把 lock 提到范围内最新；
 * git / file / link / workspace 来源没有"范围"可言，只能走 `pnpm add <pkg>@<版本>`。 */
function isRegistryRange(spec) {
  if (typeof spec !== 'string') return false
  const s = spec.trim()
  if (/^[\^~]?\d/u.test(s)) return true
  return /^(>=|>|=)\s*\d/u.test(s)
}

/** profile 里该包的依赖声明（spec）。读不到返回 null。 */
function profileSpec(profileDir, name) {
  try {
    const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const spec = pkg?.dependencies?.[name]
    return typeof spec === 'string' ? spec : null
  } catch {
    return null
  }
}

/** 已安装版本（直接读 node_modules 里那份 package.json）。 */
function readInstalledVersion(profileDir, name) {
  try {
    const pkg = JSON.parse(readFileSync(join(profileDir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'))
    return typeof pkg?.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/**
 * 从 pnpm-lock.yaml 读出该包被**钉住**的版本。解析策略（lock 格式五花八门，只认两种确定性位置，避免子串误命中）：
 *   ① importers 段：行内容恰为 `'<name>':`（可带缩进），随后几行内的 `version: X`；
 *   ② packages 段：行首（可带缩进/引号）`<name>@<版本或 git+...>:` 的键名。
 * 读不到返回 null（调用方据此判定"没能核实"，不谎报成功）。
 *
 * ★ 2026-09-22 修复（缺陷②连带）：旧版 ① 在遇到 `specifier: …` 行时**直接 break**，而 importers 段
 *   恒为 `specifier:` 在前、`version:` 在后 → ① 从来没生效过，全靠 ② 兜底；而 ② 的正则用 `[^':\s]+`
 *   取值，遇到 `name@https://…tgz` / `link:…` 会在第一个冒号处截断（读出 `http`）或读不到（link 依赖
 *   在 lock 里没有 packages 条目 → 返回 null）。后果：来源钉住的包永远被判为「漂移」→ 每次安装都白跑
 *   一次 pnpm add，并给用户一条假的「没写进 lock」警告。现在 ① 跳过 specifier 行、② 取到行尾。
 */
function lockVersion(profileDir, name) {
  const file = join(profileDir, 'pnpm-lock.yaml')
  if (!existsSync(file)) return null
  let lines = []
  try {
    lines = readFileSync(file, 'utf8').split(/\r?\n/u)
  } catch {
    return null
  }
  for (let i = 0; i < lines.length; i += 1) {
    // 键形态三种都认（0.5.38 改错）：`name`、`'name':`（pnpm 对**含 `/`/`@`** 的包名加引号）、
    // `name:`（pnpm 对**未加 scope** 的包名不加引号）。旧判据漏了第三种 ⇒ 未加 scope 的 `link:`
    // 依赖在 importers 里明明有条目却读不出来（真机 desktop profile 的 `dshmarket` 就是：
    // lock 的 35-37 行写着 `dshmarket: / specifier: link:… / version: link:../../plugin-src/dshmarket`，
    // 而 `lockVersion()` 返回 null）——后果是面板永远报"没写进 pnpm-lock.yaml"、pin 永远 partial、
    // 每次对账都白跑一次 `pnpm add`。真值一律从下面这一处读，别在调用方再补一套。
    // 0.5.39：键判据搬进 lock-importer.js#lockEntryKeyMatches —— 定点**写**入也要认同一批键形态，
    // 两处各写一份必然再次分叉（写进去的键、读的时候认不出，就是 0.5.38 那个现场）。
    if (lockEntryKeyMatches(lines[i], name)) {
      for (let k = i + 1; k < Math.min(i + 8, lines.length); k += 1) {
        const m = /^\s*version:\s*(\S+)\s*$/u.exec(lines[k])
        if (m) return m[1]
        // 只在新包的键行（`'<name>':` 形态）处停止；`specifier: X` 有值，不是键行，必须继续往下看
        if (/^\s*'?[^\s:]+'?:\s*$/u.test(lines[k])) break
      }
    }
  }
  const escaped = name.replace(/[/\\^$*+?.()|[\]{}]/gu, '\\$&')
  // 取到行尾再剥尾部的引号/冒号：`'name@https://…tgz':` / `name@git+https://…#sha:` / `name@1.2.3:`
  const keyRe = new RegExp(`^\\s*'?${escaped}@(.+?)'?:\\s*$`, 'u')
  for (const line of lines) {
    const m = keyRe.exec(line)
    if (m) return m[1]
  }
  return null
}

export { isRegistryRange, lockVersion, profileSpec, readInstalledVersion }
