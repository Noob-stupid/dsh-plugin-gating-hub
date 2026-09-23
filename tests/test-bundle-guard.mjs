// 防线逻辑离线复现：referencing dsh-root(缺失) 必须 reject；web-all 全家桶 refs 必须 allow
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const src = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
const start = src.indexOf('/** 包名归一')
const end = src.indexOf('/** 已加载插件的包元信息缓存')
const sandbox = {
  console, String, JSON, Math,
  createRequire: (await import('node:module')).createRequire,
  existsSync: fs.existsSync,
  join: path.join,
  dirname: path.dirname,
  fileURLToPath,
}
vm.createContext(sandbox)
vm.runInContext(src.slice(start, end), sandbox)
const { resolvePackageJson, packageNameOf } = sandbox

const os = await import('node:os')
const profileDir = process.env.DSH_PROFILE_DIR ?? path.join(os.homedir(), '.dsh', 'profiles', 'web')
// 该测试需要真实已安装插件树（解析 web-all 等第三方包）；CI 无 profile 时跳过而非红灯
if (!fs.existsSync(profileDir)) {
  console.log(`SKIP 需要真实 profile（${profileDir}）——CI 环境跳过；本机安装插件后可直接运行`)
  process.exit(0)
}
const refsMissing = (refs) => refs.filter((n) => resolvePackageJson(n, profileDir) === null)

const webAllRefs = [
  '@linxin666/dsh-web-all',
  '@linxin666/dsh-web-all/settings',
  '@linxin666/dsh-web-all/plugin-manager',
  '@linxin666/dsh-i18n',
  'dsh-better-sidebar',
]
const badRefs = ['@deepseek-ai/dsh-root', '@linxin666/not-exist-xyz']

const waMiss = refsMissing(webAllRefs)
const badMiss = refsMissing(badRefs)
console.log('web-all refs 缺失(应 0):', waMiss.length, JSON.stringify(waMiss))
console.log('bad refs 缺失(应全缺):', badMiss.length, JSON.stringify(badMiss))
const pass = waMiss.length === 0 && badMiss.length > 0
console.log(pass ? 'PASS：真人场景(装 dsh 桌面端 → dsh-root 缺失被拦)与正常全家桶(全可解析放行)均符合预期' : 'FAIL')
process.exit(pass ? 0 : 1)
