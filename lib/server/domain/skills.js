// L1 · domain —— skills.js（分层 Step 从 lib/index.js 搬出，只搬移未改逻辑）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md §三

import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { gitCloneUrls } from './sources.js'
import { execFileAsync, execFileWithKillTree, gitEnv } from '../infra/exec.js'
import { copyTree } from '../infra/fsx.js'
import { GITHUB_RAW, curlJson, curlText, rawTextWithFallback } from '../infra/http.js'
import { dshHome } from '../infra/paths.js'

/** 探测仓库是否为技能仓库：根目录或第一层子目录存在 SKILL.md。
 * 返回 { hasSkill, skillDir }（skillDir 为相对仓库根的目录，'' 表示根）。
 * raw 双通道竞速，3 秒封顶，失败静默。 */
async function detectSkillRepo(repo, branch = 'main') {
  const branchEnc = encodeURIComponent(branch)
  try {
    const root = await Promise.any([
      curlText(`${GITHUB_RAW}/${repo}/${branchEnc}/SKILL.md`, 3000),
      curlText(`https://ghproxy.net/${GITHUB_RAW}/${repo}/${branchEnc}/SKILL.md`, 3000),
      curlText(`https://cdn.jsdelivr.net/gh/${repo}@${branchEnc}/SKILL.md`, 3000),
    ]).catch(() => null)
    if (root !== null) return { hasSkill: true, skillDir: '' }
    // 根没有时再查一层子目录（常用布局：skills/<name>/SKILL.md、<name>/SKILL.md）
    const tree = await curlJson(`https://api.github.com/repos/${repo}/git/trees/${branchEnc}?recursive=1`, 5000).catch(() => null)
    const skillPaths = (tree?.tree ?? [])
      .filter((n) => n.type === 'blob' && /(?:^|\/)SKILL\.md$/u.test(n.path))
      .map((n) => n.path)
    if (skillPaths.length > 0) {
      const dir = skillPaths[0].slice(0, -'SKILL.md'.length).replace(/\/$/u, '')
      return { hasSkill: true, skillDir: dir }
    }
  } catch {}
  return { hasSkill: false, skillDir: null }
}

/** 提取 SKILL.md frontmatter 摘要（name / description / whenToUse，与客户端 summarizeSkillFrontmatter 同规则）。 */
function summarizeSkillFrontmatter(text) {
  if (!text.startsWith('---')) return null
  const fmEnd = text.indexOf('\n---', 3)
  if (fmEnd === -1) return null
  const fm = text.slice(3, fmEnd)
  const pick = (key) => {
    const re = new RegExp(`^${key}:\\s*(.*)$`, 'mu')
    const m = fm.match(re)
    if (!m) return ''
    const first = m[1].trim()
    if (first.startsWith('|')) {
      const rest = fm.slice(m.index + m[0].length)
      const lines = []
      for (const line of rest.split('\n')) {
        if (/^[a-zA-Z][\w-]*\s*:/u.test(line)) break
        const v = line.trim()
        if (v) lines.push(v)
        if (lines.join(' ').length > 240) break
      }
      return lines.join(' ').slice(0, 500)
    }
    return first.slice(0, 200)
  }
  const name = pick('name')
  const description = pick('description')
  const whenToUse = pick('whenToUse')
  if (!name && !description && !whenToUse) return null
  return { name, description, whenToUse }
}

/** 读取仓库 SKILL.md 的 frontmatter 摘要（raw 双通道，失败静默返回 null）。 */
async function fetchSkillMeta(repo, branch, skillDir) {
  try {
    const path = skillDir ? `${skillDir}/SKILL.md` : 'SKILL.md'
    const body = await rawTextWithFallback(repo, branch, path)
    if (body === null) return null
    return summarizeSkillFrontmatter(body)
  } catch {
    return null
  }
}

/** 技能安装：git clone 仓库 → 定位 SKILL.md（根或第一层子目录）→ 复制到 ~/.dsh/skills/<name>/。
 * 技能由 dsh-skill-filesystem 插件扫描（发现根：<dshHome>/skills），与桌面版共享。 */
async function runSkillInstallJob(job) {
  const tmpDir = join(tmpdir(), `dsh-skill-${job.id}-${Date.now()}`)
  try {
    job.stage = 'preparing'
    const shortName = String(job.repo).split('/').pop() || job.repo
    mkdirSync(tmpDir, { recursive: true })
    const urls = gitCloneUrls(job.repo, job.source)
    let cloned = false
    let lastError = null
    for (const url of urls) {
      try {
        await execFileWithKillTree('git', ['clone', '--depth', '1', '--quiet', url, tmpDir], {
          timeout: 120000,
          windowsHide: true,
          env: gitEnv(),
        })
        cloned = true
        break
      } catch (error) {
        lastError = error
      }
    }
    if (!cloned) throw new Error(`git clone 失败：${lastError?.message ?? '未知'}`)
    job.stage = 'detecting'
    // 定位 SKILL.md：根目录优先，其次第一层子目录（常用布局 skills/<name>/SKILL.md）
    let skillDir = ''
    if (!existsSync(join(tmpDir, 'SKILL.md'))) {
      const sub = readdirSync(tmpDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .find((d) => existsSync(join(tmpDir, d.name, 'SKILL.md')))
      if (sub) skillDir = sub.name
    }
    if (!existsSync(join(tmpDir, skillDir, 'SKILL.md'))) {
      // 根与第一层子目录都没有：区分「技能集合仓库」与「非技能仓库」，给出可操作提示
      let collection = false
      try {
        const tree = await curlJson(`https://api.github.com/repos/${job.repo}/git/trees/${encodeURIComponent(job.source === 'gitee' ? 'master' : 'main')}?recursive=1`, 6000).catch(() => null)
        collection = (tree?.tree ?? []).filter((n) => n.type === 'blob' && /(?:^|\/)SKILL\.md$/u.test(n.path)).length > 1
      } catch {}
      if (collection) {
        throw new Error('这是技能集合仓库（含多个 SKILL.md），请安装其中单个技能仓库（根或第一层子目录含 SKILL.md 的仓库）')
      }
      throw new Error('仓库内未找到 SKILL.md（检查根目录或第一层子目录）')
    }
    // 技能名：SKILL.md frontmatter 的 name（kebab-case）优先，否则用仓库短名
    let skillName = shortName
    try {
      const text = readFileSync(join(tmpDir, skillDir, 'SKILL.md'), 'utf8')
      const m = text.match(/^name:\s*([a-z0-9][a-z0-9-]{0,63})/mu)
      if (m) skillName = m[1]
    } catch {}
    const skillsRoot = join(dshHome(), 'skills')
    const dest = join(skillsRoot, skillName)
    mkdirSync(skillsRoot, { recursive: true })
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
    copyTree(join(tmpDir, skillDir), dest)
    job.kind = 'skill'
    job.skillName = skillName
    job.skillDir = dest
    job.status = 'done'
    job.stage = 'done'
    job.skillNote = `已安装技能「${skillName}」到 ${dest}。技能由 dsh-skill-filesystem 插件扫描发现（用户根 ~/.dsh/skills）；若当前 profile 未启用该插件，请在 profile 的 cordis.yml 启用 @deepseek-ai/dsh-skill-filesystem 后重启即可生效。`
  } catch (error) {
    job.status = 'failed'
    job.error = error instanceof Error ? error.message : String(error)
  } finally {
    // 无论成败都清理克隆临时目录（cpSync EIO 时代曾泄漏在 TEMP）
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    job.finishedAt = Date.now()
  }
}

/** 返回 SKILL.md frontmatter 内容区间（不含首尾 --- 行）；无 frontmatter 时 { has: false }。 */
function skillFrontmatterBounds(text) {
  if (!text.startsWith('---')) return { has: false }
  const nl = text.indexOf('\n')
  if (nl === -1) return { has: false }
  const end = text.indexOf('\n---', nl + 1)
  if (end === -1) return { has: false }
  return { has: true, start: nl + 1, end }
}

/** 技能是否已停用（frontmatter 含 disable-model-invocation: true）。 */
function isSkillDisabled(skillFile) {
  try {
    const text = readFileSync(skillFile, 'utf8')
    const fm = skillFrontmatterBounds(text)
    if (!fm.has) return false
    return /^\s*disable-model-invocation:\s*(true|yes|on|1)\s*$/mu.test(text.slice(fm.start, fm.end))
  } catch {
    return false
  }
}

/** 停用/启用技能（可逆）：停用 = 备份原始 SKILL.md 到同目录 .dsh-skill-fm.bak 后在
 * frontmatter 注入调用策略行；启用 = 恢复备份（无备份则移除注入行）。 */
function setSkillEnabled(skillFile, enabled) {
  const backup = join(dirname(skillFile), '.dsh-skill-fm.bak')
  const text = readFileSync(skillFile, 'utf8')
  const fm = skillFrontmatterBounds(text)
  if (!enabled) {
    if (!existsSync(backup)) writeFileSync(backup, text, 'utf8')
    const inject = `${SKILL_DISABLE_LINES.join('\n')}\n`
    if (!fm.has) {
      writeFileSync(skillFile, `---\n${inject}---\n\n${text}`, 'utf8')
    } else {
      writeFileSync(skillFile, `${text.slice(0, fm.start)}${inject}${text.slice(fm.start)}`, 'utf8')
    }
  } else if (existsSync(backup)) {
    writeFileSync(skillFile, readFileSync(backup, 'utf8'), 'utf8')
    rmSync(backup, { force: true })
  } else if (fm.has) {
    const content = text.slice(fm.start, fm.end)
    const cleaned = content.split('\n')
      .filter((l) => !/^\s*(disable-model-invocation|user-invocable)\s*:/u.test(l))
      .join('\n')
    writeFileSync(skillFile, `${text.slice(0, fm.start)}${cleaned}${text.slice(fm.end)}`, 'utf8')
  }
}

/** 列出已安装技能（~/.dsh/skills 下一层含 SKILL.md 的目录 + 平铺 .md 文件）。
 * 点号开头（如 .system）是系统技能根（dsh-skill-filesystem 保留目录），标记 system: true，
 * 前端展示「系统」标签且不提供删除。disabled = 已按官方调用策略停用。 */
function listInstalledSkills() {
  const root = join(dshHome(), 'skills')
  const skills = []
  try {
    if (!existsSync(root)) return skills
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const system = entry.name.startsWith('.')
      if (entry.isDirectory()) {
        const skillFile = join(root, entry.name, 'SKILL.md')
        if (existsSync(skillFile)) {
          skills.push({ name: entry.name, path: skillFile, system, disabled: isSkillDisabled(skillFile) })
        }
      } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'SKILL.md') {
        const skillFile = join(root, entry.name)
        skills.push({ name: entry.name.slice(0, -3), path: skillFile, system, disabled: isSkillDisabled(skillFile) })
      }
    }
  } catch {}
  return skills
}

/** 技能市场收录的 topic（/search skills 分支三 topic 并行合并）。 */
const SKILL_TOPICS = ['agent-skills', 'claude-skills', 'dsh-skill']

/** 技能停用注入的 frontmatter 行（官方调用策略：disable-model-invocation 从模型目录/loader 排除，
 * user-invocable 从用户命令排除；两者同设 = 完整停用）。 */
const SKILL_DISABLE_LINES = ['disable-model-invocation: true', 'user-invocable: false']

export { detectSkillRepo, summarizeSkillFrontmatter, fetchSkillMeta, runSkillInstallJob, skillFrontmatterBounds, isSkillDisabled, setSkillEnabled, listInstalledSkills, SKILL_TOPICS, SKILL_DISABLE_LINES }
