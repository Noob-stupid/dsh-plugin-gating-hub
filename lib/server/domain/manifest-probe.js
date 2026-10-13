// L1 · domain —— manifest-probe.js（把"抓仓库清单"的**额外通道**与**通道身份**真正接上；0.5.47）
//
// 用户复核上一批时的铁证：`market.js` 调 `rawTextFetch(repo, branch, 'package.json')` **一个 deps 都没传**
// ⇒ `http.js` 里那段 extraChannels 注入缝**不可达**；三个新模块被 import 0 次 —— 功能一样都没接上。
// 本模块就是"接线"那一步的唯一落点：**根清单探测只此一个入口**，它负责
//   ① 把「仓库落地」目录根（`getReposDir()`，真实来源，不写死）与首选包名提示真的传进探测链；
//   ② 把结果里的通道身份/逐条失败原因写回作业（面板据此显示"经 npm 镜像 / 本地落地 / 直连…"）；
//   ③ 命中本地落地时给出"一键从本地安装"的落点（目录 + `link:` 规格）。
//
// 为什么单开一个模块（而不是直接写在 install-job.js 里）：install-job.js 贴着
// test-architecture-guard.mjs 断言①的 600 行硬顶，而这一段是有判据、可离线测的接线逻辑。
//
// 分层：本文件属 L1 · domain —— 不得出现 cordis ctx（test-architecture-guard 断言⑤）。

import { getReposDir } from './repoland.js'
import { probeChannelLine } from './probe-outcome.js'
import { localInstallHint } from './presence-check.js'

/** 把"额外通道"的 deps **绑在探测袋子上**（就地包装 `probes.fetchRepoPackageEx`，返回这份 deps）。
 *
 * 为什么必须绑在袋子上、而不是只在调用点传第三个参数：根清单探测有**两个入口** ——
 * `suite.js#shouldRunSuiteInstall` 会先用 `probes.fetchRepoPackageEx(repo, branch)`（**2 参**）探一次，
 * 并把结果缓存进 `job.rootPkgProbe`，install-job 随后**复用那份缓存**。于是"只在 install-job 那一行
 * 传 deps"等于没传：套装那次 2 参调用已经把整条路走完，额外通道（本地落地 / npm registry）
 * **根本不会被用到** —— 与上一批"注入缝不可达"是同一个形状的坑，本轮实测撞到。
 * 绑在袋子上之后两个入口拿到同一份 deps；注入的桩也照样收到第三个参数（测试可断言它非空）。 */
function bindMarketDeps(probes, job, deps = {}) {
  const hinted = typeof probes.npmNameHint === 'function' ? probes.npmNameHint(job.repo) : null
  const marketDeps = {
    roots: [getReposDir()],
    packageNames: [hinted].filter((n) => typeof n === 'string' && n !== ''),
    ...(deps.marketDeps ?? {}),
  }
  const raw = probes.fetchRepoPackageEx
  if (typeof raw === 'function') {
    probes.fetchRepoPackageEx = (repo, branch, extra = {}) => raw(repo, branch, { ...marketDeps, ...extra })
  }
  return marketDeps
}

/** 抓根清单（**唯一调用点**）。返回 `rootProbe`（= fetchRepoPackageEx 的结果），
 * 并把下面这些**写回 job**（纯加法字段，老客户端忽略）：
 *   · `probe`        —— `{ channel, label, summary, failures, registryNotes, packageName, localDir }`
 *   · `channelNotes` —— 人话一行（经 noteChannel 追加）："清单经 npm 镜像（npmmirror）读到（包名）"
 *   · `packageName`  —— 清单里的包名（作业原本只从索引提示/子包展开拿，现在也认清单）
 *   · `localDir` / `localHint` —— 本地落地命中时的目录与 `link:` 规格（一键从本地安装）
 * deps 已由 bindMarketDeps 绑在袋子上 ⇒ 这里 2 参调用即可（两个入口同一份 deps）。 */
async function probeRootManifest({ job, probes, noteChannel, branch = 'main' }) {
  const rootProbe = job.rootPkgProbe !== undefined
    ? job.rootPkgProbe
    : await probes.fetchRepoPackageEx(job.repo, branch)
  job.probe = {
    channel: rootProbe.channel ?? null, label: rootProbe.label ?? null, summary: rootProbe.summary ?? '',
    failures: Array.isArray(rootProbe.failures) ? rootProbe.failures : [],
    registryNotes: Array.isArray(rootProbe.registryNotes) ? rootProbe.registryNotes : [],
    packageName: rootProbe.packageName ?? null, localDir: rootProbe.localDir ?? null,
  }
  const channelLine = probeChannelLine(rootProbe)
  if (channelLine !== null) noteChannel(job, channelLine)
  if (job.packageName === null && typeof rootProbe.packageName === 'string' && rootProbe.packageName !== '') job.packageName = rootProbe.packageName
  if (typeof rootProbe.localDir === 'string' && rootProbe.localDir !== '') {
    job.localDir = rootProbe.localDir
    job.localHint = localInstallHint({ dir: rootProbe.localDir, packageName: rootProbe.packageName })
  }
  return rootProbe
}

export { probeRootManifest, bindMarketDeps }
