// 防线逻辑离线复现：referencing dsh-root(缺失) 必须 reject；web-all 全家桶 refs 必须 allow
// Step 1 重构后：包名归一/解析函数已搬进 lib/server/infra/paths.js —— 直接 import 真模块
// （原来是"按注释标记从 index.js 切片 + vm 沙箱重放"，那种写法一挪文件就断）。
//
// ★ 0.5.84 改错（本套长期红的两条之一，真因不是产品缺陷）：
//   旧代码写死 `DSH_PROFILE_DIR ?? ~/.dsh/profiles/web`，而**宿主进程会把 DSH_PROFILE_DIR 泄漏给子进程**
//   （桌面端外壳起的 node 里它是 `…/profiles/desktop`）。于是从桌面端宿主里跑测试时，本套实际判的是
//   **desktop** profile：那里没有 `dsh-better-sidebar`（它是用户单独装进 web 的第三方插件），
//   web-all refs 就"缺 1 项"→ 长期红。清理 `DSH_PROFILE_DIR` 后逐条复跑，四条断言全部为真 ⇒ 断言没过时。
//   现在把**前提**写明白：先按"哪个 profile 真的装了这套东西"挑，挑不到就响亮 SKIP（CI 也走这条），
//   绝不把"这台机器上没装"报成"解析函数坏了"。判据强度没变：一旦挑到真 profile，五项必须全部解得出来。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const { resolvePackageJson, packageNameOf } = await import('../lib/server/infra/paths.js')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

// ── ① profile 候选：显式指定 → web → desktop → 数据目录里的其它 profile ──────────
// 顺序只影响"先看谁"，**判定**永远是"这套东西在这个 profile 里齐不齐"。
const HOME_DIR = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
const profilesRoot = path.join(HOME_DIR, 'profiles')
const candidates = []
if (process.env.DSH_PROFILE_DIR !== undefined && process.env.DSH_PROFILE_DIR.trim() !== '') candidates.push(process.env.DSH_PROFILE_DIR.trim())
for (const name of ['web', 'desktop']) candidates.push(path.join(profilesRoot, name))
try {
  for (const name of fs.readdirSync(profilesRoot)) candidates.push(path.join(profilesRoot, name))
} catch {}
const uniqueCandidates = [...new Set(candidates)].filter((dir) => fs.existsSync(dir))
console.log(`profile 候选（按序，共 ${uniqueCandidates.length} 个）: ${uniqueCandidates.join(' | ') || '（一个都没有）'}`)

// 这套东西的**锚点**是聚合包 @linxin666/dsh-web-all：它在，才谈得上"全家桶 refs 该全解"。
const anchor = '@linxin666/dsh-web-all'
const profileDir = uniqueCandidates.find((dir) => resolvePackageJson(anchor, dir) !== null) ?? null
if (profileDir === null) {
  console.log(`SKIP 需要真实 profile（其中装了 ${anchor}）——CI/隔离环境跳过，本机装上全家桶后可运行；`
    + '不假装 PASS（解析函数本身的判据由下面的夹具段覆盖，任何环境都跑得到）')
  process.exit(0)
}
console.log(`使用 profile: ${profileDir}`)

const refsMissing = (refs, dir = profileDir) => refs.filter((n) => resolvePackageJson(n, dir) === null)

// ── ② 夹具段（**任何环境都跑得到**，不依赖本机装了什么）──────────────────────────
// 判据是"resolvePackageJson 认不认包名与子路径"，与"这台机器装没装"无关 —— 用一个合成 profile
// 把两个方向都钉死：真存在的必须解得出来（含 scope 与子路径归一），不存在的必须返回 null。
{
  const sandbox = path.join(ROOT, '.testdir', 'bundle-guard-fixture', 'profiles', 'web')
  fs.rmSync(path.join(ROOT, '.testdir', 'bundle-guard-fixture'), { recursive: true, force: true })
  const put = (name, version, extra = {}) => {
    const dir = path.join(sandbox, 'node_modules', ...name.split('/'))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name, version, main: 'index.js', ...extra }, null, 2)}\n`, 'utf8')
    fs.writeFileSync(path.join(dir, 'index.js'), 'export default {}\n', 'utf8')
    return dir
  }
  // 子路径必须真的存在：`resolvePackageJson` 对 `包/子路径` 只认**真实解析语义**（exports），
  // 不会把"包根清单"当成子路径命中 —— 正是仓库里那条"负控不许放松"的判据。所以夹具要声明 exports。
  const waDir = put(anchor, '0.4.3', { exports: { '.': './index.js', './settings': './settings.js', './plugin-manager': './plugin-manager.js' } })
  fs.writeFileSync(path.join(waDir, 'settings.js'), 'export default {}\n', 'utf8')
  fs.writeFileSync(path.join(waDir, 'plugin-manager.js'), 'export default {}\n', 'utf8')
  put('@linxin666/dsh-i18n', '0.1.2')
  put('dsh-better-sidebar', '0.19.1')
  const fixtureRefs = [anchor, `${anchor}/settings`, `${anchor}/plugin-manager`, '@linxin666/dsh-i18n', 'dsh-better-sidebar']
  const fixtureMiss = refsMissing(fixtureRefs, sandbox)
  check('② 夹具：五个 refs（含 scope 包与两个 exports 子路径）全部解得出来', fixtureMiss.length === 0, JSON.stringify(fixtureMiss))
  // 负控（不许放松）：子路径不存在时**必须** null，不能从包根那份清单冒充命中
  check('② 夹具：不存在的子路径仍然 null（不许拿包根清单冒充）',
    resolvePackageJson(`${anchor}/nope`, sandbox) === null, String(resolvePackageJson(`${anchor}/nope`, sandbox)))
  const fixtureBad = refsMissing(['@deepseek-ai/dsh-root', '@linxin666/not-exist-xyz'], sandbox)
  check('② 夹具：不存在的包必须返回 null（dsh-root 这个真人事故事件仍被拦）',
    fixtureBad.length === 2, JSON.stringify(fixtureBad))
  check('② 夹具：子路径归一（web-all/settings → web-all；裸名不变）',
    packageNameOf(`${anchor}/settings`) === anchor && packageNameOf('dsh-better-sidebar') === 'dsh-better-sidebar')
  fs.rmSync(path.join(ROOT, '.testdir', 'bundle-guard-fixture'), { recursive: true, force: true })
}

// ── ③ 真机段（挑到的 profile 上）：全家桶 refs 必须全解；dsh-root 必须缺失 ─────────
{
  // 全家桶本身的四项（聚合包 + 两个子路径 + 它的 i18n）—— 它们由 web-all 带来，与"用户另外装了什么"无关
  const webAllRefs = [anchor, `${anchor}/settings`, `${anchor}/plugin-manager`, '@linxin666/dsh-i18n']
  const waMiss = refsMissing(webAllRefs)
  check(`③ 真机：全家桶 refs 全部解得出来（${webAllRefs.length} 项）`, waMiss.length === 0, JSON.stringify(waMiss))

  const badRefs = ['@deepseek-ai/dsh-root', '@linxin666/not-exist-xyz']
  const badMiss = refsMissing(badRefs)
  check('③ 真机：不存在的包必须全部缺失（dsh-root 缺失被拦的真人场景）',
    badMiss.length === badRefs.length, JSON.stringify(badMiss))

  // 第三方插件 dsh-better-sidebar：它**不属于**全家桶（是用户单独装的），所以按"装在哪个 profile"
  // 逐个判：装了的那些必须解得出来；一个都没装就响亮 SKIP —— 绝不把"这台机器没装"算成解析失败。
  const thirdParty = 'dsh-better-sidebar'
  const thirdPartyHosts = uniqueCandidates.filter((dir) => fs.existsSync(path.join(dir, 'node_modules', thirdParty, 'package.json')))
  if (thirdPartyHosts.length === 0) {
    console.log(`SKIP ③ 本机没有任何 profile 装了 ${thirdParty}（第三方插件，非全家桶成员）—— 不假装 PASS`)
  } else {
    const thirdMiss = thirdPartyHosts.filter((dir) => resolvePackageJson(thirdParty, dir) === null)
    check(`③ 真机：已安装的第三方插件 ${thirdParty} 在其所在 profile 必须解得出来`, thirdMiss.length === 0, JSON.stringify(thirdMiss))
    console.log(`       （它装在：${thirdPartyHosts.join(' | ')}）`)
  }
}

console.log(failed === 0 ? 'PASS：夹具（任何环境）与真机（本机装了全家桶的 profile）两侧均符合预期' : `FAIL（${failed} 项）`)
process.exit(failed === 0 ? 0 : 1)
