// L2 · routes —— 软件源与 Gitee 授权（GET|POST /sources · GET /gitee-oauth-url · GET /gitee-oauth-callback · POST /registry-scan）
// 分层 Step 8b：从 lib/index.js 的 handle() 原样搬出（只搬移未改逻辑；缩进保持原样）

import { webPort } from '../domain/runtime.js'
import { DEFAULT_SOURCES, GITEE_AUTH_URL, GITEE_TOKEN_URL, consumeGiteeOAuthState, createGiteeOAuthState, giteeStatusView, isAllowedGitSourceUrl, isAllowedSourceUrl, maskSources, readGiteeConfig, readSources, writeSources } from '../domain/sources.js'
import { fetchJsonUrl, postJsonUrl } from '../infra/http.js'
import { sendError, sendJson } from '../infra/httpd.js'
import { setMarketIndexCache } from '../state.js'

async function routeSourcesGet(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const webPort = rc.deps.webPort
    const sources = readSources()
    sendJson(res, 200, { ok: true, sources: maskSources(sources), giteeStatus: giteeStatusView(sources) })
    return
}

async function routeGiteeOauthUrlGet(req, res, rc) {
  const ctx = rc.ctx
  const pathname = rc.pathname
  const method = rc.method
  const webPort = rc.deps.webPort
    const gitee = readGiteeConfig(readSources())
    if (!gitee.clientId) {
      sendError(res, 400, '请先在软件源管理中配置 Gitee 应用的 client_id / client_secret')
      return
    }
    const port = webPort(ctx)
    const redirect = `http://127.0.0.1:${port}/plugin-console/gitee-oauth-callback`
    // scope 请求 user_info + projects：Gitee 会校验请求的 scope 必须在应用已勾选的权限范围内，
    // 应用权限必须同步勾选 user_info、projects，否则报「请求范围无效、未知或格式不正确」
    const state = createGiteeOAuthState()
    const url = `${GITEE_AUTH_URL}?client_id=${encodeURIComponent(gitee.clientId)}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=${encodeURIComponent('user_info projects')}&state=${encodeURIComponent(state)}`
    sendJson(res, 200, { ok: true, url, redirect, state })
    return
}

async function routeGiteeOauthCallbackGet(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const webPort = rc.deps.webPort
    const code = new URL(req.url ?? '/', 'http://x').searchParams.get('code')
    const state = new URL(req.url ?? '/', 'http://x').searchParams.get('state')
    const sources = readSources()
    const gitee = readGiteeConfig(sources)
    const failPage = (text) => {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<h3>${text}</h3>`)
    }
    if (!code) {
      failPage('这是 Gitee 授权回调地址，不能直接访问。<br>正确流程：插件面板 → 软件源管理 → 填入 client_id / client_secret → 保存配置 → 点击「授权登录 Gitee」，授权完成后会自动跳回这里。')
      return
    }
    if (!state || !consumeGiteeOAuthState(state)) {
      failPage('Gitee OAuth state 校验失败，请重新发起授权。')
      return
    }
    if (!gitee.clientId || !gitee.clientSecret) {
      failPage('未配置 Gitee 应用：请先在 gitee.com 创建第三方应用（回调地址填本页完整地址），再在插件面板 → 软件源管理 中填入 client_id / client_secret 并保存。')
      return
    }
    const port = webPort(ctx)
    const redirect = `http://127.0.0.1:${port}/plugin-console/gitee-oauth-callback`
    const result = await postJsonUrl(GITEE_TOKEN_URL, {
      grant_type: 'authorization_code',
      code,
      client_id: gitee.clientId,
      client_secret: gitee.clientSecret,
      redirect_uri: redirect,
    })
    if (result.status < 200 || result.status >= 300 || !result.body || !result.body.access_token) {
      failPage('Gitee 授权失败：token 交换错误，请检查 client_id / client_secret')
      return
    }
    gitee.token = result.body.access_token
    try {
      const user = await fetchJsonUrl(`https://gitee.com/api/v5/user?access_token=${encodeURIComponent(gitee.token)}`)
      gitee.login = user && typeof user.login === 'string' ? user.login : ''
    } catch {}
    sources.gitee = gitee
    await writeSources(sources)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<h3>Gitee 授权成功，可以关闭此页面并回到插件面板</h3>')
    return
}

async function routeRegistryScan(req, res, rc) {
  const ctx = rc.ctx
  const url = rc.url
  const pathname = rc.pathname
  const method = rc.method
  const webPort = rc.deps.webPort
  const body = rc.body
    const sources = readSources()
    const scanPkg = '@noob-stupid/dsh-plugin-console'
    const encoded = encodeURIComponent(scanPkg)
    const scanOne = async (r) => {
      const started = Date.now()
      const base = { id: r.id, name: r.name, url: r.url, primary: r.primary === true }
      try {
        const response = await fetch(`${String(r.url).replace(/\/+$/u, '')}/${encoded}`, {
          headers: { accept: 'application/vnd.npm.install-v1+json' },
          signal: AbortSignal.timeout(8000),
        })
        const ms = Date.now() - started
        if (!response.ok) return { ...base, ok: false, ms, status: response.status, latest: null, versions: null, error: `HTTP ${response.status}` }
        const data = await response.json()
        const latest = typeof data?.['dist-tags']?.latest === 'string' ? data['dist-tags'].latest : null
        const versions = data?.versions !== undefined && data.versions !== null && typeof data.versions === 'object' ? Object.keys(data.versions).length : null
        return { ...base, ok: true, ms, status: response.status, latest, versions, error: null }
      } catch (error) {
        const ms = Date.now() - started
        const message = error?.name === 'TimeoutError'
          ? '超时（8s）'
          : (error instanceof Error ? error.message : String(error))
        return { ...base, ok: false, ms, status: null, latest: null, versions: null, error: message }
      }
    }
    const results = await Promise.all(sources.registries.map((r) => scanOne(r)))
    sendJson(res, 200, { ok: true, pkg: scanPkg, scannedAt: Date.now(), results })
    return
}

async function routeSources(req, res, rc) {
  const ctx = rc.ctx
  const pathname = rc.pathname
  const method = rc.method
  const webPort = rc.deps.webPort
  const body = rc.body
    const { action } = body
    const sources = readSources()
    if (action === 'add') {
      const url = typeof body.url === 'string' ? body.url.trim() : ''
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!isAllowedSourceUrl(url)) {
        sendError(res, 400, '软件源地址必须是 https:// 开头（或本机/私网 http://）的合法 URL')
        return
      }
      if (sources.registries.some((r) => r.url === url)) {
        sendError(res, 400, '该软件源已存在')
        return
      }
      const entry = {
        id: `src-${Date.now().toString(36)}`,
        name: name || url,
        url,
        primary: sources.registries.length === 0,
      }
      sources.registries.push(entry)
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'remove') {
      sendError(res, 400, '软件源不可删除（插件安装依赖的 npm 源，请使用编辑/设为主源）')
      return
    }
    if (action === 'edit') {
      const id = typeof body.id === 'string' ? body.id : ''
      const target = sources.registries.find((r) => r.id === id)
      if (!target) {
        sendError(res, 404, '没有这个软件源')
        return
      }
      const url = typeof body.url === 'string' ? body.url.trim() : target.url
      const name = typeof body.name === 'string' ? body.name.trim() : target.name
      if (!isAllowedSourceUrl(url)) {
        sendError(res, 400, '软件源地址必须是 https:// 开头（或本机/私网 http://）的合法 URL')
        return
      }
      if (sources.registries.some((r) => r.url === url && r.id !== id)) {
        sendError(res, 400, '该软件源地址已存在')
        return
      }
      target.url = url
      target.name = name || url
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'set-primary') {
      const id = typeof body.id === 'string' ? body.id : ''
      if (!sources.registries.some((r) => r.id === id)) {
        sendError(res, 404, '没有这个软件源')
        return
      }
      for (const r of sources.registries) r.primary = r.id === id
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'add-search') {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const url = typeof body.url === 'string' ? body.url.trim() : ''
      if (!isAllowedSourceUrl(url)) {
        sendError(res, 400, '搜索地址必须是 https:// 开头（或本机/私网 http://）的合法 URL')
        return
      }
      if (!url.includes('{q}')) {
        sendError(res, 400, '搜索 URL 模板必须包含 {q} 占位符')
        return
      }
      if (sources.searchSources.some((s) => s.url === url)) {
        sendError(res, 400, '该搜索源已存在')
        return
      }
      // 可选请求头（认证等）：[{name, value}] 结构，仅服务端使用，不下发浏览器
      const headers = Array.isArray(body.headers)
        ? body.headers
          .filter((h) => h && typeof h.name === 'string' && h.name.trim() !== '' && typeof h.value === 'string')
          .map((h) => ({ name: h.name.trim().slice(0, 100), value: h.value.slice(0, 500) }))
        : []
      sources.searchSources.push({
        id: `search-${Date.now().toString(36)}`,
        name: name || url,
        type: 'custom',
        url,
        ...(headers.length > 0 ? { headers } : {}),
      })
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'remove-search') {
      const id = typeof body.id === 'string' ? body.id : ''
      const target = sources.searchSources.find((s) => s.id === id)
      if (!target) {
        sendError(res, 404, '没有这个搜索源')
        return
      }
      if (target.type === 'builtin') {
        sendError(res, 400, '内置搜索源不可删除')
        return
      }
      sources.searchSources = sources.searchSources.filter((s) => s.id !== id)
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'add-index') {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const url = typeof body.url === 'string' ? body.url.trim() : ''
      if (!isAllowedSourceUrl(url)) {
        sendError(res, 400, '索引地址必须是 https:// 开头（或本机/私网 http://）的合法 URL')
        return
      }
      if ((sources.indexSources ?? []).some((s) => s.url === url)) {
        sendError(res, 400, '该索引源已存在')
        return
      }
      sources.indexSources = [...(sources.indexSources ?? []), {
        id: `idx-${Date.now().toString(36)}`,
        name: name || url,
        url,
        primary: (sources.indexSources ?? []).length === 0,
      }]
      setMarketIndexCache(null)
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'edit-index') {
      const id = typeof body.id === 'string' ? body.id : ''
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const url = typeof body.url === 'string' ? body.url.trim() : ''
      if (!isAllowedSourceUrl(url)) {
        sendError(res, 400, '索引地址必须是 https:// 开头（或本机/私网 http://）的合法 URL')
        return
      }
      const target = (sources.indexSources ?? []).find((s) => s.id === id)
      if (!target) {
        sendError(res, 404, '没有这个索引源')
        return
      }
      target.name = name || url
      target.url = url
      setMarketIndexCache(null)
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'set-index-primary') {
      const id = typeof body.id === 'string' ? body.id : ''
      const list = sources.indexSources ?? []
      if (!list.some((s) => s.id === id)) {
        sendError(res, 404, '没有这个索引源')
        return
      }
      for (const s of list) s.primary = s.id === id
      setMarketIndexCache(null)
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'remove-index') {
      const id = typeof body.id === 'string' ? body.id : ''
      const list = sources.indexSources ?? []
      if (!list.some((s) => s.id === id)) {
        sendError(res, 404, '没有这个索引源')
        return
      }
      const rest = list.filter((s) => s.id !== id)
      if (rest.length === 0) {
        sendError(res, 400, '至少保留一个索引源（可先添加自建镜像再删除默认源）')
        return
      }
      if (!rest.some((s) => s.primary)) rest[0].primary = true
      sources.indexSources = rest
      setMarketIndexCache(null)
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'set-index-merge') {
      sources.indexMerge = body.merge === true
      setMarketIndexCache(null)
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'add-git') {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const urlTemplate = typeof body.urlTemplate === 'string' ? body.urlTemplate.trim() : ''
      if (!urlTemplate.includes('{owner}') || !urlTemplate.includes('{repo}')) {
        sendError(res, 400, 'Git 源模板必须同时包含 {owner} 与 {repo} 占位符')
        return
      }
      if (!isAllowedGitSourceUrl(urlTemplate)) {
        sendError(res, 400, 'Git 源地址必须是 https://（或本机/私网 http://、file:// 本地裸仓库）的合法 URL')
        return
      }
      if ((sources.gitSources ?? []).some((s) => s.urlTemplate === urlTemplate)) {
        sendError(res, 400, '该 Git 源已存在')
        return
      }
      sources.gitSources = [...(sources.gitSources ?? []), {
        id: `git-${Date.now().toString(36)}`,
        name: name || urlTemplate,
        urlTemplate,
        primary: (sources.gitSources ?? []).length === 0,
      }]
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'edit-git') {
      const id = typeof body.id === 'string' ? body.id : ''
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const urlTemplate = typeof body.urlTemplate === 'string' ? body.urlTemplate.trim() : ''
      if (!urlTemplate.includes('{owner}') || !urlTemplate.includes('{repo}')) {
        sendError(res, 400, 'Git 源模板必须同时包含 {owner} 与 {repo} 占位符')
        return
      }
      if (!isAllowedGitSourceUrl(urlTemplate)) {
        sendError(res, 400, 'Git 源地址必须是 https://（或本机/私网 http://、file:// 本地裸仓库）的合法 URL')
        return
      }
      const target = (sources.gitSources ?? []).find((s) => s.id === id)
      if (!target) {
        sendError(res, 404, '没有这个 Git 源')
        return
      }
      target.name = name || urlTemplate
      target.urlTemplate = urlTemplate
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'set-git-primary') {
      const id = typeof body.id === 'string' ? body.id : ''
      const list = sources.gitSources ?? []
      if (!list.some((s) => s.id === id)) {
        sendError(res, 404, '没有这个 Git 源')
        return
      }
      for (const s of list) s.primary = s.id === id
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'remove-git') {
      const id = typeof body.id === 'string' ? body.id : ''
      const list = sources.gitSources ?? []
      if (!list.some((s) => s.id === id)) {
        sendError(res, 404, '没有这个 Git 源')
        return
      }
      const rest = list.filter((s) => s.id !== id)
      if (rest.length === 0) {
        sendError(res, 400, '至少保留一个 Git 源（可先添加自建镜像再删除默认源）')
        return
      }
      if (!rest.some((s) => s.primary)) rest[0].primary = true
      sources.gitSources = rest
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'reset') {
      const defaults = JSON.parse(JSON.stringify(DEFAULT_SOURCES))
      setMarketIndexCache(null)
      await writeSources(defaults)
      sendJson(res, 200, { ok: true, sources: maskSources(defaults) })
      return
    }
    if (action === 'gitee-setup') {
      const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : ''
      const clientSecret = typeof body.clientSecret === 'string' ? body.clientSecret.trim() : ''
      const keepClientId = body.keepClientId === true
      if ((!keepClientId && !clientId) || !clientSecret) {
        sendError(res, 400, 'client_id 与 client_secret 不能为空')
        return
      }
      const current = readGiteeConfig(sources)
      // keepClientId：前端回显的是打码 clientId（abc12345…），用户只改了 secret 时保留原配置
      sources.gitee = { ...current, clientId: keepClientId ? current.clientId : clientId, clientSecret }
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    if (action === 'gitee-clear') {
      const current = readGiteeConfig(sources)
      sources.gitee = { clientId: current.clientId, clientSecret: current.clientSecret, token: '', login: '' }
      await writeSources(sources)
      sendJson(res, 200, { ok: true, sources: maskSources(sources) })
      return
    }
    sendError(res, 400, '未知操作（add / edit / set-primary / remove / add-search / remove-search / add-index / edit-index / set-index-primary / remove-index / set-index-merge / add-git / edit-git / set-git-primary / remove-git / gitee-setup / gitee-clear / reset）')
    return
}

export { routeSourcesGet, routeGiteeOauthUrlGet, routeGiteeOauthCallbackGet, routeRegistryScan, routeSources }
