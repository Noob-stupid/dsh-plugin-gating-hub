> **English**: [README.md](README.md) | **中文**: [README.zh.md](README.zh.md)

---

<img width="1170" height="609" alt="image" src="https://github.com/user-attachments/assets/b802d606-14ba-4151-9956-ff642ed12b0a" />

# DSH 插件中心（dsh-plugin-hub）

> 一站式管理你的 DeepSeek Harness 插件：一键启用/停用、500+ 插件与技能市场一键安装、
> 框架一键升级（失败自动回滚）。

## 为什么是 DSH 插件中心

- 🧩 **插件 + 技能双市场** — 自动收录 `dsh-plugin` 仓库（按 star **500+**）外加技能 tab；
  浏览、搜索、一键安装，**零 GitHub API 调用**（CDN 分发，秒开零限流）。
- 🚀 **框架一键升级** — 备份 → 在线安装（服务不中断）→ 校验 → **失败自动回滚**，端到端实测。
- 🤖 **AI 赋能** — 输入 npm 包名或 GitHub 仓库，本地 AI 读文档生成**部署计划**
  （安装/写配置/启动服务/健康检查），你确认后安全执行；服务器组件自动生成控制卡片。
  → [详见](docs/ai-empower.zh.md)

## 一键部署

```bash
# npm 发布版（推荐：预构建产物，无需 git / 构建授权）
dsh plugin --profile web add @noob-stupid/dsh-plugin-console

# 或直接装 GitHub 源码（需 git，首次需 allowBuilds 授权）
dsh plugin --profile web add github:Noob-stupid/dsh-plugin-hub
```

然后重启 dsh 服务 → 刷新页面 → **设置 → 插件 → 插件控制台**。

<details><summary><b>更多部署方式</b>（部署脚本 / 一句话交给 AI）</summary>

### 方式二：部署脚本（网络受限时的兜底）

Windows（PowerShell）：

```powershell
git clone https://github.com/Noob-stupid/dsh-plugin-hub "$env:TEMP\dsh-plugin-console" 2>$null; & "$env:TEMP\dsh-plugin-console\deploy.ps1"
```

Linux / macOS：

```bash
git clone https://github.com/Noob-stupid/dsh-plugin-hub /tmp/dsh-plugin-console 2>/dev/null; bash /tmp/dsh-plugin-console/deploy.sh
```

脚本会做两件事：把插件包拷进 `$DSH_HOME/profiles/<profile>/node_modules/`，
并在 `cordis.patch.yml` 幂等追加启用条目。完成后：

1. 重启 dsh 服务（宿主代码变更需要重启进程；命令行方式重启进程，桌面客户端退出重开）；
2. 刷新页面 → 设置 → 插件 → **插件管理**。

### 方式三：一句话交给 AI

> 安装 DSH 插件中心（dsh-plugin-hub）：运行 `dsh plugin --profile web add @noob-stupid/dsh-plugin-console`（npm 发布版）；若没有 dsh CLI，则克隆 https://github.com/Noob-stupid/dsh-plugin-hub 到 `~/.dsh/profiles/web/node_modules/`，在 `cordis.patch.yml` 注册（id: plugin-console，name: @noob-stupid/dsh-plugin-console）。完成后重启 dsh web。

要求：DSH ≥ 0.1.0-rc.6（web profile，含 `dsh-client-modules` / `dsh-host-plugin-inventory`）。

</details>

---

## 核心优势

| | 优势 | 说明 |
|---|---|---|
| 🤖 | **AI 赋能** | 输入 npm 包名 / GitHub 仓库，本地 AI 读文档生成**部署计划**（安装/写配置/启动服务/健康检查），你确认后安全执行；服务器类组件自动生成控制卡片 |
| 🛡️ | **框架升级适配门与安全** | 升级后不兼容插件强制禁用（适配门锁定，「检测更新 → 更新并适配 → 自动校验解锁」）；升级前全树 checkpoint、拉起失败自动全树回滚、框架卡片一键回滚到上一版 |
| 🏠 | **全家桶分组卡片与安全** | 同根包子路径导出自动聚合为一张全家桶卡片（收起/展开、批量检测更新、一键启用已适配、已知校验预览）；永不崩安全（启用前导入探针 + 补丁自愈 + exports 回退）；适配门源码扫描硬判据与迁移检测；删除聚合包子行仅停用该行 |
| 🚀 | **服务器组件卡片** | 左侧浮卡与主面板顶边对齐：启动 / 停止 / 状态 / 【打开】直达 Web UI，多服务器下拉、可折叠（状态记忆） |
| 🧩 | **插件 + 技能双市场** | 自动收录 `dsh-plugin` topic 仓库（按 star **500+**），另有**技能 tab**（`agent-skills` ∪ `claude-skills` ∪ `dsh-skill`，最多 300）——浏览、搜索、一键安装，零 GitHub API 调用；插件自带技能（如 openviking-memory）只读展示 |
| 🤖 | **自动收录 CI** | GitHub Actions 每 6 小时自动重跑 `build-index`（也支持手动触发）；作者只需给自己的仓库打 `dsh-plugin` / `agent-skills` / `claude-skills` / `dsh-skill` 标签，**无需申请、无需审核** |
| ⚡ | **秒开、零限流** | 索引以静态 `marketplace/index.json` 提交仓库，经 jsDelivr CDN 分发（宿主 10 分钟缓存）——终端用户**零 GitHub API 调用、零限流** |
| 🔄 | **版本检测与一键更新** | semver 比较 + beta/next 识别（本地已是测试版最新时不误报）；已安装条目自动比对 npm `dist-tags`，聚合包子包版本不配套时给出 depsOutdated 提示 |
| 🔀 | **多源检索** | GitHub / Gitee（仓库直装模式）/ 自定义搜索源（URL 模板 + 请求头认证 + 私网 http）；「⊞」并行合并 GitHub + 全部自定义源 |
| 🔒 | **安全默认** | 全部路由仅环回；AI 兜底置于明确费用授权弹窗之后；AI 赋能执行器命令/路径白名单；基础设施行禁止开关（受保护） |

<details>
<summary><b>📑 目录</b></summary>

- [核心优势](#核心优势)
- [AI 赋能与服务器组件控制](#ai-赋能与服务器组件控制)
- [一键部署](#一键部署)
- [使用方法](#使用方法)
- [功能](#功能)
- [原理](#原理)
- [兼容性策略](#兼容性策略)
- [项目结构](#项目结构)
- [HTTP 接口](#http-接口)
- [安全说明](#安全说明)
- [已知限制](#已知限制)
- [帮助 / Help](#帮助--help)
- [生态与收录](#生态与收录)
- [参与贡献](#参与贡献)
- [许可证](#许可证)
</details>

---

## 使用方法

1. 重启 DSH → 打开 Web GUI → **设置 → 插件 → 插件管理**。
2. **已安装列表**：一键开关（HMR 约 1 秒生效）、按名称/id 搜索、展开详情（版本、仓库、README 摘要）。
3. **插件市场**：GitHub 源空查询直接打开静态索引（秒开）；输入关键词实时搜索。顶部登录标切换
   搜索源（GitHub / Gitee / 自定义）；「⊞」多源合并；「★」只看可 `dsh plugin add` 直装。
4. **技能 tab**：搜索框旁切换「插件 / 技能」，浏览并一键安装技能（克隆到 `~/.dsh/skills/<名称>/`）。
5. **安装**：点「添加到本地」→ 后台安装链自动执行（可放心离开页面）；已安装条目自动出现
   「检测更新」/「更新 → vX」。

---

## 功能

### 已安装插件（一键开关 + 详情）

- **默认只显示第三方插件**（后装/非 dsh 自带），带「第三方」标签与删除入口；点「全部」切换查看完整列表（1.5s 亮框反馈）；
- 列出全部插件条目（名称、加载状态、启用状态）；支持按名称/id 搜索；
- 点「停用」= 在用户补丁层写入 `- id: X` + `disabled: true`，HMR 立即生效；
- 点「启用」= 移除该停用条目；bundle 层本就停用的行用 `disabled: false` 覆盖；
- 打标「补丁停用 / 补丁强制启用」区分用户补丁状态；
- **基础设施保护**：host 传输/热加载/存储/设置链上的插件（timer、hmr、webserver 等
  70+ 行）标记「受保护」，禁止开关——误停用会破坏热加载本身；
- **详情面板**：每个插件可点「详情」，展开简介、版本、仓库/主页链接与 README 摘要；
- **版本检测**：「检测更新」走 curl 读 npm `dist-tags.latest`（node 网络黑洞时也可用），
  并提示需要同步的子包版本（depsOutdated），避免半更新混搭导致启动冲突。

### 框架一键升级（deepseek-harness 卡片）

- **deepseek-harness 卡片**在检测到框架新版本时显示「框架升级 → vX」（稳定版 latest 优先；
  latest 与当前相同时取 next 预发布渠道）；点击一键完成：备份配置与框架本体（回滚点）→
  **在线安装**（服务保持运行、页面不断开）→ 版本校验 → **自动重启生效**；
- **实时进度**：升级时弹出 `DSH-Upgrade` 窗口，实时显示 pnpm 下载进度；面板内进度卡片
  同步显示等待时长；
- **升级保护**：失败**自动回滚**（robocopy，升级前校验回滚点有效）、版本校验防假成功、
  15 分钟硬超时、卡死检测（debug 日志无更新自动切换 registry）、全局异常兜底、
  15 分钟残留状态清理——框架绝不处于损坏状态；
- **pnpm 通道**：npm-cli.js 在 schtasks 任务环境启动即卡死（debug 日志 0 字节、网络请求
  都发不出）；升级改用 `corepack pnpm`（实测 0.4s 秒启动、11.5s 装完 rc.8）+ **国内源
  npmmirror**，并带 `dangerouslyAllowAllBuilds` 让 node-pty/koffi 等原生模块正常编译；
- **运行时解析 bin.js**：pnpm 布局下 `@deepseek-ai/dsh` 是 Junction——拉起服务在运行时
  解析（跟随 Junction 到当前版本），而非使用脚本生成时固化的路径；
- **卡片关闭语义**：终态（成功/失败）点叉号永久关闭（持久化）；进行中点叉号仅本次会话
  隐藏，刷新后恢复显示。

### 插件市场（多搜索源）

- **搜索源切换**：点击顶部登录态标识弹出菜单，在 **GitHub / Gitee / 自定义源** 间切换（选择持久化）；
  市场标题、加载提示、搜索框占位符、说明行全部随源切换；
- **GitHub 源**：默认搜索 `dsh-plugin`，浏览器直连（失败自动回退服务端通道）；
- **Gitee 源**：Gitee 官方搜索 API 已停用，采用**仓库直装模式**——输入 `owner/repo`
  （支持中文路径与完整 URL）精确查找仓库并安装；
- **自定义搜索源**：软件源管理中添加（URL 模板含 `{q}`/`{page}` 占位符），支持
  **请求头认证**（如 `Authorization: Bearer ...`）与**本机/私网 http 地址**；
- **多源汇总**：搜索框旁「⊞」开启——GitHub + 全部自定义源并行检索，结果合并并标注来源；
- **★ 官方筛选**：只筛**可 `dsh plugin add` 直装**的插件——根包带 `dsh.bundle` 清单（官方）
  或聚合仓库中**子包带 `dsh.bundle`**（子包可直装）；标记由服务端 curl 双通道 + 客户端兜底补全，
  搜索结果与筛选即时可用；
- **类型徽标**：官方 / 聚合 / 技能（仓库含 SKILL.md）自动识别；
- 「添加到本地」= 按当前源安装（registry 失败自动回退 git 通道）+ 写入启用条目，HMR 生效。

### 静态索引市场（插件 / 技能双 tab）

> **混合架构**：浏览走静态索引（秒开、零 API 调用），搜索走实时通道（GitHub 搜索 API / 多源并行）——
> 两者互补：新仓库即使还没进索引，也能被实时搜索找到。

- GitHub 源空查询展示**静态索引**（`marketplace/index.json`，jsDelivr CDN + 宿主 10 分钟缓存）：
  按 star 排序 500+ 插件，秒开、**零 GitHub API 调用**；
- 搜索框旁**「插件 / 技能」tab**：技能 tab 列出自动收录的 `agent-skills` ∪ `claude-skills` ∪
  `dsh-skill` 仓库（最多 300）；
- **自动版本比对**：市场中已安装的条目后台自动查 npm `dist-tags.latest`，卡片变「更新 → vX」；
- **技能安装**：技能条目一键安装 = git clone → 复制 SKILL.md 及同目录资源到
  `~/.dsh/skills/<名称>/`（frontmatter 的 name 优先于仓库名；SKILL.md 位于仓库根或第一层
  子目录均可识别）；已装技能显示灰色「已装」徽标。

### 软件源管理

市场标题行右侧悬浮「软件源」按钮（半透明、颜色加深），弹出管理模态框：

![软件源管理](https://github.com/user-attachments/assets/ef712900-65ae-4f6f-9584-bacdd8d34ea1)

- **安装源（registry）**：添加 / 行内编辑 / 设为主源 / 恢复默认；支持私有源与内网地址；
  **删除已保护**（插件安装依赖的 npm 源，避免误删）；
- **搜索源**：内置 GitHub、Gitee + 自定义搜索源（增删、🔒 显示请求头数量）；
- **Gitee 登录（可选）**：直装模式无需登录；登录仅提高接口限额——创建第三方应用
  （gitee.com → 数据管理 → 第三方应用，权限勾选 user_info、projects）后填入
  client_id / client_secret → 保存 → 授权登录。

---

## 文档

- [AI 赋能与服务器组件控制](docs/ai-empower.zh.md)
- [框架升级适配门与升级安全](docs/upgrade-safety-adapt-gate.zh.md)
- [原理](docs/how-it-works.zh.md) · [兼容性策略](docs/compatibility.zh.md) · [项目结构](docs/project-layout.zh.md)
- [HTTP 接口](docs/http-endpoints.zh.md) · [AI 兜底安装与授权弹窗](docs/ai-fallback.zh.md)
- [安全说明与免责声明](docs/security-disclaimer.zh.md)

---

## 已知限制

- 宿主代码变更需要**重启服务**（面板的重启按钮自带守护、安全）；客户端变更只需刷新页面；
- 实时 GitHub 搜索依赖 GitHub 可达性（浏览器直连 + 服务端兜底；网络黑洞期请稍后重试）；
- 版本检测只对已发布到 npm 的包生效；技能类仓库没有版本概念；
- 静态索引有上限（每次构建 500 插件 / 300 技能）；新仓库靠 star 爬升或等下一轮 6 小时 CI 进入索引；
- 技能由 `dsh-skill-filesystem` 扫描发现——若当前 profile 未启用该插件，装好的技能会休眠，启用并重启后生效。

---

## 帮助 / Help

遇到问题先看这里；仍有疑问请到 [议题](https://github.com/Noob-stupid/dsh-plugin-hub/issues) 提问。

- **面板没出现**：重启 dsh 服务 → 刷新页面 → 设置 → 插件 → 插件管理。
- **点开关没反应**：基础设施行带"受保护"标签（禁止开关，这是保护机制）；普通插件开关经
  HMR 生效，约 1-3 秒，可点刷新查看。
- **顶部出现兼容性警告**：官方发布了破坏性更新，请到本仓库获取适配版本（见兼容性策略）。
- **市场搜索没结果/报错**：GitHub 源走浏览器直连（与浏览器可用性一致），失败自动回退
  服务端通道；Gitee 源为仓库直装模式（输入 `owner/repo`）；自定义源检查地址与请求头配置；
  网络黑洞期请稍后重试。
- **★ 筛选为空**：★ 只筛可 `dsh plugin add` 直装（官方 + 子包带 bundle 的聚合）；
  标记 1-3 秒后台补全后自动出现，不会误报"没有"。
- **安装失败**：确认仓库有 package.json 且包名已发布到 npm；npm 装不了的会回退
  `github:owner/repo` 安装（需要 git）；可在软件源管理中换主源（如 npmmirror 网络波动时）。
- **装好的技能 DSH 不识别**：在 profile 的 `cordis.yml` 启用 `@deepseek-ai/dsh-skill-filesystem`
  并重启；技能位于 `~/.dsh/skills/<名称>/`。

---

## 生态与收录

- 已被 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（社区主精选列表）与 [DSH Directory](https://dsh.directory) 收录；
- 本中心的自动收录索引（500+ 插件 / 300 技能，CI 每 6 小时刷新）会收录**任何**打了 `dsh-plugin` / `agent-skills` / `claude-skills` / `dsh-skill` 标签的仓库——作者打上标签即可自动出现在市场，无需申请；
- 如果你在开发 DSH 插件，本面板就是你的分发渠道：所有使用本面板的用户都能一键安装你的插件。

## 支持

如果这个面板帮你省了时间、让 DSH 更好用：

- ⭐ **给本仓库点个 Star**——直接帮助更多 DSH 用户发现它；
- 分享给身边的 DSH 用户或社区；
- 提交你自己的插件（打上 `dsh-plugin` 标签）一起壮大生态；
- 发现 bug 或有新需求？[开一个 Issue](https://github.com/Noob-stupid/dsh-plugin-hub/issues)。

---

## 参与贡献

欢迎各种形式的贡献——Issue、PR、文档、翻译：

- **贡献指南**：[CONTRIBUTING.md](CONTRIBUTING.md)
- **行为准则**：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- **安全政策**：[SECURITY.md](SECURITY.md)（漏洞私下报告）
- **Issue 模板**：从 [新建 Issue](https://github.com/Noob-stupid/dsh-plugin-hub/issues/new/choose) 页面选择 Bug / 功能建议

---

## 更新日志

版本记录见 [CHANGELOG.md](CHANGELOG.md)。

---

## License

MIT

---

---

## 预览版（实验性 · 请勿用于生产）

分层重构预览线在**独立仓库**：[**`Noob-stupid/dsh-plugin-hub-refactor`**](https://github.com/Noob-stupid/dsh-plugin-hub-refactor)

- **它是什么**：把单体 `lib/index.js`（8547 行）拆成分层结构 —— `lib/index.js` **141 行** + `lib/server/**` **38 个模块**，**功能与 `0.3.57` 等价**，只为可维护性；
- **已验证**：19 套测试全绿 · 8 条架构守卫断言 · 与稳定版逐条对打**路由清单一致**（`status` + 响应字段）；
- **已实测**（2026-09-20 真装真卸演练）：普通插件 / bundle 插件 / 无 npm 仓库 / 套装 / 技能 / 聚合仓库子包 / 仓库落地 / 服务器组件启停；
- **尚未实测**：真框架升级 / 真回滚、重启守护链路、AI 真跑、Gitee OAuth 回调（长尾风险主观估计 **10%~25%**）；
- **日常使用请继续用**：npm `@noob-stupid/dsh-plugin-console@0.3.59`，或本仓库 `main`。
- 请多反馈问题
