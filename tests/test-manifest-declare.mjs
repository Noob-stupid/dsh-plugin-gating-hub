// 「安装即声明」回归测试（domain/manifest.js）—— 2026-09-24 三个现象同一根因的修复。
//
// 修的是什么：我们的安装通道（curl 直取 / 手铺文件兜底 / git 克隆）只写 `dsh.profile.bundles`
// 与 `cordis.patch.yml` 行，**从不写 profile 的 `dependencies`**。后果是三连：
//   ① 官方「设置 → 插件」的已安装分区只显示声明过的包 → 我们装的插件在那里看不见；
//   ② 任何一次 pnpm 操作按清单 + lock 重装 → 未声明的包被还原/清掉（「更新成功、重启还是旧版」）；
//   ③ 我们自己的「清理残余」按同样判据把在用插件当孤儿（2026-09-24 实测差点删 7 个）。
// 这里把「装到哪版就声明哪版」「卸载即撤销」「来源型 spec 不动」钉死。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'manifest-declare-home')
process.env.DSH_HOME = HOME
process.env.DSH_TEST_SKIP_NETWORK = '1'
rmSync(HOME, { recursive: true, force: true })

const profileDir = join(HOME, 'profiles', 'web')
mkdirSync(join(profileDir, 'node_modules', '@fake'), { recursive: true })
writeFileSync(join(profileDir, 'cordis.patch.yml'), '# manifest test\n[]\n', 'utf8')
const writeManifest = (manifest) => writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
const readManifest = () => JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
const writePkg = (name, version) => {
  const dir = join(profileDir, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }), 'utf8')
  return dir
}

const {
  addBundleToManifest, declareProfileDependency, installedVersionOf, removeBundleFromManifest, undeclareProfileDependency,
} = await import('../lib/server/domain/manifest.js')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

// 初始：一个手铺的第三方插件（没有任何声明）—— 就是用户机器上那 4 个的真实形态
writePkg('@fake/hand-laid', '1.2.3')
writeManifest({ name: 'dsh-profile-web', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } })
check('读磁盘真实版本（不猜）', (await installedVersionOf(profileDir, '@fake/hand-laid')) === '1.2.3')
check('读不到的包返回 null 而不是抛错', (await installedVersionOf(profileDir, '@fake/not-installed')) === null)

// ① 声明：写进去的是磁盘上的版本
const first = await declareProfileDependency(profileDir, '@fake/hand-laid')
check('声明成功且写的是磁盘版本', first.changed === true && first.version === '1.2.3' && readManifest().dependencies['@fake/hand-laid'] === '1.2.3', JSON.stringify(first))
// ② 幂等：重复声明不改动
const again = await declareProfileDependency(profileDir, '@fake/hand-laid')
check('重复声明幂等（changed=false）', again.changed === false && readManifest().dependencies['@fake/hand-laid'] === '1.2.3', JSON.stringify(again))
// ③ 读不到版本的包：如实回报，不瞎写
const ghost = await declareProfileDependency(profileDir, '@fake/not-installed')
check('读不到版本的包不写清单且带原因', ghost.changed === false && ghost.version === null && typeof ghost.reason === 'string' && !('@fake/not-installed' in (readManifest().dependencies ?? {})), JSON.stringify(ghost))

// ④ bundle 路径：bundles 与 dependencies 一次写齐（同一把写锁）
writePkg('@fake/family', '9.9.9')
const added = await addBundleToManifest(profileDir, '@fake/family')
const afterAdd = readManifest()
check('bundle 安装：bundles 与 dependencies 同时写齐', afterAdd.dsh.profile.bundles.includes('@fake/family') && afterAdd.dependencies['@fake/family'] === '9.9.9', JSON.stringify({ version: added.version }))
check('bundle 安装不破坏既有条目', afterAdd.dsh.profile.bundles.includes('@deepseek-ai/dsh-base') && afterAdd.dependencies['@fake/hand-laid'] === '1.2.3')

// ⑤ 卸载即撤销（bundles 与 dependencies 一起清）
await removeBundleFromManifest(profileDir, '@fake/family')
const afterRemove = readManifest()
check('bundle 卸载：bundles 与 dependencies 一起清掉（不留幽灵依赖）', !afterRemove.dsh.profile.bundles.includes('@fake/family') && !('@fake/family' in (afterRemove.dependencies ?? {})))
await undeclareProfileDependency(profileDir, '@fake/hand-laid')
check('单独撤销声明生效', !('@fake/hand-laid' in (readManifest().dependencies ?? {})))
check('清单文件仍是合法 JSON 且保留其它字段', readManifest().name === 'dsh-profile-web')

// ⑥ 装完能**被清理判据看见**：这正是「官方面板可见 / 不被当孤儿」的前提
writePkg('@fake/visible', '0.5.0')
await declareProfileDependency(profileDir, '@fake/visible')
check('声明后包出现在清单里（官方面板与清理判据都以它为准）', readManifest().dependencies['@fake/visible'] === '0.5.0' && existsSync(join(profileDir, 'node_modules', '@fake', 'visible', 'package.json')))

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
