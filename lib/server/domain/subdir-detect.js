// L1 · domain —— subdir-detect.js（仓库子目录插件识别）
//
// 为什么单开一个文件：install-job.js 已经贴着 600 行硬顶（tests/test-architecture-guard.mjs 断言），
// 而"根目录没有 package.json 时向下扫子目录"是一块自洽的只读逻辑，搬出来还能独立单测。
//
// 真机现场（2026-10-13 用户实测）：`Fei2411/DeepSeek-Bot`（topics 含 dsh-plugin）根目录**没有**
// package.json —— 但 `ds-bot/package.json` 同时声明了 `dsh.client` 与 `dsh.bundle.patch`，
// 是不折不扣的 DSH 插件。旧判定只看仓库根，于是给用户一句"不是插件"，
// 既不准（结论错）也不给路（没有下一步）。判据：**向下扫 1–2 层**（`<dir>/package.json`、
// `<dir>/<sub>/package.json`，与 fetchSubpackageNames 的路径口径完全一致），
// 命中带 dsh 标记的清单就明说"插件在 <子目录>/ 下"，扫完确实没有才保持旧结论 ——
// 且文案必须补上"已检查根目录与 N 层子目录"（诚实：让用户知道我们看过哪里）。
//
// 分层：本文件属 L1 · domain —— 不得出现 cordis ctx（test-architecture-guard 断言⑤）。

/** 清单里的 DSH 插件标记（`dsh.bundle` / `dsh.client` 任一）。
 * 判据与官方安装器一致：`dsh.bundle.patch` 说明是 bundle 层包（其 cordis.patch.yml 会被组合进树），
 * `dsh.client` 说明带 UI 入口 —— 两者任一即"这是给 DSH 用的包"。
 * 纯函数（单测覆盖）：JSON 解析失败、`dsh` 不是对象、字段类型不对，一律返回 []，绝不抛。 */
function dshMarkersOf(pkg) {
  const out = []
  try {
    if (pkg === null || typeof pkg !== 'object') return out
    const dsh = pkg.dsh
    if (dsh !== null && typeof dsh === 'object') {
      if (typeof dsh.bundle?.patch === 'string' && dsh.bundle.patch !== '') out.push('dsh.bundle.patch')
      if (dsh.client !== null && dsh.client !== undefined) out.push('dsh.client')
    }
  } catch {
    return []
  }
  return out
}

/** 读一段 package.json 文本（已从网络/磁盘拿到）→ 归一化的包信息。
 * 返回 `{ name, markers, privateRoot }`；解析失败或没有合法名字返回 null
 * （"读到了但不算包"与"没读到"是两件事，这里只管前者，调用方负责后者）。 */
function describeDshManifest(text) {
  try {
    const pkg = JSON.parse(text)
    if (pkg === null || typeof pkg !== 'object') return null
    if (typeof pkg.name !== 'string' || pkg.name === '') return null
    return { name: pkg.name, markers: dshMarkersOf(pkg), privateRoot: pkg.private === true }
  } catch {
    return null
  }
}

/** 把"已知子包清单"（各行含 path / name / markers）折成**用户可读的结论**（纯函数，单测覆盖）。
 *
 * `subs` 形态与 market.js 的 `fetchSubdirPlugins` 返回值一致：
 * `[{ path: 'ds-bot', name: 'ds-bot', markers: ['dsh.client', 'dsh.bundle.patch'] }, …]`
 *
 * 返回：
 *   · found=true  → `{ dir, packageName, markers, checkedDirs }`（插件在哪个子目录）
 *   · found=false → `{ checkedDirs }`（真扫过这些目录，一个 dsh 清单都没有）
 * `checkedDirs` 永远如实列出**本次真的读到清单的那些目录**（没读到的用 `scanned` 计数带过），
 * 这样文案里那句"已检查 N 层子目录"是有据可查的，而不是一句空话。 */
function pickSubdirPlugin(subs) {
  const list = (Array.isArray(subs) ? subs : []).filter((s) => s !== null && typeof s === 'object')
  const checkedDirs = list.map((s) => String(s.path ?? s.dir ?? '')).filter((d) => d !== '')
  const hit = list.find((s) => Array.isArray(s.markers) && s.markers.length > 0)
  if (hit === undefined) return { found: false, checkedDirs }
  return {
    found: true,
    dir: String(hit.path ?? hit.dir ?? ''),
    packageName: typeof hit.name === 'string' && hit.name !== '' ? hit.name : String(hit.path ?? '').split('/').pop(),
    markers: [...hit.markers],
    checkedDirs,
  }
}

/** 命中子目录插件时的**可安装下一步**（纯函数，单测覆盖）。
 *
 * 0.5.47 改错（用户实测）：0.5.46 只做到"认出来了 + 给一段可复制的文字"，**装不了** ——
 * 用户拿到一句"插件在 ds-bot/ 下"之后还得自己想办法。现在把结构化的可执行计划一并带出：
 * `{ action: 'install-subdir', repo, branch, dir, packageName, markers }`。
 * 面板据此渲染一个**按钮**（而不是让用户从报错里抄路径），点下去就是把 `subdir` 交给既有的
 * `/plugin-console/install` —— 由 domain/subdir-install.js 先落地该子目录、再按既有**本地目录来源**
 * （`link:`，见 source-spec.js 的判据 C）装进 profile。
 * 判据不放松：到服务端那一步仍要重新读 `<dir>/package.json` 并按同一把尺子核实（名字 + dsh 标记），
 * 前端传什么都不算数。`markers` 只为展示判据来源；`repo`/`branch` 由**识别当时**的事实给出，
 * 免得面板再猜一次。 */
function subdirInstallPlan(repo, branch, pick) {
  const dir = String(pick?.dir ?? '')
  const packageName = String(pick?.packageName ?? '')
  if (dir === '' || packageName === '') return null
  return {
    action: 'install-subdir',
    repo: String(repo ?? ''),
    branch: String(branch ?? ''),
    dir,
    packageName,
    markers: Array.isArray(pick?.markers) ? [...pick.markers] : [],
  }
}

/** 命中子目录插件时的用户可读结论（纯函数，单测覆盖）。
 * 要点（对应用户实测的质疑"它不是 DSH 插件吗"）：
 *   ① 先**纠正结论** —— 这不是"不是插件"，而是"插件不在根目录"；
 *   ② 给出**子目录路径**与**包名**，以及标记来源（dsh.bundle.patch / dsh.client）—— 判据可核验；
 *   ③ 给出**可安装的下一步**（0.5.47 改错）：控制台自己能从这个子目录装 —— 面板上的按钮走
 *      `/plugin-console/install` + `subdir`，服务端先稀疏取该子目录源码到本地、再按既有
 *      **本地目录来源**（`link:`）装进 profile；清单校验 / 来源校验与别的安装路径**同一套**。
 *      npm 上若已发布该包，另给一条可直接照抄的命令（两条路都要说清，不二选一藏起来）。 */
function subdirPluginText(repo, branch, pick, source = 'github') {
  const dir = String(pick?.dir ?? '')
  const pkgName = String(pick?.packageName ?? '')
  const markers = Array.isArray(pick?.markers) ? pick.markers.join('、') : ''
  return `仓库 ${repo}（${branch} 分支）根目录没有 package.json，但**插件在子目录 ${dir}/ 下**`
    + `（${dir}/package.json 声明了 DSH 标记：${markers}）。`
    + `它就是 DSH 插件，只是清单不在仓库根——${pkgName === '' ? '该子包的包名没能读到' : `包名是 ${pkgName}`}。`
    + `下一步：点下面的「从这个子目录安装」即可 —— 控制台会先把 ${dir}/ 的源码取到本地，`
    + `再按既有**本地目录来源**（link:）装进 profile（清单校验与来源校验与其它安装路径同一套，`
    + `装完照样收口：清单 + lock + 挂载行）。`
    + `${pkgName === '' ? '' : `该包若已发布到 npm，也可以直接安装：dsh plugin --profile <你的 profile> add ${pkgName}。`}`
}

/** 扫完根目录与子目录都没找到插件时的用户可读结论（纯函数，单测覆盖）。
 * 与 packageProbeErrorText 的分工：那个只管"根目录为什么没读到"（超时/非法/确实没有），
 * 这里补上**本次到底检查了哪里**（子目录层数 + 读到清单的目录名），
 * 让"不是插件"这个结论有据可查，而不是一句没有出处的断言。
 *
 * `scanFailed`（2026-10-13 补）：子目录这一轮**没能扫成**（探针抛错 / 返回非数组 / 根本没给探针）时，
 * 结论句必须从"未发现声明 dsh 标记的 package.json"降级成"只覆盖读到的部分" ——
 * 否则一次网络限流就会变成一句比事实更强的断言（"没有"≠"没读到"）。
 * `reason` 是根清单探测的原因码：`FETCH_UNREACHABLE`（'unreachable'）同理降级。 */
function notPluginText(repo, branch, reason, checkedCount, subCount, baseText = '', scanFailed = false) {
  const head = baseText !== '' ? baseText.replace(/。$/u, '') : `仓库 ${repo}（${branch} 分支）不是可安装的插件`
  const partial = scanFailed || reason === 'unreachable' || subCount > checkedCount
  const scope = `已检查根目录与 2 层子目录（本次读到清单的子目录 ${checkedCount} 个`
    + `${subCount > checkedCount ? `，另有 ${subCount - checkedCount} 个目录清单没读到（可能是网络受限，不代表不存在）` : ''}）`
  const verdict = partial
    ? '；子目录这一轮没能完整读到，所以"没有 dsh 插件"这条结论只覆盖读到的部分'
    : '，未发现声明 dsh 标记的 package.json'
  return `${head}。${scope}${verdict}。`
}

/** 根目录没有清单时**唯一**的结论出口（纯函数，单测覆盖）：把扫描结果折成
 * 服务端 job 上要写的那几个字段（hint / error / subplugin），调用方（install-job）只剩赋值。
 * 为什么要把出口收成一个函数：两个分支必须**互斥且都给出路** —— 命中子目录插件时文案说
 * "插件在 <子目录>/ 下 + 下一步"，没命中时文案必须补"已检查根目录与 2 层子目录"（诚实）。
 * 任何"分支走错一句话"的变异都会被 tests/test-subdir-plugin.mjs 抓住。
 * `probe`（可选）负责真去扫 —— 注入缝与 install-job 的 marketProbes 同一套语义：
 * 传桩函数即可离线断言"扫到了什么就说什么"，生产调用传真的 fetchSubdirPlugins。
 * 探针**抛错或返回非数组**（含 fetchSubdirPlugins 的"扫描失败 → null"契约）⇒ `scanFailed=true`：
 * 结论照旧给，但文案降级为"只覆盖读到的部分"（"没读到"绝不冒充"没有"）。 */
async function decideNoRootManifest({ repo, branch, reason, subScan = null, probe = null, baseText = '', source = 'github' } = {}) {
  let scan = []
  let scanFailed = false
  if (Array.isArray(subScan)) {
    scan = subScan
  } else if (typeof probe === 'function') {
    try {
      const result = await probe(repo, branch)
      if (Array.isArray(result)) scan = result
      else scanFailed = true
    } catch {
      scanFailed = true
    }
  } else {
    // 没给探针 = 这一轮根本没扫过子目录 —— 不许假装"检查过了"
    scanFailed = true
  }
  const pick = pickSubdirPlugin(scan)
  if (pick.found === true) {
    return {
      hint: 'subdir-plugin',
      // 0.5.47：`install` 是**可执行**的下一步（面板据此渲染按钮）；老客户端忽略该字段（纯加法）。
      subplugin: { dir: pick.dir, packageName: pick.packageName, markers: pick.markers, checkedDirs: pick.checkedDirs, install: subdirInstallPlan(repo, branch, pick) },
      error: subdirPluginText(repo, branch, pick, source),
    }
  }
  return {
    hint: 'repo-land',
    subplugin: null,
    error: notPluginText(repo, branch, reason, pick.checkedDirs.length, Array.isArray(scan) ? scan.length : 0, baseText, scanFailed),
  }
}

export { dshMarkersOf, describeDshManifest, pickSubdirPlugin, subdirInstallPlan, subdirPluginText, notPluginText, decideNoRootManifest }
