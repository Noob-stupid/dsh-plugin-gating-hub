// 防线逻辑离线复现：referencing dsh-root(缺失) 必须 reject；web-all 全家桶 refs 必须 allow
// Step 1 重构后：包名归一/解析函数已搬进 lib/server/infra/paths.js —— 直接 import 真模块
// （原来是"按注释标记从 index.js 切片 + vm 沙箱重放"，那种写法一挪文件就断）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const { resolvePackageJson, packageNameOf } = await import('./lib/server/infra/paths.js')

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
// 顺带把 packageNameOf 的子路径归一钉住（bundle 行判定依赖它）
const normOk = packageNameOf('@linxin666/dsh-web-all/settings') === '@linxin666/dsh-web-all'
  && packageNameOf('dsh-better-sidebar') === 'dsh-better-sidebar'
console.log('packageNameOf 归一:', normOk ? 'OK' : 'FAIL')
const pass = waMiss.length === 0 && badMiss.length > 0 && normOk
console.log(pass ? 'PASS：真人场景(装 dsh 桌面端 → dsh-root 缺失被拦)与正常全家桶(全可解析放行)均符合预期' : 'FAIL')
process.exit(pass ? 0 : 1)
