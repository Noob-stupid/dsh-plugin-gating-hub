/**
 * 框架层补丁：dsh-app-boot 的 cordis.patch.yml 解析容错（议题 #5）。
 *
 * 问题：cordis.patch.yml 若含顶格 `[]` 占位符 + 后续条目（两个 YAML 根节点），
 * DSH 启动时 parsePatchList 解析崩溃（"end of the stream or a document separator is expected"）。
 *
 * 修复：parsePatchList 解析失败时，自动移除顶格空数组占位行（视为 no-op）后重试。
 *
 * 用法：node scripts/apply-framework-patch.cjs
 * 说明：DSH 升级（npx 重新拉取）后框架文件会被覆盖，重新运行本脚本即可。
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

/** npm 缓存下的 npx 缓存目录候选（**不写死盘符/用户名**）。
 *  npm 的 cache 位置是用户配置（把 cache 指到别的盘很常见）→ 按 npm 自己的来源读：
 *  环境变量 npm_config_cache / NPM_CONFIG_CACHE + 用户级 ~/.npmrc 的 `cache=`。
 *  （原实现第一条写死开发机上的缓存绝对路径：某个盘符下的 node_cache\_npx。） */
function npmNpxCacheRoots() {
  const roots = []
  const push = (value) => {
    if (typeof value !== 'string') return
    const dir = value.trim().replace(/^["']|["']$/g, '').replace(/^~(?=[\\/]|$)/, os.homedir())
    if (dir !== '') roots.push(path.join(dir, '_npx'))
  }
  for (const key of ['npm_config_cache', 'NPM_CONFIG_CACHE']) push(process.env[key])
  try {
    for (const line of fs.readFileSync(path.join(os.homedir(), '.npmrc'), 'utf8').split(/\r?\n/)) {
      const hit = /^\s*cache\s*=\s*(.*?)\s*$/i.exec(line)
      if (hit) push(hit[1])
    }
  } catch {}
  return roots
}

// 定位 @deepseek-ai/dsh-app-boot（与 @deepseek-ai/dsh 同级）
function locateAppBoot() {
  try {
    const dshPkg = require.resolve('@deepseek-ai/dsh/package.json')
    const aiDir = path.dirname(dshPkg) // .../node_modules/@deepseek-ai
    const candidate = path.join(aiDir, 'dsh-app-boot', 'lib', 'index.js')
    if (fs.existsSync(candidate)) return candidate
  } catch {}
  const cacheRoots = [
    process.env.NODE_CACHE || '',
    ...npmNpxCacheRoots(),
    path.join(os.homedir(), '.npm', '_npx'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'node_cache', '_npx') : '',
  ].filter(Boolean)
  for (const root of cacheRoots) {
    if (!fs.existsSync(root)) continue
    let entries = []
    try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(root, entry.name, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return null
}

const MARKER = 'tryDropEmptyArrayPlaceholder'
const OLD = `function parsePatchList(binName, file, content, label) {
	let parsed;
	try {
		parsed = yaml.load(content, { schema: userPatchesSchema });
	} catch (error) {
		throw new Error(\`${'${binName}'}: failed to parse ${'${label}'} ${'${file}'}: ${'${String(error)}'}\`);
	}`
const NEW = `function parsePatchList(binName, file, content, label) {
	let parsed;
	try {
		parsed = yaml.load(content, { schema: userPatchesSchema });
	} catch (error) {
		// 容错（issue #5）：文件可能是「[] 空数组占位符 + 后续条目」两个根节点，
		// YAML 解析必然失败。移除顶层空数组占位行（视为 no-op）后重试。
		const retried = tryDropEmptyArrayPlaceholder(content);
		if (retried !== null) {
			try {
				parsed = yaml.load(retried, { schema: userPatchesSchema });
			} catch {
				throw new Error(\`${'${binName}'}: failed to parse ${'${label}'} ${'${file}'}: ${'${String(error)}'}\`);
			}
		} else {
			throw new Error(\`${'${binName}'}: failed to parse ${'${label}'} ${'${file}'}: ${'${String(error)}'}\`);
		}
	}`

const HELPER = `
/**
 * 容错辅助（issue #5）：若文件含顶格空数组占位行（\`[]\` / \`[ ]\`，可带行尾注释），
 * 视为 no-op 全部移除；无此模式返回 null。
 */
function tryDropEmptyArrayPlaceholder(content) {
	const lines = String(content).split("\\n");
	const kept = [];
	let dropped = false;
	for (const line of lines) {
		if (/^\\[\\s*\\]\\s*(?:#.*)?$/u.test(line)) {
			dropped = true;
			continue;
		}
		kept.push(line);
	}
	if (!dropped) return null;
	return kept.join("\\n");
}
`

function main() {
  const target = locateAppBoot()
  if (!target) {
    console.error('未找到 @deepseek-ai/dsh-app-boot/lib/index.js，请确认 DSH 已安装（或手动指定路径）')
    process.exit(1)
  }
  const source = fs.readFileSync(target, 'utf8')
  if (source.includes(MARKER)) {
    console.log('已打过补丁，跳过：' + target)
    return
  }
  if (!source.includes('function parsePatchList')) {
    console.error('未找到 parsePatchList（框架版本可能已变更），跳过。' + target)
    process.exit(1)
  }
  fs.copyFileSync(target, target + '.bak-issue5')
  const next = source.replace(OLD, NEW) + HELPER
  fs.writeFileSync(target, next, 'utf8')
  console.log('补丁已应用：' + target)
  console.log('备份：' + target + '.bak-issue5')
}

main()
