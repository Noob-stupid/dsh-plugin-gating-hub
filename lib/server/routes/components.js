// L2 · routes —— 组件与仓库落地（/components · /component/* · /repo-*）
// 分层 Step 8b：从 lib/index.js 的 handle() 原样搬出（只搬移未改逻辑；缩进保持原样）

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { compFind, compStart, compStatus, compStop, compUiUrl, compUpsert, findComponents } from '../domain/components.js'
import { getReposDir, listLandedRepos, setReposDir } from '../domain/repoland.js'
import { gitCloneUrls } from '../domain/sources.js'
import { execFileAsync, gitBin, gitEnv } from '../infra/exec.js'
import { disposeDir, disposeNote } from '../infra/fsx.js'
import { sendError, sendJson } from '../infra/httpd.js'

async function routeComponents(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    const list = findComponents()
    const enriched = []
    for (const c of list) {
      try {
        enriched.push(await compStatus(c.id))
      } catch {
        enriched.push({ id: c.id, name: c.name, running: false, healthy: null, pid: null, port: c.port ?? null, autoStart: c.autoStart === true })
      }
    }
    sendJson(res, 200, { ok: true, components: enriched.map((x) => ({ ...x, uiUrl: compUiUrl(compFind(x.id) ?? {}) })) })
    return
}

async function routeRepoClone(req, res, rc) {
  const ctx = rc.ctx
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    // 仓库落地：克隆任意项目到 <配置路径>/<owner>/<name>（地址由「软件源 → Git 源」决定，
    // 因此这里接受任意平台的仓库链接：GitHub / Gitee / GitLab / 自建 Gitea / 镜像代理前缀）
    const raw = typeof body.repo === 'string' ? body.repo.trim() : ''
    // 循环剥离协议/域名前缀：镜像代理链接可能叠两层（ghproxy.net/https://github.com/...）
    let repo = raw
    for (let guard = 0; guard < 4; guard += 1) {
      const next = repo
        .replace(/^https?:\/\/[^/]+\//u, '')
        .replace(/^git@[^:]+:/u, '')
      if (next === repo) break
      repo = next
    }
    repo = repo.replace(/\.git$/u, '').replace(/\/+$/u, '')
    const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(repo)
    if (!m) {
      sendError(res, 400, '仓库格式不正确：请提供 owner/repo 或仓库链接（如 https://gitee.com/owner/repo）')
      return
    }
    const [, owner, name] = m
    const root = getReposDir()
    const target = join(root, owner, name)
    if (existsSync(target)) {
      sendError(res, 400, `已存在：${target}（如需更新请先手动处理该目录）`)
      return
    }
    try {
      mkdirSync(root, { recursive: true })
      const urls = gitCloneUrls(`${owner}/${name}`)
      let lastError = null
      let cloned = false
      let usedUrl = ''
      for (const url of urls) {
        try {
          await execFileAsync(gitBin(), ['clone', '--depth', '1', url, target], { cwd: root, timeout: 600000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: gitEnv() })
          cloned = true
          usedUrl = url
          break
        } catch (error) {
          lastError = error
          // 失败可能留下半成品目录，清理后再试下一个源，否则会因目标已存在而连环失败
          // （删不掉时 disposeDir 会改名降级成 .trash-*，原路径照样让开）
          disposeDir(target)
        }
      }
      if (!cloned) throw lastError ?? new Error('未知错误')
      sendJson(res, 200, { ok: true, owner, name, path: target, url: usedUrl })
    } catch (error) {
      sendError(res, 500, `克隆失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return
}

async function routeRepoList(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    try {
      sendJson(res, 200, { ok: true, dir: getReposDir(), repos: listLandedRepos() })
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : String(error))
    }
    return
}

async function routeRepoLandConfig(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    const dir = typeof body.dir === 'string' ? body.dir.trim() : ''
    if (dir === '' || !/^[A-Za-z]:[\\/]/.test(dir) && !/^\\\\/.test(dir)) {
      // 0.5.28 改错：示例原本写成本机真实目录（把开发者的目录当成了通用示例）。
      // 换成中性的任意绝对路径示例，并说明"任意绝对路径"——判据是形状（盘符/UNC），不是具体目录。
      sendError(res, 400, '保存路径不合法：请提供绝对路径（任意绝对路径均可，如 C:\\repos 或 \\\\server\\share\\repos）')
      return
    }
    try {
      setReposDir(dir)
      sendJson(res, 200, { ok: true, dir: getReposDir() })
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : String(error))
    }
    return
}

async function routeRepoRemove(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    const target = typeof body.path === 'string' ? body.path : ''
    const rootNorm = getReposDir().replace(/[\\/]+$/u, '')
    const tNorm = target.replace(/[\\/]+$/u, '')
    if (!tNorm.startsWith(rootNorm) || tNorm === rootNorm || !existsSync(target)) {
      sendError(res, 400, '路径不在仓库落地目录内或不存在')
      return
    }
    // 核实删除结果：本机环境可能让 rmSync 静默落空（见 removeDirVerified 注释），
    // 删不掉却回 {ok:true} 会让用户以为仓库已清理。
    // 2026-09-26（本次改错）：走 disposeDir —— 删不掉就改名降级成同父目录的 `.trash-<ts>`，
    // 原路径已经让开就算成功，并如实把降级结果告诉用户（不再出现「请手动删除」）。
    const result = disposeDir(target)
    if (result.ok !== true) {
      sendError(res, 500, `删除失败：目录仍存在（${target}）——${disposeNote(result)}`)
      return
    }
    sendJson(res, 200, result.trashed === true
      ? { ok: true, trashed: true, trashPath: result.trashPath, note: disposeNote(result) }
      : { ok: true })
    return
}

/** 「打开文件夹」用的文件管理器（Windows=explorer.exe；macOS=open；其余=xdg-open）。 */
function openFolderBin() {
  if (process.platform === 'win32') return 'explorer.exe'
  return process.platform === 'darwin' ? 'open' : 'xdg-open'
}

// ── 唯一进程创建点（可注入 + 默认安全；2026-10-13 两次事故记录）──────────────────────────
// 事故一（0.5.45）：上一批测试为了覆盖"成功路径"直接调真路由 ⇒ 真的起了 explorer.exe，而夹具路径
// 当时不存在 ⇒ 用户桌面弹出 Windows「位置不可用」对话框。
// 事故二（0.5.46 施工中）：又弹了一次 —— 根因是**默认不安全**：那时"默认真 spawn，只靠外部设
// DSH_OPEN_FOLDER_NO_SPAWN=1 才拦得住"，任何人/任何 CI 不带那个变量跑测试就会重新踩到。
// ⇒ 现在把语义**反过来**：真 spawn 必须**显式 opt-in**，缺席时的默认结局是**被拒绝**（不是弹窗）。
// 进程创建只此一处，四重防线：
//   ① 注入缝：单测 `__setOpenFolderSpawn(stub)` 换成桩（一次进程都不建）；
//   ② 保险丝：`DSH_OPEN_FOLDER_NO_SPAWN=1` 时**绝不**走到 spawn —— 如实返回结构化拒绝
//      （不是静默跳过：调用方照旧把这条原因报给用户）；
//   ③ **默认安全（opt-in）**：回落到真 `defaultSpawn` 需要 `allowRealSpawn:true` 或
//      `DSH_OPEN_FOLDER_ALLOW_REAL_SPAWN=1`；两者都没有 ⇒ 结构化拒绝。生产的 routeRepoOpen 是
//      唯一的 opt-in 调用方 —— 于是"测试漏了注入"的默认结局是**红/被拒**，而不是弹用户一个窗口；
//   ④ 计数：真实 spawn 调用次数可读，测试断言恒为 0；`__openFolderSelfCheck()` 是计数器的正控
//      （真的起一次**不弹任何窗口**的进程，证明计数不是死的 —— 桩自校验，本仓既有做法）。
let injectedSpawn = null
let realSpawnCalls = 0

/** 真 spawn 的**显式 opt-in**（默认拒绝；见 openFolderVerified 第 ③ 条）。 */
function realSpawnOptIn(allowRealSpawn) {
  return allowRealSpawn === true || process.env.DSH_OPEN_FOLDER_ALLOW_REAL_SPAWN === '1'
}

function defaultSpawn(bin, args, options) {
  realSpawnCalls += 1
  return spawn(bin, args, options)
}

/** 单测注入启动桩：传函数 = 打桩（**不创建任何进程**）；传 null = 还原生产实现。 */
function __setOpenFolderSpawn(fn) {
  injectedSpawn = typeof fn === 'function' ? fn : null
  return injectedSpawn !== null
}

/** 真实子进程创建次数（测试断言本套跑完仍为 0）。 */
function __openFolderRealSpawnCalls() {
  return realSpawnCalls
}

/** 计数器正控（桩自校验）：用**生产同一个** defaultSpawn 起一次 node -e ""（无窗口、无副作用），
 * 返回它是否被计数到。返回 false ⇒ 计数桩坏了，测试必须据此响亮失败，而不是拿 0 当"没启动过"。 */
async function __openFolderSelfCheck() {
  const before = realSpawnCalls
  try {
    const child = defaultSpawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' })
    child.on('error', () => {})
    await new Promise((resolve) => { child.on('exit', resolve); setTimeout(resolve, 2000) })
  } catch {
    return { ok: false, counted: realSpawnCalls - before }
  }
  return { ok: realSpawnCalls - before === 1, counted: realSpawnCalls - before }
}

/** 路径能否"打开文件夹"：存在且是目录（文件也给开，交给文件管理器处理）。
 * 返回 null 表示可以打开，否则是给用户看的原因（不抛）。 */
function openFolderPathIssue(target) {
  try {
    const st = statSync(target)
    return st.isDirectory() || st.isFile() ? null : `${target} 既不是文件也不是目录`
  } catch (error) {
    const code = error?.code ?? ''
    if (code === 'ENOENT') return `目录不存在：${target}（可能已被删除或改名，请刷新落地列表）`
    return `读不到该路径：${target}（${error instanceof Error ? error.message : String(error)}）`
  }
}

/** 打开文件夹的**可判定**执行器（2026-10-13 改错，用户实测「点了没反应」）：
 * 旧实现是 `execFile('explorer.exe', [target], {detached:true}).unref()` —— **即发即忘**：
 *   ① 没有 error 监听（spawn 失败如 ENOENT 是**异步** 'error' 事件，try/catch 抓不到，
 *      实测：`spawn('不存在的.exe')` 在 try 块内不抛，一个 tick 后才在 error 事件里出现）；
 *   ② 立刻回 `{ok:true}` —— 失败也报成功（假绿），用户拿不到任何判据；
 *   ③ 客户端又把非 2xx 统一吞掉（`catch {}`）⇒ 用户那边**一个字都看不到**。
 * 现在：启动后**等它的结局**再回话（对象只描述观察到的事实）：
 *   · 'error'（ENOENT/EACCES…）→ ok:false + 系统原话（这就是"失败必须说出来"的正身）；
 *   · 'exit' → ok:true，退出码与用时**如实带上**（真机 explorer.exe 把请求交给已有 shell 进程后
 *     自己退出，退出码常是 1；这是委派而非失败，所以不判红，但也绝不谎称"窗口已打开"）；
 *   · 超时仍在跑 → ok:true 且注明"未在 Nms 内退出"。
 * 判据（本仓口径）：宁可红也不报假绿；静默一律不许。 */
function openFolderVerified({ target, bin = null, spawnFn = null, launchWaitMs = 1200, allowRealSpawn = false } = {}) {
  const started = Date.now()
  return new Promise((resolve) => {
    // ② 保险丝：测试红线。**先于任何进程创建**判定，且如实说明被拦下的原因。
    if (process.env.DSH_OPEN_FOLDER_NO_SPAWN === '1') {
      resolve({
        ok: false,
        reason: 'spawn-guard',
        durationMs: Date.now() - started,
        error: '测试红线：本进程禁止真的启动文件管理器（DSH_OPEN_FOLDER_NO_SPAWN=1）',
      })
      return
    }
    // ③ **默认安全**（2026-10-13 第二次事故后收紧）：回落到**底层真 spawn**（defaultSpawn）需要
    //    **显式 opt-in**；注入桩（spawnFn / __setOpenFolderSpawn）不在此列（调用方自担，且不建进程）。
    //    为什么必须这样：旧形态是"默认真 spawn，靠外部设 DSH_OPEN_FOLDER_NO_SPAWN 才拦住"——
    //    任何一条测试路径漏了注入（或忘了设那个环境变量）就会真的起 explorer.exe 指到夹具目录，
    //    在用户桌面弹出「位置不可用」（真机第二次事故）。现在"漏了注入"的默认结局是**被拒绝**，
    //    不是弹窗。生产的 routeRepoOpen 是本函数**唯一**的 opt-in 调用方（它代表"用户点了按钮"）。
    const injected = typeof spawnFn === 'function' ? spawnFn : injectedSpawn
    if (injected === null && !realSpawnOptIn(allowRealSpawn)) {
      resolve({
        ok: false,
        reason: 'spawn-guard',
        durationMs: Date.now() - started,
        error: '测试红线：本进程默认禁止真的启动文件管理器 —— 真 spawn 需显式 opt-in（openFolderVerified({allowRealSpawn:true}) 或 DSH_OPEN_FOLDER_ALLOW_REAL_SPAWN=1）',
      })
      return
    }
    const launch = injected ?? defaultSpawn
    const command = typeof bin === 'string' && bin !== '' ? bin : openFolderBin()
    let child = null
    try {
      // stdio:'ignore' —— 不建管道（旧 execFile 默认管道 + unref 会留下未 unref 的 pipe 句柄），
      // detached:true 让文件管理器窗口在插件宿主退出后依然在。
      child = launch(command, [target], { windowsHide: true, detached: true, stdio: 'ignore' })
    } catch (error) {
      resolve({ ok: false, reason: 'spawn-throw', durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) })
      return
    }
    let done = false
    const finish = (payload) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ durationMs: Date.now() - started, ...payload })
    }
    const timer = setTimeout(() => finish({
      ok: true,
      reason: 'launched',
      exited: false,
      note: `已向 ${command} 发出打开请求，进程在 ${launchWaitMs}ms 内未退出（窗口通常已弹出）`,
    }), launchWaitMs)
    child.on('error', (error) => finish({
      ok: false,
      reason: 'spawn-error',
      code: error?.code ?? null,
      error: error instanceof Error ? error.message : String(error),
    }))
    child.on('exit', (code, signal) => finish({
      ok: true,
      reason: 'exited',
      code,
      note: `${command} 进程已退出（exit ${code ?? '?'}${signal ? `/${signal}` : ''}，用时 ${Date.now() - started}ms）—— 请求已交给系统文件管理器`,
    }))
    try { child.unref?.() } catch {}
  })
}

async function routeRepoOpen(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    const target = typeof body.path === 'string' ? body.path : ''
    const rootNorm = getReposDir().replace(/[\\/]+$/u, '')
    const tNorm = target.replace(/[\\/]+$/u, '')
    if (!tNorm.startsWith(rootNorm) || tNorm === rootNorm) {
      // 守卫照旧（只允许落地目录内的路径），但**必须说清为什么被拒** ——
      // 旧实现只回一句 400，客户端又把它吞了 ⇒ 用户看到的就是"点了没反应"。
      sendError(res, 400, `为安全起见只能打开仓库落地目录内的路径：${target || '（空路径）'} 不在 ${getReposDir()} 内`)
      return
    }
    if (!existsSync(target)) {
      sendError(res, 404, `目录不存在：${target}（可能已被删除或改名，请刷新落地列表）`)
      return
    }
    const issue = openFolderPathIssue(target)
    if (issue !== null) {
      sendError(res, 400, `无法打开：${issue}`)
      return
    }
    // 启动点是注入缝（单测经 rc.deps.openFolderLauncher 打桩，**绝不真的起文件管理器**）；
    // 生产 routeDeps 不带这个键 ⇒ 走 openFolderVerified 的实现。
    const launch = typeof rc.deps?.openFolderLauncher === 'function' ? rc.deps.openFolderLauncher : openFolderVerified
    // 生产唯一的 opt-in 调用方：用户点了「打开文件夹」按钮，才允许回落到真 spawn。
    const result = await launch({ target, bin: openFolderBin(), allowRealSpawn: true })
    if (result.ok !== true) {
      sendError(res, 500, `打开文件夹失败：${result.error ?? result.reason}（命令：${openFolderBin()} ${target}）`)
      return
    }
    // 如实回结构化状态：成功也带证据（用时/退出码/note），前端据此显示结果而不是静默。
    sendJson(res, 200, {
      ok: true,
      path: target,
      target,
      action: 'open-folder',
      via: openFolderBin(),
      reason: result.reason,
      durationMs: result.durationMs ?? null,
      exitCode: typeof result.code === 'number' ? result.code : null,
      note: typeof result.note === 'string' ? result.note : '',
    })
    return
}

async function routeComponentAutostart(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    const id = typeof body.id === 'string' ? body.id : ''
    const enabled = body.enabled === true
    if (id === '') {
      sendError(res, 400, '缺少组件 id')
      return
    }
    if (!compFind(id)) {
      sendError(res, 404, '组件不存在')
      return
    }
    compUpsert({ id, autoStart: enabled })
    if (enabled) {
      compStart(id).catch(() => {})
    }
    sendJson(res, 200, { ok: true, id, autoStart: enabled })
    return
}

async function routeComponentStart(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    const id = typeof body.id === 'string' ? body.id : ''
    if (id === '') {
      sendError(res, 400, '缺少组件 id')
      return
    }
    try {
      sendJson(res, 200, { ok: true, ...(await compStart(id)) })
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : String(error))
    }
    return
}

async function routeComponentStop(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    const id = typeof body.id === 'string' ? body.id : ''
    if (id === '') {
      sendError(res, 400, '缺少组件 id')
      return
    }
    try {
      sendJson(res, 200, { ok: true, ...(await compStop(id)) })
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : String(error))
    }
    return
}

async function routeComponentStatus(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const body = rc.body
    const id = typeof body.id === 'string' ? body.id : ''
    if (id === '') {
      sendError(res, 400, '缺少组件 id')
      return
    }
    try {
      sendJson(res, 200, { ok: true, ...(await compStatus(id)) })
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : String(error))
    }
    return
}

export { routeComponents, routeRepoClone, routeRepoList, routeRepoLandConfig, routeRepoRemove, routeRepoOpen, routeComponentAutostart, routeComponentStart, routeComponentStop, routeComponentStatus, openFolderBin, openFolderVerified, __setOpenFolderSpawn, __openFolderRealSpawnCalls, __openFolderSelfCheck }
