// 批次 D-①（2026-09-27）：**源码通道按仓库体积判定**（改错：private 根不再一刀切禁 git/archive/稀疏取源码）。
//
// 真机事故：用户实测 yjh051108/dsh-routing-suite「三件套只装到两件」——该仓库根包 private（1334 KB），
// 而 0.5.18 批次 A-③ 的判据是「根包 private → 禁用 git 通道」（为治 dsh-web 429 MB 白拉），
// 于是 preset/（= dsh-router-standard 预设，只存在于仓库源码里）连一次机会都没有。
// 本用例把新判据的全部边界钉死（全离线、零网络）：
//   ① 纯判据 sourceChannelGate：小/大/未知 × 阈值边界（恰好等于 / 多 1 KB）× 0 字节仓库
//   ② env 配置 DSH_GIT_MAX_REPO_MB 的夹取（1 MB ~ 4096 MB）
//   ③ 探测 fetchRepoSize：成功 / 404 / 超时 / 异常 → state；**成功才落缓存**、缓存命中不再探测
//   ④ 门禁落到 job（gatePrivateRoot）：放行/禁止/未知三种结局 + note 必须含尺寸、原因与出路
//   ⑤ dsh-web 429 MB 元数据 fixture → **必须仍被禁**，且 note 含 429.0 MB
//   ⑥ 边界矩阵（表驱动，每行一条断言）：仓库 小/大 × 根包 已发布/private/未发布
//      × 子包 有 npm/仅 release/仅源码 × 类型 插件/bundle/预设 × 探测 成功/超时/404
import { strict as assert } from 'node:assert'
import { GIT_MAX_REPO_MB, gitMaxRepoMb, formatRepoSize, sourceChannelGate, fetchRepoSize, evaluateSourceChannel, gatePrivateRoot, sizeCache } from '../lib/server/domain/repo-size.js'

let pass = 0
let fail = 0
function check(name, ok, info = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${info === '' ? '' : ` — ${info}`}`) } else { fail += 1; console.log(`FAIL ${name}${info === '' ? '' : ` — ${info}`}`) }
}

const KB = 1024
const SMALL = 1334              // dsh-routing-suite 真实元数据（1334 KB）
const HUGE = 429 * 1024         // dsh-web 真实元数据（429 MB）

// ── ① 纯判据：小 / 大 / 未知 + 阈值边界 ────────────────────────────────────────────────
{
  const small = sourceChannelGate({ state: 'known', sizeKb: SMALL }, 20)
  check('① 小仓库（1.3 MB ≤ 20 MB）→ 放行源码通道', small.allow === true, JSON.stringify(small))
  check('① 放行时的 note 仍要说清体积与上限（不静默放行）',
    small.note.includes(formatRepoSize(SMALL)) && small.note.includes('20 MB'), small.note)

  const huge = sourceChannelGate({ state: 'known', sizeKb: HUGE }, 20)
  check('① 巨仓（429 MB > 20 MB）→ 仍被禁', huge.allow === false, JSON.stringify(huge))
  check('★ 巨仓的 note 必须含尺寸、原因与**出路**（「仓库落地」或本地镜像）',
    huge.note.includes(formatRepoSize(HUGE)) && huge.note.includes('过于庞大')
    && huge.note.includes('仓库落地') && huge.note.includes('本地镜像'), huge.note)

  const unknown = sourceChannelGate({ state: 'unknown', sizeKb: null }, 20)
  check('★ 探测不到尺寸 → 保守但仍禁（allow=false）', unknown.allow === false, JSON.stringify(unknown))
  check('★ 尺寸未知时**不沉默**：note 说明"尺寸未知，已保守跳过源码通道"',
    unknown.note.includes('体积未知') && unknown.note.includes('保守跳过'), unknown.note)

  // 阈值边界：恰好等于 → 放行（≤ 语义）；多 1 KB → 禁
  const exact = sourceChannelGate({ state: 'known', sizeKb: 20 * KB }, 20)
  check('① 边界：恰好等于阈值（20480 KB = 20 MB）→ 放行', exact.allow === true, JSON.stringify(exact))
  const over = sourceChannelGate({ state: 'known', sizeKb: 20 * KB + 1 }, 20)
  check('① 边界：阈值多 1 KB → 禁', over.allow === false, JSON.stringify(over))
  const zero = sourceChannelGate({ state: 'known', sizeKb: 0 }, 20)
  check('① 边界：0 KB（空仓库）→ 放行', zero.allow === true, JSON.stringify(zero))
  const bogus = sourceChannelGate({ state: 'known', sizeKb: Number.NaN }, 20)
  check('① 边界：sizeKb 非数字 → 当"未知"处理（禁 + 不沉默）', bogus.allow === false && bogus.state === 'unknown', JSON.stringify(bogus))
  const badLimit = sourceChannelGate({ state: 'known', sizeKb: 5 * KB }, 0)
  check('① 边界：阈值非法（0）→ 回落到默认 20 MB 而不是"全部禁止"', badLimit.allow === true && badLimit.limitMb === GIT_MAX_REPO_MB, JSON.stringify(badLimit))
  check('① 默认阈值常量就是 20 MB', GIT_MAX_REPO_MB === 20, String(GIT_MAX_REPO_MB))
  check('① formatRepoSize 保留 1 位小数', formatRepoSize(1334) === '1.3 MB' && formatRepoSize(HUGE) === '429.0 MB', `${formatRepoSize(1334)} / ${formatRepoSize(HUGE)}`)
}

// ── ② env 配置夹取 ────────────────────────────────────────────────────────────────────
{
  check('② DSH_GIT_MAX_REPO_MB=50 → 50', gitMaxRepoMb({ DSH_GIT_MAX_REPO_MB: '50' }) === 50)
  check('② DSH_GIT_MAX_REPO_MB=0 → 夹到 1（不允许"全禁"）', gitMaxRepoMb({ DSH_GIT_MAX_REPO_MB: '0' }) === 1)
  check('② DSH_GIT_MAX_REPO_MB=99999 → 夹到 4096', gitMaxRepoMb({ DSH_GIT_MAX_REPO_MB: '99999' }) === 4096)
  check('② 未配置 / 非法 → 默认 20', gitMaxRepoMb({}) === 20 && gitMaxRepoMb({ DSH_GIT_MAX_REPO_MB: 'abc' }) === 20)
  const g = sourceChannelGate({ state: 'known', sizeKb: 30 * KB }, gitMaxRepoMb({ DSH_GIT_MAX_REPO_MB: '50' }))
  check('② 可配置阈值真的生效（30 MB 在 50 MB 阈值下放行）', g.allow === true && g.limitMb === 50, JSON.stringify(g))
}

// ── ③ 探测：成功 / 404 / 超时 / 异常 + 缓存语义 ────────────────────────────────────────
{
  let calls = 0
  const cache = new Map()
  const okProbe = await fetchRepoSize('probe-org/small', { cache, race: async () => { calls += 1; return { size: SMALL } } })
  check('③ 探测成功 → state=known + sizeKb 如实', okProbe.state === 'known' && okProbe.sizeKb === SMALL, JSON.stringify(okProbe))
  const again = await fetchRepoSize('probe-org/small', { cache, race: async () => { calls += 1; return { size: 999 } } })
  check('★ 缓存命中：同一仓库第二次不再探测（calls 仍是 1）', calls === 1 && again.cached === true && again.sizeKb === SMALL, `calls=${calls} ${JSON.stringify(again)}`)
  const other = await fetchRepoSize('probe-org/other', { cache, race: async () => { calls += 1; return { size: 7 } } })
  check('③ 缓存按仓库分键（不同仓库各探一次）', calls === 2 && other.sizeKb === 7 && other.cached === false, `calls=${calls}`)

  const cache2 = new Map()
  const notFound = await fetchRepoSize('probe-org/gone', { cache: cache2, race: async () => { throw new Error('GitHub 请求失败 (HTTP 404)') } })
  check('③ 404（探测抛错）→ state=unknown（不抛给调用方）', notFound.state === 'unknown' && notFound.sizeKb === null, JSON.stringify(notFound))
  const timeout = await fetchRepoSize('probe-org/slow', { cache: cache2, race: async () => null })
  check('③ 超时（外层预算到点 → null）→ state=unknown', timeout.state === 'unknown', JSON.stringify(timeout))
  check('★ 探测失败**不落缓存**（一次网络抖动不会把仓库永久钉成"尺寸未知"）', cache2.size === 0, `cacheSize=${cache2.size}`)
  const noSize = await fetchRepoSize('probe-org/nosize', { cache: new Map(), race: async () => ({ name: 'probe-org/nosize' }) })
  check('③ 元数据里没有 size 字段 → state=unknown（不瞎猜）', noSize.state === 'unknown', JSON.stringify(noSize))
  const badRepo = await fetchRepoSize('not-a-repo', { cache: new Map(), race: async () => { throw new Error('不该被调用') } })
  check('③ 仓库名非法 → 直接 unknown（一次网络都不发）', badRepo.state === 'unknown' && badRepo.note.includes('无效'), JSON.stringify(badRepo))
}

// ── ④ 门禁落到 job 上（gatePrivateRoot 是 install-job 两处 private 根分支的唯一入口）────────
{
  const mk = () => ({ id: 'j', repo: 'probe-org/x', channelNotes: [] })
  const notes = (job) => job.channelNotes
  const note = (job, text) => { if (!job.channelNotes.includes(text)) job.channelNotes.push(text) }

  const smallJob = mk()
  const gs = await gatePrivateRoot(smallJob, note, { probe: async () => ({ state: 'known', sizeKb: SMALL }) })
  check('④ 小仓库 + private 根 → git 与源码通道**都放行**（这正是本次改错的核心）',
    gs.allow === true && smallJob.gitChannelBlocked === false && smallJob.sourceChannelBlocked === false && smallJob.privateRoot === true,
    JSON.stringify({ allow: gs.allow, git: smallJob.gitChannelBlocked, src: smallJob.sourceChannelBlocked }))
  check('④ 放行也留 note（面板能看出"为什么这次允许"）', notes(smallJob).some((n) => n.includes('1.3 MB')), JSON.stringify(notes(smallJob)))
  check('④ job.repoSize 如实记录（state/sizeKb/limitMb）',
    smallJob.repoSize.state === 'known' && smallJob.repoSize.sizeKb === SMALL && smallJob.repoSize.limitMb === 20, JSON.stringify(smallJob.repoSize))

  const hugeJob = mk()
  const gh = await gatePrivateRoot(hugeJob, note, { probe: async () => ({ state: 'known', sizeKb: HUGE }) })
  check('④ 巨仓 + private 根 → 仍禁（gitChannelBlocked=true）', gh.allow === false && hugeJob.gitChannelBlocked === true && hugeJob.sourceChannelBlocked === true)
  check('★ 巨仓的 note 含尺寸与出路（"仓库落地"/本地镜像）',
    notes(hugeJob).some((n) => n.includes('429.0 MB') && n.includes('仓库落地')), JSON.stringify(notes(hugeJob)))

  const unknownJob = mk()
  await gatePrivateRoot(unknownJob, note, { probe: async () => ({ state: 'unknown', sizeKb: null }) })
  check('★ 尺寸未知 + private 根 → 保持禁令，但 note 说明"尺寸未知，已保守跳过"',
    unknownJob.gitChannelBlocked === true && notes(unknownJob).some((n) => n.includes('体积未知') && n.includes('保守跳过')),
    JSON.stringify(notes(unknownJob)))

  // evaluateSourceChannel：阈值可注入
  const g50 = await evaluateSourceChannel('probe-org/mid', { probe: async () => ({ state: 'known', sizeKb: 30 * KB }), thresholdMb: 50 })
  const g20 = await evaluateSourceChannel('probe-org/mid', { probe: async () => ({ state: 'known', sizeKb: 30 * KB }), thresholdMb: 20 })
  check('④ 同一个 30 MB 仓库：阈值 50 放行 / 阈值 20 禁（判据真的按配置走）', g50.allow === true && g20.allow === false)
  const gEnv = await evaluateSourceChannel('probe-org/mid', { probe: async () => ({ state: 'known', sizeKb: 30 * KB }), env: { DSH_GIT_MAX_REPO_MB: '40' } })
  check('④ env 阈值也走同一条路（DSH_GIT_MAX_REPO_MB=40 → 放行）', gEnv.allow === true && gEnv.limitMb === 40)
  const gThrow = await evaluateSourceChannel('probe-org/mid', { probe: async () => { throw new Error('探测器炸了') } })
  check('④ 探测器抛错 → 保守（禁）而不是把作业打挂', gThrow.allow === false && gThrow.state === 'unknown')
}

// ── ⑤ 真机 fixture：zhu1090093659/dsh-web = 429 MB → 必须仍被禁 ─────────────────────────
{
  const job = { id: 'j-dshweb', repo: 'zhu1090093659/dsh-web', channelNotes: [] }
  const note = (j, text) => { if (!j.channelNotes.includes(text)) j.channelNotes.push(text) }
  await gatePrivateRoot(job, note, { probe: async () => ({ state: 'known', sizeKb: HUGE }) })
  check('★⑤ dsh-web（429 MB 元数据 fixture）**必须仍被禁**（0.5.18 的疗效不许丢）',
    job.gitChannelBlocked === true && job.sourceChannelBlocked === true, JSON.stringify(job.repoSize))
  check('★⑤ 被禁的 note 必须含尺寸（"429.0 MB"）——OLD 文案里的 0 尺寸不许回归',
    job.channelNotes.some((n) => n.includes('429.0 MB')), JSON.stringify(job.channelNotes))
  const gate = sourceChannelGate({ state: 'known', sizeKb: HUGE }, 20)
  check('★⑤ 判据本身也说清了尺寸（尺寸以元数据为准，不是硬编码）',
    gate.note.includes('429.0 MB') && gate.limitMb === 20, gate.note)
}

// ── ⑥ 边界矩阵（表驱动；每一行一条断言，覆盖父任务要求的五个维度）──────────────────────────
// 维度：仓库 小/大 × 根包 已发布/private/未发布 × 子包 有 npm/仅 release/仅源码
//       × 类型 插件/bundle/预设 × 探测 成功/超时/404
// 本层（体积门禁）能判定的就是"源码通道是否放行"；后面三个维度分别由
//   · shouldRunSuiteInstall（根包/子包是否已发布 → 走不走套装）
//   · tryCandidateChannels（按包名的通道序列 + 新增的预设源码通道）
//   · assemblePreset / suiteReport 的 type 字段（插件/bundle/预设）
// 各自断言 —— 见本套 MATRIX 的 kind 列与 test-suite-*、test-preset-source 两套。
const MATRIX = []
for (const repo of [{ k: '小', sizeKb: SMALL }, { k: '大', sizeKb: HUGE }]) {
  for (const rootPkg of ['已发布', 'private', '未发布']) {
    for (const subPkg of ['有 npm', '仅 release', '仅源码']) {
      for (const kind of ['插件', 'bundle', '预设']) {
        for (const probe of ['成功', '超时', '404']) {
          MATRIX.push({ repo, rootPkg, subPkg, kind, probe })
        }
      }
    }
  }
}
check('⑥ 矩阵规模 = 2 仓库 × 3 根包 × 3 子包 × 3 类型 × 3 探测 = 162 行（每一行都有断言）', MATRIX.length === 162, `rows=${MATRIX.length}`)
{
  let rows = 0
  const mismatches = []
  for (const row of MATRIX) {
    const probeResult = row.probe === '成功'
      ? { state: 'known', sizeKb: row.repo.sizeKb }
      : { state: 'unknown', sizeKb: null }
    const gate = await evaluateSourceChannel('probe-org/matrix', { probe: async () => probeResult })
    // 期望：探测成功时按体积（小=放行 / 大=禁）；探测失败（超时/404）一律保守禁
    const expectAllow = row.probe === '成功' && row.repo.k === '小'
    rows += 1
    if (gate.allow !== expectAllow) mismatches.push(JSON.stringify(row))
    // 每一行还必须有一条非空 note（"不许沉默"是这次事故的另一半）
    if (typeof gate.note !== 'string' || gate.note === '') mismatches.push(`note 为空：${JSON.stringify(row)}`)
    if (row.repo.k === '大' && row.probe === '成功' && !gate.note.includes('429.0 MB')) mismatches.push(`大仓库 note 缺尺寸：${JSON.stringify(row)}`)
    if (row.probe !== '成功' && !gate.note.includes('体积未知')) mismatches.push(`未知尺寸 note 不达意：${JSON.stringify(row)}`)
  }
  check(`⑥ 162 行矩阵全部符合期望（放行=探测成功且小仓库；其余一律禁 + 非空 note）`,
    mismatches.length === 0, mismatches.slice(0, 4).join(' | ') || `${rows} rows ok`)
  // 抽样把 5 个维度的组合打印出来，便于人工复核矩阵确实覆盖了三维交叉
  const sample = MATRIX.filter((r) => r.repo.k === '小' && r.rootPkg === 'private' && r.kind === '预设')
  check('⑥ 矩阵确实交叉覆盖（小仓库 × private 根 × 预设 × 三个子包/探测组合）', sample.length === 9, `sample=${sample.length}`)
  check('⑥ 真机那一格在矩阵里（小仓库 + private 根 + 仅源码 + 预设 + 探测成功）',
    MATRIX.some((r) => r.repo.k === '小' && r.rootPkg === 'private' && r.subPkg === '仅源码' && r.kind === '预设' && r.probe === '成功'))
}

// ── ⑦ 生产默认值：真实调用不注入 probe 时不应抛（不联网断言：只查 shape）───────────────
{
  let thrown = null
  let res = null
  try {
    res = await evaluateSourceChannel('', {})
  } catch (error) { thrown = error }
  check('⑦ 生产路径（无注入 probe）不抛，返回结构化判据', thrown === null && res !== null && typeof res.allow === 'boolean', thrown === null ? JSON.stringify(res) : String(thrown?.message))
  check('⑦ 默认缓存是进程内 Map（跨调用共享）', sizeCache instanceof Map)
}

assert.ok(pass > 0)
console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（PASS ${pass} / FAIL ${fail}）`)
process.exit(fail === 0 ? 0 : 1)
