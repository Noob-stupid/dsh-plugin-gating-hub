// issue #22 ②③：用户备注 / 用户徽章 / 用户自建分组 —— 数据层（全离线、隔离 DSH_HOME）
//
// 用户 2026-10-25 定稿的数据模型（备注 + 徽章 + 分组共用一个文件）：
//   { "plugins": { "<包名或 rowId>": { "note": "...", "badges": [...] } },
//     "groups":  [ { "id": "...", "name": "记忆类", "packages": [...], "collapsed": false } ] }
//
// 这一套钉的是**用户数据本身的可靠性**（每一件都对应一类"静默丢数据"的失败）：
//   ① 读写往返：备注 / 徽章 / 分组都能写进去、读得回、形状稳定；
//   ② **坏文件不覆盖**：文件被手工改坏 ⇒ 读降级成空结构 + 报原因；写拒绝（409）；文件一字节不动；
//   ③ **绝不拖累插件列表**：注解文件坏掉时 GET /state 照常 200、字段一个不少（用户原话：
//      "绝不因注解数据损坏而影响插件列表本身"）；
//   ④ 写盘四步：备份 → 原子写 → 读回核实 → 失败回滚（rename 抛错 ⇒ 原文件内容不变）；
//   ⑤ 并发不丢更新：10 个并发写不同包 ⇒ 10 条全在、文件始终是合法 JSON；
//   ⑥ 校验与语义：超长备注/非法徽章/重名分组被拒且零写盘；一个包只属于一个分组；
//      删分组只解除归属（备注/徽章不动）；撤销恢复回原位置；折叠状态持久化；
//   ⑦ 键控：包名命中；只给 rowId 也能命中（不产生重复记录）；
//   ⑧ 本机化纪律：本轮文件里 0 处本机绝对路径 / 用户名。
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'annotations-home')
process.env.DSH_HOME = HOME
rmSync(HOME, { recursive: true, force: true })
const PROFILE = join(HOME, 'profiles', 'web')
mkdirSync(PROFILE, { recursive: true })
writeFileSync(join(PROFILE, 'cordis.patch.yml'), '# fixture\n', 'utf8')
const cordisUrl = pathToFileURL(join(PROFILE, 'cordis.yml')).href
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })

const FILE = join(HOME, 'plugin-console', 'plugin-annotations.json')

const {
  NOTE_MAX, BADGE_MAX_COUNT, BADGE_MAX_LEN, GROUP_NAME_MAX,
  annotationsPath, readAnnotations, planAnnotationAction, applyAnnotation, annotationsSummary,
} = await import('../lib/server/domain/plugin-annotations.js')
const { routeAnnotationsGet, routeAnnotationsPost } = await import('../lib/server/routes/annotations.js')
const { routeStateGet } = await import('../lib/server/routes/state.js')

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

const fakeRes = () => {
  const res = { status: 0, body: null }
  res.writeHead = (status) => { res.status = status }
  res.end = (payload) => { res.body = payload }
  return res
}
const readFileJson = (file = FILE) => JSON.parse(readFileSync(file, 'utf8'))
const writeFileRaw = (text, file = FILE) => writeFileSync(file, text, 'utf8')
const write = (input) => applyAnnotation(input)

// ── ① 读写往返 ───────────────────────────────────────────────────────────────
console.log('\n=== ① 读写往返：备注 / 徽章 / 分组 ===')
check('① 注解文件就在 <DSH_HOME>/plugin-console/plugin-annotations.json（用户指定的位置）',
  annotationsPath() === FILE, annotationsPath())
{
  const none = readAnnotations()
  check('① 文件不存在 ⇒ 空结构 + exists:false（不报错）',
    none.ok === true && none.exists === false && Object.keys(none.data.plugins).length === 0 && none.data.groups.length === 0)

  const noted = await write({ action: 'note', packageName: '@openviking/dsh-memory-plugin', rowId: 'dsh-memory', note: '  记忆插件：给助手长期记忆，别删  ' })
  check('① 写备注 ⇒ 落盘并回 changed:true', noted.ok === true && noted.changed === true, JSON.stringify(noted.error))
  const afterNote = readFileJson()
  check('① 备注被 trim 后原样存下', afterNote.plugins['@openviking/dsh-memory-plugin']?.note === '记忆插件：给助手长期记忆，别删')
  check('① rowId 一并记下（供"只给 rowId"的调用命中）', afterNote.plugins['@openviking/dsh-memory-plugin']?.rowId === 'dsh-memory')

  const badged = await write({ action: 'badges', packageName: '@openviking/dsh-memory-plugin', badges: ['必装', '  必装  ', '记忆类'] })
  check('① 写徽章 ⇒ 去重去空白（必装 只留一个）',
    badged.ok === true && JSON.stringify(readFileJson().plugins['@openviking/dsh-memory-plugin']?.badges) === JSON.stringify(['必装', '记忆类']),
    JSON.stringify(readFileJson().plugins['@openviking/dsh-memory-plugin']?.badges))

  const created = await write({ action: 'group-create', name: '记忆类' })
  check('① 建分组 ⇒ 回 group（带 id / 空成员 / collapsed:false）',
    created.ok === true && typeof created.meta?.group?.id === 'string' && created.meta.group.name === '记忆类'
    && Array.isArray(created.meta.group.packages) && created.meta.group.packages.length === 0)
  const groupId = created.meta.group.id

  const assigned = await write({ action: 'group-assign', id: groupId, packageName: '@openviking/dsh-memory-plugin' })
  check('① 把插件加进分组 ⇒ 成员里有它',
    assigned.ok === true && readFileJson().groups[0].packages.includes('@openviking/dsh-memory-plugin'))
  check('① 备注与徽章**没被**分组动作碰掉（分组只管归属）',
    readFileJson().plugins['@openviking/dsh-memory-plugin']?.note === '记忆插件：给助手长期记忆，别删'
    && readFileJson().plugins['@openviking/dsh-memory-plugin']?.badges?.length === 2)
  check('① 摘要统计正确（1 个包 / 1 条备注 / 2 个徽章 / 1 个分组 / 1 个成员）',
    JSON.stringify(annotationsSummary(readAnnotations().data)) === JSON.stringify({ packages: 1, notes: 1, badges: 2, groups: 1, members: 1 }),
    JSON.stringify(annotationsSummary(readAnnotations().data)))
}

// ── ② 坏文件不覆盖 + 降级读出空结构 ──────────────────────────────────────────────
console.log('\n=== ② 坏文件：降级读 + 拒绝写 + 文件一字节不动 ===')
{
  const before = JSON.stringify(readFileJson(), null, 2)
  writeFileRaw('{ 这不是 JSON，是用户手滑或别的工具写坏的 ', FILE)
  const broken = readFileSync(FILE, 'utf8')
  const read = readAnnotations()
  check('② 读：ok:false + 带原因 + **降级成空结构**（面板照常渲染）',
    read.ok === false && typeof read.error === 'string' && read.error.includes('不是合法 JSON')
    && Object.keys(read.data.plugins).length === 0 && read.data.groups.length === 0, String(read.error)?.slice(0, 80))
  const attempt = await write({ action: 'note', packageName: '@openviking/dsh-memory-plugin', note: '想覆盖坏文件' })
  check('② ★ 写被拒绝（409）且**绝不覆盖**用户文件（这是"丢数据"的唯一入口）',
    attempt.ok === false && attempt.status === 409, `status=${attempt.status}`)
  check('② ★ 坏文件内容一字节没变', readFileSync(FILE, 'utf8') === broken)

  // 空文件是另一回事：那是"还没有内容"，应该正常当空结构用（写入时正常覆盖并备份）
  writeFileRaw('   \n', FILE)
  const emptyRead = readAnnotations()
  check('② 空文件 ⇒ 正常降级（emptyFile:true、ok:true）', emptyRead.ok === true && emptyRead.emptyFile === true)
  const wrote = await write({ action: 'note', packageName: 'pkg-after-empty', note: '空文件后写入' })
  check('② 空文件后写入成功（不是"坏文件"，不该被拒）', wrote.ok === true && readFileJson().plugins['pkg-after-empty']?.note === '空文件后写入')

  // JSON 但顶层是数组（结构不对）：同样按"坏文件"处理
  writeFileRaw('[1,2,3]', FILE)
  const arrayRead = readAnnotations()
  const arrayWrite = await write({ action: 'note', packageName: 'x-pkg', note: 'n' })
  check('② 顶层不是对象（数组）⇒ 读降级 + 写拒绝（409）',
    arrayRead.ok === false && arrayWrite.ok === false && arrayWrite.status === 409)

  // 还原成可用状态
  writeFileRaw(before, FILE)
  check('② 还原后读得回原来的内容', Object.keys(readAnnotations().data.plugins).length === 1)
}

// ── ③ 注解损坏绝不影响插件列表（/state 照常）──────────────────────────────────────
console.log('\n=== ③ 注解坏了，插件列表照常（/state 不读注解）===')
{
  const stateSrc = readFileSync(join(HERE, '..', 'lib', 'server', 'routes', 'state.js'), 'utf8')
  check('③ 源码级：/state 的模块**没有**引用注解模块（结构上就不可能被拖累）',
    !stateSrc.includes('plugin-annotations'))
  const domainSrc = readFileSync(join(HERE, '..', 'lib', 'server', 'domain', 'plugin-annotations.js'), 'utf8')
  check('③ 源码级：注解模块只在自己的文件里读写（不 import patch / persist / manifest 等插件侧模块）',
    !/from '\.\/(?:patch|persist|manifest|install|compat)\.js'/u.test(domainSrc))

  // 真跑一次 GET /state（夹具 ctx），注解文件同时是坏的 ⇒ /state 必须 200 且字段一个不少
  writeFileRaw('{ broken again', FILE)
  const ctx = {
    baseUrl: cordisUrl,
    loader: {
      entries: () => [
        { id: 'include', options: { name: 'cordis:include', group: true, config: { path: cordisUrl } } },
        { id: 'include:plugin-console', options: { name: '@noob-stupid/dsh-plugin-console' }, disabled: false, fiber: { state: 2 } },
      ],
    },
    webServer: { register: () => () => {} },
    effect: (fn) => { try { fn() } catch {} return () => {} },
  }
  const deps = {
    detectFrameworkUpgrade: () => null,
    detectCompat: async () => ({ ok: true }),
    listEntries: () => [{ entryId: 'include:plugin-console', moduleName: '@noob-stupid/dsh-plugin-console', rowId: 'plugin-console', enabled: true, extra: true, fiberPhase: 'ready' }],
    detectAdoptablePending: () => new Map(),
    readExtraBundleRows: async () => new Set(),
    currentFrameworkVersion: () => '0.2.1-rc.2',
    isProtectedModule: () => false,
    rowIdModuleMap: () => new Map(),
    webPort: () => 3080,
    fetchJson: async () => { throw new Error('stub: 不出网') },
    runInstallJob: async () => ({}),
    runSuiteInstallJob: async () => ({}),
    aiEmpowerExecute: async () => ({}),
    aiEmpowerPlan: async () => ({}),
    backupProfileSnapshot: async () => ({}),
    frameworkCompatReportFor: () => null,
    pnpmRemove: async () => ({}),
    preflightDisableIncompatible: async () => ({}),
    DEFAULT_SEARCH: [],
  }
  const res = fakeRes()
  await routeStateGet({ method: 'GET', url: '/plugin-console/state', headers: {} }, res, { ctx, deps, url: new URL('http://x/plugin-console/state'), pathname: '/plugin-console/state', method: 'GET' })
  const payload = res.body === null ? null : JSON.parse(res.body)
  const required = ['compat', 'compatGate', 'compatPending', 'components', 'entries', 'framework', 'gating', 'github', 'health', 'host', 'installJobs', 'lockAutofix', 'ok', 'patch', 'patchHeal', 'patchPath', 'pendingRestart', 'recentFailures', 'rollback', 'selfVersion', 'skippedBundles']
  const keys = payload === null ? [] : Object.keys(payload).sort()
  const missing = required.filter((k) => !keys.includes(k))
  check('③ ★ 注解文件坏着的时候，GET /state 仍 200 且既有字段一个不少',
    res.status === 200 && missing.length === 0, `status=${res.status} missing=${missing.join(',')}`)
  check('③ /state 里**没有**冒出注解字段（注解是独立通道，不混进插件列表契约）',
    !keys.includes('annotations') && !keys.includes('notes'))
  writeFileRaw('   \n', FILE) // 收尾成空文件，后面的用例从空状态开始
}

// ── ④ 写盘四步：备份 / 原子写 / 读回核实 / 失败回滚 ────────────────────────────────
console.log('\n=== ④ 备份 → 原子写 → 读回核实 → 失败回滚 ===')
{
  rmSync(FILE, { force: true })
  for (const name of readdirSync(join(HOME, 'plugin-console'))) {
    if (name.startsWith('plugin-annotations.json.')) rmSync(join(HOME, 'plugin-console', name), { force: true })
  }
  const first = await write({ action: 'note', packageName: 'backup-pkg', note: '第一版' })
  check('④ 首次写入没有旧文件 ⇒ 不产生备份文件（backup:null）', first.ok === true && first.backup === null, String(first.backup))
  const second = await write({ action: 'note', packageName: 'backup-pkg', note: '第二版' })
  check('④ 覆盖写前先备份（backup 指向 .bak-* 文件）',
    second.ok === true && typeof second.backup === 'string' && existsSync(second.backup), String(second.backup))
  check('④ 备份里是**旧内容**（第一版），这是回滚的本钱',
    JSON.parse(readFileSync(second.backup, 'utf8')).plugins['backup-pkg'].note === '第一版')
  check('④ 主文件是**新内容**（第二版）', readFileJson().plugins['backup-pkg'].note === '第二版')
  const leftovers = readdirSync(join(HOME, 'plugin-console')).filter((n) => n.includes('.tmp-'))
  check('④ 没有残留的 .tmp-* 临时文件（rename 成功即无残留）', leftovers.length === 0, leftovers.join(','))

  // 注入 rename 失败 ⇒ 写失败、原文件一字节不动、无残留临时文件
  const before = readFileSync(FILE, 'utf8')
  const failing = await applyAnnotation(
    { action: 'note', packageName: 'backup-pkg', note: '这次必须失败' },
    { deps: { renameSync: () => { throw new Error('EPERM: 模拟 Windows 占用') } } },
  )
  check('④ ★ 原子写失败 ⇒ ok:false + 带真实原因（不谎报成功）',
    failing.ok === false && String(failing.error).includes('EPERM'), String(failing.error)?.slice(0, 80))
  check('④ ★ 失败后原文件内容**一字节不动**（没有半截文件）', readFileSync(FILE, 'utf8') === before)
  const tmpAfterFail = readdirSync(join(HOME, 'plugin-console')).filter((n) => n.includes('.tmp-'))
  check('④ 失败后清理了临时文件', tmpAfterFail.length === 0, tmpAfterFail.join(','))

  // 读回核实失败 ⇒ 回滚（用 deps.read 模拟"写进去的不是预期内容"）
  const beforeVerify = readFileSync(FILE, 'utf8')
  let calls = 0
  const verifyFail = await applyAnnotation(
    { action: 'note', packageName: 'backup-pkg', note: '会被回滚' },
    {
      deps: {
        read: (file) => {
          calls += 1
          // 第 1 次是写入前读（正常）；第 2 次是读回核实（故意返回"没写进去"的旧内容）
          if (calls === 1) return readAnnotations(file)
          return { ok: true, exists: true, emptyFile: false, file, data: JSON.parse(beforeVerify), error: null, repaired: [] }
        },
      },
    },
  )
  check('④ ★ 读回核实不过 ⇒ ok:false 且明说"已回滚"（"写了但没生效"不许当成功）',
    verifyFail.ok === false && String(verifyFail.error).includes('读回核实'), String(verifyFail.error)?.slice(0, 80))
  check('④ ★ 核实失败后文件被回滚成写入前的内容', readFileSync(FILE, 'utf8') === beforeVerify)
}

// ── ⑤ 并发写：不丢更新 ─────────────────────────────────────────────────────────
// ⚠ 诚实标注（变异验证 A2 的结果）：`applyAnnotationSync` 内部**没有任何 await**，是纯同步的
//   ⇒ 10 个并发调用其实是一个微任务接一个微任务跑完，天然不会交错 ⇒ 这一节的"全部落盘"
//   **当前实现下不可能红**（把 queuedWrite 摘掉也照样绿，实测确认过）。
//   它仍然留着，因为它钉的是**用户可见的结果**（10 条都在、不串味），将来写盘一旦变成异步
//   （例如加一次 await fs.promises.rename），这一节就是最早红的那条。真正的并发防线是 ⑤-b：
//   `applyAnnotation` 必须经 `queuedWrite`（进程级串行队列）——它现在就是"未来的护栏"，源码级钉住。
console.log('\n=== ⑤ 10 个并发写 ⇒ 10 条全在（结果正确性）+ ⑤-b 队列护栏 ===')
{
  rmSync(FILE, { force: true })
  const names = Array.from({ length: 10 }, (_, i) => `concurrent-pkg-${i}`)
  await Promise.all(names.map((name, i) => write({ action: 'note', packageName: name, note: `并发第 ${i} 条` })))
  const stored = readFileJson()
  const landed = names.filter((name) => typeof stored.plugins[name]?.note === 'string')
  check('⑤ 10 个并发写全部落盘（没有"后写的覆盖前面"）', landed.length === names.length, `落盘 ${landed.length}/${names.length}`)
  check('⑤ 每条内容都对（没有串味）',
    names.every((name, i) => stored.plugins[name]?.note === `并发第 ${i} 条`))
  // 并发里也跑一次坏输入：不许影响其它写
  const mixed = await Promise.all([
    write({ action: 'note', packageName: 'concurrent-mixed', note: '好的一条' }),
    write({ action: 'badges', packageName: 'concurrent-mixed', badges: ['x'.repeat(BADGE_MAX_LEN + 1)] }),
  ])
  check('⑤ 并发里一条非法输入只失败它自己（另一条照常成功）',
    mixed[0].ok === true && mixed[1].ok === false && readFileJson().plugins['concurrent-mixed']?.note === '好的一条')
  check('⑤ 文件自始至终是合法 JSON 且 version=1', readFileJson().version === 1)
}

// ── ⑤-b 并发防线（源码级）：写动作必须经进程级串行队列 ────────────────────────────
{
  const domainSrc = readFileSync(join(HERE, '..', 'lib', 'server', 'domain', 'plugin-annotations.js'), 'utf8')
  check('⑤-b ★ applyAnnotation 经 queuedWrite 串行（异步化以后也不会丢更新）',
    /return queuedWrite\(\(\) => applyAnnotationSync\(/u.test(domainSrc)
    && /import \{ queuedWrite \} from '\.\.\/infra\/fsx\.js'/u.test(domainSrc))
  check('⑤-b 队列是既有那份（infra/fsx.js 的 writeQueue），没有另造一个新队列',
    !/let writeQueue|const writeQueue|new Queue\(/u.test(domainSrc))
}

// ── ⑥ 校验与语义 ──────────────────────────────────────────────────────────────
console.log('\n=== ⑥ 校验（400 且零写盘）/ 分组语义 / 撤销 ===')
{
  rmSync(FILE, { force: true })
  await write({ action: 'note', packageName: 'rules-pkg', note: '初始' })
  const snapshot = readFileSync(FILE, 'utf8')
  const rejects = [
    ['超长备注', { action: 'note', packageName: 'rules-pkg', note: 'x'.repeat(NOTE_MAX + 1) }, '备注太长'],
    ['note 不是字符串', { action: 'note', packageName: 'rules-pkg', note: 42 }, 'note 必须是字符串'],
    ['徽章不是数组', { action: 'badges', packageName: 'rules-pkg', badges: 'a' }, 'badges 必须是字符串数组'],
    ['徽章太长', { action: 'badges', packageName: 'rules-pkg', badges: ['x'.repeat(BADGE_MAX_LEN + 1)] }, '太长'],
    ['徽章太多', { action: 'badges', packageName: 'rules-pkg', badges: Array.from({ length: BADGE_MAX_COUNT + 1 }, (_, i) => `b${i}`) }, '最多'],
    ['包名不合法', { action: 'note', packageName: 'not a package', note: 'x' }, '不是合法的包名'],
    ['空分组名', { action: 'group-create', name: '   ' }, '不能为空'],
    ['超长分组名', { action: 'group-create', name: 'x'.repeat(GROUP_NAME_MAX + 1) }, '太长'],
    ['不认识的 action', { action: 'nope' }, '不认识的 action'],
  ]
  let rejected = 0
  for (const [label, input, needle] of rejects) {
    const r = await write(input)
    const good = r.ok === false && r.status === 400 && String(r.error).includes(needle)
    if (good) rejected += 1
    else check(`⑥ 拒绝「${label}」`, false, `status=${r.status} error=${r.error}`)
  }
  check(`⑥ ${rejects.length} 类非法输入全部 400 且原因可读`, rejected === rejects.length)
  check('⑥ ★ 被拒的这些一条都没写进文件（零写盘）', readFileSync(FILE, 'utf8') === snapshot)

  // 分组：重名拒绝 / 一个包只属于一个分组 / 折叠持久化 / 删除只解除归属 / 撤销回原位
  const g1 = await write({ action: 'group-create', name: '记忆类' })
  const g2 = await write({ action: 'group-create', name: '搜索类' })
  const dup = await write({ action: 'group-create', name: '记忆类' })
  check('⑥ 重名分组被拒（409）', dup.ok === false && dup.status === 409, `status=${dup.status}`)
  const id1 = g1.meta.group.id
  const id2 = g2.meta.group.id
  await write({ action: 'group-assign', id: id1, packageName: 'rules-pkg' })
  const moved = await write({ action: 'group-assign', id: id2, packageName: 'rules-pkg' })
  const groupsNow = readFileJson().groups
  check('⑥ ★ 一个包只属于一个分组：assign 到「搜索类」会从「记忆类」移出',
    groupsNow.find((g) => g.id === id2).packages.includes('rules-pkg')
    && !groupsNow.find((g) => g.id === id1).packages.includes('rules-pkg')
    && JSON.stringify(moved.meta.movedFrom) === JSON.stringify([id1]),
    JSON.stringify(moved.meta))
  await write({ action: 'note', packageName: 'rules-pkg', note: '删除分组前后的备注' })
  await write({ action: 'badges', packageName: 'rules-pkg', badges: ['保留我'] })
  const collapsed = await write({ action: 'group-collapse', id: id2, collapsed: true })
  check('⑥ 折叠状态持久化', collapsed.ok === true && readFileJson().groups.find((g) => g.id === id2).collapsed === true)
  const deleted = await write({ action: 'group-delete', id: id2 })
  check('⑥ 删分组回 deleted（带原位置 index，供撤销）',
    deleted.ok === true && deleted.meta?.deleted?.group?.id === id2 && deleted.meta?.deleted?.index === 1,
    JSON.stringify(deleted.meta))
  check('⑥ ★ 删分组**不动**插件的备注与徽章（用户数据只增不毁）',
    readFileJson().plugins['rules-pkg']?.note === '删除分组前后的备注'
    && JSON.stringify(readFileJson().plugins['rules-pkg']?.badges) === JSON.stringify(['保留我']))
  check('⑥ 删分组后分组列表里没有它了', !readFileJson().groups.some((g) => g.id === id2))
  const restored = await write({ action: 'group-restore', group: deleted.meta.deleted.group, index: deleted.meta.deleted.index })
  const afterRestore = readFileJson().groups
  check('⑥ ★ 撤销删除：分组回到**原来的位置**（index=1）',
    restored.ok === true && afterRestore.length === 2 && afterRestore[1].id === id2 && afterRestore[1].packages.includes('rules-pkg'),
    JSON.stringify(afterRestore.map((g) => g.name)))
  const unassigned = await write({ action: 'group-assign', id: id2, packageName: 'rules-pkg', member: false })
  check('⑥ 从分组移除：归属没了、备注还在',
    unassigned.ok === true && !readFileJson().groups.find((g) => g.id === id2).packages.includes('rules-pkg')
    && readFileJson().plugins['rules-pkg']?.note === '删除分组前后的备注')
  const unknownGroup = await write({ action: 'group-assign', id: 'g-does-not-exist', packageName: 'rules-pkg' })
  check('⑥ 往不存在的分组加 ⇒ 404（不是静默成功）', unknownGroup.ok === false && unknownGroup.status === 404)
}

// ── ⑦ 键控：包名 / rowId 命中同一份记录 ─────────────────────────────────────────
console.log('\n=== ⑦ 键控：包名与 rowId 指向同一条记录 ===')
{
  rmSync(FILE, { force: true })
  await write({ action: 'note', packageName: '@scope/with-row', rowId: 'with-row', note: '按包名写的' })
  const byRowId = await write({ action: 'note', rowId: 'with-row', note: '按 rowId 改的' })
  const stored = readFileJson()
  check('⑦ 只给 rowId 也能命中同一条记录（不会多出一条）',
    byRowId.ok === true && Object.keys(stored.plugins).length === 1
    && stored.plugins['@scope/with-row']?.note === '按 rowId 改的', JSON.stringify(Object.keys(stored.plugins)))
  check('⑦ 解析结果回带了 key（面板据此定位）', byRowId.meta?.key === '@scope/with-row', String(byRowId.meta?.key))

  const plan = planAnnotationAction(readAnnotations().data, { action: 'note', packageName: '@scope/with-row', note: '按 rowId 改的' })
  check('⑦ 同内容再写一次 ⇒ changed:false（幂等，不产生无谓写盘）', plan.ok === true && plan.changed === false)
}

// ── ⑧ 路由：GET/POST 的形状与状态码 ─────────────────────────────────────────────
console.log('\n=== ⑧ 路由 /annotations：GET 只读、POST 映射状态码 ===')
{
  const res = fakeRes()
  await routeAnnotationsGet({ method: 'GET' }, res, {})
  const view = JSON.parse(res.body)
  check('⑧ GET 恒 200 且形状完整（ok/file/exists/plugins/groups/stats/repaired/error）',
    res.status === 200 && typeof view.file === 'string' && Array.isArray(view.groups)
    && view.plugins !== null && typeof view.plugins === 'object' && view.stats !== null
    && Array.isArray(view.repaired) && 'error' in view,
    JSON.stringify(Object.keys(view)))
  const postRes = fakeRes()
  await routeAnnotationsPost({ method: 'POST' }, postRes, { body: { action: 'note', packageName: '@scope/with-row', note: '经路由写' } })
  const posted = JSON.parse(postRes.body)
  check('⑧ POST 成功 ⇒ 200 且回整份最新状态（面板不必再拉一次）',
    postRes.status === 200 && posted.ok === true && posted.changed === true
    && posted.plugins['@scope/with-row']?.note === '经路由写' && Array.isArray(posted.groups) && posted.stats !== null)
  const badRes = fakeRes()
  await routeAnnotationsPost({ method: 'POST' }, badRes, { body: {} })
  check('⑧ POST 缺 action ⇒ 400 + 可用动作清单（不是 500/静默）',
    badRes.status === 400 && String(JSON.parse(badRes.body).error).includes('group-create'))
  const conflictRes = fakeRes()
  await routeAnnotationsPost({ method: 'POST' }, conflictRes, { body: { action: 'group-rename', id: 'nope', name: 'x' } })
  check('⑧ POST 分组不存在 ⇒ 404（如实）', conflictRes.status === 404, `status=${conflictRes.status}`)
}

// ── ⑨ 本机化纪律 ──────────────────────────────────────────────────────────────
console.log('\n=== ⑨ 本机化纪律 ===')
{
  const CHANGED = [
    'tests/test-plugin-annotations.mjs',
    'lib/server/domain/plugin-annotations.js',
    'lib/server/routes/annotations.js',
  ]
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const userName = home === '' ? '' : home.split(/[\\/]/u).pop()
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const asPath = (s) => new RegExp(`(?:[\\\\/]|[A-Za-z]:|\\$HOME[\\\\/]|~[\\\\/])${esc(s)}`, 'u')
  const BANNED = [
    { name: '本机用户名（路径位置，原样）', re: userName.length < 2 ? null : asPath(userName) },
    { name: '本机家目录明文', re: home === '' ? null : new RegExp(home.replace(/[\\/]/gu, '[\\\\/]').replace(/[.*+?^${}()|[\]\\]/gu, (m) => (m === '\\' || m === '/' ? m : `\\${m}`)), 'u') },
    { name: '本次工作副本绝对路径', re: new RegExp(ROOT.replace(/[\\/]/gu, '[\\\\/]').replace(/[.*+?^${}()|[\]\\]/gu, (m) => (m === '\\' || m === '/' ? m : `\\${m}`)), 'u') },
  ].filter((b) => b.re !== null)
  const hits = []
  for (const rel of CHANGED) {
    readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/u).forEach((line, i) => {
      for (const b of BANNED) if (b.re.test(line)) hits.push(`${rel}:${i + 1} ${b.name}`)
    })
  }
  check(`⑨ ★ 本轮文件里本机绝对路径 / 用户名 0 出现（扫 ${CHANGED.length} 个文件）`, hits.length === 0, hits.slice(0, 5).join(' | ') || undefined)
}

console.log(failed === 0 ? '\nALL PASS（用户注解：备注/徽章/分组 —— 不丢数据、不覆盖坏文件、不拖累插件列表）' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
