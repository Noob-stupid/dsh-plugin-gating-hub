// 框架升级「可选版本列表」测试（2026-09-23 用户要求：有的版本都加上，测试版也可以有列表）
//
// 覆盖两件事：
//   ① 候选列表 helper（frameworkUpgradeCandidates）——过滤/排序/渠道标注/只收更新的；
//   ② **真跑**路由处理器（fake ctx + fake req/res，不碰真实 ~/.dsh）：
//      · /framework-check 的响应必须带 versions 列表（前端靠它渲染选择器）；
//      · /framework-upgrade 选一个合法版本要能进流程；选不存在/更旧的版本必须 400 且**不生成升级脚本**。
// 为什么要真跑路由而不是只测 helper：helper 对但路由没接线＝用户点了没反应，这种"接线漏了"只有真跑看得见。
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

const require = createRequire(import.meta.url)

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'fw-versions-home')
process.env.DSH_HOME = HOME
rmSync(HOME, { recursive: true, force: true })

// 假 profile：让宿主端真的读到一个"当前框架版本"（否则 current=null，候选列表不过滤，测不出过滤逻辑）
const profileDir = join(HOME, 'profiles', 'web')
mkdirSync(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
mkdirSync(join(profileDir, 'node_modules', '@fake', 'demo'), { recursive: true })
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })
writeFileSync(join(profileDir, 'cordis.yml'), '# stub\n', 'utf8')
writeFileSync(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.2', main: 'index.js' }), 'utf8')
writeFileSync(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'index.js'), 'export const ok = true\n', 'utf8')
writeFileSync(join(profileDir, 'node_modules', '@fake', 'demo', 'package.json'), JSON.stringify({ name: '@fake/demo', version: '1.0.0', main: 'index.js' }), 'utf8')
writeFileSync(join(profileDir, 'node_modules', '@fake', 'demo', 'index.js'), 'export const ok = true\n', 'utf8')

let failed = 0
const check = (label, cond, extra) => {
	console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
	if (!cond) failed += 1
}

// ── ① helper：候选列表 ───────────────────────────────────────────────────────
const { frameworkUpgradeCandidates } = await import('./lib/server/infra/semver.js')

const META = {
	'dist-tags': { latest: '0.1.5-rc.3', next: '0.1.7-rc.1', alpha: '0.1.7-alpha.2' },
	versions: {
		'0.1.2-rc.1': {}, '0.1.5-rc.1': {}, '0.1.5-rc.2': {}, '0.1.5-rc.3': {},
		'0.1.6-alpha.1': {}, '0.1.6-alpha.2': {}, '0.1.7-alpha.1': {}, '0.1.7-alpha.2': {}, '0.1.7-rc.1': {},
	},
}
const c152 = frameworkUpgradeCandidates(META, '0.1.5-rc.2')
const list152 = c152.versions.map((v) => v.version)
check('只收「比当前新」的版本（当前 0.1.5-rc.2 → 6 个候选）', c152.versions.length === 6, JSON.stringify(list152))
check('比当前旧的绝不进列表（0.1.5-rc.1 / 0.1.2-rc.1 都不在）', !list152.includes('0.1.5-rc.1') && !list152.includes('0.1.2-rc.1'))
check('按语义版本降序（最新在最前；同基线的 rc > alpha）', list152.join(',') === '0.1.7-rc.1,0.1.7-alpha.2,0.1.7-alpha.1,0.1.6-alpha.2,0.1.6-alpha.1,0.1.5-rc.3', list152.join(','))
check('渠道标注：next / alpha / latest 各自命中', c152.versions[0].channel === 'next' && c152.versions[1].channel === 'alpha' && c152.versions[5].channel === 'latest')
check('latest 标 isLatest（前端显示「稳定版」）', c152.versions[5].isLatest === true && c152.versions[0].isLatest === false)
check('tagDefault = latest（没选时默认仍升稳定版，老行为不变）', c152.tagDefault === '0.1.5-rc.3', String(c152.tagDefault))
check('已是最新时候选为空（不误导用户）', frameworkUpgradeCandidates(META, '0.1.7-rc.1').versions.length === 0 && frameworkUpgradeCandidates(META, '0.1.7-rc.1').tagDefault === null)
check('当前版本未知时不乱过滤（全部列出，保留选择能力）', frameworkUpgradeCandidates(META, null).versions.length === 9)
const cBad = frameworkUpgradeCandidates({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {}, 'not-a-version': {} } }, '0.1.5-rc.2')
check('非法版本号被跳过，不炸', cBad.versions.length === 1 && cBad.versions[0].version === '1.0.0')
check('元数据为空/畸形也不炸', frameworkUpgradeCandidates(null, '0.1.5-rc.2').versions.length === 0 && frameworkUpgradeCandidates({}, 'x').versions.length === 0)
const cStable = frameworkUpgradeCandidates({ 'dist-tags': { latest: '1.0.0' }, versions: { '0.1.5-rc.3': {}, '1.0.0': {} } }, '0.1.5-rc.2')
check('正式版排在预发布之后（0.1.5-rc.3 < 0.1.5 < 1.0.0）', cStable.versions.map((v) => v.version).join(',') === '1.0.0,0.1.5-rc.3', cStable.versions.map((v) => v.version).join(','))

// ── ② 真跑路由 ──────────────────────────────────────────────────────────────
const cordisUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
const ctx = {
	baseUrl: cordisUrl,
	loader: {
		entries: () => [
			{ id: 'include', options: { name: 'cordis:include', group: true, config: { path: cordisUrl } } },
			{ id: 'include:demo', options: { name: '@fake/demo' }, disabled: false, fiber: { state: 2 } },
			{ id: 'include:plugin-console', options: { name: '@noob-stupid/dsh-plugin-console' }, disabled: false, fiber: { state: 2 } },
		],
	},
	webServer: { register: (route) => { globalThis.__fwRoute = route; return () => {} } },
	effect: (fn) => { try { fn() } catch {}; return () => {} },
}
const mod = await import('./lib/index.js')
mod.apply(ctx)
const route = globalThis.__fwRoute
check('路由已装配（register 拿到 handler）', route !== undefined && typeof route.handler === 'function')

const fakeReq = (method, pathname, body) => ({
	method, url: pathname, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' },
	signal: { aborted: false, addEventListener: () => {} },
	[Symbol.asyncIterator]() {
		const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
		let i = 0
		return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) }
	},
})
const fakeRes = () => { const r = { status: 0, body: null }; r.writeHead = (s) => { r.status = s }; r.end = (p) => { r.body = p }; return r }
const call = async (method, path, body) => {
	const r = fakeRes()
	await route.handler(fakeReq(method, path, body), r)
	let json = null
	try { json = r.body === null || r.body === undefined ? null : JSON.parse(r.body) } catch {}
	return { status: r.status, json, raw: r.body }
}

const chk = await call('POST', '/plugin-console/framework-check', { refresh: true })
check('/framework-check 返回 200', chk.status === 200, `status=${chk.status}`)
check('/framework-check 读到当前框架版本（假 profile 的 0.1.5-rc.2）', chk.json?.current === '0.1.5-rc.2', String(chk.json?.current))
check('/framework-check 带 versions 数组', Array.isArray(chk.json?.versions), `len=${Array.isArray(chk.json?.versions) ? chk.json.versions.length : 'n/a'}`)
check('/framework-check 带 tagDefault 与 alpha 字段', 'tagDefault' in (chk.json ?? {}) && 'alpha' in (chk.json ?? {}))

if (Array.isArray(chk.json?.versions) && chk.json.versions.length > 0) {
	const v0 = chk.json.versions[0]
	check('候选项结构 = { version, channel, isLatest }', typeof v0.version === 'string' && 'channel' in v0 && 'isLatest' in v0, JSON.stringify(v0))
	check('候选全部比当前新（宿主端真过滤了，不是原样透传 registry）', chk.json.versions.every((v) => v.version !== '0.1.5-rc.1' && v.version !== '0.1.5-rc.2'))
	check('默认目标仍在候选里（没选时不会指到一个不可选版本）', chk.json.target === null || chk.json.versions.some((v) => v.version === chk.json.target), `target=${chk.json.target}`)
} else {
	console.log('SKIP 候选内容断言——本机 registry 不可达（versions 为空），仅验证字段存在')
}

const bad = await call('POST', '/plugin-console/framework-upgrade', { version: '9.9.9-does-not-exist' })
check('乱填版本 → 400 拒绝（不生成升级脚本）', bad.status === 400, `status=${bad.status}`)
check('拒绝原因可读（提到「不在可选列表内」）', typeof bad.json?.error === 'string' && bad.json.error.includes('不在可选列表内'), String(bad.json?.error ?? bad.raw).slice(0, 90))

const old = await call('POST', '/plugin-console/framework-upgrade', { version: '0.1.2-rc.1' })
check('选一个「比当前旧」的版本同样被拒（降级走回滚，不走升级）', old.status === 400, `status=${old.status}`)

rmSync(HOME, { recursive: true, force: true })

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
