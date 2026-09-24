// L1 · domain —— ai.js（AI 赋能的纯逻辑部分：任务表与视图、DeepSeek 密钥与配置、占位符/Python/VLM 解析、写入白名单与运行白名单、内置计划模板、计划 JSON 解析；分层 Step 7 从 lib/index.js 搬出，只搬移未改逻辑。注：aiEmpowerPlan/Execute、runAiStep、aiRepair 吃运行上下文，留到 Step 8）
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md 三

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import { maskUrl } from '../infra/mask.js'
import { aiJobsFile } from '../infra/paths.js'

/** AI 赋能任务注册表（规划/执行均常驻服务端，面板轮询进度）。 */
const aiJobs = new Map()

function saveAiJobs() {
  try {
    mkdirSync(dirname(aiJobsFile()), { recursive: true })
    const arr = [...aiJobs.values()].map((j) => ({ id: j.id, source: j.source, status: j.status, stage: j.stage, plan: j.plan ?? null, logText: j.logText ?? '', stepStates: j.stepStates ?? [], progress: j.progress ?? null, error: j.error ?? null, createdAt: j.createdAt, finishedAt: j.finishedAt ?? null }))
    writeFileSync(aiJobsFile(), JSON.stringify(arr, null, 2), 'utf8')
  } catch {}
}

function loadAiJobs() {
  try {
    if (!existsSync(aiJobsFile())) return
    const arr = JSON.parse(readFileSync(aiJobsFile(), 'utf8'))
    for (const j of arr) {
      if (!j || typeof j.id !== 'string') continue
      let job = j
      if (job.status === 'running') {
        job = { ...job, status: 'failed', error: 'DSH 重启，任务中断（可重新发起）', finishedAt: Date.now() }
      }
      aiJobs.set(job.id, job)
    }
  } catch {}
}

/** AI 赋能计划/执行任务视图（content 一律剥离，防密钥经轮询泄露）。 */
function aiJobView(job) {
  return {
    jobId: job.id,
    source: job.source,
    status: job.status,
    stage: job.stage,
    error: job.error ?? null,
    type: job.plan?.type ?? null,
    displayName: job.plan?.displayName ?? null,
    summary: job.plan?.summary ?? null,
    servers: (job.plan?.servers ?? []).map((s) => ({ name: s.name, healthUrl: s.healthUrl ?? null, port: s.port ?? null })),
    steps: (job.plan?.steps ?? []).map((s, i) => ({
      index: i,
      action: s.action,
      description: s.description ?? '',
      path: typeof s.path === 'string' ? resolvePlaceholders(s.path, job) : null,
      package: s.package ?? null,
      url: typeof s.url === 'string' ? maskUrl(s.url) : null,
      name: s.name ?? null,
    })),
    stepStates: job.stepStates ?? [],
    progress: job.progress ?? { done: 0, total: (job.plan?.steps ?? []).length },
    logText: (job.logText ?? '').slice(-6000),
    createdAt: job.createdAt,
    finishedAt: job.finishedAt ?? null,
    workspace: job.parentCwd ?? null,
    frameworkCheck: job.frameworkCheck ?? null,
  }
}

/** 占位符：${home} 家目录 / ${profile} DSH profile 目录 / ${python} Python 解释器 / ${scripts} Python Scripts / ${node} node 可执行 / ${deepseekKey} DSH 凭据中的 DeepSeek 密钥。 */
let deepseekKeyCache = null

function readDeepSeekKey() {
  if (deepseekKeyCache !== null) return deepseekKeyCache
  try {
    const credFile = join(homedir(), '.dsh', '.credentials.yaml')
    if (existsSync(credFile)) {
      const m = /^\s*DEEPSEEK_API_KEY\s*:\s*(\S+)\s*$/mu.exec(readFileSync(credFile, 'utf8'))
      if (m) {
        deepseekKeyCache = m[1]
        return deepseekKeyCache
      }
    }
  } catch {}
  deepseekKeyCache = ''
  return deepseekKeyCache
}

/**
 * AI 赋能模型配置（OpenViking VLM 用）：
 * 1) 优先 ~/.dsh/plugin-console/ai-empower.json（独立区块，显式覆盖）
 *    格式：{ "vlm": { "provider": "...", "api_base": "...", "model": "..." }, "api_key": "sk-..." }
 *    api_key 缺省时继承 DSH 凭据；vlm 缺省时整体回退 DSH 当前设置。
 * 2) 未配置区块 → 跟随 DSH：settings.yaml 的 agent-default-model + .credentials.yaml 的 DEEPSEEK_API_KEY。
 */
function readAiEmpowerConfig() {
  try {
    const cfgFile = join(homedir(), '.dsh', 'plugin-console', 'ai-empower.json')
    if (existsSync(cfgFile)) return JSON.parse(readFileSync(cfgFile, 'utf8'))
  } catch {}
  return null
}

function resolveVlmForOpenViking() {
  const custom = readAiEmpowerConfig()
  let base = null
  try {
    const settings = readFileSync(join(homedir(), '.dsh', 'settings.yaml'), 'utf8')
    const m = /agent-default-model:\s*[\s\S]*?provider:\s*(\S+)\s*\n\s*model:\s*(\S+)/u.exec(settings)
    const p = m?.[1] ?? ''
    if (p === 'deepseek-official' || p === 'deepseek') {
      base = { provider: 'openai', api_base: 'https://api.deepseek.com', model: m[2] ?? 'deepseek-v4-flash-vision-exp' }
    }
  } catch {}
  if (base === null) base = { provider: 'openai', api_base: 'https://api.deepseek.com', model: 'deepseek-v4-flash-vision-exp' }
  const vlm = custom?.vlm ?? base
  const apiKey = typeof custom?.api_key === 'string' && custom.api_key !== '' ? custom.api_key : readDeepSeekKey()
  return { provider: vlm.provider ?? 'openai', api_base: vlm.api_base ?? 'https://api.deepseek.com', model: vlm.model ?? 'deepseek-v4-flash-vision-exp', api_key: apiKey }
}

function resolvePlaceholders(value, jobOrEnv) {
  const env = jobOrEnv ?? {}
  const profile = env.profileDir ?? ''
  const python = resolvePythonPath()
  const home = homedir()
  return String(value)
    .replaceAll('${home}', home)
    .replaceAll('${profile}', profile)
    .replaceAll('${python}', python)
    .replaceAll('${scripts}', join(dirname(python), 'Scripts'))
    .replaceAll('${node}', process.execPath)
    .replaceAll('${deepseekKey}', readDeepSeekKey())
}

function resolvePythonPath() {
  const candidates = [join('E:', 'python314', 'python.exe'), join(homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python314', 'python.exe'), 'python.exe']
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return 'python.exe'
}

/** 写入路径白名单：只允许 DSH profile、~/.dsh、~/.openviking、~/.cache/openviking、ASCII 数据根。 */
function isAllowedWritePath(p, profileDir) {
  const norm = (s) => s.replace(/[\\/]+/gu, '/').replace(/\/+$/u, '')
  const target = norm(resolvePlaceholders(p, { profileDir }))
  const roots = [
    norm(homedir()) + '/.dsh',
    norm(homedir()) + '/.openviking',
    norm(homedir()) + '/.cache/openviking',
    norm(homedir()) + '/.local/share/openviking',
    norm(homedir()) + '/.dsh/repos',
    norm(profileDir),
    'D:/OpenVikingData',
  ]
  return roots.some((root) => target === root || target.startsWith(root + '/'))
}

/** run-cmd 可执行文件白名单（按 basename）。 */
const ALLOWED_RUN_FILES = new Set(['curl.exe', 'curl', 'git.exe', 'git', 'node.exe', 'node', 'python.exe', 'python', 'py.exe', 'py', 'gh.exe', 'gh', 'npm.cmd', 'npm', 'ov.cmd', 'ov'])

const DESTRUCTIVE_RE = /(^|\s)(rm\s+(-[a-zA-Z]*r)|rmdir\s+\/s|del\s+\/s|format\s+[a-zA-Z]:|Remove-Item\b|taskkill\s+\/im|reg\s+delete|schtasks\s+\/delete|shutdown|cipher\s+\/w)/iu

function isSafeRunCmd(file, args) {
  const base = basename(String(file)).toLowerCase()
  if (!ALLOWED_RUN_FILES.has(base)) return false
  const joined = [file, ...(args ?? [])].join(' ')
  return !DESTRUCTIVE_RE.test(joined) && !/[&|;`$<>]/u.test(joined)
}

/** 已知组件内置模板：跳过 AI 调研，直接产出经过验证的部署计划（当前仅 OpenViking）。 */
function builtinPlanFor(source) {
  // 精确匹配 OpenViking 服务器本体（npm/pip 包名 openviking 或 volcengine/OpenViking 仓库），
  // 防止宽泛子串匹配误命中 openclaw_openviking_skill 之类的第三方包（曾实际发生误判）。
  const norm = String(source).trim().toLowerCase()
    .replace(/^https?:\/\//u, '')
    .replace(/^www\./u, '')
    .replace(/^github\.com\//u, '')
    .replace(/^raw\.githubusercontent\.com\//u, '')
    .replace(/\.git$/u, '')
    .replace(/\/$/u, '')
  if (norm !== 'openviking' && norm !== 'volcengine/openviking') return null
  const home = homedir()
  const storage = /^[\x00-\x7F]+$/u.test(home) ? `${home}/.openviking/data` : 'D:/OpenVikingData'
  const vlm = resolveVlmForOpenViking()
  // 注意：路径必须在此处（JSON.stringify 之前）使用真实值，由 stringify 统一转义；
  // 不能在 content 中保留 ${home} 占位符——写文件时替换会把反斜杠路径变成非法 JSON 转义。
  const ovConf = {
    server: { host: '127.0.0.1', port: 1933, cors_origins: ['*'] },
    vlm: { provider: vlm.provider, api_base: vlm.api_base, api_key: vlm.api_key, model: vlm.model },
    embedding: { dense: { provider: 'local', model: 'bge-small-zh-v1.5-f16', model_path: join(home, '.cache', 'openviking', 'models', 'bge-small-zh-v1.5-f16.gguf') } },
    storage: { workspace: storage },
  }
  const server = { name: 'openviking-server', file: '${python}', args: ['-m', 'openviking_cli.server_bootstrap'], cwd: '${home}/.openviking', healthUrl: 'http://127.0.0.1:1933/health', uiUrl: 'http://127.0.0.1:1933/studio', port: 1933 }
  return {
    type: 'service',
    displayName: 'OpenViking（本地记忆服务器）',
    summary: '安装 OpenViking 服务器（Python 3.14 + llama-cpp-python）、下载中文嵌入模型、写入 ov.conf（复用 DSH 的 DeepSeek 凭据、ASCII 存储路径）、启动并健康检查；完成后重启 DSH 会话即可出现 mcp__openviking__* 工具，pending 积压自动回放。',
    servers: [server],
    steps: [
      { action: 'install-pip', package: 'openviking[local-embed]', description: '安装 OpenViking 服务器（含本地嵌入 llama-cpp-python）' },
      { action: 'download', url: 'https://huggingface.co/CompendiumLabs/bge-small-zh-v1.5-gguf/resolve/main/bge-small-zh-v1.5-f16.gguf?download=true', path: '${home}/.cache/openviking/models/bge-small-zh-v1.5-f16.gguf', description: '下载中文本地嵌入模型 bge-small-zh-v1.5-f16（47MB，走 hf-mirror）' },
      { action: 'write-file', path: '${home}/.openviking/ov.conf', content: JSON.stringify(ovConf, null, 2), description: '写入 ov.conf（DeepSeek VLM + 本地嵌入 + dev 免鉴权 + ASCII 存储路径）' },
      { action: 'start-service', ...server, description: '启动 openviking-server（127.0.0.1:1933）' },
      { action: 'wait-health', url: 'http://127.0.0.1:1933/health', timeoutMs: 90000, description: '等待健康检查通过' },
    ],
  }
}

/** AI 赋能预案：把已知环境事实与踩坑点固化为提示，避免子代理每次重新踩坑。 */
function aiEmpowerPresetFor(source) {
  const common = [
    '## 本机环境事实（务必遵守）',
    '- 网络：pypi.org 不通、清华镜像 403；pip 必须用 `--index-url https://mirrors.aliyun.com/pypi/simple/`。npm registry.npmjs.org 可能黑洞，pnpm 用 `--registry https://registry.npmmirror.com`。huggingface.co 被墙，模型文件一律用 `https://hf-mirror.com/<同一路径>`（执行器会自动把 huggingface.co 换成 hf-mirror.com，计划里也可直接写 hf-mirror）。',
    '- 用户名含中文（花火）：任何写盘路径若含中文，各语言的 Rust/原生向量库会报 UnicodeDecodeError——服务数据目录必须纯 ASCII（如 `D:/OpenVikingData`）。',
    '- 凭据复用：DSH 的 DeepSeek 密钥在 `${home}/.dsh/.credentials.yaml`（YAML 行 `DEEPSEEK_API_KEY: sk-...`）；模型选择在 `${home}/.dsh/settings.yaml` 的 `agent-default-model`（provider deepseek-official）。对外 OpenAI 兼容接口：api_base `https://api.deepseek.com`，模型名 `deepseek-v4-flash-vision-exp`。',
    '- 步骤解释用中文；每个动作一个步骤；步骤数尽量少；不得包含任何破坏性命令；服务类组件必须配 start-service + wait-health。',
  ]
  if (/openviking/i.test(source)) {
    return [
      ...common,
      '## OpenViking 已验证的部署事实（v0.4.17，Python 3.14）',
      '- 安装：`pip install openviking[local-embed]`（含 llama-cpp-python 0.3.35，cp310-abi3 轮子可用；无需加 --force-reinstall）。',
      '- 嵌入模型：`bge-small-zh-v1.5-f16.gguf`（47MB，512 维中文）下载到 `${home}/.cache/openviking/models/`（写 download 步骤；URL 写 huggingface.co 会被执行器自动换 hf-mirror.com）。',
      '- ov.conf 路径 `${home}/.openviking/ov.conf`，内容：vlm = { provider: openai, api_base: https://api.deepseek.com, model: deepseek-v4-flash-vision-exp, api_key: 从 `${home}/.dsh/.credentials.yaml` 读取并内联 }；embedding.dense = { provider: local, model: bge-small-zh-v1.5-f16, model_path: <上面的 gguf 路径> }；server = { host: 127.0.0.1, port: 1933 }（不要写 root_api_key，dev 免鉴权模式自动启用）；storage.workspace = `${home}` 含非 ASCII 时写 `D:/OpenVikingData`，否则 `${home}/.openviking/data`。',
      '- 启动：start-service，file=`${python}`，args=`["-m","openviking_cli.server_bootstrap"]`，cwd=`${home}/.openviking`，healthUrl=`http://127.0.0.1:1933/health`，port=1933。服务器启动首次会建 `D:/OpenVikingData` 数据目录。',
      '- 部署完成后惯例：重启 DSH 会话后 mcp__openviking__* 工具出现，`${home}/.openviking/pending` 的积压消息会在新会话启动时自动回放——把这写进总结。',
    ].join('\n')
  }
  return common.join('\n')
}

/** 从子代理输出中提取 ```json ... ``` 计划。 */
function parsePlanJson(text) {
  const m = /```json\s*([\s\S]*?)```/u.exec(text)
  const raw = m ? m[1] : text
  try {
    const plan = JSON.parse(raw)
    if (!plan || typeof plan !== 'object' || !Array.isArray(plan.steps)) return null
    for (const s of plan.steps) {
      if (typeof s.action !== 'string' || !['install-pip', 'install-npm', 'write-file', 'download', 'run-cmd', 'start-service', 'wait-health', 'register-component'].includes(s.action)) return null
    }
    return plan
  } catch {
    return null
  }
}

export { aiJobs, saveAiJobs, loadAiJobs, aiJobView, deepseekKeyCache, readDeepSeekKey, readAiEmpowerConfig, resolveVlmForOpenViking, resolvePlaceholders, resolvePythonPath, isAllowedWritePath, ALLOWED_RUN_FILES, DESTRUCTIVE_RE, isSafeRunCmd, builtinPlanFor, aiEmpowerPresetFor, parsePlanJson }
