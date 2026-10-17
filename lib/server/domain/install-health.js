// L1 · domain —— 安装健康摘要（0.5.55 加法）
//
// 为什么需要（审计结论 + 用户 2026-10-15「优化到你能做到的最好」）：
//   面板有 176 个按钮、3 个区块，信息散在「兼容门控 / peer 否决 / 持久化 / 依赖锁 / 框架残留 / 闭包预检」
//   六处。用户打开面板时**没有一个地方能回答**："我这套安装现在整体健康吗？有哪几件事需要我处理？"
//   于是该点的找不到、不该点的全在眼前 —— 这不是功能不足，是**入口缺失**。
//
// 本模块刻意**只做折叠、不新增判据**：
//   输入全部是 /state 里**已经算好**的东西（否决行、被跳过的 bundle、待适配行、补丁自愈结果），
//   输出一句话摘要 + 分项计数。**不读盘、不联网、不 spawn** —— 因此可以放进 /state 的返回里，
//   不带来任何额外 IO 成本。
//
// 判据口径（与各自真源保持一致，别在这里另立标准）：
//   · veto         ← entries[].veto（domain/peer-veto.js 的结论）
//   · skippedBundle← skippedBundles（domain/bundle-veto.js 的结论；只在 reliable 时计入）
//   · pendingCompat← compatPending.pending（兼容门控的待适配行）
//   · patchHeal    ← patchHeal.uncertain / autoDisabled（补丁自愈的遗留项）
//
// 分层：L1 domain —— 纯函数，收已解开的数组/对象（因此**不 import 任何其它模块**）。

/** 严重度：blocker 会让人"看不到/用不了"，warn 只是"有风险"。 */
const SEVERITY = { blocker: 'blocker', warn: 'warn' }

/**
 * 把已算好的各块折叠成一份健康摘要。
 *
 * @param {object} p
 * @param {Array} [p.entries] /state 的 entries（含 veto）
 * @param {{items?: Array, reliable?: boolean}} [p.skippedBundles] bundle 级否决结果
 * @param {Array} [p.pendingCompat] 待适配行
 * @param {Array} [p.patchUncertain] 补丁自愈里"说不准"的行 id
 * @returns {{ issues: number, items: Array<{kind: string, severity: string, count: number, label: string}> }}
 */
function buildInstallHealth(input = {}) {
  // 体检模块自己不能崩：null / undefined / 非对象一律当空输入（tests/test-install-health.mjs ⑥ 钉住）
  const src = input !== null && typeof input === 'object' ? input : {}
  const list = Array.isArray(src.entries) ? src.entries : []
  const skippedBundles = src.skippedBundles ?? null
  const pendingCompat = Array.isArray(src.pendingCompat) ? src.pendingCompat : []
  const patchUncertain = Array.isArray(src.patchUncertain) ? src.patchUncertain : []
  const items = []

  // ① bundle 级：被框架**整层跳过** —— 最严重，因为它在列表里连位置都没有（用户看不到）
  const skipped = skippedBundles !== null && skippedBundles !== undefined && skippedBundles.reliable === true && Array.isArray(skippedBundles.items)
    ? skippedBundles.items.length
    : 0
  if (skipped > 0) items.push({ kind: 'skipped-bundle', severity: SEVERITY.blocker, count: skipped, label: '被框架跳过的 bundle（装了但没装载，列表里看不到）' })

  // ② 行级：被 peer 否决（可见但未加载）
  const vetoed = list.filter((e) => e !== null && e !== undefined && e.veto !== null && e.veto !== undefined)
  if (vetoed.length > 0) items.push({ kind: 'vetoed', severity: SEVERITY.blocker, count: vetoed.length, label: '被框架否决的插件行（未加载）' })

  // ③ 待适配（兼容门控挂着的行）
  const pending = Array.isArray(pendingCompat) ? pendingCompat.length : 0
  if (pending > 0) items.push({ kind: 'pending-compat', severity: SEVERITY.warn, count: pending, label: '待适配确认的行' })

  // ④ 补丁自愈里"说不准"的行（工具改过但无法确认是否它想要的）
  const uncertain = Array.isArray(patchUncertain) ? patchUncertain.length : 0
  if (uncertain > 0) items.push({ kind: 'patch-uncertain', severity: SEVERITY.warn, count: uncertain, label: '补丁自愈无法确认的行' })

  return { issues: items.length, items }
}

export { SEVERITY, buildInstallHealth }
