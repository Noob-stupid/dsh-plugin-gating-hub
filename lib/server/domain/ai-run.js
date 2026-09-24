// L1 · domain —— ai-run.js（AI 赋能的执行侧：规划 / 执行 / 修复 / 单步运行）。
// 分层 Step 8c-2 从 lib/index.js 搬出；形参由 ctx 收窄为 ports，只搬移未改逻辑。
// 分组见 D:\dsh\dsh-plugin-hub-plan\architecture.zh.md 三

import { writeFileSync, existsSync, statSync, rmSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createRequire } from 'node:module'
import { aiEmpowerPresetFor, isAllowedWritePath, isSafeRunCmd, parsePlanJson, resolvePlaceholders, resolvePythonPath, saveAiJobs } from './ai.js'
import { frameworkCheckPromptText } from './compat.js'
import { compFind, compUpsert } from './components.js'
import { jobLog, waitHealth } from './jobs.js'
import { gitCloneUrls } from './sources.js'
import { execFileAsync, gitEnv, resolvePnpmRunners, runPnpmWithFallback } from '../infra/exec.js'
import { maskUrl } from '../infra/mask.js'

/**
 * 本地 AI 修复：拉起无父上下文的 in-process 子代理接管安装。
 * 子代理与本会话使用同一套工具（终端/文件），能真实修复安装。
 */
async function aiRepair(job, ports, profileDir, candidates, lastError) {
  job.stage = 'repairing'
  job.ai = true
  let subagents = null
  try { subagents = ports.get('subagents') } catch {}
  const startFn = subagents?.start
  if (typeof startFn !== 'function') {
    job.status = 'failed'
    job.error = `确定性安装通道全部失败，且本地 AI 修复通道（subagents 服务）不可用。原始错误：${lastError ?? '未知'}；请手动执行：dsh plugin --profile web add <包名>`
    return
  }
  let provider = 'spawn'
  try {
    const list = subagents.list?.() ?? []
    if (!list.includes(provider)) provider = list[0]
    if (provider === undefined) throw new Error('no provider')
  } catch (error) {
    job.status = 'failed'
    job.error = `本地 AI 修复通道没有可用的子代理提供方：${String(error)}；请手动执行：dsh plugin --profile web add <包名>`
    return
  }
  // 跨平台提示：corepack 的位置随安装方式/系统而异（Windows 官方安装器在 <node bin>/node_modules，
  // Linux 的 npm 全局在 <prefix>/lib/node_modules），所以给子代理的提示不再写死路径
  const corepackRunner = resolvePnpmRunners()[0]
  const prompt = [
    '你是 DeepSeek Harness 的插件安装专家。用户通过插件管理面板安装插件失败，现在由你主动接管安装（不是被动"修复"，而是像人工一样把它装好）。',
    `目标仓库：${job.repo}`,
    `候选包名：${candidates.join('、')}`,
    `profile 目录：${profileDir}（pnpm 管理，绝不能用 npm 写入，会破坏链接）`,
    `此前确定性通道的错误：${lastError ?? '未知'}`,
    '接管步骤：',
    `1) 先弄清楚装什么：若根包是 private 的聚合仓库（monorepo），用 gh api repos/${job.repo}/git/trees/main?recursive=1 或读 packages 目录下的 package.json 找出子包名；优先选聚合包（名字含 all，如 dsh-web-ui-all，一个包装全部）；`,
    `2) 用 corepack/pnpm 安装（本机可用的执行方式：${corepackRunner?.note ?? 'corepack pnpm 或 pnpm'}，即在该方式后接 add <包名> --registry https://registry.npmmirror.com，工作目录 ${profileDir}；Windows 上是 node <corepack.js> pnpm，Linux 上通常是 corepack pnpm 或直接 pnpm）；镜像 404 时改 --registry https://registry.npmjs.org；都不行再用 git 通道；`,
    '3) **node 网络黑洞判定**：pnpm 长时间无下载进度（Progress 停在 downloaded 0）、或报 socket hang up / EPERM / TIMEOUT、或 node 脚本连 127.0.0.1 都超时，说明本机拦截 node 进程网络——此时 curl 与系统 git 通常仍可用，立即改用 curl 手动安装：先 `curl -s https://registry.npmmirror.com/<包名>` 取最新版本号，再 `curl -sL -o <临时目录>/pkg.tgz https://registry.npmmirror.com/<包名>/-/<包名>-<版本>.tgz`，解压 tar -xzf 后把 package 内容放入 profile/node_modules/<包名>（先备份旧目录）；包有 dependencies 时用同样方式逐个 curl 拉取补齐到 node_modules；零依赖包（如 dsh-skin）一条龙即可完成；',
    `4) 安装成功后按官方 dsh plugin add 规则落配置：包声明 dsh.bundle 时把包名追加进 profile 目录 package.json 的 dsh.profile.bundles 数组；普通插件在 cordis.patch.yml 追加 insert 行（id 由包名去 scope、非字母数字转连字符生成，name 填包名）；`,
    '5) 装完自查：确认包已出现在 node_modules、配置已写入；必要时用 gh api 核对仓库信息；',
    '6) 执行 git/pnpm 前先设置环境变量 GIT_TERMINAL_PROMPT=0 和 GCM_INTERACTIVE=never，禁止弹出任何登录/凭据窗口；',
    '7) 不要杀进程、不要重启服务、不要改动与本次安装无关的文件。',
    '完成后用一两句话报告结果；确实无法安装也请说明原因。',
  ].join('\n')
  try {
    // in-process 驱动要求 parent 是真实的活动 Agent（parent.ctx.agents.create）。
    // 控制台在根上下文运行，从 Agent 注册表借一个顶级会话作为结构性父代理。
    let parent = null
    try {
      const agents = ports.get('agents')
      const candidates = typeof agents?.roots === 'function' ? agents.roots() : (typeof agents?.list === 'function' ? agents.list() : [])
      parent = candidates[0] ?? null
    } catch {}
    if (parent === null) {
      job.status = 'failed'
      job.error = `本地 AI 修复无法借用活动会话（agents 注册表为空）。原始错误：${lastError ?? '未知'}；请手动执行：dsh plugin --profile web add <包名>`
      return
    }
    const controller = new AbortController()
    const run = await startFn.call(subagents, provider, {
      label: `install-repair-${String(job.repo).split('/')[1] ?? 'plugin'}`,
      prompt: [{ type: 'text', text: prompt }],
      // 父代理深度 0，修复子代理至少深度 1（0 会触发 depth 校验失败）
      maxDepth: 1,
      signal: controller.signal,
      parent,
    })
    let settleFn = null
    try {
      const requireLocal = createRequire(join(profileDir, 'package.json'))
      ;({ settleRun: settleFn } = requireLocal('@deepseek-ai/dsh-subagent'))
    } catch {}
    const settle = settleFn ?? (async (runHandle) => {
      try {
        const result = await runHandle.result
        return { status: result?.stopReason === 'completed' ? 'completed' : 'failed', detail: String(result?.stopReason ?? 'unknown') }
      } catch (error) {
        return { status: 'failed', detail: String(error) }
      }
    })
    const outcome = await Promise.race([
      settle(run),
      new Promise((resolve) => setTimeout(() => {
        controller.abort()
        resolve({ status: 'failed', detail: '本地 AI 修复超时（10 分钟）' })
      }, 600000)),
    ])
    if (outcome.status === 'completed') {
      // 校验修复结果：任一候选包现在可解析（或已进 bundle 层）才算成功，
      // 避免子代理"跑完流程但没装上"被误报为成功
      let verified = false
      try {
        const requireLocal = createRequire(join(profileDir, 'package.json'))
        for (const name of candidates) {
          try {
            requireLocal.resolve(`${name}/package.json`)
            verified = true
            break
          } catch {}
        }
        if (!verified) {
          const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
          const bundles = manifest.dsh?.profile?.bundles ?? []
          if (candidates.some((name) => bundles.includes(name))) verified = true
        }
      } catch {}
      if (verified) {
        job.status = 'done'
        job.aiNote = '本地 AI 已接管并完成修复，请刷新页面查看'
      } else {
        job.status = 'failed'
        job.error = `本地 AI 完成了修复流程，但未能确认安装成功（候选包 ${candidates.join('、')} 均不可解析）；请手动执行：dsh plugin --profile web add <包名>`
      }
    } else {
      job.status = 'failed'
      job.error = `本地 AI 修复未成功（${outcome.detail ?? outcome.status}）。请手动执行：dsh plugin --profile web add <包名>`
    }
  } catch (error) {
    job.status = 'failed'
    job.error = `本地 AI 修复通道异常：${error instanceof Error ? error.message : String(error)}；请手动执行：dsh plugin --profile web add <包名>`
  }
}

/** AI 赋能：规划阶段——子代理只读调研文档，产出结构化部署计划（JSON）。 */
async function aiEmpowerPlan(job, ports, profileDir) {
  job.profileDir = profileDir
  job.status = 'running'
  job.stage = 'planning'
  let subagents = null
  try { subagents = ports.get('subagents') } catch {}
  const startFn = subagents?.start
  if (typeof startFn !== 'function') {
    job.status = 'failed'
    job.error = 'AI 赋能需要 DSH 子代理服务（subagents），当前不可用'
    job.finishedAt = Date.now()
    return
  }
  let provider = 'spawn'
  try {
    const list = subagents.list?.() ?? []
    if (!list.includes(provider)) provider = list[0]
    if (provider === undefined) throw new Error('no provider')
  } catch (error) {
    job.status = 'failed'
    job.error = `没有可用的子代理提供方：${String(error)}`
    job.finishedAt = Date.now()
    return
  }
  // 优先用「Git 源」把目标仓库克隆到本地，让子代理读本地材料：
  // 内网/离线环境下 api.github.com 与 raw 通道不可达时，这是唯一可行的调研通道。
  let materialDir = null
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(String(job.source ?? '').trim())) {
    const srcDir = join(tmpdir(), `dsh-ai-src-${job.id}-${Date.now().toString(36)}`)
    try {
      mkdirSync(srcDir, { recursive: true })
      for (const url of gitCloneUrls(job.source)) {
        try {
          await execFileAsync('git', ['clone', '--depth', '1', '--quiet', url, srcDir], { timeout: 120000, windowsHide: true, env: gitEnv() })
          materialDir = srcDir
          break
        } catch {}
      }
    } catch {}
    if (materialDir === null) {
      try { rmSync(srcDir, { recursive: true, force: true }) } catch {}
    } else {
      job.materialDir = srcDir
      // 30 分钟后自动清理（规划+执行通常早已结束）
      const timer = setTimeout(() => { try { rmSync(srcDir, { recursive: true, force: true }) } catch {} }, 30 * 60 * 1000)
      if (typeof timer?.unref === 'function') timer.unref()
    }
  }
  const prompt = [
    '你是 DSH 插件控制台挂载的「AI 赋能」部署规划器。用户想把下面的组件完整部署到本机。',
    `目标来源：${job.source}`,
    '',
    '## 框架适配检测（控制台权威结果，规划时必须引用并向用户解释）',
    frameworkCheckPromptText(job.frameworkCheck),
    '',
    '【任务】只做只读调研与规划，禁止执行任何安装/写文件/启动服务/杀进程命令（curl 的 GET 抓取、gh api 查询、读取文件是允许的）。',
    materialDir !== null
      ? `调研材料：目标仓库已由控制台通过「Git 源」克隆到本地目录 ${materialDir} —— 直接读取该目录下的 README / package.json / docs/ / install 说明即可（无需联网，内网/离线环境同样可用）。`
      : '调研材料：npm README / GitHub README / docs/ 目录 / package.json / install 说明。',
    '全部调研完成后，输出且只输出一个 ```json ... ``` 代码块，内容为部署计划；代码块之外不要输出任何文字。',
    '',
    '计划 schema（严格遵循）',
    '{',
    '  "type": "pure-plugin" | "service" | "config-only",',
    '  "displayName": "简短中文名",',
    '  "summary": "一句话：这是什么、为何这样部署",',
    '  "servers": [ { "name": "进程名", "file": "启动文件/命令", "args": ["参数..."], "cwd": "工作目录", "healthUrl": "http://127.0.0.1:端口/health", "port": 1933 } ],',
    '  "steps": [ { "action": "...", "description": "中文说明", "...": "动作参数" } ]',
    '}',
    '',
    '动作与参数（每个动作一个步骤，按依赖顺序）',
    '- install-pip: {"package":"<包名[extras]>"}',
    '- install-npm: {"package":"<npm 包名>","directory":"${profile}"}',
    '- write-file: {"path":"<目标文件>","content":"<完整文件内容原文>"}',
    '- download: {"url":"https://...","path":"<保存路径>"}',
    '- run-cmd: {"file":"可执行文件","args":["..."]}（file 仅限 curl/git/node/python/py/gh/npm/ov）',
    '- start-service: {"name":"<唯一名>","file":"...","args":["..."],"cwd":"...","healthUrl":"...","port":数字}',
    '- wait-health: {"url":"http://127.0.0.1:端口/health","timeoutMs":60000}',
    '',
    '约束',
    '- 占位符只能用 ${home} ${profile} ${python} ${scripts} ${node}；write-file 的 content 会被原样落盘',
    '- 纯 npm 插件：type=pure-plugin，只写 install-npm 步骤，不要 servers',
    '- 若用户提供的来源带 @tag（如 pkg@beta），install-npm 的 package 必须原样保留该 @tag，不得丢弃',
    '- 危险命令（rm -rf、del /s、format、Remove-Item 等）出现在计划里会被拒绝执行',
    '',
    '## 调研纪律（必须遵守）',
    '- 禁止递归扫描目录（Get-ChildItem -Recurse、find /、rg 全盘搜索）；只允许：读 ~/.openviking/、~/.dsh 顶层文件（.credentials.yaml、settings.yaml）、文档缓存目录，以及 curl 单次直连抓取',
    '- 每条命令必须带超时：curl 用 --max-time 30；PowerShell 单命令控制在 15 秒内；抓取失败就跳过，不要反复重试同一 URL',
    '- 总调研时间预算 8 分钟；剩余时间必须全部用于生成 JSON 计划，禁止重复验证已经确定的事实',
    '',
    aiEmpowerPresetFor(job.source),
  ].join('\n')

  try {
    let parent = null
    try {
      const agents = ports.get('agents')
      const list = typeof agents?.roots === 'function' ? agents.roots() : (typeof agents?.list === 'function' ? agents.list() : [])
      // 父代理选择：优先 cwd 与 DSH 服务工作区一致的会话（子代理 cwd 继承父会话），
      // 避免多工作区/多会话时借到别的 workspace 的会话导致调研错位
      const svcCwd = String(process.cwd() ?? '').replace(/[\\/]+$/u, '')
      const cwdOf = (a) => {
        try { return String(a?.session?.header?.cwd ?? a?.cwd ?? '').replace(/[\\/]+$/u, '') } catch { return '' }
      }
      parent = list.find((a) => cwdOf(a) !== '' && cwdOf(a) === svcCwd) ?? list[0] ?? null
      job.parentCwd = parent ? cwdOf(parent) : null
    } catch {}
    if (parent === null) {
      job.status = 'failed'
      job.error = 'AI 赋能无法借用活动会话（agents 注册表为空），请先开启一个会话再试'
      job.finishedAt = Date.now()
      return
    }
    const controller = new AbortController()
    job.abort = controller
    const run = await startFn.call(subagents, provider, {
      label: `ai-empower-plan-${String(job.source).split('/')[0]?.slice(0, 20) ?? 'component'}`,
      prompt: [{ type: 'text', text: prompt }],
      maxDepth: 1,
      signal: controller.signal,
      parent,
    })
    let settleFn = null
    try {
      const requireLocal = createRequire(join(profileDir, 'package.json'))
      ;({ settleRun: settleFn } = requireLocal('@deepseek-ai/dsh-subagent'))
    } catch {}
    const settle = settleFn ?? (async (runHandle) => {
      try {
        const result = await runHandle.result
        return { status: result?.stopReason === 'completed' ? 'completed' : 'failed', detail: String(result?.stopReason ?? 'unknown') }
      } catch (error) {
        return { status: 'failed', detail: String(error) }
      }
    })
    const outcome = await Promise.race([
      settle(run),
      new Promise((resolve) => setTimeout(() => {
        controller.abort()
        resolve({ status: 'failed', detail: 'AI 赋能规划超时（15 分钟）' })
      }, 900000)),
    ])
    if (outcome.status === 'completed') {
      const plan = parsePlanJson(String(outcome.output ?? outcome.detail ?? ''))
      if (plan === null) {
        job.status = 'failed'
        job.error = '子代理完成调研但未产出可解析的部署计划 JSON，请重试或手动部署'
      } else {
        job.plan = plan
        job.status = 'plan-ready'
      }
    } else {
      job.status = 'failed'
      job.error = `AI 赋能规划未成功（${outcome.detail ?? outcome.status}）`
    }
  } catch (error) {
    job.status = 'failed'
    job.error = `AI 赋能规划异常：${error instanceof Error ? error.message : String(error)}`
  }
  job.finishedAt = Date.now()
  saveAiJobs()
}

/** AI 赋能：执行阶段——按用户勾选的步骤顺序执行，逐步回显日志。 */
async function aiEmpowerExecute(job, ports, profileDir, selected) {
  job.status = 'running'
  job.stage = 'executing'
  job.stepStates = (job.plan?.steps ?? []).map((_, i) => ({ index: i, status: 'skipped' }))
  if (job.abort) job.abort = null
  const controller = new AbortController()
  job.abort = controller
  const steps = job.plan?.steps ?? []
  const chosen = new Set((selected ?? steps.map((_, i) => i)).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n < steps.length))
  const chosenList = steps.map((s, i) => ({ s, i })).filter((x) => chosen.has(x.i))
  let done = 0
  for (const { s, i } of chosenList) {
    if (controller.signal.aborted) {
      job.status = 'failed'
      job.error = '已取消执行（用户中断）'
      break
    }
    job.stepStates[i].status = 'running'
    job.progress = { done, total: chosenList.length }
    jobLog(job, `▶ 步骤 ${i + 1}/${steps.length} [${s.action}] ${s.description ?? ''}`)
    try {
      await runAiStep(job, s, ports, profileDir, controller.signal)
      job.stepStates[i].status = 'ok'
      done += 1
      jobLog(job, `✔ 步骤 ${i + 1} 完成`)
    } catch (error) {
      job.stepStates[i].status = 'fail'
      job.status = 'failed'
      job.error = `步骤 ${i + 1}（${s.action}）失败：${error instanceof Error ? error.message : String(error)}`
      jobLog(job, `✘ 步骤 ${i + 1} 失败：${job.error}`)
      break
    }
  }
  if (job.status !== 'failed') {
    job.status = 'done'
    job.stage = 'done'
  }
  job.progress = { done, total: chosenList.length }
  job.finishedAt = Date.now()
  jobLog(job, job.status === 'done' ? '🎉 AI 赋能部署完成' : '⛔ AI 赋能部署中止')
  saveAiJobs()
}

/** 单步执行器：动作白名单 + 路径白名单 + 破坏性命令拦截。 */
async function runAiStep(job, step, ports, profileDir, signal) {
  const profile = profileDir
  switch (step.action) {
    case 'install-pip': {
      const pkg = String(step.package ?? '')
      if (!/^[A-Za-z0-9_\-\.\[\]=\s]+$/u.test(pkg) || pkg === '') throw new Error(`包名不合法：${pkg}`)
      const python = resolvePythonPath()
      const params = ['-m', 'pip', 'install', pkg, '--index-url', 'https://mirrors.aliyun.com/pypi/simple/', '--disable-pip-version-check']
      jobLog(job, `  运行: ${python} ${params.join(' ')}`)
      await execFileAsync(python, params, { timeout: 900000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, signal })
      return
    }
    case 'install-npm': {
      const pkg = String(step.package ?? '')
      if (!/^(@[A-Za-z0-9_\-\.]+\/)?[A-Za-z0-9_\-\.]+(@[A-Za-z0-9_\-\.]+)?$/u.test(pkg)) throw new Error(`包名不合法：${pkg}`)
      const dir = resolvePlaceholders(String(step.directory ?? profile), { profileDir: profile })
      // 跨平台：不再拼 `node <node bin>/node_modules/corepack/dist/corepack.js`（Linux 上必 MODULE_NOT_FOUND，
      // 2026-09-20 另一位用户的 install-npm 失败现场就是这一行），改为按优先级尝试可用的执行方式
      const args = ['add', pkg, '--dir', dir, '--registry', 'https://registry.npmmirror.com']
      const { runner } = await runPnpmWithFallback(args, {
        execOpts: { timeout: 900000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, signal },
      })
      jobLog(job, `  运行: ${runner.note} ${args.join(' ')}`)
      return
    }
    case 'write-file': {
      const target = resolvePlaceholders(String(step.path ?? ''), { profileDir: profile })
      if (!isAllowedWritePath(target, profile)) throw new Error(`写入路径不在白名单内：${target}`)
      mkdirSync(dirname(target), { recursive: true })
      let content = resolvePlaceholders(String(step.content ?? ''), { profileDir: profile })
      // JSON 内容防御：若计划生成方用了占位符导致非法转义（路径反斜杠未转义），在这里拦住并给出明确报错
      const trimmed = content.trim()
      if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && content.length < 1024 * 1024) {
        try {
          JSON.parse(trimmed)
        } catch {
          throw new Error('write-file 的内容不是合法 JSON（占位符替换后可能残留未转义的反斜杠路径）：请让计划以 JSON.stringify 后的原文提供 content')
        }
      }
      writeFileSync(target, content, 'utf8')
      jobLog(job, `  已写入 ${target}（${content.length} 字节）`)
      return
    }
    case 'download': {
      const url = maskUrl(String(step.url ?? ''))
      if (!/^https?:\/\//u.test(url)) throw new Error(`下载地址不合法：${url}`)
      const target = resolvePlaceholders(String(step.path ?? ''), { profileDir: profile })
      if (!isAllowedWritePath(target, profile)) throw new Error(`下载路径不在白名单内：${target}`)
      mkdirSync(dirname(target), { recursive: true })
      if (existsSync(target) && statSync(target).size > 1024 * 1024) {
        jobLog(job, `  已存在，跳过下载：${target}（${statSync(target).size} 字节）`)
        return
      }
      const realUrl = String(step.url).replaceAll('https://huggingface.co', 'https://hf-mirror.com')
      jobLog(job, `  下载 ${maskUrl(realUrl)} → ${target}`)
      await execFileAsync('curl.exe', ['-fSL', '-o', target, realUrl], { timeout: 900000, windowsHide: true, maxBuffer: 1024 * 1024, signal })
      jobLog(job, `  下载完成（${statSync(target).size} 字节）`)
      return
    }
    case 'run-cmd': {
      const file = resolvePlaceholders(String(step.file ?? ''), { profileDir: profile })
      const args = (step.args ?? []).map((a) => resolvePlaceholders(String(a), { profileDir: profile }))
      if (!isSafeRunCmd(file, args)) throw new Error('run-cmd 未通过安全白名单校验（不允许的可执行文件或破坏性参数）')
      jobLog(job, `  运行: ${[file, ...args].join(' ')}`)
      const { stdout, stderr } = await execFileAsync(file, args, { timeout: 600000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, signal })
      jobLog(job, `  输出: ${String(stdout ?? '').slice(-1500)}${stderr ? `（stderr: ${String(stderr).slice(-500)}）` : ''}`)
      return
    }
    case 'start-service': {
      const name = String(step.name ?? 'service')
      const file = resolvePlaceholders(String(step.file ?? ''), { profileDir: profile })
      const args = (step.args ?? []).map((a) => resolvePlaceholders(String(a), { profileDir: profile }))
      const cwd = resolvePlaceholders(String(step.cwd ?? homedir()), { profileDir: profile })
      const healthUrl = typeof step.healthUrl === 'string' ? resolvePlaceholders(step.healthUrl, { profileDir: profile }) : null
      const uiUrl = typeof step.uiUrl === 'string' ? resolvePlaceholders(step.uiUrl, { profileDir: profile }) : null
      const port = Number(step.port ?? 0)
      if (!isSafeRunCmd(file, args)) throw new Error('start-service 未通过安全白名单校验')
      if (healthUrl !== null) {
        try {
          const probe = await fetch(healthUrl, { signal: AbortSignal.timeout(2500) })
          if (probe.ok) {
            const slugPre = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
            compUpsert({ id: slugPre || `svc-${Date.now()}`, kind: 'server', pid: null, file, args, cwd, healthUrl, uiUrl, port, repo: job.source, installedAt: Date.now() })
            jobLog(job, `  服务健康已就绪，跳过启动（复用现有进程）：${healthUrl}`)
            return
          }
        } catch {}
      }
      const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd, shell: false })
      child.unref()
      const pid = child.pid
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
      const id = slug || `svc-${Date.now()}`
      if (healthUrl) {
        const alive = await waitHealth(healthUrl, 60000, job, signal).catch(() => false)
        if (!alive) jobLog(job, `  ⚠ healthUrl ${healthUrl} 在 60s 内未就绪（进程 pid=${pid} 已启动，待手工排查）`)
      }
      compUpsert({ id, name, kind: 'server', pid, file, args, cwd, healthUrl, uiUrl, port, repo: job.source, installedAt: Date.now() })
      jobLog(job, `  服务已启动：${name}（pid=${pid}${healthUrl ? `，healthUrl=${healthUrl}` : ''}）`)
      return
    }
    case 'stop-service': {
      const id = String(step.id ?? '')
      const record = compFind(id)
      if (!record || !record.pid) throw new Error(`组件不存在或未记录 pid：${id || '(空)'}`)
      await execFileAsync('taskkill.exe', ['/PID', String(record.pid), '/F'], { timeout: 30000, windowsHide: true })
      compUpsert({ id, pid: null })
      jobLog(job, `  服务已停止：${record.name}`)
      return
    }
    case 'wait-health': {
      const url = resolvePlaceholders(String(step.url ?? ''), { profileDir: profile })
      const timeoutMs = Number(step.timeoutMs ?? 60000)
      const ok = await waitHealth(url, timeoutMs, job, signal)
      if (!ok) throw new Error(`健康检查未通过：${url}（${timeoutMs}ms）`)
      return
    }
    case 'register-component': {
      const id = String(step.id ?? '')
      if (!id) throw new Error('register-component 缺少 id')
      compUpsert({ id, name: String(step.name ?? id), kind: String(step.kind ?? 'server'), pid: null, file: step.file ? resolvePlaceholders(String(step.file), { profileDir: profile }) : undefined, args: (step.args ?? []).map((a) => resolvePlaceholders(String(a), { profileDir: profile })), healthUrl: step.healthUrl ? resolvePlaceholders(String(step.healthUrl), { profileDir: profile }) : undefined, uiUrl: step.uiUrl ? resolvePlaceholders(String(step.uiUrl), { profileDir: profile }) : undefined, port: Number(step.port ?? 0), repo: job.source, installedAt: Date.now() })
      return
    }
    default:
      throw new Error(`未知动作：${step.action}`)
  }
}

export { aiEmpowerPlan, runAiStep, aiRepair, aiEmpowerExecute }
