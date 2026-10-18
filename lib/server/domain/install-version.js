// L1 · domain —— install-version.js（「更新到的到底是哪一版」的**唯一判据**；2026-10-18 新增，纯加法）
//
// 真机缺陷（2026-10-18，用户实测，父任务已确认现场）：
//   点「更新并适配」`@deepseek-ai/dsh-experimental-auto-review`（0.1.6-alpha.1 → 0.2.1-rc.2），
//   请求体显式带 `version: "0.2.1-rc.2"`，作业跑完**报 done、version=0.2.1-rc.2、error=null**，
//   而磁盘与清单**都还是 0.1.6-alpha.1**。
//   根因不是"版本号没传下去"，而是**没人核对最终落地的是不是目标版本**：
//   该包在 registry 上的 `dist-tags.latest` 恰好就是旧版 0.1.6-alpha.1（rc 版从不打 latest），
//   于是"按最新版下载"的通道（curl）把**旧版**铺回 node_modules，凡是"按名报成功"的判据都看不出异常。
//
// 本模块只做一件此前没人做的事：**把请求里点名的版本与磁盘上真实的版本比一比**。
// 为什么不塞进 install-verify.js：那个模块的契约是"只提示、绝不改成功判定"（见它的顶部硬规矩①），
// 而这里的结论**必须能否决一次成功**——两者语义相反，放一个文件里迟早会被下一个人混用。
//
// 三条硬规矩：
//   ① 只读：只读 node_modules/<包名>/package.json 的 version 字段，绝不写盘、绝不改动清单；
//   ② 只对"点名了版本"的请求生效（`job.version` 为空 = 照旧按 latest，判据恒 null，行为一字不变）；
//   ③ 绝不猜：读不到版本时 actual 记 null，**不**据此报"不是目标版本"以外的任何结论（见 versionMissText）。
import { readInstalledVersion } from './selfupdate.js'

/** 这次作业**点名**要装的那个版本（没有点名 / 不是点名的那个包 ⇒ null）。
 *
 * 为什么必须逐字比包名：`job.version` 是"目标包的目标版本"，而候选循环里的 `name` 可能是自动展开出的
 * 任意子包（聚合仓库）。给子包套用父候选的版本号＝给一个根本没发布这个版本号的包下精确规格，
 * 会把"本来能装"变成"404 装不上"（与 domain/install-channels.js 顶部 ① 条同一条理由）。
 * 版本号只对**用户点名的那一件**成立 —— 传进来的 name 必须与 job.packageName 逐字相等。 */
function targetVersionOf(job, name) {
  const version = typeof job?.version === 'string' ? job.version.trim() : ''
  if (version === '' || typeof name !== 'string' || name === '') return null
  return name === job.packageName ? version : null
}

/**
 * 磁盘上真实的版本 vs 目标版本（**只读**，永不抛）。
 * 返回 null 表示"无需/无法判定"：
 *   · 没点名版本（按 latest 装的请求）—— 既有流程一字不动；
 *   · 磁盘上就是目标版本 —— 通道这次真的把版本装对了。
 * 返回 `{ kind:'version-miss', packageName, expected, actual, channel }` 表示**没装上目标版本**。
 * `channel` 由调用方填（哪个通道声称装上了），只用于如实告知，不参与判定。
 */
function versionMissOf(profileDir, name, job, channel = null) {
  const expected = targetVersionOf(job, name)
  if (expected === null) return null
  const actual = readInstalledVersion(profileDir, name)
  if (actual === expected) return null
  return {
    kind: 'version-miss',
    packageName: name,
    expected,
    actual: typeof actual === 'string' && actual !== '' ? actual : null,
    channel: typeof channel === 'string' && channel !== '' ? channel : null,
  }
}

/** 一句话如实说清"哪一版没装上、盘上现在是什么"（作业 error / 通道备注共用一份文案）。 */
function versionMissText(miss) {
  if (miss === null || typeof miss !== 'object') return null
  const actual = miss.actual === null || miss.actual === undefined ? '（磁盘上读不到版本）' : String(miss.actual)
  const via = miss.channel === null || miss.channel === undefined ? '' : `${miss.channel} 通道`
  return `目标版本 ${miss.expected} 没有装上：${via === '' ? '本次' : via}落地的是 ${actual}`
    + '（多半是镜像的 dist-tags.latest 还指着旧版，按"最新版"下载就会拿到它）。'
    + '已保留磁盘上现有的这一版、清单未改动；可换源后重试，或稍等镜像同步。'
}

export { targetVersionOf, versionMissOf, versionMissText }
