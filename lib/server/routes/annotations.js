// L2 · routes —— /annotations（用户备注 / 用户徽章 / 用户分组；issue #22 ②③）
//
// 两条路由，同一个路径（与既有的 `/sources` 同一手法：GET 只读住守卫前，POST 吃 body 住守卫后）：
//   · GET  /plugin-console/annotations  → 读整份注解（**纯只读**，永不抛；坏文件降级 + 带原因）
//   · POST /plugin-console/annotations  → 一次写动作（action 见 domain/plugin-annotations.js）
//
// 三条边界：
//   ① **与插件列表完全解耦**：注解读/写失败只影响这两条路由，绝不进 /state 的路径
//      （插件列表照常渲染；"注解坏了不该让我看不见插件"——用户明确要求）。
//   ② 写动作全部走 domain 的四步（备份 → 原子写 → 读回核实 → 回滚），路由只做**入参映射 + 状态码**：
//      校验 400、坏文件/重名 409、分组不存在 404、其余 200。绝不在这里自己写盘。
//   ③ 成功时回**整份最新状态**（plugins + groups + stats），面板不必再请求一次就能重绘
//      （少一次往返，也避免"写成功但界面还是旧的"这种自相矛盾）。
//
// 路由注册：`lib/server/routes/index.js`（GET 在 ROUTES_EARLY，POST 在 ROUTES）；
// 路由清单：`tests/test-route-inventory.mjs`。
import { annotationsSummary, annotationsPath, applyAnnotation, readAnnotations } from '../domain/plugin-annotations.js'
import { sendError, sendJson } from '../infra/httpd.js'

/** 一份可直接给面板渲染的注解视图（读不到也永远有完整形状）。 */
function annotationsView(read) {
  const data = read.data
  return {
    ok: read.ok === true,
    file: read.file,
    exists: read.exists === true,
    emptyFile: read.emptyFile === true,
    version: data.version ?? 1,
    updatedAt: data.updatedAt ?? 0,
    plugins: data.plugins,
    groups: data.groups,
    stats: annotationsSummary(data),
    // 读的时候做过规范化（用户手工改过文件）：如实把"我改了哪些"说出来，不静默
    repaired: Array.isArray(read.repaired) ? read.repaired : [],
    error: read.error ?? null,
  }
}

async function routeAnnotationsGet(req, res, rc) {
  void rc
  const read = readAnnotations()
  // 只读接口永远 200：坏文件也要让面板拿得到"空结构 + 原因"，否则面板只能显示一句泛泛的失败
  sendJson(res, 200, annotationsView(read))
}

async function routeAnnotationsPost(req, res, rc) {
  const body = rc.body ?? {}
  const action = typeof body.action === 'string' ? body.action : ''
  if (action === '') {
    sendError(res, 400, '缺少 action（可用：note / badges / group-create / group-rename / group-delete / group-restore / group-assign / group-collapse）')
    return
  }
  // input 原样透传：所有校验都在 domain（**一处判据**），路由不重复判断、也不放宽
  const result = await applyAnnotation({ ...body, action })
  const after = readAnnotations()
  const view = annotationsView({ ...after, data: result.data ?? after.data })
  const payload = {
    ok: result.ok === true,
    action,
    changed: result.changed === true,
    error: result.error ?? null,
    backup: result.backup ?? null,
    file: result.file ?? annotationsPath(),
    key: result.meta?.key ?? null,
    group: result.meta?.group ?? null,
    deleted: result.meta?.deleted ?? null,
    index: result.meta?.index ?? null,
    movedFrom: result.meta?.movedFrom ?? null,
    removedFrom: result.meta?.removedFrom ?? null,
    plugins: view.plugins,
    groups: view.groups,
    stats: view.stats,
  }
  if (result.ok === true) {
    sendJson(res, 200, payload)
    return
  }
  const status = Number.isFinite(result.status) ? result.status : 400
  sendJson(res, status, { ...payload, ok: false })
}

export { routeAnnotationsGet, routeAnnotationsPost, annotationsView }
