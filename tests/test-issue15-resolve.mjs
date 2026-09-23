// 场景模拟（issue #15）：npm 全局安装 dsh 时 ctx.baseUrl 落在框架安装树，
// resolvePackageJson(moduleName, frameworkBase, profileDir) 必须回退解出第三方包。
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const src = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
const start = src.indexOf('/** 包名归一')
const end = src.indexOf('/** 已加载插件的包元信息缓存')
if (start < 0 || end < 0) { console.error('markers not found'); process.exit(1) }
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
const { resolvePackageJson } = sandbox

const os = await import('node:os')
// 模拟全局 dsh 树：优先环境变量，其次本机 npx 缓存常见位置（CI 无此环境则跳过）
const frameworkBase = [process.env.DSH_FRAMEWORK_BASE, 'D:/node_cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh']
  .filter(Boolean)
  .find((p) => fs.existsSync(p)) ?? ''
const profileDir = process.env.DSH_PROFILE_DIR ?? path.join(os.homedir(), '.dsh', 'profiles', 'web')
if (frameworkBase === '' || !fs.existsSync(profileDir)) {
  console.log(`SKIP 需要本机框架树与 profile（frameworkBase=${frameworkBase || '未找到'} profile=${profileDir}）——CI 环境跳过`)
  process.exit(0)
}

const cases = [
  ['第三方: dsh-better-sidebar', 'dsh-better-sidebar'],
  ['第三方: @noob-stupid/dsh-plugin-console', '@noob-stupid/dsh-plugin-console'],
  ['全家桶: @linxin666/dsh-web-all/plugin-manager', '@linxin666/dsh-web-all/plugin-manager'],
  ['官方: @deepseek-ai/dsh-settings', '@deepseek-ai/dsh-settings'],
]
let fail = 0
for (const [label, name] of cases) {
  const noFallback = resolvePackageJson(name, frameworkBase, null)
  const withFallback = resolvePackageJson(name, frameworkBase, profileDir)
  const ok = withFallback !== null && withFallback.includes('dsh-plugin-hub')
    ? true // 第三方在 profile 下
    : withFallback !== null
  // 判定：官方包两种都能解；第三方必须依赖回退才能解
  const cond = name.startsWith('@deepseek-ai/')
    ? withFallback !== null
    : withFallback !== null && noFallback === null
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}: noFallback=${noFallback === null ? 'null' : path.basename(dirOf(noFallback))} withFallback=${withFallback === null ? 'null' : withFallback}`)
  if (!cond) fail += 1
}
function dirOf(p) { return path.dirname(p) }
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
