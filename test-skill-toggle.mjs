// 技能停用/启用逻辑验证（独立于运行中的服务，用临时 DSH_HOME 不碰真实技能）
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 测试目录放在仓库内（.testdir/，已 gitignore）：系统 tmpdir 在部分环境下 rmSync 静默失败
const ROOT = dirname(fileURLToPath(import.meta.url))
process.env.DSH_HOME = process.env.DSH_TEST_HOME ?? join(ROOT, '.testdir', 'skill-home')
const home = process.env.DSH_HOME
await rm(home, { recursive: true, force: true })
await mkdir(`${home}/skills/test-skill`, { recursive: true })
const original = `---
name: test-skill
description: 测试技能
---

# Test skill body
`
await writeFile(`${home}/skills/test-skill/SKILL.md`, original, 'utf8')

const require = createRequire(import.meta.url)
const mod = await import(new URL('./lib/index.js', import.meta.url).href)

const ctx = {
  baseUrl: 'file:///C:/Users/%E8%8A%B1%E7%81%AB/.dsh/profiles/web/cordis.yml',
  loader: { entries: () => [] },
  webServer: { register: (route) => { globalThis.__route = route; return () => {} } },
  effect: (fn) => { fn() },
}
mod.apply(ctx)
const route = globalThis.__route

function fakeReq(method, pathname, body) {
  const req = {
    method,
    url: pathname,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    signal: { aborted: false, addEventListener: () => {} },
    [Symbol.asyncIterator]() {
      const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
      let i = 0
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) }
    },
  }
  return req
}
function fakeRes() {
  const res = { status: 0, body: null }
  res.writeHead = (status) => { res.status = status }
  res.end = (payload) => { res.body = payload }
  return res
}
async function call(method, path, body) {
  const res = fakeRes()
  await route.handler(fakeReq(method, path, body), res)
  return { status: res.status, json: res.body === null ? null : JSON.parse(res.body) }
}

let failed = 0
function check(label, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}

// 1. skills-installed 初始状态
let r = await call('GET', '/plugin-console/skills-installed')
check('installed lists skill', r.status === 200 && r.json.skills.length === 1 && r.json.skills[0].name === 'test-skill', JSON.stringify(r.json))
check('installed disabled=false initially', r.json.skills[0].disabled === false)

// 2. 停用
r = await call('POST', '/plugin-console/skill-toggle', { name: 'test-skill', enabled: false })
check('toggle off ok', r.status === 200 && r.json?.ok === true && r.json.enabled === false, JSON.stringify(r.json))
let text = await readFile(`${home}/skills/test-skill/SKILL.md`, 'utf8')
check('frontmatter injected', text.includes('disable-model-invocation: true') && text.includes('user-invocable: false'), text.slice(0, 120))
let bak = await readFile(`${home}/skills/test-skill/.dsh-skill-fm.bak`, 'utf8').catch(() => null)
check('backup created', bak === original)

// 3. 已停用状态可见
r = await call('GET', '/plugin-console/skills-installed')
check('installed disabled=true after off', r.json.skills[0].disabled === true)

// 4. 启用
r = await call('POST', '/plugin-console/skill-toggle', { name: 'test-skill', enabled: true })
check('toggle on ok', r.status === 200 && r.json?.ok === true && r.json.enabled === true, JSON.stringify(r.json))
text = await readFile(`${home}/skills/test-skill/SKILL.md`, 'utf8')
check('frontmatter restored', text === original, text.slice(0, 80))
bak = await readFile(`${home}/skills/test-skill/.dsh-skill-fm.bak`, 'utf8').catch(() => null)
check('backup removed', bak === null)
r = await call('GET', '/plugin-console/skills-installed')
check('installed disabled=false after on', r.json.skills[0].disabled === false)

// 5. 系统技能保护
r = await call('POST', '/plugin-console/skill-toggle', { name: '.system-x', enabled: false })
check('toggle system rejected 403', r.status === 403, `status=${r.status}`)
r = await call('POST', '/plugin-console/skill-remove', { name: '.system-x' })
check('remove system rejected 403', r.status === 403, `status=${r.status}`)

// 6. 未知技能
r = await call('POST', '/plugin-console/skill-toggle', { name: 'no-such-skill', enabled: false })
check('toggle unknown 404', r.status === 404, `status=${r.status}`)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
await rm(home, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
