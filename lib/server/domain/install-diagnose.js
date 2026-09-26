// L1 · domain —— install-diagnose.js（安装失败分类 → 定向重试 / 提示；**纯函数**：无 IO、不认识 ctx、不读进程）
//
// 为什么（2026-09-26）：安装失败时面板只给一句原始 stderr，用户与后续流程都不知道"能不能重试、怎么重试"。
// 这里把失败文本归成 { kind, hint, retry }，调用方（install-job.js）据此只做两件事：
//   ① retry === 'longer-timeout' 的失败（网络类超时/连接重置）→ **定向重试一次**、且用更长超时；
//   ② 其余分类 → 只把 hint 写进 job.diagnosis 供面板展示，**不新增任何自动重试**（重试上限语义不变）。
//
// ⚠️ 安全边界（不许越线，写死在这里）：
//   `allowBuilds` / `ignored build scripts` 这一类**只提示，绝不自动写**用户的 allowBuilds / 构建白名单。
//   allowBuilds 决定哪些依赖可以执行安装期脚本（postinstall），自动放行 = 替用户授权任意代码执行；
//   这是必须由人做的安全决策，所以本模块对它只产出文案，且 retry 恒为 null。
//
// 分类依据是**失败文本**（pnpm 的 stderr / ExecError message），同一个 kind 的文案只维护一份。

/** 分类规则：**顺序敏感**（具体在前、宽泛在后；network-timeout 最宽，放最后兜住超时类文本）。 */
const DIAGNOSIS_RULES = [
  {
    // 2026-09-27 加法：pnpm 的**供应链年龄闸**（`minimumReleaseAge`）真的拦下安装时的专用错误码。
    // 与下面泛化的 minimumReleaseAge 分开，是因为这条要带**安全边界文案**（可自行显式绕过、代价自负，
    // 本控制台绝不代为绕过）。`withPackages` 不置位：这条错误文本里通常没有 registry URL。
    kind: 'supply-chain-age',
    re: /ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION|minimum release age violation/iu,
    retry: 'later',
    hint: '版本太新，被 pnpm 的 minimumReleaseAge（供应链安全间隔）拦下：稍后再试即可自动放行；'
      + '确有紧急需要时，**由你自己**显式加 `--config.minimumReleaseAge=0` 绕过（放行"刚发布不久"的版本有安全代价）——本控制台绝不替你绕过。',
  },
  {
    // 2026-09-27 加法：registry 抓取 404 —— 与泛化的 not-found 分开，是因为 404 要能**点名丢的是哪个依赖**。
    kind: 'fetch-404',
    re: /ERR_PNPM_FETCH_404|not found in the registry|is not in the npm registry|404 Not Found[^\n]{0,80}https?:\/\/(?:registry|npm)[^\s]*/iu,
    retry: null,
    withPackages: true,
    hint: '依赖在 registry 上 404（包名/版本不存在，或镜像未同步）：核对包名与版本、或换一个已同步的源后重试；'
      + '本控制台**不会**为了让 lock 重建成功而静默丢弃你的依赖。',
  },
  {
    // 2026-09-27 加法：陈旧/残缺的 pnpm-lock.yaml（pnpm 在 frozen-lockfile 下的确定性报错）。
    // 以前落进 other，用户只能看到一句原始 stderr；现在给"这不是网络问题、是 lock 与清单对不上"的定性。
    kind: 'lockfile-outdated',
    re: /ERR_PNPM_OUTDATED_LOCKFILE|Cannot install with "?frozen-lockfile|lockfile is not up to date|ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY/iu,
    retry: null,
    hint: 'pnpm-lock.yaml 与实际依赖不一致（陈旧或残缺）：这不是网络问题；可在「升级安全 → 依赖锁体检」里只读体检并**显式**重建 lock（本控制台不会自动改你的 profile）。',
  },
  {
    kind: 'minimumReleaseAge',
    // pnpm 的供应链安全间隔（默认关闭，可配置）：版本"太新"时拒装
    re: /minimumReleaseAge|minimum release age|ERR_PNPM_MINIMUM_RELEASE_AGE|发布年龄|安全间隔/iu,
    retry: 'later',
    hint: 'registry 的 minimumReleaseAge（供应链安全间隔）拦下了这个版本：稍后重试即可（版本"过龄"后自动放行）；'
      + '确有紧急需要时由你自行放宽（pnpm 侧 --config.minimum-release-age=0）——本控制台不替你放宽安全间隔。',
  },
  {
    kind: 'allowBuilds',
    re: /allowBuilds|allow-builds|ignored build scripts|Ignored build scripts|approve-builds|ERR_PNPM_IGNORED_BUILDS/iu,
    retry: null,
    hint: '该包带安装脚本（postinstall 一类）且被 pnpm 拦下（allowBuilds / ignored build scripts）：'
      + '本控制台**只提示，绝不自动写 allowBuilds / 构建白名单**（放行等于允许该依赖执行安装期任意代码）；'
      + '确认该包可信后，请自行执行 `pnpm approve-builds` 或在 profile 配置里显式放行。',
  },
  {
    kind: 'missing-tool',
    re: /ENOENT|Cannot find module|MODULE_NOT_FOUND|is not recognized as an internal or external command|command not found/iu,
    retry: null,
    hint: '本机缺少要用的命令/模块（corepack、pnpm、git、tar 之一）：确认 Node 安装完整、PATH 里能找到 corepack 与 git，'
      + '必要时执行 `corepack enable`；本控制台已按多套布局回退查找，真的找不到才会报到这里。',
  },
  {
    kind: 'not-found',
    // 泛化 404：**非 registry 依赖解析**的那些（GitHub release 资源、npm 的 E404 文本等）。
    // 上面的 fetch-404 更具体（能点名依赖），所以带 registry 特征的 404 会先被它命中；
    // 这里的 ERR_PNPM_FETCH_404 保留为兜底（万一文本形态变化，也不至于掉进 other）。
    re: /ERR_PNPM_FETCH_404|E404|404 Not Found|not found in the registry|is not in the npm registry/iu,
    retry: null,
    hint: 'registry 上没有这个包/这个版本（包名拼错、子包未发布，或镜像未同步）：核对包名与版本后重试；'
      + '若确认已发布，多半是镜像未同步完整 —— 换一个 registry 或稍后再试。',
  },
  {
    kind: 'locked',
    re: /EPERM|EACCES|EBUSY|ERR_PNPM_EEXIST|operation not permitted|being used by another process/iu,
    retry: null,
    hint: '文件被占用/无权限（Windows 上多为杀软或残留句柄占着 node_modules）：本控制台在安装前已清理陈旧包目录与'
      + ' pnpm `_tmp_` 残留；仍失败请关掉占用该目录的进程（编辑器、资源管理器预览）后再重试。',
  },
  {
    kind: 'network-timeout',
    // 注意：最后一条兜底最宽 —— 超时/连接类文本很多（含我们自己的"超时 Nms：已终止整棵进程树"）
    re: /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch timeout|timed out|timeout|TIMEOUT|超时|network|ERR_PNPM_\w*FETCH_FAIL|request to .* failed/iu,
    retry: 'longer-timeout',
    hint: '网络类失败（超时/连接被重置/抓取失败）：已用更长超时**自动重试一次**；仍失败多为镜像抖动或代理问题 ——'
      + '稍后重试，或在「源管理」里换一个 registry（本控制台主源是 registry.npmmirror.com）。',
  },
]

/** 从失败文本里**点名**被抓取失败的依赖（纯函数，2026-09-27 加法）。
 *
 * 为什么必须能点名：pnpm 的 404 报错里包名只出现在 URL 路径里（`GET https://registry.npmmirror.com/dsh-github-login`），
 * 用户在面板上只看到一句"registry 上没有这个包"，还得自己去翻 stderr 才知道是哪一个。
 * 这里把 URL 路径还原成包名（含 `@scope%2fname` 这种编码形态），去重后按出现顺序返回。
 * 认不出来就返回空数组（调用方据此保留原样文案，绝不编造包名）。 */
function missingPackagesFrom(text) {
  const raw = typeof text === 'string' ? text : String(text ?? '')
  const found = []
  for (const m of raw.matchAll(/https?:\/\/[^\s'"()<>]+/gu)) {
    let path = ''
    try {
      path = new URL(m[0]).pathname
    } catch {
      continue
    }
    const cut = path.split('/-/')[0] // tarball 形态：/<pkg>/-/<file>.tgz → 只取包名段
    // pnpm 的报错里 URL 常直接跟着冒号/逗号（`…/dsh-x: Not Found - 404`）→ 先去尾部标点再认包名
    const decoded = decodeURIComponent(cut).replace(/^\/+/u, '').replace(/[/:;,.]+$/u, '')
    if (!/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/u.test(decoded)) continue
    if (/\.(?:tgz|json|yaml|yml)$/iu.test(decoded)) continue
    if (!found.includes(decoded)) found.push(decoded)
  }
  return found
}

/** 按分类取短句 hint（纯函数；2026-09-27 加法）：**文案只有一份**——
 * lockfile-health.js 的体检结论也走这里，避免"同一分类两处措辞"。认不出的分类返回 null。 */
function hintForKind(kind, packages = []) {
  const rule = DIAGNOSIS_RULES.find((r) => r.kind === kind)
  if (rule === undefined) return null
  const list = Array.isArray(packages) ? packages.filter((p) => typeof p === 'string' && p !== '') : []
  return rule.withPackages === true && list.length > 0 ? `${rule.hint}（涉及：${list.join('、')}）` : rule.hint
}

/** 失败文本 → { kind, hint, retry, packages }。
 * retry 取值：'longer-timeout'（调用方**只对它**做一次定向长超时重试）| 'later'（提示"稍后再试"，不自动重试）| null。
 * packages（2026-09-27 加法）：文本里能点名的依赖包名（认不出就是空数组）——只用于展示，不参与任何判定。 */
function classifyInstallFailure(stderrOrMessage) {
  const text = typeof stderrOrMessage === 'string' ? stderrOrMessage : String(stderrOrMessage ?? '')
  const packages = missingPackagesFrom(text)
  for (const rule of DIAGNOSIS_RULES) {
    if (!rule.re.test(text)) continue
    return { kind: rule.kind, hint: hintForKind(rule.kind, packages), retry: rule.retry, packages }
  }
  return {
    kind: 'other',
    hint: '未归类的安装失败：请把下面的原始输出用于排查；可先原样重试一次，仍失败再换源或看作业详情里的完整 stderr。',
    retry: null,
    packages,
  }
}

/** 定向重试用的更长超时（纯函数）：默认翻倍，至少 +15s，封顶 4 分钟 —— 避免"重试"变成"再卡一次很久"。
 * 非法输入回落到 90s（= 安装通道默认值）后再翻倍。 */
function longerTimeoutFor(timeout, { cap = 240000 } = {}) {
  const base = Number.isFinite(timeout) && timeout > 0 ? timeout : 90000
  return Math.min(Math.max(Math.round(base * 2), base + 15000), cap)
}

/** 一行可展示文案（面板/日志用；纯函数）：说清分类、是否已自动重试、点名的依赖、以及下一步建议。 */
function diagnosisText(diagnosis) {
  if (diagnosis == null || typeof diagnosis !== 'object') return null
  const retried = diagnosis.retried === true ? '（已自动重试一次：更长超时）' : ''
  const pkgs = Array.isArray(diagnosis.packages) && diagnosis.packages.length > 0 ? `（涉及：${diagnosis.packages.join('、')}）` : ''
  return `失败分类：${diagnosis.kind}${retried}${diagnosis.hint ? `；${diagnosis.hint}` : ''}${pkgs}`
}

/** ③ 的定向重试编排（**本文件唯一的非纯函数**，只被 install-job.js 调用）：
 * pnpm 通道的失败若分类为 network-timeout（retry === 'longer-timeout'），用**更长超时**再试**一次**；
 * 其余分类只把 hint 写进 job.diagnosis，不重试。返回 { installedName, error, diagnosis }：
 * 重试成功给 installedName，失败给 error（调用方据此更新 lastError，语义与原来一致）。 */
async function retryPnpmOnce({ ch, profileDir, name, registries, pnpmError, job, baseTimeoutMs = 90000 }) {
  const diagnosis = classifyInstallFailure(pnpmError?.message)
  job.diagnosis = diagnosis
  if (diagnosis.retry !== 'longer-timeout') return { installedName: null, error: null, diagnosis }
  const retryTimeoutMs = longerTimeoutFor(baseTimeoutMs)
  try {
    await ch.pnpmInstall(profileDir, name, registries[0], retryTimeoutMs)
    const ok = { ...diagnosis, retried: true, retryTimeoutMs }
    job.diagnosis = ok
    return { installedName: name, error: null, diagnosis: ok }
  } catch (error) {
    const failed = { ...classifyInstallFailure(error?.message), retried: true, retryTimeoutMs }
    job.diagnosis = failed
    return { installedName: null, error, diagnosis: failed }
  }
}

export { classifyInstallFailure, longerTimeoutFor, diagnosisText, retryPnpmOnce, missingPackagesFrom, hintForKind, DIAGNOSIS_RULES }
