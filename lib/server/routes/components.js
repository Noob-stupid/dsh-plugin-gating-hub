// L2 · routes —— 组件与仓库落地（/components · /component/* · /repo-*）
// 分层 Step 8b：从 lib/index.js 的 handle() 原样搬出（只搬移未改逻辑；缩进保持原样）

import { existsSync, mkdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
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
      sendError(res, 400, '保存路径不合法：请提供绝对路径（如 D:\\dsh\\repos）')
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
      sendError(res, 400, '路径不在仓库落地目录内')
      return
    }
    if (!existsSync(target)) {
      sendError(res, 404, `目录不存在：${target}`)
      return
    }
    try {
      execFile('explorer.exe', [target], { windowsHide: true, detached: true }).unref()
      sendJson(res, 200, { ok: true })
    } catch (error) {
      sendError(res, 500, `打开失败：${error instanceof Error ? error.message : String(error)}`)
    }
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

export { routeComponents, routeRepoClone, routeRepoList, routeRepoLandConfig, routeRepoRemove, routeRepoOpen, routeComponentAutostart, routeComponentStart, routeComponentStop, routeComponentStatus }
