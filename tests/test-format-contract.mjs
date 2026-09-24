// Step 0 行为基线②：跨进程 / 落盘格式契约（拆分时最容易"顺手改掉"的东西）
//
// 为什么要有它：这些格式不只被本插件用，还被**升级脚本（PowerShell）**和**用户**直接读：
//   · cordis.patch.yml 的禁用块格式 —— 升级/回滚/隔离脚本都在用文本匹配写它
//   · fw-upgrade-state.txt 的 `状态|消息[|stage=x]` —— 脚本写、Node 读
//   · fw-quarantine.json 的字段名 —— 脚本写、Node 读
//   · ~/.dsh/plugin-console/ 下的文件名 —— 用户排障时会去看
//   · 客户端 localStorage 键 —— 一改就丢用户设置
// 拆分（L0-L3 分层）可以随便挪代码，但这些契约一个字都不能变。
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOME = join(ROOT, '.testdir', 'format-contract-home')
process.env.DSH_HOME = HOME
rmSync(HOME, { recursive: true, force: true })
const profileDir = join(HOME, 'profiles', 'web')
mkdirSync(join(profileDir, 'node_modules', '@fake', 'demo'), { recursive: true })
const patchPath = join(profileDir, 'cordis.patch.yml')
writeFileSync(patchPath, '# contract\n', 'utf8')
writeFileSync(join(profileDir, 'node_modules', '@fake', 'demo', 'package.json'), JSON.stringify({ name: '@fake/demo', version: '1.0.0', main: 'index.js' }), 'utf8')
writeFileSync(join(profileDir, 'node_modules', '@fake', 'demo', 'index.js'), 'export const ok = true\n', 'utf8')
mkdirSync(join(HOME, 'plugin-console'), { recursive: true })

const cordisUrl = pathToFileURL(join(profileDir, 'cordis.yml')).href
const ctx = {
  baseUrl: cordisUrl,
  loader: {
    entries: () => [
      { id: 'include', options: { name: 'cordis:include', group: true, config: { path: cordisUrl } } },
      { id: 'include:demo', options: { name: '@fake/demo' }, disabled: false, fiber: { state: 2 } },
    ],
  },
  webServer: { register: (route) => { globalThis.__route = route; return () => {} } },
  effect: (fn) => { try { fn() } catch {}; return () => {} },
}
const mod = await import('../lib/index.js')
mod.apply(ctx)
const route = globalThis.__route
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
const call = async (method, path, body) => { const r = fakeRes(); await route.handler(fakeReq(method, path, body), r); return { status: r.status, json: r.body === null ? null : JSON.parse(r.body) } }

let failed = 0
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${extra === undefined ? '' : ' — ' + extra}`)
  if (!cond) failed += 1
}
const serverSrc = (function walkServer(dir) {
  let out = ''
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name)
    if (e.isDirectory()) out += walkServer(f)
    else if (e.name.endsWith('.js')) out += readFileSync(f, 'utf8')
  }
  return out
})(join(ROOT, '..', 'lib', 'server'))
// 分层后这些契约字符串分散在 index.js 与 lib/server/** 各模块里 —— 契约是"整个插件源码里仍然这么写"
const indexSrc = readFileSync(join(ROOT, '..', 'lib', 'index.js'), 'utf8') + serverSrc
const clientSrc = readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8')

// ── ① cordis.patch.yml 禁用块格式（升级/回滚/隔离脚本都在写它）────────────────
await call('POST', '/plugin-console/toggle', { entryId: 'include:demo', enabled: false })
let text = readFileSync(patchPath, 'utf8')
check('禁用块格式 = `- id: X` + 两空格 `disabled: true`', /- id: demo\r?\n {2}disabled: true\r?\n/u.test(text), JSON.stringify(text.slice(-40)))
await call('POST', '/plugin-console/toggle', { entryId: 'include:demo', enabled: true })
text = readFileSync(patchPath, 'utf8')
check('启用后禁用块被移除（恢复原文本）', !/disabled: true/u.test(text), JSON.stringify(text))

// ── ② fw-upgrade-state.txt 三种形态的解析（脚本写 → Node 读）──────────────────
const stateFile = join(HOME, 'plugin-console', 'fw-upgrade-state.txt')
const parseState = async (content) => {
  writeFileSync(stateFile, content, 'utf8')
  const r = await call('GET', '/plugin-console/framework-upgrade-status')
  return r.json
}
let st = await parseState('done|升级完成，服务已监听 3080')
check('状态格式 `<status>|<message>` 可解析', st.status === 'done' && st.message.includes('升级完成'), JSON.stringify(st))
st = await parseState('failed|异常终止|stage=relaunching')
check('状态格式带 `|stage=` 可解析且不透传进 message', st.status === 'failed' && st.stage === 'relaunching' && !String(st.message).includes('stage='), JSON.stringify(st))
st = await parseState('\uFEFFdone|BOM 容错')
check('状态文件带 UTF-8 BOM 也能解析（PS5.1 Set-Content 会写 BOM）', st.status === 'done', JSON.stringify(st))

// ── ③ 隔离记录字段名（脚本写 → Node 读；改名等于隔离登记失效）────────────────
check('隔离记录字段名固定：at / mode / presets / rows / lines', ['at', 'mode', 'presets', 'rows', 'lines'].every((k) => new RegExp(`\\b${k}\\s*=`, 'u').test(indexSrc)) && indexSrc.includes('fw-quarantine.json'))
check('状态心跳文件名 = 状态文件 + .hb', indexSrc.includes("'fw-upgrade-state.txt'") && /\+ '\.hb'|\.hb`/u.test(indexSrc))

// ── ④ ~/.dsh/plugin-console 下的文件名（用户排障会直接看）────────────────────
const INTERFACE_FILES = [
  'compat-pending.json', 'compat-gate.json', 'framework-rollback.json', 'framework-state.json',
  'fw-upgrade-state.txt', 'fw-upgrade.log', 'fw-relaunch.log', 'fw-quarantine.json',
  'fw-quarantine-candidates.json', 'fw-analyze-boot.mjs', 'console-restart.log', 'fw-merge-error.log',
]
const missingFiles = INTERFACE_FILES.filter((f) => !indexSrc.includes(f))
check(`落盘文件名契约（${INTERFACE_FILES.length} 个）`, missingFiles.length === 0, missingFiles.length === 0 ? '全部存在' : `消失: ${missingFiles.join(', ')}`)

// ── ⑤ 客户端 localStorage 键（一改就丢用户设置）─────────────────────────────
const lsKeys = new Set([...clientSrc.matchAll(/["'`](pc-[a-z0-9-]+)["'`]/gu)].map((m) => m[1]))
// 固化 18 个键里最关键的几个（工具栏/市场/框架卡片状态：丢了就等于用户设置被重置）
const CRITICAL_LS = ['pc-toolbar-open', 'pc-toolbar-pos', 'pc-market-mode', 'pc-market-installed-q', 'pc-market-query', 'pc-fw-dismiss-at', 'pc-repo-land', 'pc-ai-remember']
const missingLs = CRITICAL_LS.filter((k) => !lsKeys.has(k))
check('客户端 localStorage 关键键仍在', missingLs.length === 0, missingLs.length === 0 ? `共 ${lsKeys.size} 个键` : `丢失: ${missingLs.join(', ')}`)

// ── ⑥ 安装进度 / AI 授权卡的前端接线（服务端下发了没人读 = 白做）─────────────────
// 2026-09-20 真装实测的两个缺口都在"前端没把服务端状态显示出来"这一侧：进度只显示 stage、
// 授权只有一行小字（连顶部消息都没有）。服务端字段已有 test-route-inventory.mjs 钉死；这里静态
// 钉死前端**确实在渲染它们**（浏览器里的像素仍是人工验证项，但"悄悄删掉授权卡"这类退化会被拦下）。
{
  const I18N_KEYS = ['progressSubpackage', 'progressSuiteClone', 'progressSuiteAssemble', 'progressDone', 'aiConsentCardTitle', 'aiConsentCountdown', 'aiConsentTimeoutNote', 'aiConsentLastError', 'aiConsentTopHint']
  const countOf = (k) => [...clientSrc.matchAll(new RegExp(`\\b${k}\\s*:`, 'gu'))].length
  const notBoth = I18N_KEYS.filter((k) => countOf(k) !== 2) // 中文 + English 各一处
  check(`进度/授权 i18n 键中英两套都在（${I18N_KEYS.length} 个）`, notBoth.length === 0,
    notBoth.length === 0 ? '全部命中两次（zh+en）' : notBoth.map((k) => `${k}:${countOf(k)}`).join(', '))
  check('子包/套装进度渲染成"第 i/n 个"（progressText 读 channel/phase/index/total/name，并接进安装进度列表）',
    /const progressText = \(progress\) =>/u.test(clientSrc) && clientSrc.includes('progressText(job.progress)')
    && /progressSubpackage/u.test(clientSrc) && /progressSuiteClone/u.test(clientSrc)
    && /styles\.progress\b/u.test(clientSrc))
  check('★ 授权卡：进度区一块显眼的警告色卡片（倒计时 + 同意/取消 + 最后错误），不再只有一行小字',
    clientSrc.includes('.pc_consentCard{') && clientSrc.includes('styles.consentCard')
    && /const remain = consentRemaining\(job\)/u.test(clientSrc) && clientSrc.includes('styles.consentCountdown')
    && clientSrc.includes('aiConsent(job.jobId, true)') && clientSrc.includes('aiConsent(job.jobId, false)')
    && /aiConsentLastError/u.test(clientSrc))
  check('顶部消息也提示一句（aiConsentTopHint 接进 /install-status 轮询）',
    /setMessage\(t\("aiConsentTopHint"\)\)/u.test(clientSrc) && clientSrc.includes('data.aiConsent?.pending === true'))
  check('模态框同样给出倒计时与最后错误（失焦/切页也看得到关键信息）',
    /const remain = consentRemaining\(consentJob\)/u.test(clientSrc) && clientSrc.includes('consentTimeoutMinutes(consentJob)'))
}

rmSync(HOME, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
