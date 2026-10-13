// L1 · domain —— probe-outcome.js（探测结果的**通道身份 / 逐条失败原因 / 已装核实**收口；0.5.47 加法）
//
// 为什么单开一个模块：install-job.js 贴着 600 行架构硬顶（test-architecture-guard 断言①），
// 而"清单是怎么读到的、失败了都试过谁、其实是不是已经装上了"这三件事本身就是一段有判据、
// 可离线测的纯逻辑；放在 market.js 里还会把它顶过 600 行（本轮就撞上了）。
//
// 三层内容：
//   ① 通道身份：成功时如实说"经哪条通道读到的"（本地落地 / npm 镜像 / …），不再只说失败；
//   ② 逐条失败原因：全失败时**逐条**列出"通道 + 各自为什么没成"（用户红线：不许一句 unreachable 带过）；
//   ③ 已装核实：报"失败"之前先核实"是不是其实已经装上了"（判据在 domain/presence-check.js，只读零网络）。
//
// 分层：本文件属 L1 · domain —— 不得出现 cordis ctx（test-architecture-guard 断言⑤）。

import { channelFailureSummary, channelLabel } from '../infra/http.js'
/** ★胜出通道身份（0.5.47）：成功时如实告诉用户"清单是**经哪条通道**读到的"
 * （本地落地 / npm 镜像 / npm 官方源 / https / gh CLI / curl 直连 / jsDelivr）。
 * 为什么必须带出来：用户被"抓取超时"误导过一次 —— 面板只说失败、不说试过什么，
 * 于是既不知道能不能换源、也不知道其实本地就有。 */
function probeChannelLine(probe) {
  if (probe === null || typeof probe !== 'object') return null
  const channel = typeof probe.channel === 'string' && probe.channel !== '' ? probe.channel : null
  if (channel === null) return null
  const name = typeof probe.packageName === 'string' && probe.packageName !== '' ? `（${probe.packageName}）` : ''
  if (channel === 'local') {
    const dir = typeof probe.localDir === 'string' && probe.localDir !== '' ? `：${probe.localDir}` : ''
    return `清单来自「仓库落地」本地目录${dir}${name}`
  }
  return `清单经 ${channelLabel(channel)} 读到${name}`
}

/** 失败时的逐条原因清单（字符串行数组；空 = 一个原因都没收到）。
 * 收 `summary`（已经拼好的文本）与 `failures`（结构化数组）两种形态：install-job 下发的
 * `job.probe` 是前者，`fetchRepoPackageEx` 的返回是后者，两条路都要能出清单。 */
function probeFailureLines(probe) {
  if (probe === null || typeof probe !== 'object') return []
  const summary = typeof probe.summary === 'string' && probe.summary !== ''
    ? probe.summary
    : channelFailureSummary(probe.failures)
  return summary === '' ? [] : summary.split('\n')
}

/** ★全通道失败时的诚实文案：既有 baseText（**保留现文案**）+ 逐条「通道：原因」+ registry 匹配备注。
 * 用户红线：**不许一句 unreachable 带过** —— 每条通道各自为什么没成都要看得见。 */
function composeProbeFailureText(probe, baseText) {
  const base = typeof baseText === 'string' && baseText !== '' ? baseText : '抓取仓库清单失败'
  const lines = probeFailureLines(probe)
  const notes = Array.isArray(probe?.registryNotes) ? probe.registryNotes.filter((n) => typeof n === 'string' && n !== '') : []
  const parts = [base]
  if (lines.length > 0) parts.push(`各通道的失败原因：\n${lines.join('\n')}`)
  if (notes.length > 0) parts.push(`npm registry 核对（按 repository 字段匹配，不靠猜名）：\n${notes.map((n) => `· ${n}`).join('\n')}`)
  return parts.join('\n')
}

// 「报失败之前先核实其实已经装上了」的**实现归属**：domain/install-verify.js 的
// installedEvidence / failedJobEvidence（0.5.47 那批已接在 routes/install-status 与 routes/state 两处）。
// 本模块只管"这次探测是怎么读到的 / 为什么没读到"，不重复实现核实 —— 同一件事只留一个承担者。

export { probeChannelLine, probeFailureLines, composeProbeFailureText }
