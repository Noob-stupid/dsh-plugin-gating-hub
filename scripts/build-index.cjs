/**
 * 构建静态插件/技能索引：嗅探 GitHub topic 仓库 → marketplace/index.json。
 *
 * 插件模式（默认）：topic:dsh-plugin，按 star 排序，限制 --limit（默认 500）
 * 技能模式：--skills，合并 topic:agent-skills + topic:claude-skills + topic:dsh-skill，
 *   写入 index.json 的 skills 段（保留已有 items 段），限制 --limit（默认 300）
 *
 * 数据拉取（本机沙箱禁止 node spawn gh 时的推荐方式）：
 *   gh api --paginate "search/repositories?q=topic:dsh-plugin&sort=stars&order=desc&per_page=100" > raw.json
 *   node scripts/build-index.cjs --input raw.json [--limit 500]
 * 无 --input 时尝试直接用 gh CLI 拉取（GitHub Actions 中预装 gh 且已认证）。
 *
 * 产物：marketplace/index.json（提交到仓库，经 jsDelivr CDN 分发，终端零 GitHub API 调用）
 */
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const fs = require('node:fs')
const path = require('node:path')

const execFileAsync = promisify(execFile)

const SKILL_TOPICS = ['agent-skills', 'claude-skills', 'dsh-skill']

// gh api search 单对象响应，--paginate 拼接后不是合法 JSON，改手动分页循环
async function ghSearchRepos(query, limit) {
  const all = []
  let page = 1
  const perPage = Math.min(100, limit)
  while (all.length < limit) {
    const { stdout } = await execFileAsync('gh', [
      'api',
      'search/repositories',
      '--method', 'GET',
      '-f', 'q=' + query,
      '-f', 'sort=stars',
      '-f', 'order=desc',
      '-f', `per_page=${perPage}`,
      '-f', `page=${page}`,
      '--jq', '.items',
    ], {
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    })
    const batch = JSON.parse(stdout)
    if (!Array.isArray(batch) || batch.length === 0) break
    all.push(...batch)
    page += 1
  }
  return all
}

function normalizeRepo(item) {
  const fullName = String(item.full_name ?? '').trim()
  if (!fullName) return null
  return {
    fullName,
    description: item.description ?? '',
    htmlUrl: item.html_url ?? `https://github.com/${fullName}`,
    stars: item.stargazers_count ?? 0,
    updatedAt: item.updated_at ?? '',
    defaultBranch: item.default_branch ?? 'main',
    topics: Array.isArray(item.topics) ? item.topics : [],
  }
}

function readExisting(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * 仓库 → npm 包名（批次 C-⑪）：市场索引的 npmName 字段。
 * 为什么需要：有些仓库的根包没有发布到 npm（private），真正该装的产物是某个子包/聚合包
 * （真机：zhu1090093659/dsh-web → @linxin666/dsh-web-all，5.97 MB，而仓库本体 429 MB、
 * git 协议 0 B/s）。把这个映射写进索引后，hub 侧可以**直接按包名走 registry 安装**，
 * 省掉"先探测根 package.json、再展开子包"的一整轮（本机 github 不可达时那条路根本走不通）。
 * 只收录**能确定**的（人工核对过的映射文件）；不能确定就省略 —— 老索引没有这个字段，
 * hub 侧行为与改动前完全一致。
 */
function readNpmNameHints(explicitFile) {
  const file = explicitFile ?? path.join(__dirname, '..', 'marketplace', 'npm-name-hints.json')
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const hints = raw && typeof raw.hints === 'object' && raw.hints !== null ? raw.hints : {}
    const out = {}
    for (const [repo, npmName] of Object.entries(hints)) {
      if (typeof repo !== 'string' || repo.trim() === '') continue
      if (typeof npmName !== 'string' || !/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u.test(npmName.trim())) continue
      out[repo.trim().toLowerCase()] = npmName.trim()
    }
    return out
  } catch {
    return {}
  }
}

/** 给归一化后的条目补 npmName（能确定时）。纯函数，便于单测。 */
function withNpmNames(items, hints) {
  return items.map((item) => {
    const hit = hints[String(item.fullName).toLowerCase()]
    return hit === undefined ? item : { ...item, npmName: hit }
  })
}

async function main() {
  const skillsMode = process.argv.includes('--skills')
  const limitArg = process.argv.find((a) => a.startsWith('--limit='))
  const limit = limitArg ? Number(limitArg.split('=')[1]) || (skillsMode ? 300 : 500) : (skillsMode ? 300 : 500)
  const inputArg = process.argv.find((a) => a.startsWith('--input='))
  const inputFile = inputArg ? inputArg.split('=')[1] : null

  const dir = path.join(__dirname, '..', 'marketplace')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'index.json')

  let items = []
  if (skillsMode) {
    console.log(`拉取技能 topic 仓库（${SKILL_TOPICS.join(' + ')}，gh CLI，自动分页）…`)
    try {
      const raw = inputFile ? JSON.parse(fs.readFileSync(inputFile, 'utf8')) : null
      if (raw) {
        items = Array.isArray(raw) ? raw : (raw.items ?? [])
      } else {
        for (const topic of SKILL_TOPICS) {
          const batch = await ghSearchRepos(`topic:${topic} in:name,description,topics`, limit)
          items.push(...batch)
        }
      }
    } catch (error) {
      console.error('技能搜索失败：' + error.message)
      process.exit(1)
    }
  } else if (inputFile) {
    // 外部已拉取的数据文件（gh api --paginate 输出：JSON 数组）
    console.log(`读取数据文件 ${inputFile}…`)
    const raw = JSON.parse(fs.readFileSync(inputFile, 'utf8'))
    items = Array.isArray(raw) ? raw : (raw.items ?? [])
  } else {
    console.log('拉取 dsh-plugin topic 仓库（gh CLI，自动分页）…')
    try {
      items = await ghSearchRepos('topic:dsh-plugin in:name,description,topics', limit)
    } catch (error) {
      console.error('搜索失败：' + error.message)
      process.exit(1)
    }
  }

  const seen = new Set()
  const normalized = []
  for (const item of items) {
    const norm = normalizeRepo(item)
    if (!norm || seen.has(norm.fullName)) continue
    seen.add(norm.fullName)
    if (skillsMode) {
      norm.skillTopics = SKILL_TOPICS.filter((t) => norm.topics.includes(t))
    }
    normalized.push(norm)
    if (normalized.length >= limit) break
  }

  const existing = readExisting(file)
  // 批次 C-⑪：给能确定的条目补 npmName（--hints=<file> 可覆盖映射文件）
  const hintsArg = process.argv.find((a) => a.startsWith('--hints='))
  const hints = readNpmNameHints(hintsArg ? hintsArg.split('=')[1] : undefined)
  const named = withNpmNames(normalized, hints)
  const out = {
    generatedAt: new Date().toISOString(),
    count: existing.count ?? 0,
    items: existing.items ?? [],
    skills: existing.skills ?? [],
  }
  if (skillsMode) {
    out.skills = named
    out.skillCount = named.length
  } else {
    out.items = named
    out.count = named.length
  }
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf8')
  const hinted = named.filter((it) => typeof it.npmName === 'string').length
  console.log(`已更新 ${file}：${skillsMode ? '技能 ' + named.length : '插件 ' + named.length}（限制 ${limit}${hinted > 0 ? `；其中 ${hinted} 条带 npmName` : ''}）`)
}

if (require.main === module) main().catch((error) => { console.error(error); process.exit(1) })

module.exports = { normalizeRepo, readNpmNameHints, withNpmNames }
