# 安全政策 Security Policy

本文件说明 `@noob-stupid/dsh-plugin-console`（仓库 [Noob-stupid/dsh-plugin-gating-hub](https://github.com/Noob-stupid/dsh-plugin-gating-hub)）的安全政策：这个插件**能做什么**（能力清单）、已内置哪些护栏、自动化静态扫描容易误报的地方，以及如何报告漏洞。

英文能力摘要见文末 [Capability summary (English)](#capability-summary-english)。

## 支持的版本

| 版本 | 支持状态 |
|---|---|
| 0.3.x（当前 latest） | ✅ 支持 |
| 0.3.x 更早版本 | ⚠️ 仅严重漏洞修复 |

## 报告漏洞

**请勿在公开 Issue 中披露安全漏洞**。请通过以下方式私下报告：

1. 通过 GitHub 的 [Security Advisory](https://github.com/Noob-stupid/dsh-plugin-gating-hub/security/advisories/new)（推荐，私密）
2. 或给仓库 owner 发 GitHub 私信

请在报告中包含：

- 影响面（哪条路由/哪个文件、可造成什么危害）
- 复现步骤（最小化，脱敏密钥）
- 受影响版本（插件版本 + DSH 版本 + 操作系统）

## 处理承诺

- 收到报告后 3 天内确认收到；
- 修复后发布补丁版本前，不会公开细节；
- 修复发布后，会在 CHANGELOG 中致谢报告者（如需匿名请说明）。

## 能力清单：这个插件能做什么

插件控制台是**插件的管理器**——安装/更新/启停/审查其他 DSH 插件，因此需要文件写入、网络访问与进程控制能力。以下能力**全部由你在控制台里主动触发**，或属于你显式配置过的后台行为（组件自启动、索引源拉取）。**没有遥测、没有硬编码的回传地址**；除你调用的功能（搜索、市场索引、安装、检查更新）之外，不向外发送任何数据。

### 读（文件系统）

- DSH profile 目录：`cordis.yml` / `cordis.patch.yml`、`node_modules` 元数据、已装插件的 `package.json` / `README.md` / 源码（用于兼容性源码扫描）
- `<dshHome>` 状态：软件源配置、组件记录、任务与缓存状态、GitHub 登录**状态**（令牌本身永不下发到浏览器）
- DSH 安装目录：定位 `bin.js`，用于「重启服务」

### 写（白名单）

| 目标 | 用途 |
|---|---|
| profile 的 `cordis.patch.yml` | 启用/停用/自动停用/新增插件行 |
| `<dshHome>/plugin-console/*` | 软件源、组件记录、任务与缓存状态 |
| profile 的 `node_modules` | 安装或卸载你指定的插件 |
| `<dshHome>/skills` | 安装或删除你指定的技能 |
| 临时目录（`%TEMP%`、仓库落地目录） | git 克隆、下载、AI 调研用检出，任务结束即清理 |

所有写入都经过 `isAllowedWritePath` 校验（DSH profile、`~/.dsh`、`~/.openviking`、ASCII 数据根）；「仓库落地」的删除额外要求目标位于你配置的仓库目录内。

### 网络

- GitHub API / raw：搜索、元数据、release 查询，带镜像回退（ghproxy / ghfast / jsDelivr）
- **npm 软件源：列表完全由你配置**。默认 `registry.npmmirror.com`（主）+ `registry.npmjs.org`；内网 Verdaccio / Nexus 的明文 `http` **只在环回与 RFC1918 私网地址**上被接受
- 市场静态索引（一个 JSON 文件），地址可配置——这是「完全离线 / 内网市场」的实现方式
- Git 克隆源，可配置（`{owner}/{repo}` 模板，含 `file://` 本地裸仓库）

### 进程

- `pnpm`（优先）/ `npm` 安装：固定 argv 数组、`shell: false`
- `git clone` / `git ls-remote`：非交互环境（`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`、`GIT_ASKPASS=echo`、`SSH_ASKPASS=echo`），克隆绝不会卡在凭据弹窗上
- `taskkill.exe /PID <记录的 PID> /F`：只用于停止**你注册过**的组件；「重启服务」走计划任务 + `Stop-Process`
- 组件自启动：DSH 启动时，把你标记为「自启动」的组件用记录的启动命令拉起（以你的用户权限运行）

插件**不执行第三方仓库的安装脚本**；套装/聚合安装只按仓库声明的安装语义走 npm / git。

### HTTP 面

所有路由都在 `/plugin-console` 下，且**仅限本机**：socket 地址不是环回直接 403，`Host` 头必须与服务端口一致，所有非 GET 路由还必须通过同源校验（`Origin` / `Sec-Fetch-Site`）。因为判定用的是 socket 地址，即使 DSH 绑定 `0.0.0.0`，这些路由在局域网内依然不可达。

## 已内置的安全护栏

| 领域 | 护栏 |
|---|---|
| 写路由 | 环回 + `Host` 校验 + 同源校验，仅接受 JSON body |
| 路径 | 写入路径白名单；仓库落地/删除限定在配置目录内 |
| 密钥 | GitHub / Gitee 令牌不出本机（只回传 `loggedIn` / `login` 状态）；自定义源请求头与 Gitee clientSecret 在响应里打码，并单独存于 secrets 文件 |
| 克隆 | git 非交互环境（不会弹凭据框、不会挂住） |
| 供应链 | **没有 `preinstall` / `postinstall` 脚本**；唯一的生命周期脚本是 `prepublishOnly`（发布前 BOM 自检） |
| 框架升级 | 升级前备份、失败自动回滚；引用了已删除框架 API 的插件会被自动停用，而不是放任整个服务崩溃 |
| 安装安全 | 注册插件行之前校验 bundle 引用模块，引用无法解析的插件会被拒绝，避免启动崩溃 |

## 给自动化静态扫描器的说明（已知误报）

如果你用 AST / 启发式扫描器审查本插件，以下模式是有意为之，可以按误报处理：

- **`process.kill(pid, 0)`**：signal `0` 的**存活探测**。不发送任何信号、无法终止进程，是 Node.js 判断「记录的组件 PID 是否还活着」的标准写法。
- **`rmSync(...)`**：23 处调用全部清理本插件自己在安装/克隆/升级流程中创建的目录（临时检出、下载缓存、被替换的旧目录、升级备份）；另有 2 处是**用户主动触发**的删除（删技能、删已落地仓库），带名称正则 / 路径前缀校验。
- **`spawn` / `execFile`**：固定 argv 数组 + `shell: false`，不存在拼接出来的 shell 命令串。
- **`process.env` 读取**：用于定位 `DSH_HOME` / `LOCALAPPDATA`，不向外传输任何环境变量值。
- **外联地址**：GitHub、npm 软件源、市场索引——要么是公开默认值，要么是你在控制台里配置的地址。

## 用户加固建议

- 软件源优先用 `https://`；`http` 只对环回/私网开放，在内网使用时请自行知情。
- 除非前面有配对门（`dsh-remote-web-ui`）保护 `/api`，否则不要把服务绑定切到局域网。
- 安装前先看：控制台会展示仓库地址、README 摘要与源码级兼容性扫描结果；可与 [dsh.so 的 artifact 页](https://www.dsh.so/zh/artifact/dsh-plugin-hub/)交叉验证。
- 只把信任的组件标记「自启动」——它们会在每次 DSH 启动时以你的权限运行。

## 已知关注点

- 插件控制台只允许本机（127.0.0.1）访问，并对写路由做 Origin 校验（见 `lib/index.js`）；
- AI 赋能执行器有命令/路径白名单与破坏性命令拦截；若发现绕过方式，请优先私信报告。

## Capability summary (English)

`@noob-stupid/dsh-plugin-console` is a plugin **manager** for DeepSeek Harness. It reads the DSH profile and `<dshHome>` state; it writes only to the profile's `cordis.patch.yml`, `<dshHome>/plugin-console/*`, profile `node_modules` (installs you ask for), `<dshHome>/skills`, and its own temp dirs (all gated by a write-path whitelist). It reaches the network only for GitHub, **user-configured** npm registries, the configurable market index and configured git sources — there is **no telemetry and no hardcoded upload endpoint**. It spawns `pnpm`/`npm`/`git` with fixed argv and `shell: false`, stops only component PIDs you registered (`taskkill /PID`), and restarts DSH through a scheduled-task helper. All HTTP routes are under `/plugin-console`, **loopback-only**, with `Host` and same-origin checks on writes. There are **no `preinstall`/`postinstall` scripts**.

Known static-scanner false positives: `process.kill(pid, 0)` is a signal-0 liveness probe; `rmSync` call sites clean up temp/backup directories the plugin created (plus two user-initiated, path-checked deletions); `process.env` reads only locate `DSH_HOME`/`LOCALAPPDATA`.
