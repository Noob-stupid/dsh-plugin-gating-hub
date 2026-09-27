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

// 探测桩（2026-09-27 改错配套）：声明的**写回形态**现在由 registry 可解析性决定，
// 所以本用例一律注入桩 —— 既钉住"可解析 → 版本号（回归不变）"与"404 → link:"两条语义，
// 又让整套断言**完全不依赖网络**（旧版本这里真的会打 registry，CI 上时红时绿）。
const probeResolvable = async (name, registries, options = {}) => ({ resolvable: true, hasVersion: true, latest: options.version ?? null, registry: 'stub', tried: [] })
const probe404 = async () => ({ resolvable: false, hasVersion: false, latest: null, registry: null, tried: ['stub：HTTP 404 Not Found'] })
const probeDown = async () => ({ resolvable: false, hasVersion: false, latest: null, registry: null, tried: ['stub：fetch failed（网络不可达）'] })
const DECLARE = { syncLock: false, probe: probeResolvable }

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

// ① 声明：写进去的是磁盘上的版本（该包在 registry 上可解析 → 形态不变，回归）
const first = await declareProfileDependency(profileDir, '@fake/hand-laid', null, DECLARE)
check('声明成功且写的是磁盘版本', first.changed === true && first.version === '1.2.3' && readManifest().dependencies['@fake/hand-laid'] === '1.2.3', JSON.stringify(first))
check('registry 可解析的包：form=version（回归：不因为本次改错而改变形态）', first.form === 'version' && first.spec === '1.2.3' && first.suggested === null, JSON.stringify({ form: first.form, spec: first.spec }))
// ② 幂等：重复声明不改动
const again = await declareProfileDependency(profileDir, '@fake/hand-laid', null, DECLARE)
check('重复声明幂等（changed=false）', again.changed === false && readManifest().dependencies['@fake/hand-laid'] === '1.2.3', JSON.stringify(again))
// ③ 读不到版本的包：如实回报，不瞎写
const ghost = await declareProfileDependency(profileDir, '@fake/not-installed', null, DECLARE)
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
await declareProfileDependency(profileDir, '@fake/visible', null, DECLARE)
check('声明后包出现在清单里（官方面板与清理判据都以它为准）', readManifest().dependencies['@fake/visible'] === '0.5.0' && existsSync(join(profileDir, 'node_modules', '@fake', 'visible', 'package.json')))

// ⑦ **改错本体**（2026-09-27）：registry 查无此包的依赖，绝不能写成裸版本号 ——
//    真机证据：desktop profile 里 `@dsh-external/dsh-graded-mode: 0.0.1-rc1`（npmmirror/npmjs 双双 404），
//    下一次任何 pnpm 操作就是 ERR_PNPM_FETCH_404。形态必须是 link:（物化到 plugin-src 后指过去）。
writePkg('@fake/release-only', '0.0.1-rc1')
const pinned = await declareProfileDependency(profileDir, '@fake/release-only', null, { syncLock: false, probe: probe404 })
const pinnedSpec = readManifest().dependencies['@fake/release-only']
const wantLink = `link:${join(HOME, 'plugin-src', '@fake', 'release-only').replace(/\\/gu, '/')}`
check('★ 404 依赖写的是 link:（不是会 404 的裸版本号）',
  pinned.form === 'link' && pinnedSpec === wantLink, JSON.stringify({ form: pinned.form, spec: pinnedSpec }))
check('★ link 目标真的物化出来了（<DSH_HOME>/plugin-src/<包名>）',
  existsSync(join(HOME, 'plugin-src', '@fake', 'release-only', 'package.json')), pinnedSpec)
check('★ 已按 link: 记录时才给出"已按 link: 形式记录"的说明（文案与实际一致）',
  typeof pinned.depNote === 'string' && pinned.depNote.includes(pinnedSpec) && pinned.depNote.includes('已按 link: 形式记录'), String(pinned.depNote).slice(0, 80))
const pinnedAgain = await declareProfileDependency(profileDir, '@fake/release-only', null, { syncLock: false, probe: probe404 })
check('★ 幂等：再次声明仍是 link:（不会被退回版本号）',
  pinnedAgain.changed === false && readManifest().dependencies['@fake/release-only'] === wantLink, JSON.stringify({ changed: pinnedAgain.changed, spec: pinnedAgain.spec }))

// ⑧ 探测**没成功**（网络不可达）时不许猜：仍按版本号写（与旧行为一致）但如实记 note +
//    下发结构化「钉住」建议动作（面板可一键执行），绝不写成"已钉住"。
writePkg('@fake/maybe-registry', '2.0.0')
const unsure = await declareProfileDependency(profileDir, '@fake/maybe-registry', null, { syncLock: false, probe: probeDown })
const unsureSpec = readManifest().dependencies['@fake/maybe-registry']
check('★ 探测不到（网络）：写版本号但 form=unknown，不冒充已钉住',
  unsure.form === 'unknown' && unsureSpec === '2.0.0' && !String(unsure.depNote).includes('已按 link: 形式记录'), JSON.stringify({ form: unsure.form, spec: unsureSpec }))
check('★ 探测不到时下发结构化「钉住」动作（老客户端忽略该字段，向后兼容）',
  unsure.suggested?.kind === 'pin-dependency' && unsure.suggested?.payload?.action === 'pin-dependency'
  && unsure.suggested?.payload?.packageName === '@fake/maybe-registry'
  && typeof unsure.suggested?.command === 'string' && unsure.suggested.command.includes('pnpm add link:')
  && !('command' in unsure.suggested.payload), JSON.stringify(unsure.suggested))

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
