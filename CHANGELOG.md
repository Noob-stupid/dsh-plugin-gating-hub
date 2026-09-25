# Changelog

All notable changes to dsh-plugin-hub.

## v0.5.8 — 老框架兼容加固：子插槽不存在时静默降级（2026-09-25）

用户提问「老框架装我们这版会不会出问题」后自查 + 加固：

- **风险点**：新增的「升级安全」入口注册进**官方插件管理页声明的子插槽** `plugins.bundle.config`。
  老版本框架里这个插槽可能根本不存在；若注册抛错且冒泡到 `apply()`，会连带把原来的「插件」tab 一起拖没。
- **加固**：该注册包 `try/catch`，插槽不可用时只跳过这一个入口（`ctx.logger.debug` 记一笔），其余功能照常。
- **自查结论（无框架 API 依赖）**：服务端**零运行时依赖**（`dependencies: null`），只用文件系统 + pnpm + 我们自己的路由；
  客户端 `inject` 声明的是 `dsh-client-runtime` / `-locale` / `-ui-settings` —— 与老版本「插件」tab 用的是同一套，没引入新面。
- **未验证**：尚未在**真实老版本框架**上实测（见待办：用 clean-install 门槛跑一个旧框架 + 本插件的矩阵）。

25 套测试全绿。
## v0.5.7 — 升级脚本 `//` 注释修复 + 「关闭这条记录」（2026-09-25）

**修：升级脚本异常终止（真机证据）**
`%TEMP%\fw-upgrade-10000.ps1` 第 94–96 行是 **JS 风格注释 `// …`**（生成器里写错了注释符号），
被原样写进 PowerShell → PS 把 `//` 当命令名执行 → `无法将"//"项识别为 cmdlet…` → 脚本异常终止，
面板留下一条吓人的失败记录（而框架本体其实已经升级成功）。
- `infra/fw-integrity-check.js`：三行 `//` → PowerShell 注释 `#`
- 新增护栏断言：生成脚本里**不允许出现以 `//` 开头的行**（PowerShell 语法解析查不出这类错误——裸命令是合法语法；已做双向验证：旧代码 FAIL / 修复后 PASS）

**新：「关闭这条记录」按钮**
升级记录常驻是设计（方便回看步骤），但用户需要能一键关掉。
- 新路由 `POST /plugin-console/framework-status-clear`：删状态文件与心跳（**不动日志**，`fw-upgrade.log` / `fw-relaunch.log` 仍在 `~/.dsh/plugin-console`）
- 框架面板记录区新增按钮（中/英文案），点击后界面立刻显示「还没有升级记录」

25 套测试全绿。
## v0.5.6 — 图标视觉尺寸微调（2026-09-25）

官方插件列表按整框渲染图标，我们的盾牌图形占满 512 视口 → 同一排里看起来比别的插件大一圈。
现把图形整体内缩到 **0.72**（四周约 28% 内边距），视觉尺寸与同排插件一致。

- `icon.svg`：包一层 `translate(256 256) scale(0.72) translate(-256 -256)`（只改内边距，图形本身不变）
- 25 套测试全绿
## v0.5.5 — 专属图标（官方插件页显示自家标记）（2026-09-24）

之前官方插件页里我们那一行显示的是 DSH 默认图标，而同为第三方的 `@linxin666/dsh-web-all` 显示自家标记。
查清原因：官方页渲染 `row.meta?.icon`，而 web-all 在 `package.json` 顶层声明了 `icon: "icon.svg"` 并随包发出 —— **我们没声明**。

- 新增包根 `icon.svg`（512 方形、单色 `#4d6bfe`、盾牌 + 闸门意象）
- `package.json` 顶层新增 `"icon": "icon.svg"`（与 web-all 同写法）
- `files` 白名单补 `icon.svg`（否则不随 npm 包发出；`npm pack` 预演已确认带上）
- 25 套测试全绿
## v0.5.3 — 收起面板不再"自动弹回上次的面板" + README 界面一览（2026-09-24）

- **修**：点「框架升级 / 回滚」（就地打开）→ 关掉弹窗 → 收起面板 → 再展开，弹窗又自己弹出来。
  根因是收起时没清掉「就地分区」状态，内嵌控制台重新挂载时按它又打开了一遍；
  现在 `toggleOpen()` 收起即清 `section`，同一个分区按钮再点一次可收起
- **文档**：README 新增「Screenshots · 界面一览」（官方插件页入口 / 升级安全面板 / 框架升级回滚 / 门控明细），
  中文说明 + 英文 caption
- 门控面板里「当前待适配：N 行」重复显示**保留**（用户要求：作为强调）
- 25 套测试全绿
## v0.5.2 — 软件源弹窗秒开 + 运行模式面板就地展开（2026-09-24）

- **软件源弹窗不再"正在读取插件…"干等**：挂载时就把整份源配置缓存下来，打开弹窗直接渲染缓存
  （右侧「功能包」里的软件源一直很快，就是因为它复用已取到的数据）；无缓存时才请求，且带 15s 超时 + 可重试
- **运行模式面板改成「功能包」那种就地展开**（Q 弹 cubic-bezier(.34,1.56,.64,1)、背景深一号、箭头旋转），
  不再走右侧固定浮层；图标由 emoji 换成 16px 线条 SVG
- **默认运行模式 = 观察者**（只守门、不接管框架升级）；**一旦走了本控制台的框架升级，自动切回托管**并记录原因
- 新增「补声明」：把「已装但未声明」的插件写进 profile 清单（plan / apply 两步，可回滚），
  修掉「官方插件页看不见 / 被 pnpm 还原 / 被清理判据当孤儿」这同一根因
- 入口挂在**官方插件管理页自己的插槽** `plugins.bundle.config`（key=包名）——官方容器与风格，无 DOM 注入

验证：25 套测试全绿。## v0.5.1 — 环境指纹精度补丁（2026-09-24）

> clean-install 门槛在 0.5.0 上实测到：隔离实例里 `/compat-status` 的指纹 `pnpmEntities=null`
> —— `@deepseek-ai/dsh` 解析到了 `.pnpm/@deepseek-ai+dsh@…/node_modules/…`（实体内部），
> 直接 `dirname(dirname())` 会停在 `.pnpm` **里面**，数不到包数。

- `routes/compat.js`：向上逐级找「含 `.pnpm` 的那一层」作为框架运行时根（最多 6 级），
  顶层投影与实体内部两种布局都能数到包数；找不到时退回原值，不猜
- 影响面：仅环境指纹里的「框架树包数」这一项更准确（它用于判定「半装/损坏」类环境变更）
- 25 套测试全绿；门槛对新版本复跑
## v0.5.0 — 官方互操作 + 门控常驻化 + 官方风格入口（2026-09-24）

> 起因：官方「设置 → 插件」已经支持自定义/内网安装源，并且**桌面端即将自带升级器**。
> 本版把重心从「装插件」整体挪到「升级安全」：门控不再寄生在我们自己的升级按钮上，
> 而是由**环境指纹变化**触发 —— 官方升级器升的、手动 pnpm 升的，一样守得住。

### 安装即声明（根治三现象同一根因）
我们的安装通道此前只写 `dsh.profile.bundles` 与补丁行，**从不写 `dependencies`**，于是：
① 官方「已安装」分区看不见我们装的包；② 任何一次 pnpm 操作按清单还原它；
③ 连我们自己的「清理残余」都把它当孤儿（实测差点删 7 个在用插件）。现在四条安装收尾路径
（bundle / 已由聚合包提供 / 已由条目提供 / 普通插件）全部「装到哪版声明哪版」，卸载确认包没了才撤销，
自更新通道补写清单 spec（防止下一次 pnpm 把它降级回去）。

### 门控常驻化
- `domain/compat-state.js`：运行模式（**托管 / 观察者**，默认托管=行为不变）、**环境指纹**
  （框架版本 + 运行时位置 + 框架树包数）、回滚点可用性（记录在但树没了 → 如实报不可用）
- 新接口：`GET /compat-status` · `POST /compat-mode` · `POST /compat-stamp`
- 触发源换成指纹变化：官方桌面端自带运行时（换了安装根）同样会被发现

### 契约规则库（可 PR）
- 数据：`lib/contracts/rules.json`（随包发布），文档：`docs/contracts/README.md`
- 5 条真实事故规则：V3→V4 消息来源契约、schemastery `.volatile()` 依赖 API、预设 `persona.text→prefix`、
  `dsh-settings` 命名空间 API 移除、补丁层顶层数组契约；每条带真实报错原文与实现位置
- 预检响应带规则覆盖率；规则文件缺失时如实回报 `unavailable`，**不伪装成「零发现」**

### 官方风格「升级安全」入口（纯加法）
在官方插件页新增第二个 tab（`settings.plugins.tab` id=`console-safety`，order=21）：
模式开关 / 框架版本 / 回滚点 / 环境指纹变更（一键记为基线）/ 一键适配（复用契约预检），
并把控制台各功能**就地展开**。**原 tab 与原悬浮面板一行未动** —— 官方插槽没有切兄弟 tab 的 API。

### 验证
- 25 套测试全绿（新增 test-compat-state 20 项、test-manifest-declare 11 项、test-contract-rules 23 项）
- 发布物核对：规则库位于 `lib/**`（随包发布）；升级无残留（0.4.1 的 8 个文件全在 0.5.0 中）
## v0.4.1 — 预检精度补丁：不扫自己 + 注释不算调用（2026-09-24）

> 发版门槛（隔离 DSH_HOME + 空闲端口 + npm 实装 0.4.0 + 全新真实实例 HTTP 矩阵）跑通后暴露的两处**自噪声**：
> 预检把**控制台自身**也当生产方扫，而它的报错文案与文档注释里本身就含 `kind: 'plugin'`、`.volatile(` 字样，
> 于是每次预检都会多报 2 条无意义 blocker + 3 条提示。

- **扫描面排除控制台自身**：它是工具、不是会话消息生产方（`preflightRoots` 按自身包名跳过）。
- **「已知 API 破坏」规则改走注释掩码**：与 `kind: 'plugin'` 规则同源 —— 注释里提到 `.volatile(` 不算调用。
- 行为无其它变更：两条新路由与清理残余修复与 0.4.0 完全一致；`/framework-check` 的候选列表按「比当前新」过滤，
  已是最新框架时为空属正确结果（门槛断言据此修正）。

**验证**：22 套测试全绿；发版门槛对 npm 实装版本复跑 → 全新实例 181 行挂载、预检实网抓到 `sessionFormatVersion=4`、
清理响应带 `kept/removed`、必定失败包名走完安装流程并干净失败（无 ReferenceError / without inject）。
## v0.4.0 — 分层架构转正 + 升级前会话格式契约预检 + 清理残余修复（2026-09-24）

> 用户拍板「把这个分层架构直接覆盖稳定版，整合后全部发最新版，我的新功能都要有」。
> 这一版把预览线（分层重构，lib/server/**）**转正为稳定线**，并把它与稳定线之间剩余的差异补齐。
> **接口向后兼容**：路由只增不改（新增 2 条），既有 `/plugin-console/*` 行为与响应字段不变；
> 自更新判据是「npm latest ≠ 本机版本」，所以 0.3.67 → 0.4.0 能正常识别并升级。

### 架构：单体 → 分层（转正）
- `lib/index.js` 由 **9,768 行的单体**缩到 **141 行的薄入口**，服务端拆进 `lib/server/**`（44 模块）：
  `domain/`（业务）、`routes/`（表驱动路由装配）、`infra/`（fs/HTTP/路径/语义化版本）。
  分层目标（2026-09-11 定案：先分层、抽包晚点再做）至此在**稳定线**落地，双线维护结束。
- 保留稳定线全部既有能力与元数据：框架升级可选版本列表、门控明细清单、安装后结构完整性校验、
  升级按钮文案联动（0.3.66/0.3.67）、5 条新仓库名索引源（0.3.65）、双语 description/关键词（0.3.64）。
- 测试 22 套（原预览线 20 套 + 新增 2 套）全绿，含架构守卫（分层方向、单文件 ≤600 行、domain 不出现 ctx、
  import 落地与导出核对、包根唯一）。

### 新功能：升级前「会话格式契约预检」（Step 1 + Step 2）
> 起因：2026-09-24 框架 0.1.5-rc.2 → 0.1.7-rc.1 把会话消息格式升到 **V4**（要求被解释消息的 source 带
> producer-owned kind，非空且不等于字面量 `plugin`）。框架自带迁移包只迁移**磁盘上的历史会话**；
> 运行期新消息由本地生产方（agent-presets + 插件 runtime）自己构造，仍写 V3 老形状 →
> **一发消息就报 `format v4 message requires a producer-owned source kind`，整个会话不可用**。
> 包级适配门（peerDependencies / 版本号）看不见这类**运行期契约**破坏，所以必须在升级前单独预检。

- **Step 1 · 契约抓取**：认出会话格式**迁移边**（`dsh-session-format-vN-to-vM`），并给出判定信号
  **「目标版本的迁移边集合比当前版本多出一条」= 一次契约变更**（实网实测 0.1.5-rc.2 → 0.1.7-rc.1：新增 `v3→v4`）。
  发现路径按实网探明：先问 `@deepseek-ai/dsh-session-format-catalog`（该版本全部迁移边挂在它的 dependencies 上），
  缺失才退回扫顶层 `dsh` 依赖；README 走 jsDelivr → npmmirror 多通道兜底；registry 不可达时**降级为内置规则扫描并如实说明**。
- **Step 2 · 生产方扫描 + 一键适配**：扫 `~/.dsh/agent-presets/**` 与 profile 内每个已装插件包
  （跳过 `node_modules`/测试文件/构建产物/pnpm `_tmp_` 残留，限 4000 文件 + 2MB/文件）。
  补丁只改 `kind: 'plugin'` 这个**字面量**且要求同对象里确有 `plugin:` 字段：字符串字面量 → `'plugin:<名>'`
  （命中重命名表则用专名），标识符/成员表达式 → `` `plugin:${表达式}` ``；**无法安全内联的一律只报告不修改**。
  写盘前逐文件备份 `.bak-preflight-*`，且只允许改本次上报名单内的文件。
- **实网读数逼出来的加固**：① 注释掩码（JSDoc 里的 `kind: 'plugin'` 不算代码）；② 框架自带包只报告不改
  （判定用「解析到 profile 之外」**或**「包名落在 `@deepseek-ai/` 作用域」——profile 里手工铺的真实副本
  路径判定认不出来）；③ README 解析收窄到「Message-source conversion」小节且只认表头含 `plugin`/`kind` 的那张表，
  小节定位锚定标题行（目录里有同名条目）；④ 带**探针**的规则：`.volatile()` 类 API 破坏先按文件位置真的解析一次依赖，
  确认那份副本缺该 API 才报，修好后自动静默；⑤ 按规则聚合计数。
- 接口：`POST /plugin-console/framework-preflight`（只读报告）/ `POST /plugin-console/framework-preflight-patch`
  （`mode=plan` 出 diff、`mode=apply` 备份后写回并复扫）。
- 界面：常驻框架面板新增「升级预检」按钮与报告块（放在升级按钮之前，让「先预检、再升级」成为默认路径）。

### 修复：清理残余（用户实测「点清除后 9 项删不掉」）
- **判据修正**：原实现拿旧聚合包 `@linxin666/dsh-web-ui-all@0.3.6` 的 dependencies 当「声明基线」，
  把后来单独安装、**正在用**的插件也判成「未声明旧子包」——实测那次准备删的 9 项里有 7 个是真插件
  （`dsh-i18n` 当时还是**已挂载**的行），真删成的后果是重启后这些行直接消失。
  现在只删能证明是垃圾的东西：`*.old-*` 备份、pnpm `*_tmp_<pid>_<n>` 残留、**当前 loader 无任何行引用**的孤儿包。
- **在用行一律保留**并在响应里回报（`kept`），界面显示「保留在用插件 N 个」。
- **删除器加固**（`removeDirVerifiedAsync`）：清只读位 → `rmSync` → **轮询核实**（容忍 Windows 删除挂起）
  → 失败回退 `cmd /c rmdir /s /q`（POSIX `rm -rf`）→ 再核实。真机诊断证据：同一棵树 Node 的 `rmSync`
  可能「不抛错、目录仍在」，而 .NET/PowerShell 能删掉；旧实现只重试 2 次就报「当前环境可能禁止删除」，
  把用户引向并不存在的权限问题。
- **报错说真话**：失败项带回真实 errno/消息（不再统一替换成一句话），界面直接显示。
- **顺带清真正的「残余备份」**：`~/.dsh/plugin-console/` 下的 `fw-quarantine.json.applied-*`（实测堆积 **375 个**）
  保留最近 2 个、`upgrade-watch-*.log` / `restart-guard-*.count` 超 7 天、`.bak-*` 超 30 天。

**验证**：22 套测试全绿（新增 `test-format-preflight.mjs` 59 项断言、`test-clean-residuals.mjs` 14 项断言）；
实网 registry 契约抓取实测（0.1.5-rc.2 → 0.1.7-rc.1：新增 `v3→v4` 迁移边，规则与重命名表解析正确）；
本机真实 profile 只读扫描 3008 个生产方文件 **0 blocker / 1 提示**（仅框架自带 `dsh-schedule` 陈旧副本）。

## v0.3.67 — 修复：升级按钮文字没跟「自选版本」联动（2026-09-24，用户实测截图发现）

> 0.3.66 的补丁版，**只改一行显示逻辑**，无接口/脚本行为变化。

**现象**（用户截图）：面板里选好 `0.1.7-rc.1` 后，下面的按钮仍显示 `框架升级 → v0.1.5-rc.3`。

**真因**：0.3.66 里「自选版本」改了三处——选择器、升级请求、按钮文字。
前两处在稳定线正确落地，**只有按钮文字那一处漏改**（仍写死 `fwCheck.target`）。
所以选择与实际执行的升级目标都是对的，只有按钮文案不跟着变——**纯显示 bug**，但确实让人以为"选了没用"。

**修复**：按钮文字改为 `(fwSelected ?? fwCheck.target)`，与选择器、请求三处同源。
并补一条客户端接线断言（把按钮改回写死 → 断言立刻变红，已反向验证），防止再漏。

**验证**：稳定线 18 套全绿；断言反向验证（改回错的必红）。

## v0.3.66 — 框架升级可选版本列表 + 门控明细清单 + 安装后结构校验（2026-09-24）

- **框架升级可选版本列表**（用户要求：有的版本都加上，测试版也可以有列表）：面板里的升级目标现在可展开，
  列出 registry 上**所有比当前新的版本**（含 rc/alpha 预发布），每条标渠道（稳定版 · latest / 预发布 · next / 预发布 · alpha），
  默认仍选中 `latest`；自选后升级按钮与升级脚本都按你选的版本走。
  **安全边界**：乱填版本、或选一个比当前旧的版本 → 服务端 400 拒绝且**不生成升级脚本**（降级请用「回滚到上一版」）。
- **门控面板显示「具体是哪些插件」**（用户要求：应该可以显示是哪些，有列表数据）：`/state` 新增 `gating` 明细，
  面板从此不再只有一句数量，而是可展开清单——待适配行带**名字 / 版本 / 原因 / 来源（启动失败隔离 or 升级预扫）/ 时间**，
  并单独列出**已适配解锁**的行（历史上被拦过、现已放行，便于核对）。
- **升级脚本新增「安装后结构完整性校验」**：版本号对 ≠ 装完整。安装完成后逐项验证
  `package.json` 存在 → `lib/bin.js` 存在（顶层或 `.pnpm` 内）→ `dsh --version` 自报版本等于目标；
  任一不过即按**升级失败**处理并走回滚。背景：2026-09-24 一次框架升级的 pnpm 安装被中断，
  顶层 `@deepseek-ai\dsh` 目录整个消失、`.pnpm` 实体只剩几个硬链接——只校验版本号会被这种"半装"骗过。
- 架构：预览线把「拉元数据 + 候选列表 + 目标选择」收进 `domain/framework.js` 的 `resolveFrameworkUpgradePlan()`，
  路由文件回到守卫行数上限之内；新增 `infra/fw-integrity-check.js`。

**验证**：稳定线 18 套测试全绿、预览线 20 套全绿；clean-install 门槛对最终候选两线各 PASS 18/18；
真机 HTTP 实测 `/framework-check` 返回 6 个候选（渠道标注正确）、非法版本两条均 400。

## v0.3.65 — 元数据与默认索引源修正：内网 / 离线能力写进身份描述 + 索引源改到新仓库名（2026-09-23）

> 无功能逻辑变更：一处默认配置修正（索引源 URL）+ 身份描述补全。

- **身份描述补上「内网 / 离线」这条硬能力**（用户指出：这条能力我们早就有，但描述里没人看得出来）：
  仓库描述、npm description、中英 README 首屏现在都写明——安装源 / 搜索源 / 索引源 / Git 源**四类源全部可自定义**，
  可指向公司内网私有 registry、内网自建索引、`file://` 本地裸仓库，**纯内网或断网环境照样浏览与安装**。
- **修默认索引源仍是旧仓库名**（`dsh-plugin-hub` → `dsh-plugin-gating-hub`，5 条：jsDelivr cdn/gcore/fastly、ghproxy、raw）：
  旧路径在 jsDelivr 上命中**旧缓存**，实测拿到的 `marketplace/index.json` 的 `generatedAt` 落后一天（2026-09-22T15:49Z），
  而新路径与 GitHub `main` 一致（2026-09-23T02:01Z，556,993 B）。默认索引源本该**始终**是最新的那份。
  5 条源逐个实测：cdn / gcore / fastly / ghproxy / raw 新路径全部 200。
- 内务：测试文件收进 `tests/`（根目录 tracked 32 → 13），CI 路径同步；发布物不含 `tests/`。

**验证**：19 个测试文件全绿（18 套 + suite-detect）；clean-install 发版门槛对**已发布 0.3.64** PASS 17/17；
本版对 0.3.64 的差异为 `package.json`（描述/版本）+ 5 条索引源 URL + README 文案，`lib/index.js` 除索引源数组外无改动。

## v0.3.64 — 元数据版：npm 描述/关键词中英双语 + repository 指向新仓库名（2026-09-23）

> 纯元数据与检索可见性改进，**不含功能变更**（代码与 0.3.63 相同）。

- **npm description 改为中英双语**，补上用户实际会搜的词：`一键框架升级失败自动回滚` / `one-click framework upgrade with auto-rollback`、
  `插件升级门控` / `version gating`（此前只有英文 `one-click framework upgrade`，中文用户搜"框架升级/回滚"匹配不到）。
- **keywords 扩充到 14 个**（npm 搜索按 keywords 加权）：`dsh-plugin`、`dsh-plugins`、`deepseek-harness`、`plugin-manager`、
  `plugin-market`、`plugin-console`、`marketplace`、`framework-upgrade`、`rollback`、`auto-rollback`、`插件市场`、`框架升级`、`自动回滚`。
- **`repository` 字段改为新仓库名** `https://github.com/Noob-stupid/dsh-plugin-gating-hub`（旧名 301 跳转仍有效；
  社区目录站 dsh-plugin.org 会做 repo→npm 反查，旧名可能被判定"信息不一致"）。
- CI 内务：`npm-check` 工作流的"某版本是否存在"改为**只报告不失败**（核查未发布版本属正常中间态，不该刷 failed 通知）。

**验证**：18 个测试文件全绿；clean-install 发版门槛对 0.3.63 已 PASS 17/17（本版代码与其一致）。

## v0.3.63 — 修「安装后依赖规格被改写成不存在的 npm 版本」（缺陷②，潜伏性数据一致性缺陷）（2026-09-22）

> **本版 = 0.3.62（注入缝 `ctx.get` 修复）+ 缺陷②修复 合并发布。** 0.3.62 已提交（`c3cd8d8`）但发布环节被打断
> （未 push / 未打 tag / 未发 GitHub Release / npm 上也没有），因此两者合成一次发布，版本号递增到 0.3.63。
> 如果你在 0.3.59~0.3.61 上装过「只发 GitHub release、没有发 npm」的插件，**请务必升级** —— 见下面第 ② 节。

### ① 注入缝改用 `ctx.get`（即 0.3.62 的内容，随本版一起交付）

- `channelImpls(ports)` 改为**优先 `ctx.get('installChannels')`**（Cordis 的正规可选读取，未声明也不抛），
  普通对象（测试替身/窄接口）才回退属性访问并 try/catch 兜底。属性式读取未 inject 的名字在真实 cordis ctx 上
  会**同步抛** `cannot get property "installChannels" without inject` —— 这正是 0.3.59「每次安装都失败」的根因。
- 新增 `strict-ctx.mjs` 严格测试替身（未 inject 的名字只能 `ctx.get` 读，属性访问抛错并记账本），
  `test-suite-detect.mjs` / `test-suite-install.mjs` 全程改用，杜绝「替身与真实运行时语义不一致」这类漏网。
- 详见下面 v0.3.62 一节。

### ② 依赖规格写回：release 来源的包不再被改写成「不存在的 npm 版本号」

**现象（用户 issue 草案「缺陷②」，附实测）**：release 通道（从 GitHub release 的 tarball 装、npm registry 上
并不存在的包）安装完成后，`<profile>/package.json` 里该依赖的 specifier 被改写成**裸版本号**
（例：`"@dsh-external/dsh-super-injector": "0.3.3"`），而该包 `npm view` 是 **404**。
现在能跑只是因为 `pnpm-lock.yaml` 里还留着 tarball URL 的解析；**一旦 lock 被重建**（删 lock、清
`node_modules`、换机、CI 重装）→ `ERR_PNPM_FETCH_404`，而报错指向 npm registry，用户根本联想不到是几周前
面板安装改写造成的。**装完完全看不出问题**，属于最阴的一类潜伏性缺陷。

**根因（明确结论：是 0.3.57 引入的回归）**：写回者不是 release 通道本身（`githubReleaseInstall()` 只解压落盘、
从不碰 manifest，全仓库也没有任何 `manifest.dependencies[...] = …` 赋值），而是 **0.3.57 新增的 lock 对账
`reconcileLockfile()`**：它对每个漂移包执行 `pnpm add <name>@<installed>`。对 registry 上不存在的包，pnpm
发现「已装版本满足新 spec」就**静默**把 specifier 改写成裸版本号 —— 实测输出 `Already up to date`、
**EXIT=0**，面板据此报 `lockUpdated=true`（成功），用户毫无察觉。
首次引入该函数的提交是 `962c7e5`（`git describe --contains` = `v0.3.57~1`）。

**修法**：
- 写回 spec 前**先探 registry**（`probeRegistryPackage()`，多镜像 + 超时兜底）：确认「这个包的**这个版本**」
  可解析才写 `<name>@<版本>`（registry 来源写版本号本来就是对的，不误伤正常包）；
- 查无此包（404）→ **绝不写裸版本号**：把已装副本物化到 `<DSH_HOME>/plugin-src/<包名>`，specifier 写
  **`link:<该绝对路径>`**；
- 为什么不用 tarball URL（issue 的方案 A）：**实测 pnpm 10.34.5 对 direct-URL 依赖只在冷缓存真下载时记
  `integrity`**，命中缓存重写 lock 时写出的 `resolution: {tarball: <url>}` **没有 integrity** →
  `ERR_PNPM_MISSING_TARBALL_INTEGRITY`，而且 pnpm 会把 lock 文件**直接删掉**（profile 变无 lock 状态），
  形成「删 lock 修不好、不删 lock 装不动」的死循环。`link:` 只建符号链接，不经 registry 解析、不经 tarball
  完整性校验，实测 8 个场景（删 lock / 删 lock+node_modules / `--frozen-lockfile` / 加装别的包 / 重复对账…）
  全部通过；
- **已污染状态自愈**：识别「manifest 是裸版本号 + lock 解析到 URL」这一指纹，自动规整为 `link:`；
- **顺带修一个被掩盖的老 bug**：`lockVersionOf()` 解析 importers 段时遇到 `specifier:` 行就 `break`，
  导致它从来没读到过 `version:`（一直靠 packages 段兜底），而兜底正则用 `[^':\s]+` 取值，遇到
  `name@https://…tgz` 会截断成 `http`、link 依赖干脆读不到 → 来源钉住的包被判「永久漂移」，
  每次安装都白跑一次 `pnpm add` 并给用户一条假的「没写进 lock」警告。

**用户可见说明**：走 `link:` 这种非常规形式时，安装结果里带一条明确 note（面板直接展示）：
「该包只存在于 GitHub release，已按 link: 形式记录依赖（`link:<路径>`）—— 不经 npm registry 解析、
不经 tarball 完整性校验，pnpm 重建 lock 也能装上」。

**实测对照**（真 pnpm 10.34.5 + 真 corepack，临时 profile；详见 `D:\dsh\dsh-plugin-hub-plan\refactor-bugs.zh.md` 第 23 节）：

| 步骤 | 修前 | 修后 |
|---|---|---|
| lock 对账后 specifier | `0.3.3`（裸版本号，pnpm `Already up to date`、EXIT=0） | `link:<DSH_HOME>/plugin-src/@dsh-external/dsh-super-injector` |
| 删 lock + node_modules 后 `pnpm install --no-frozen-lockfile` | ❌ `ERR_PNPM_FETCH_404`（报错指向 npm registry） | ✅ 成功（`--frozen-lockfile` 亦通过） |
| 重复对账 | 每次再改写一次（永久漂移） | 幂等：判为已对齐，不再跑 `pnpm add` |

- 另外修掉本次改动自己会引入的一个隐患：`"pkg": "latest"` 这类 **dist-tag 规格**必须保留标签，写成 `<name>@latest`；绝不能把裸 `latest` 丢给 `pnpm add`（那会去装一个名叫 `latest` 的包）。
- 又补一条**链接有效性**护栏：`link:` 依赖若被 release/curl 通道的"先 rmSync 再 copyTree"换成了真实目录，`lock` 里仍是 `link:`、版本号看不出差异 —— 下一次 pnpm 操作就会按 lock 重建链接、把刚更新上去的版本**还原**成 `plugin-src` 里的旧副本（与 0.3.56 修过的自更新缺陷同族）。现在对账会检测"链接是否真的还指向目标"，不成立就重新物化（把新副本刷进 `plugin-src`）再重放 `link:`（实测能把链接与版本一起恢复）。
- 18/18 测试全绿（含新增 17 条缺陷②断言：registry 404 桩 → 断言写回 `link:`、registry 可解析 → 仍写版本号、
  git 来源不被改写、已污染自愈、link 已对齐不白跑 pnpm）。

## v0.3.62 — 注入缝改用 `ctx.get`（方案 A）+ 假 ctx 换严格替身（2026-09-22）

> 承接 0.3.60/0.3.61 的抢修。那两版只是用 try/catch **兜住症状**，本版按 issue 草案把修法与根因一起做扎实。

- **① 注入缝语义修正（草案方案 A）**：`channelImpls(ports)` 改为**优先 `ctx.get('installChannels')`** ——
  Cordis 的正规可选读取，未声明也不抛，与同文件 `ctx.get('subagents')` / `ctx.get('agents')` /
  `ctx.get('skills')` 等 5 处既有写法一致；普通对象（测试替身/窄接口）才回退属性访问，try/catch 保留。
  属性式读取未 inject 的名字在真实 cordis ctx 上会**同步抛** `cannot get property "installChannels" without inject`。
  草案第一条建议（把"同文件其它 5 处都写对了"列为佐证）正是选 A 的依据：这不是风格问题，是新加的这处偏离了既有约定。
- **② 测试替身现在会校验未声明属性（真正杜绝同类回归）**：新增 `strict-ctx.mjs` —— 复刻 cordis 语义的严格替身：
  `inject` 声明过的名字可属性访问；只 provide、未 inject 的名字**只能 `ctx.get` 读**，属性访问抛
  `cannot get property "X" without inject` **并记入账本**（即使异常被 try/catch 吞掉也留痕）。
  `test-suite-detect.mjs` 新增 ⑯ 节、`test-suite-install.mjs` 全程换用它，并断言"整条安装路径账本为空"。
  实测演示：把注入缝改回属性访问 → 两条用例立刻红（`race=false` + 账本记下 `installChannels`）。
  草案第二条建议（把"单测为什么没拦住"写进去）落实为这条防线：根因是**替身与真实运行时语义不一致**，
  只改那一行代码，同类缺陷还会再来。
- **审计**：`ctx.` / `ports.` 的属性式访问逐个对照 `inject = ['webServer','loader']` 与本对象实际形状 ——
  除本处外全是 `loader` / `webServer`（已 inject）、`baseUrl`（Context 的 own property）、`effect`（原型方法）
  与 `ctx.get(...)`（不校验 inject），无第二处隐患。
- 18/18 测试全绿（逐文件单独跑）。

## v0.3.60 — 紧急修复：安装通道注入缝读到了 cordis ctx，导致每一次安装都失败（2026-09-22）

> **如果你在 0.3.59 上装插件报 `cannot get property installChannels without inject`，请立刻升级到本版。**

- 根因：为单测加的"通道实现注入缝"写成 `ports?.installChannels`，而**生产路径上 `ports` 就是 cordis 的 `ctx` 代理**——
  访问未在 `inject` 里声明的属性会**同步抛错**，于是每次安装都在进入通道前就失败（面板显示"操作失败：cannot get property installChannels without inject"）。
  预览线不受影响，因为它传的是 `routeDeps()` 出来的纯对象，所以这个错误只在稳定线（单体版）出现 —— 这正是"越改越坏"的那一处。
- 修复：注入缝的读取改为 try/catch 兜底（读不到就用真实实现），并加注释说明为什么不能直接访问 ctx 属性。
- 测试：18 个测试文件全绿；另核对单体版 `channelImpls(ctx)` 在生产路径下会安全回落到真实实现。

**教训（写进代码注释）**：给测试留的注入缝，绝不能挂在 cordis 的 ctx 代理上——要么走显式参数，要么兜住访问异常。

## v0.3.59 — release 通道学会「按包名反查真正发布它的仓库」；并修掉 0.3.58 引入的一处回归与竞速通道的永不结算（2026-09-22）

> 承接 v0.3.58 的 issue 修复。这一版把 issue 的 #3 做完了，同时修掉两处**必须尽快发**的缺陷。

### 修复
- **回归（0.3.58 引入，务必升级）**：候选循环里 `repoChannelAllowed` 的声明写在 `const name` **之前**，
  触发 TDZ `ReferenceError` —— **私有聚合根 + 前端带包名的安装必然失败**（正是本 issue 的场景）。已修。
- **并行竞速通道「永不结算」**：该通道只有「成功」与「120 秒兜底」两个出口，pnpm 与 curl **两条都秒失败时
  没有出口** → 每个候选白等满 120 秒（3 个候选 ≈ 6 分钟就吃光作业预算，然后掉进 AI 授权再等 10 分钟）。
  现补第三个出口（两条都 settle 即收工）并清理兜底定时器；`test-suite-install.mjs` 从 **8 分钟以上降到 6 秒**。

### 新增能力（issue #3）
- **release 通道按包名反查真实发布仓库**：显式 repo → 已装包 `package.json.repository` → npm registry 元数据 →
  GitHub 搜索（先 `scope name` 再裸名）；再**遍历 ≤10 条 release 的全部 assets**、按包名匹配挑选
  （`@scope/pkg` ↔ `scope-pkg-1.2.3.tgz`/`pkg-1.2.3.tgz` 等大小写/下划线/版本变体，精确匹配优先、版本高优先）。
  成功时在面板写明「哪个仓库 / 哪条 release / 哪个 asset」，失败时把**尝试过的仓库与资产清单**写进错误。
  硬预算：总 20 秒、只扫前 3 个候选仓库、release 不翻页。
- 落盘前仍走**盒子验证**（包名 / 入口 / 依赖引用），不通过不装。
- 守卫收尾：curl 与并行竞速不再受 `!expanded` 限制；release 不再受 `subpackageMode` 限制（改为按包名施工 + 预算）；
  git 通道保持「只对根包」+「展开后不再重复尝试」。

### 真实验证（只读，未真装）
- `@dsh-external/dsh-super-injector` → 反查到 `yjh051108/dsh-super-injector`，选中 release `v0.3.5` 的
  `dsh-external-dsh-super-injector-0.3.5.tgz`（358.2 KB）→ 解压校验 name/version/main/`dsh.bundle.patch` 全部通过，
  耗时 6.5~7.1 秒；失败路径（无仓库的包）会明说「也没能反查到候选仓库」。
- 子包发现（v0.3.58 起）：`yjh051108/dsh-routing-suite` 能列出 3 个子包（`injector/`、`graded/`、`preset/`），旧白名单命中 0。

- 顺带修：本机 release 产物**直连下载不可用**（SSL exit 35），而同一 URL 经镜像正常 → 已加「直连优先 + ghproxy/ghfast 兜底」（总 70 秒封顶）；
  `releaseInstallTarget` 在开发检出下的目标目录判据加固（避免往检出父目录写包）。

测试：18 个测试文件全绿（总 28.6 秒）。

## v0.3.58 — 安装通道不再连坐：private 根 + 带包名也能走 git/release/curl，子包发现弃用目录白名单（2026-09-21）

> 来自用户 issue（附逐条实测）：根包 `private: true` 且前端带了包名时会置位 `subpackageMode`，同一个守卫把
> curl / GitHub release / git 三条通道一起跳过，只剩 npm 通道 404 —— 明明 UI 推荐的 `dsh plugin add github:owner/repo`
> 从未被尝试，最后被拖进约 4 分钟的 AI 兜底。

- **守卫语义修正**：`subpackageMode` 只表达「优先装子包」，不再表达「禁止其它策略」。并行竞速与 curl 通道
  （按包名走 registry，与根包是否 private 无关）对子包候选一并开放；release / git 通道（按 `job.repo` 施工）
  只在「候选就是被请求的那个包」时尝试 —— 既修掉连坐，又保留「别对聚合仓库的 private 根做无意义尝试」的原意。
  放开后即使失败也会留下 `lastError`，排查信息才完整。
- **子包发现弃用目录白名单**：原来只认 `packages|examples|plugins|skills|apps|extensions|src|lib` 下的
  `package.json`（本 issue 仓库的子包在 `injector/`、`preset/`、`graded/` → 命中 0 条；trees 接口本身正常，
  是本地正则把候选全过滤掉了）；现改为**任意深度 ≤2 的 `package.json`**（排除 `node_modules`），仍聚合包优先、上限 24。
- 测试：18 个测试文件全绿。

**尚未做（下一步）**：按包名反查真实发布仓库 + 遍历 release assets 挑选匹配包（issue #3，本例真正解法的来源）、
git-hosted 包自动写 `onlyBuiltDependencies`（issue #5，pnpm 10.34+ 要求带完整 URL 的精确 spec）。

## v0.3.57 — 所有安装通道都对账 lockfile：装上的插件不再可能被 pnpm 静默还原（2026-09-21）

> 与 0.3.56 的自更新修复同源。起因是用户实测报告：一键更新/兜底通道只把文件铺进 `node_modules`、
> 不写 `pnpm-lock.yaml`，而 profile 依赖由 pnpm 按 lock 管理——之后任何 pnpm 操作（开关插件改
> `dsh.profile.bundles`、`dsh plugin add/remove`）都可能把包**还原成 lock 里的旧版本**、甚至当外来物处理。

- **装完必对账**：新增 `reconcileLockfile()`，覆盖**所有**非 pnpm 通道装出来的包——并行 curl / curl tarball /
  GitHub Release / git 装配、**套装装配出的普通插件**（`copyTree`）、**聚合包补装/对齐的子包**：
  ① 版本与 lock 一致 → 直接返回（不跑 pnpm，零成本）；② 有漂移 → **一次** `pnpm add <包1>@<v1> <包2>@<v2> …`
  把漂移包全部写进 lock；③ 仍对不上 → 面板**如实告警**（逐包列出"装了 X／lock 里是 Y"）并给出可复制的
  `dsh plugin --profile <profile> add <包>@<版本>`，不再假装成功。
- 安装结果视图新增 `lockUpdated` / `lockVersion` / `lockNote`；客户端在安装成功提示里显著追加 ⚠️ 警告。
- 与 0.3.56 的自更新修复配套：**面板能改的东西，都不会再留下"装上了但不在 lock 里"的静默不一致**。

**如实说明覆盖边界**：技能（`~/.dsh/skills`）与 agent 预设（`~/.dsh/.agent-presets`）**不由 pnpm 管理**，
本就不需要写 lock；受 pnpm 影响的是 `node_modules` 里的包，本次已全覆盖。

**验证**：18 个测试文件全绿（新增 4 条离线断言：一次 pnpm add 传数组 spec、对齐后逐包 aligned=true、
对不上逐包说清并给命令、失败包 aligned=false 不谎报）。另做了真 pnpm 实验确认机制：lock 钉 1.2.0 + 手铺
1.3.0 → `install` / `add 另一个包` / `install --force` 均不覆写（本机 pnpm 11.21.0），
说明"静默不一致"是普遍存在但发作依赖环境的隐患——本版把它从根上消掉。

## v0.3.56 — 一键更新现在会写进 lockfile：升级不再被 pnpm 还原（2026-09-20）

> 版本号说明：`0.3.55` 首次发布时被 npm 的暂存发布流程拦下（409 Cannot publish over previously
> staged version），重发改用了 `0.3.56`；随后 `0.3.55` 也由该流程自动发布，两者内容相同，
> npm 的 `latest` 已指向 `0.3.56`。
>
> 来自用户实测报告（附完整时间线与复现步骤）：一键更新把文件铺进 `node_modules`、**没动 `pnpm-lock.yaml`**；
> 而 profile 的依赖由 pnpm 按 lock 管理（`dsh plugin` 本身就是 pnpm 的薄转发器），所以之后任何一次 pnpm 操作
> ——开关插件（改 `dsh.profile.bundles`）、`dsh plugin add/remove`——都可能按 lock 重装，把刚升上去的版本
> **还原**成 lock 里钉住的旧版本。用户侧现象：UI 一直提示有新版、点更新显示成功、重启后还是旧版。

- **自更新改为「包管理器优先」**：spec 是版本范围 → 先 `pnpm update <pkg>`（spec 不变、同步把 lock 提到范围内最新）；
  仍没到最新（超出范围 / spec 是 git·file 来源）→ `pnpm add <pkg>@<版本>`（spec 与 lock 一起改写，并在提示里说明来源切换）。
- **回读核实再报成功**：响应新增 `method` / `spec` / `installedVersion` / `lockVersion` / `lockUpdated` / `lockNote` /
  `command` / `errors`；手铺 tarball 降级为**最后兜底**，且必然带「此更新未写入 pnpm-lock.yaml，之后任何 pnpm
  操作都会还原它」的醒目警告与可复制的 `dsh plugin --profile <profile> add <包>@<版本>`。
- 面板提示同步：`lockUpdated === false` 时把警告**显眼**拼进结果提示，不再让人以为升级成功了。
- 附带解决报告里另一处不一致：`package.json` 的 spec 与 lock 长期不一致，导致「检测更新」一直提示一个
  落不了地的版本——走 pnpm 路径后两者同步。

**验证**：真 pnpm（本机用的是 corepack 里的 pnpm 11.21.0）端到端跑产品自己的 `selfUpdateToLatest()`：
把 fixture profile 里的控制台从 `0.3.53` 升到 `0.3.54` → `method=pnpm-update+pnpm-add`、`lockUpdated=true`、
`lockVersion=0.3.54`；随后再触发重装与 `pnpm install --force` 强制重链，**仍是 0.3.54 且 lock 一致**。
如实说明：**本地没能复现"被还原"这一步**（pnpm 11 对本机手铺的文件在 install/add/--force 下都不覆写），
报告方的证据是其环境里的 lock 重写时间戳与框架备份记录；修复的价值在于让 lock 与安装版本**始终一致**，
并在此前不可能察觉的兜底路径上给出明确警告。18 个测试文件全绿（含 8 条新断言）。

## v0.3.54 — 真装真卸演练修出来的一整批：删除不再谎报、装完未重启也能撤、失败清场、聚合进度（2026-09-20）

> 这一批全部来自 2026-09-20 的**真装真卸演练**（拿本机没有的插件真装真卸：普通插件 / bundle 插件 /
> 无 npm 仓库 / 套装 / 技能 / 聚合仓库 / 仓库落地 / 服务器组件），不是纸面推断。

- **删除不再谎报**：`/skill-remove`、`/clean-residuals`、`/repo-remove`、克隆重试前清理、装包前清旧目录
  一律改为「删完**核实**再报成功」。本机实测同一个 `rmSync` 在 `D:\` 删得掉、在 `C:\Users\…\.dsh\…` 与
  `%TEMP%` 下会**静默落空**（不抛错、目录还在），旧代码删完直接 `{ok:true}` → "技能删了还在""残留清理
  假装清干净"。现在删不掉就如实报错并给出目录路径；装包路径宁可直接报错，也不把新包合并进旧目录。
- **克隆失败说人话**：多源重试的失败汇总带上 **git 自己说的原因**（stderr 末两行，如 `HTTP 502`、无法解析
  主机）；半成品目录**清不掉时停止重试**并写明"目录清不掉、多源重试无效、请手动删除"，不再让第二个源报
  一句没信息量的"目录非空"（套装子模块失败就是这么被掩盖的）。
- **装完未重启也能撤**：`POST /uninstall` 现在同时接受 `{entryId}` 与 `{jobId}`；`GET /state` 新增
  `pendingRestart`，面板把"已安装但运行中的 DSH 还没加载"的插件显示成 **「已安装·重启后生效」** 行，
  删除按钮直接撤销这次安装（补丁行 / `dsh.profile.bundles` / 包目录三处各自回读核实，删不干净如实告警）。
- **失败清场**：安装走到"等本地 AI 兜底授权"后取消/超时失败时，**自动清掉本次落盘的包目录与 pnpm `_tmp_`
  半成品**，错误里写清「已清理 X / 未能清理（请手动删除：路径）」——不再有"面板说失败、磁盘上却留着半个包"。
- **聚合安装看得见进度**：装多子包聚合仓库时显示「正在装第 i/n 个子包：<名字>」；确定性通道全失败、需要你
  授权跑本地 AI 兜底时，进度位置出现**带倒计时（剩余 mm:ss）的授权卡**（同意 / 取消），不再让人对着不动
  的进度条干等 10 分钟然后失败。套装通道同样有「clone 第 i/n 个子模块 / 装配第 i/n 个组件」进度。
- **`@scope/all` 也认作聚合包**：「聚合包优先」判据补 `/all$`（`@dsh-suite/all` 这种 scope 根形式的聚合包
  以前命中不了，纯靠目录顺序碰巧排前面）。
- **报错文案不再借用别人的包名**：私有根仓库安装失败时，示例改成 `<子包名>` 占位 + 该仓库自己的 git 规格
  命令（以前写死 `@linxin666/dsh-web-all`，任何无关仓库报错都让用户去装别人家的全家桶）。

**验证**：18 个测试文件全绿；真装真卸演练逐类跑通并复原基线（`node_modules` 逐项一致、`cordis.patch.yml`
sha 一致、`/state` 条目数一致）。

## v0.3.53 — 外观回退为一颗 pill；GitHub 登录改走设备码（dsh-github-login 窗口），Token 作兜底（2026-09-20）

- **外观回退**：市场页恢复成原来**一颗** pill（显示「已登录 GitHub：<login>」/「未登录 GitHub」+ 点开搜索源菜单），
  不再单独一颗登录徽章；登录相关入口收进那颗菜单里。
- **登录优先走设备码**：新增 `POST /plugin-console/github-open-login` —— 代理调用已安装插件
  `dsh-github-login` 的 `POST /github-auth/open`（它用 GitHub Device Flow，在 **GitHub 官方页面输账号密码/验证码**），
  并顺带透传 `/github-auth/status`；客户端点「GitHub 登录」后**每 2s 轮询** `/state`，最多 60s，
  登录成功即提示「已登录 GitHub：<login>」。
  为什么必须轮询：授权在另一个进程/窗口里完成，本插件收不到回调。
  该通道**永不 500**：插件没装 / 路由不可达 / 平台不支持 → 回 200 + `started:false` + 可读 `reason`，
  客户端据此**自动回退到 Token 粘贴**（上一版的 `POST /plugin-console/github-login` 保留）。
- 为什么不能"输账号密码"：GitHub 自 2020 起禁止第三方应用用密码换 token，正规方式只有 Device Flow /
  OAuth 跳转授权（都需要注册过的 client_id）与 PAT；`dsh-github-login` 复用的是 GitHub CLI 的公开 client_id。
- 路由数 47 → 48（测试清单与弱断言同步）。
## v0.3.52 — 子包列表「读不到」不再说成「不存在」；「未登录 GitHub」可点、支持 Token 登录（2026-09-20）

- **子包列表：读不到 ≠ 不存在**（用户实测）：装 `zhu1090093659/dsh-web`（根包 `private: true`）时报「未发现子包」，
  而该仓库 main/dev **各有 22 个子包**（含 `@linxin666/dsh-web-all`）——真实原因是当时网络受限、列表没读到。
  现在：① 空列表时**自动换分支重试一次**（main ↔ dev）；② 仍为空则明确说「**本次没能读到**它的子包列表
  （多为网络受限/超时，**不代表没有子包**）」并给出可复制的安装命令；③ 记 `job.probeReason` 便于排查。
- **GitHub 登录（新）**：市场页「未登录 GitHub」徽章改为**可点按钮**，展开面板粘贴 fine-grained token 即可登录。
  服务端新增 `POST /plugin-console/github-login`：校验令牌形状 → 用**该 token 自身**向 GitHub 校验并取登录名
  → 写 `~/.dsh/github-auth.json`（与 `dsh-github-login` 同格式）；**响应与日志从不回显 token**，失败不落盘。
  登录后按子包名搜索（代码搜索）可用，API 限额也更高。
  ⚠️ 校验通道刻意**不与 `gh` CLI 的 keyring 凭据竞速**：否则一个无效 token 会被本机 gh 登录态"验成有效"
  并写进 `github-auth.json`，把用户真实登录顶掉（实现过程中实测到的坑）。
- 路由数 46 → 47（`test-route-inventory.mjs` 清单与契约同步）。
## v0.3.51 — 市场索引源全挂时 65.7s → 16.7s；CI actions 升 v5（2026-09-20）

- **市场打开更快（网络差时尤其明显）**：`market-index` 逐个拉取索引源时原来用 `fetchJsonUrl`
  （内部 = curl 一次 + node:https 兜底，兜底默认 **20s** 超时）→ 单源最坏 ~28s；5 个源全部不可达时
  实测 **65.7s** 才回退到落盘缓存/报错，用户看到的就是"市场一直转圈"。
  现在改为**每源单次 curl**（8s 硬超时）+ 整体预算 12s：真实网络（当时索引源确实全挂）实测同一路径 **16.7s**，
  错误文案仍是可读的「网络不可达（N 个索引源全部失败）：…」。
- **CI**：`actions/checkout` / `actions/setup-node` 升到 **v5**（`registry.yml` 早已是 v5），消除 Node 20 弃用 annotation。

**已知行为提醒**：默认索引源在 0.3.49 扩容到 5 个，但**对已有 `~/.dsh/plugin-console-sources.json`
的实例不生效**（自定义配置优先于默认值）。想要多入口的用户可在「软件源 → 索引源」里补
`https://gcore.jsdelivr.net/gh/Noob-stupid/dsh-plugin-hub@main/marketplace/index.json` 等备用入口。

**安装**：`dsh plugin add @noob-stupid/dsh-plugin-console`，或控制台「检测更新 → 更新并适配」。

## v0.3.50 — CI 增加「真装真卸」冒烟：把"非 Windows 硬编码 + 兜底路径从不执行"挡在 Linux 宿主上（2026-09-20）

> 复盘（今天连撞两次低级错误后）：环境相关测试"没有 profile 就整体 SKIP"，
> 于是 `git.exe`、corepack 的 Windows 路径假设、以及"多通道兜底路径（pnpm → curl → Release → git）"
> 在 CI 的 Linux 宿主上**从未被执行**——直到真实用户在 Android/proot Ubuntu 上撞出来。
> 本次**不改产品行为**，只补一层"能在 Linux 上真跑"的验证。

- 新增 `test-install-smoke.mjs`，作为 CI 独立步骤（**不带** `DSH_TEST_SKIP_NETWORK`，
  因为该变量会让其它环境相关测试整体跳过）：在临时 `DSH_HOME` 里
  ① 校验 `gitBin()` 在本平台可用（真的跑 `git --version`）；
  ② 校验 `resolvePnpmRunners()` 的首选执行方式与本平台匹配（win32 不得选裸 `corepack`，反之亦然）；
  ③ **真装**一个零依赖小包 `left-pad`（npmjs → npmmirror 依次尝试，走的就是出过 MODULE_NOT_FOUND 的那条通道）；
  ④ 校验落盘 + **真卸载** + 校验目录已移除；
  ⑤ `gitCloneRepo` **真克隆**一个小仓库（顺带验证 git 通道与"重试前清理目标目录"）；
  只有显式 `DSH_TEST_SKIP_NETWORK=1` 时才跳过；
- 为便于测试，导出三个内部函数：`pnpmInstall` / `pnpmRemove` / `gitCloneRepo`（无行为变化）；
- **反向对照**：把 PATH 打断后该测试**响亮失败**（`spawnSync git.exe ENOENT`；克隆报「首个错误」+ 尝试清单），
  证明它对"工具链不可用 / 平台假设错误"这类故障有牙齿，而不是静默跳过。

**安装**：`dsh plugin add @noob-stupid/dsh-plugin-console`，或控制台「检测更新 → 更新并适配」。

**测试**：16 套测试全绿 + 新增的真装真卸冒烟 9 项全过（Windows 本机与 CI 的 Linux 宿主同一份代码）。

## v0.3.49 — 搜索可搜「npm 包名 / README / 仓库文件里的名字」+ 克隆失败不再掩盖真实原因（2026-09-20）

> 用户反馈：搜 `web-all` 搜不到全家桶 `zhu1090093659/dsh-web`（★7800）；另一位用户点**安装**报
> `git clone 失败：… fatal: destination path '…dsh-suite-job-1-…' already exists and is not an empty directory.`

**一、搜索可达性**——先回答"为什么搜不到"：

- `web-all` 是 **npm 包名** `@linxin666/dsh-web-all`，而那个 GitHub 仓库**名字是 `dsh-web`**，
  名字/描述/topics 里都没有 `web-all` → GitHub **仓库搜索**（检索面只有这三处）对它无解：
  实测 `web-all` 32 条不含它、`dsh-web-all` 21 条也不含、`web-all in:name` 7449 条同样没有；
  唯一能命中的是 `dsh-web-all in:readme`（README 里的词）；
- 控制台本来有条能搜到它的**代码搜索**（monorepo 子包）通道，但 GitHub **代码搜索 API 强制登录**：
  未登录实测 `401 Requires authentication`（对照：仓库搜索未登录 200 可用）；
- 那位用户**索引也加载失败**（2 个默认索引源同时不可达）→ 本地索引模糊匹配同样失效 → 三条路全断。

修复（新增三条互不依赖的通路）：

- **npm 包名反查**：registry 搜索接口 → 候选包 → packument 的 `repository.url` → 仓库（并补真实星数/
  描述/默认分支），命中**置顶**并带 `packageName` + `npmPackage` 标记，点安装即按包名安装；
- **in:readme 重查**：首屏没有"名字逐词命中"的条目时，自动用 `in:name,description,readme` 再查一次
  （未登录也能用）；
- **索引源 2 → 5**（jsDelivr cdn/gcore/fastly + ghproxy + raw）、单源超时 15s → 8s、循环加 20s 总预算；
  全部失败时的文案说清后果（此刻只剩 GitHub 实时结果）；
- **增量检索通道 `extras`**：浏览器直连 GitHub 搜索成功时不会走服务端路由，而未登录用户恰恰只能走直连 →
  前端现在**并行**再调一次 `/search {extras:true}`（只跑 npm 反查 + in:readme + 子包），合并时 npm 置顶、
  按 fullName 去重，并改为**就地打补丁**应用 enrich 结果（避免把增量条目整表冲掉）；
- **界面**：索引彻底没加载成功时给出"只剩 GitHub 实时结果"的说明 + **重试按钮**；未登录时提示
  "登录后可按子包名搜索"；
- **按包名安装**：`addLocal` 支持 `npmPackage` 标记（不改这行，npm 命中会退化成"按仓库装"，
  装到的不是用户输入的那个包）。

**二、克隆重试不再掩盖真实原因**

`gitCloneRepo` 多源重试（ghproxy 镜像 → GitHub 直连）**不清理目标目录**：第一次失败会留下半成品目录，
第二次立刻以 `destination path … already exists and is not an empty directory` 失败，旧代码把**最后一条**
错误抛出去 → 用户只看到"目录非空"，真实原因（镜像/网络不可达）被完全掩盖、排查方向被带偏。
现在每次尝试前清理目标目录，失败时抛**首个错误**（真实原因）+ 尝试清单，并把"目录非空"那条标出来。

**安装**：`dsh plugin add @noob-stupid/dsh-plugin-console`，或控制台「检测更新 → 更新并适配」。

**测试**：16 套测试全绿 + 全功能路由冒烟 24 项全过；端到端 `q=web-all` 首位 = `zhu1090093659/dsh-web`
（★7812、`@linxin666/dsh-web-all@0.3.23`、默认分支 dev、可按包名安装）；三个**真套装**仓库对照仍正确判为套装
（内容校验没修过头）。

## v0.3.48 — 三类「环境相关」缺陷：套装误判 / 抓取超时被误报成「没有 package.json」/ 非 Windows 必炸（2026-09-20）

> 两位用户实测反馈：
> ① 装 `MeteorNOX/DeepSeek-Balance-Whale-Widget`（标准 bundle 插件，四个分支根目录都没有 `.gitmodules`）
> 报「未找到 .gitmodules（不是 submodule 套装仓库）」；
> ② Android + proot Ubuntu 容器里 GitHub 仓库直装恒定失败报「仓库没有 package.json」，
> 「仓库落地」报 `spawn git.exe ENOENT`，AI 赋能报 `Cannot find module '.../corepack/dist/corepack.js'`。

**一、套装判定改「内容校验」——不再被代理/CDN 的假响应骗到**

- **根因**：旧逻辑只看 `.gitmodules` 探测结果是否非 null，**空字符串也算"文件存在"**；四通道
  （node:https / gh / curl / jsDelivr）竞速时，任何一个通道对**不存在的文件**回 2xx
  （代理空 body / 拦截页 / 失效镜像的停放页）就足以把普通插件判成"submodule 套装置仓库"，
  clone 后必然报「未找到 .gitmodules」。
- 新增 `readBodyOrNull`（空串/纯空白不算读到文件）与 `looksLikeGitmodules`（必须含 `[submodule "x"]` 段），
  四通道统一口径；`/enrich` 标记、`/repo` 详情、安装兜底**全部改用内容校验**。
- **套装通道兜底**：clone 后若确实没有 `.gitmodules`，不再直接失败，而是**自动回落普通插件安装**
  （npm → GitHub Release → git 规格）并在任务里说明——即便将来再误判，插件照样装得上。
- 移除失效镜像前缀 `mirror.ghproxy.com`（实测连接超时；失效域名被停放页接管时会回 2xx HTML）。

**二、抓取超时 ≠ 文件不存在（预算与出口都分开）**

- `rawTextFetch()` 返回 `{ state, body }`：`ok` / `not-found`（真 404）/ `unreachable`（超时或通道全灭）；
  竞速语义抽成纯函数 `raceFetchOutcome()`。旧代码把两者放在同一个 `null` 出口，
  于是"网络太慢"被写成"仓库没有 package.json"，日志里永远不出现"超时"，误导排查方向。
- **预算放宽**：raw 抓取 5s → **10s**，默认分支探测 3s → **8s**，curl 通道 6s → 9s；
  GitHub 域名的 curl 通道加 **`-4`**——「解析出 IPv6 但没有 IPv6 路由」的环境里，
  默认要先空等 ~5.2s 才回退 IPv4（实测 5473ms vs `-4` 的 461ms）。
- **文案分开**：超时写「抓取超时/网络不可达…请重试，或先用『仓库落地』克隆到本地目录」，
  只有真 404 才说「没有 package.json」；原因记入 `job.probeReason`。

**三、去掉两处非 Windows 必炸的硬编码**

- 「仓库落地」的 `git.exe` → `gitBin()`（win32 = `git.exe`，其余 = `git`）；
- AI 赋能 install-npm 把 corepack 路径写死为 `<node bin>/node_modules/...`（Windows 布局）→
  改为 `resolvePnpmRunners()`（Windows 官方布局 / Linux `<prefix>/lib/node_modules` / brew libexec，
  外加 Windows `cmd /c` 与 Linux `corepack`/`pnpm` 兜底）与 `runPnpmWithFallback()`
  （只有"执行方式本身不可用"才换下一个，真正的安装失败立即抛出并附已尝试清单）；
  `pnpmInstall` / `pnpmRemove` / install-npm 三处统一走它。

**安装**：`dsh plugin add @noob-stupid/dsh-plugin-console`，或控制台「检测更新 → 更新并适配」。

**测试**：新增 `test-suite-detect.mjs`（离线确定性：空 body/垃圾页不算套装、四种竞速结局、
超时与 404 文案必须不同、git 与 corepack 跨平台定位），套件 16 → **17 套**，全部通过。

## v0.3.47 — 「一键启用已适配」只启用一部分：目标漏掉「已记已适配却从未扫描」的行（2026-09-14）

> 用户实测：全家桶卡片点「一键启用已适配」后只有个别行被启用，其余仍停在【补丁停用】。

**根因**：批量解锁只挑 `status === 'pending'` 的记录；而全家桶那批行的记录是 `status: 'adopted'` + `check: 'unknown'`
（**账面已适配、从没跑过源码扫描** —— 它们是被 safe-mode 隔离后、由"启用即视为已适配"的对账逻辑记成 adopted 的），
却仍被 `cordis.patch.yml` 禁着 → 目标集合为空 → 接口直接返回「没有待适配行、无需操作」，用户看到的却是"一行都没启用"。

- **目标集合修正**：`pending` ∪（`adopted` 且 `check !== 'pass'`）—— 把"账面上已适配、实际没验证、还禁着"的行纳入批量扫描；
- **返回值补统计**：`scanned / unlocked / kept` + 说明文案；
- **界面文案说实情**：提示与确认改为"会重跑源码扫描：通过即解锁；未通过保持禁用并给出原因"（中英）；
- **逐行「启用 + 风险确认」通道保留**（未通过扫描的行仍可手动强行启用）。

**安装**：`dsh plugin add @noob-stupid/dsh-plugin-console`，或控制台「检测更新 → 更新并适配」。

**测试**：全部套件通过（含 46 条路由契约与软锁断言）。

## v0.3.46 — 回补重构中发现的 3 个真 bug：自报名读取 / 不认 DSH_HOME / 死形参（2026-09-13）

> 这两天在做分层重构（工作副本 `dsh-hub-Exp`），通读代码时挖出 3 个**现网代码本来就有的问题**（不是重构引入的）。按既定安排重构期间不动主仓库，现在把产品 bug 单独回补回来。

- **修 `/framework-upgrade` 的自报名读取**：读插件自身 `package.json` 时路径算错 —— `join(dirname(fileURLToPath(import.meta.url)), 'package.json')` 落在**不存在的 `lib/package.json`**，每跑必抛错、又被 `catch {}` 吞掉 → `selfName` 恒为 `null`，生成升级脚本时只能退回 hardcode 兜底。**"自报名一致性校验"实际上从未按真实包名运行过**（换包名/改名场景会静默失效）。改为读真实包根。
- **修 3 个路径常量不认 `DSH_HOME`**：`COMPONENTS_FILE` / `AI_JOBS_FILE` / `REPO_LAND_CONF` 硬编码 `join(homedir(), '.dsh', 'plugin-console', …)` → 组件注册表、AI 任务、仓库落地配置在**自定义 `DSH_HOME` / 多 profile / 测试隔离**场景下会读写**真实用户目录**（互污染、隔离失效）。改为惰性函数 `componentsFile()` / `aiJobsFile()` / `repoLandConfFile()`，统一走文件里已有的 `dshHome()` —— 与其它路径常量写法一致；**未设 `DSH_HOME` 时行为完全不变**。
- **`runSkillInstallJob(job, ctx)` 删掉死形参**：`ctx` 在函数体内从未被使用。

**验证（改动前/后对照，证明只修 bug、不影响原有功能）**：改动前的代码 16/16 套件全绿、且验收探针能复现前两个 bug；改动后 16/16 套件仍全绿、验收探针 ALL PASS（三个文件都从 `DSH_HOME` 读写）；`git diff` 仅 18 增 18 删，全部是上述 9 处替换。

**npm 发布**：2026-09-14 已发布到 npm（`latest = 0.3.46`）。

## v0.3.45 — 清单与现实对账：启用后不再假挂【待适配】（2026-09-11）

> 用户实测两连问：「点一键启用已适配，它说『该全家桶没有待适配行』，可我卡片里明明有已适配可解锁」＋「我刚才启用的插件，一重启变成待适配了？」—— 两个问题同一个根：**清单记录与开关现实脱节**。

- **启用即视为已适配（保留痕迹）**：手动启用一个待适配行后，清单记录转为 `adopted`（`adoptedBy: 'manual-enable'`），但**保留** `check` / `checkNote` / `riskyApprovedAt` 供事后查。之前只改开关不清记录 → 重启后那行又顶着【待适配】（用户实测的 5 行就是这么来的）；
- **启动对账 `reconcileCompatPending()`**：① 补 `moduleName`（隔离记录里只有 rowId，而"全家桶"是按 moduleName 前缀匹配的 → 永远匹配不到，这就是「没有待适配行」的来源）；② 把"当前已启用却还挂着 pending"的记录转成 `adopted`（`adoptedBy: 'row-enabled'`）；
- **合并即补全**：`mergeQuarantineRecord(ctx)` 现在按当前 loader 反查 `moduleName`/`version`，并对已启用的行直接记成已适配；
- **显示与开关对齐**：`/state` 里【待适配】只在"补丁此刻确实还禁着它"时显示 —— 记录与开关不一致时不再误导人；
- **全家桶匹配双前缀**：`moduleName` 前缀 **或** 该 bundle 的 rowId 集合（老记录 moduleName 为空也能被正确解锁）。

**测试**：`test-quarantine-merge.mjs` 增加 8 项（合并补 moduleName、已启用不留 pending、对账三态、痕迹保留）；`test-compat-soft-lock.mjs` 增加 4 项端到端断言（启用后记录转 adopted、已启用不显示待适配、仍禁用的照旧显示）；14 套测试全绿。

## v0.3.44 — 「自动禁用没登记」修复：隔离记录带 BOM 导致清单永不更新（2026-09-11）

> 用户实测发现：框架升级后那 20 个第三方插件显示【停用】而不是【待适配】，**看不出为什么被禁、也找不到解锁入口**。查证：它们是被升级脚本的「安全模式」自动禁用的（日志 12:02–12:04 三轮），而"自动禁用 → 登记进适配门清单"这条链路断了。

**根因（沙箱复现 + 字节级验证）**：升级脚本用 PowerShell `Set-Content -Encoding UTF8` 写 `fw-quarantine.json`，PS5.1 会**带 UTF-8 BOM**；而合并逻辑是"**先复制 + 删除记录，再判断 `JSON.parse` 结果**"——BOM 让 `JSON.parse` 必然失败（`Unexpected token ''`）→ 记录被销毁、却从未写进清单。实测字节：`EF BB BF 7B …`；`JSON.parse` 失败，剥掉 BOM 后成功。

- **先合并、校验通过才销毁记录**：把"写清单"提到"归档/删除记录"之前，并且写完**回读校验**（清单里必须真能查到这些 rowId）才算成功；
- **BOM 兼容**：读隔离记录时统一剥掉 BOM（与状态文件读取同一处理，代码里早有先例）；
- **失败不再静默**：解析失败/写入失败都保留原始记录（下次启动重试）并写 `fw-merge-error.log`（之前那只 `catch {}` 是这次事故查不到原因的直接原因）；
- 修复 `mergeQuarantineRecord` 函数签名被上一轮编辑压成一行的问题。

**效果**：重启后你机器上那条隔离记录（20 行）会被正确并入清单 → 界面显示【待适配】+「启动失败隔离（safe-mode）」原因 + 「已适配，立即解锁」入口，而不是没有解释的【停用】。

**测试**：新增 `test-quarantine-merge.mjs`（15 项断言：带 BOM 必须能合并、校验通过才销毁、**写失败/坏 JSON 都必须保留记录并留痕**、幂等、预设隔离、无记录时不动清单），已进 CI；14 套测试全绿。

## v0.3.43 — 「重启服务」不再需要你手动拉起（独立守护任务）（2026-09-11）

> 用户实测：「我重启了，但是是手动重启，因为他自己没拉起来。」现场证据很硬 —— 任务计划里躺着 **5 个 Ready 僵尸任务**（`DSH-Restart-13804` / `-31688` / `-3744` / `RestartV2-28496` / `RestartV3-5100`）。重启脚本最后一行是"自删任务"，任务还在 ⇒ **脚本杀完服务后自己也被结束了**（与升级/回滚脚本同一个毛病：`0xC000013A`），于是"检查端口 → 拉起服务"那几行根本没跑到。

- **守护任务（关键改动）**：主脚本动手**之前**先注册一个独立的、每分钟复查一次的计划任务 `DSH-RestartGuard-<pid>`。服务被杀、主脚本被杀都不影响它：端口已监听 → 收工自删；没监听 → 自己拉起；连拉 5 次仍失败 → 记日志放弃（**不会变成永动机**）。
- **主脚本加固**：原来 `sleep 3 秒 + 查一次端口`（端口还占着就误判"已有人监听"从而跳过拉起），现在改成**轮询等端口真正释放**（最多 20 秒）→ 拉起 → 每次等 16 秒确认，**失败重试 3 次**；
- **有日志可查**：重启与守护的每一步都写 `~/.dsh/plugin-console/console-restart.log`（以前重启失败是完全无声的，只能靠猜）；
- **bin 解析复用升级/回滚那套多级回退**（node resolve → 目标版本 `.pnpm` → 顶层链接），不再只认一条写死的路径；
- **开机清僵尸**：服务起来时顺手清掉 `DSH-FW-Upgrade-*` / `DSH-FW-Rollback-*` / `DSH-Restart*` / `DSH-RestartGuard-*` 残留任务（原来是等自愈时才清，且不含重启类）。

**测试**：新增 18 项断言覆盖两段重启脚本 —— 内容生成成功、PowerShell 语法校验（真的交给解析器）、多级回退接线、端口轮询、3 次重试、任务自删、守护任务自删与失败上限、开机清理；13 套测试全绿。

## v0.3.42 — 复审抓到的转义丢失 bug（生成脚本里的正则全成了字面量）（2026-09-11）

> 用户要在真机上再跑一次框架升级，让我先通读一遍代码。把两段生成的 PowerShell 导出来逐行看，抓到一类**静默 bug**：JS 模板串里的 `\d` `\s` 会被 JS 自己吃掉（`\d` → `d`），于是生成出来的 PowerShell 正则变成了**字面量匹配**——脚本语法完全合法、测试也全绿，只有行为悄悄退化。

共 5 处，其中一处**直接决定框架重链到哪个版本**：

- **`Compare-Version` 的版本正则**（`'^(\d+)\.(\d+)\.(\d+)…'` → 实际是 `'^(d+)…'`）：正则永不匹配 → 一律退化成**字符串比较** → `0.1.10` 会被判成小于 `0.1.9`，重链时可能把顶层链接指到**更旧**的框架版本。这个函数当初就是为了修这个问题写的，结果修复本身没生效。已修，并在 PowerShell 里实测：`0.1.10 > 0.1.9` ✓、`rc.2 > rc.1` ✓、`rc.1 < 正式版` ✓。
- **npmrc 缓存目录正则**（`'^cache\s*=\s*(.+)$'` → `'^caches*=s*(.+)$'`）：永远读不到 `.npmrc` 里的 cache 配置，一直走 APPDATA 兜底；
- **启动失败隔离的查重正则**（`'\s*$'` → `'s*$'`）：靠"零个 s 也算匹配"侥幸还能用，一并修正；
- 顺手把 `$nil`（未定义变量，靠 PowerShell 宽松语义当 `$null` 用）改成 `$null`，避免以后有人开 `Set-StrictMode` 就炸；
- 升级/回滚成功后作废版本检查缓存，[框架] 面板立刻显示新版本，不会再"升级完 5 分钟内还说可以升级"。

**测试**：新增**转义丢失 canary** —— 扫描 `lib/index.js` 里所有"整行就是一个模板串"的生成行，发现会被 JS 吃掉的转义就红灯（这类 bug 语法合法、行为静默，只能这样设闸）；另加 3 项断言（生成脚本不含 `(d+)`/`(s+)` 残留、版本比较与 npmrc 正则内容正确）。13 套测试全绿。

## v0.3.41 — 回滚按钮：客户端自己也算一遍可用性（2026-09-11）

> 用户实测（面板截图）：当前版本已经是 `0.1.5-rc.1`，而回滚记录里的 `from` 也是 `0.1.5-rc.1`，**回滚按钮却还亮着**。原因：判定字段 `applicable` 是 v0.3.39 才加到服务端的，而当时运行中的服务进程还是 0.3.38 —— 客户端拿不到该字段就默认"可用"。

- **客户端自算**：只要 `/state` 里有 `framework.version` 与 `rollback.from`，就能判定「当前版本 == 回滚目标 ⇒ 不该再提供回滚」；服务端的 `applicable` 只作为额外否决位。这样即使服务端是旧版（或字段缺失）也判得对，而且**只改前端 → 刷新页面即生效，不需要重启服务**。
- 顺手把这条判定写进回归测试，避免以后有人"优化"掉它。

**测试**：`test-framework-upgrade.mjs` 增加 1 项接线断言（客户端自算回滚可用性）；13 套测试全绿。

## v0.3.40 — 卡片语义明确化：关一次就真的关掉、自愈结果不弹卡片（2026-09-11）

> 用户连问两次「卡片为什么还在」（第一次是 0.3.39 还没重启加载，第二次是卡片本身的语义问题）。两件事都要修：**说明白** + **改对**。

- **关闭标记按「这一次运行」记**：原先用状态字符串（`done`/`failed`）当标记，于是"关掉了 failed 卡片、结果自愈成 done 又冒出来一张"。现在用状态文件的时间戳当运行身份（`pc-fw-dismiss-at`），关一次就真的关掉；下次升级时间戳变了才会再弹。
- **自愈出来的结果不弹卡片**：脚本被强杀、服务端按现实判定出来的结论，用户根本没看着它跑，弹卡片纯打扰 —— 这类结果只常驻在「功能包 → 框架」里；卡片只负责**进行中**的实时进度（以及没被关过的真实结束卡片）。
- **挂载时不再整块吞掉状态**：原先若命中"终态已关闭"标记就不写入 `frameworkStatus`，连 [框架] 按钮的角标一起瞎掉。现在状态照收，显不显示卡片由统一规则决定。
- 与 0.3.39 的自愈配合后的效果：脚本被强杀的那次运行，重启后卡片**自动消失**、状态变「已完成（附自愈说明）」、回滚按钮因 `applicable=false` 一并消失、[框架] 角标不再挂 ✕。

**测试**：`test-framework-upgrade.mjs` 增加 2 项接线断言（关闭标记按时间戳记录、自愈结果不弹卡片）；13 套测试全绿。

## v0.3.39 — 状态自愈：脚本被强杀后不再永远「进行中」（2026-09-11）

> 真机现象（用户实测）：回滚**其实成功了**（框架已回到 `0.1.5-rc.1`、服务正常、新拉起逻辑写下了真实 bin.js 路径），但卡片一直显示「回滚中…」不停转圈，而且「回滚到上一版」按钮还能点。查计划任务发现：回滚脚本进程被 Ctrl+C 类事件结束（`Last Result = 0xC000013A` = `STATUS_CONTROL_C_EXIT`），**收尾那一步没写成**，状态文件停在 `rollback|回滚到升级前版本…`。

- **心跳机制**：升级/回滚脚本每推进一步就更新 `fw-upgrade-state.txt.hb` 的时间戳（状态变更 + 安装等待循环 + 拉起等待循环都会打点）；
- **状态自愈**：读取状态时若处于**非终态**且心跳**超过 90 秒没动**，判定脚本已死，再用**现实**核对结论：
  - 已装版本 == 记录的 `to` → 升级实际成功；
  - 已装版本 == 记录的 `from` 且阶段是停服/回滚/拉起 → 回滚实际成功；
  - 两者都不符 → 只报「脚本可能已中断」，**不乱改判**；
  - 自愈时会顺手清掉残留的 `DSH-FW-Upgrade-*` / `DSH-FW-Rollback-*` 计划任务（脚本被强杀时来不及自删）；
- **心跳新鲜时绝不抢跑**：脚本还活着（<90 秒有动静）就保持原状态，避免把正在进行的升级误判成完成；
- **回滚按钮可用性**：当前版本已经等于回滚记录里的 `from` 时不再提供回滚按钮（点了等于"恢复到你现在这个版本"），改为显示「已回滚到 X（当前就是快照版本，没有更早的可回）」；
- 卡片与常驻面板都会显示自愈说明（「⚠ 脚本进程已中断，但框架已是 X、服务正常 —— 实际结果：…」）。

**测试**：`test-framework-upgrade.mjs` 增加 8 项断言（脚本已死→按现实判完成、心跳新鲜→不抢跑、现实对不上→只报中断、回滚按钮 applicable 双向、客户端接线）；13 套测试全绿。

## v0.3.38 — 框架升级/回滚变成「功能包 → 框架」常驻入口（2026-09-11）

> 用户实测：升级卡片点过叉号后，`localStorage` 里留下永久关闭标记，**重启后卡片再也不会出现** —— 升级状态、回滚按钮、进度条全都找不回来了。框架操作不该依赖一张可以被关掉的卡片。

- **新增常驻入口**：右上角「功能包」抽屉里多了 **[框架]** 按钮（与 [门控] 并列），随时可开：
  - **版本信息**：本机已装版本 / 可升级到哪个版本（同时列出 `latest` 与 `next` 两个渠道）/ 检查失败时明确报错而不是假装"已是最新"；
  - **上次（或当前）升级记录**：七个步骤逐条显示，失败时按崩溃前最后阶段标 ✓ / ✕ / 「未执行」，并保留「框架本体其实已升级」的说明；
  - **操作**：升级（两步确认，说明会停服/装新版/拉起/失败先隔离再回滚）、回滚到上一版、刷新进度、重新检查版本、重启服务。
- **按钮自带状态角标**：升级进行中 `⟳`、上次失败 `✕`、有可用更新 `↑` —— 不打开面板也知道框架处于什么状态。
- **不再受「已关闭」标记影响**：面板查询状态时无视那个永久关闭标记（卡片仍保持原语义：你关了就关了就关了）。
- **新增只读接口 `/framework-check`**：当前 / `latest` / `next` / 升级目标，与升级路由同一套判定规则，但**不备份、不写状态文件**，5 分钟内存缓存（面板常驻，不能每次打开都打 registry）。
- **顺手去重**：升级步骤视图与回滚动作各只保留一份实现（原先卡片和面板各写一遍）。

**测试**：`test-framework-upgrade.mjs` 增加 10 项断言（接口契约、目标只能取自 latest/next、5 分钟缓存命中、只读不碰状态文件、客户端接线、步骤视图只有一份实现）；13 套测试全绿。

## v0.3.37 — 升级脚本「重启服务」崩溃修复 + 进度条不再整列红叉（2026-09-11）

> 真机事故（`0.1.5-rc.1 → 0.1.5-rc.2`）：框架本体**升级成功**（顶层可见版本校验通过、rc.2 正常拉起运行），但脚本在最后「重启 DSH 服务」这一步异常终止，界面把七个步骤全打成 ✕ —— 看起来像彻底失败，其实只是一个 `$null` 崩了整个收尾流程。

**根因（已在本机用 PowerShell 复现证明）**：

```powershell
$binNow = ''; try { $binNow = (& node -e "…require.resolve…" | Select-Object -Last 1) } catch {}
if ($binNow -ne '' -and (Test-Path $binNow)) { … }
```

解析那一瞬间失败时管道无输出 → `Select-Object -Last 1` 让 `$binNow` 变成 **`$null`**，而 PowerShell 里 **`$null -ne ''` 是 `true`**（守卫形同虚设）→ `Test-Path $null` 抛「无法将参数绑定到参数"Path"，因为该参数是空值」。同一段拉起代码原先被**复制了 5 份**（升级后 / 回滚后 / 隔离重试 / 异常兜底 / 一键回滚脚本），所以同一个坑反复出现。

**修复**：

- **拉起逻辑收敛成一份**：新增生成器 `relaunchPrelude()`，产出 `Resolve-DshBin` + `Invoke-DshRelaunch` 两个函数，5 处调用点全部改为调用它（拉起命令只在一个地方写）；
- **解析结果永不为 `$null`**：非字符串一律归一成空串，再用 `[string]::IsNullOrWhiteSpace` 判断；所有路径参数走 `Test-Path -LiteralPath`；
- **多级回退**（不再假设某一处一定可用）：node resolve → 目标版本的 `.pnpm` 实体目录 → 顶层可见链接 → `.pnpm` 里最新的一个；全都找不到时只记录「请手动启动 DSH」并返回 `$false`，**绝不再抛错**；
- **进度条诚实化**：脚本失败时把崩溃前最后到达的阶段写进状态文件（`stage=…`），界面据此把已完成步骤显示成 ✓、真正失败的那一步显示 ✕、其后显示「未执行」；旧记录没有 `stage` 时，若框架本体已在目标版本，则提示「框架本体其实已经升到 X 并已生效——失败的只是最后重启服务那一步」。

**测试**（`test-upgrade-script-syntax.mjs` 从「语法校验」升级为**真机行为验证**）：

- 拉起助手只定义一次、拉起命令只有一处、`$binNow` 写法彻底清除、对变量的 `Test-Path` 只用在归一化结果上；
- 两段生成脚本仍交给 PowerShell 解析器做语法校验；
- **三种场景真跑**：① 正常 → 解析到真实 `bin.js` 并真的发起服务进程；② **解析探针坏掉（复现当天崩溃现场）→ 回退链兜住并成功拉起**；③ 连框架根都是假的 → 返回空串、函数返回 `$false`、日志可读，**不抛错**；
- `test-framework-upgrade.mjs` 增加 8 项断言覆盖状态解析（stage 透出、消息不被污染、旧记录推断「本体已升级」、目标版本对不上时不误报、客户端接线）。

## v0.3.36 — 门控总开关收进「功能包」的 [门控] 按钮（2026-09-11）

- **位置调整**：兼容门总开关从「已安装」列表表头的两个小复选框，挪进右上角「功能包」抽屉里的 **[门控]** 按钮 —— 点开是弹窗，两个拉杆开关 + 说明 + 当前待适配行数；
- **按钮上直接显示待适配条数**（如「门控 3」），不点开也知道有没有待处理的；没有待适配行时只显示「门控」；
- **开关改成拉杆**（与「服务器组件自启动」同一套样式），比表头复选框更好点，也不再挤占列表表头；
- 行为不变：升级时自动禁用 / 打开时自动检测，各自可关，关掉即纯手动。

**测试**：`test-compat-soft-lock.mjs` 增加 3 项前端接线断言（[门控] 按钮与面板存在、面板用拉杆、已安装表头不再有门控复选框）；13 套测试全绿。

## v0.3.35 — 预扫误伤修复：框架自带包永不自动禁用 + 删除 API 判定改为符号引用（2026-09-11）

> 起因：拿**实时插件行快照**对真机做了一次只读预演（不写补丁、不装框架，总开关置为「只报告」）：结果算出「升级到 `0.1.5-rc.2` 会禁用 1 行」——禁用对象是 `settings-controller`，也就是**框架自己的设置控制器**。顺着查，是两个 bug。

- **子串巧合被当成「引用已删除 API」**：框架包 `@deepseek-ai/dsh-api-settings-controller` 里有个标识符 `settingsNamespaceRequestSchema`，而旧判定用的是 `text.includes('settingsNamespace')` 这种**子串**匹配 → 直接判 fail。现在要求**标识符边界**（前后不能再是标识符字符），并排除「本地 `const/let/var/function/class` 定义、且同行没有 dsh-settings 引用」的情况。真引用（import / 属性访问 / 调用）依旧判 fail——**门禁没有被修软**，真机复核：旧判定命中该文件、新判定干净。
- **框架自带包一律不自动禁用**：解析到 profile 目录**之外**的包（npx/pnpm 缓存里的框架包）与框架同源发布，禁用不是正确处置（正确处置是回滚框架），而且一旦判定有误就直接砍掉框架功能。真机演练里这一条覆盖 **58 行**，加上原有的核心/受保护行豁免，共 **128 行**不再进入预扫禁用范围。
- **预演复测**：修复后升级到 `0.1.5-rc.2` 时「会被自动禁用的行」= **0**；用户装的第三方插件（全部解析在 profile 内）该禁的照禁。

**测试**：新增 `test-preflight-guard.mjs`（10 项：子串巧合不误判 / 真引用仍禁用 / 框架自带包不碰 / 清单只收真不适配 / 幂等），已进 CI。

## v0.3.34 — 适配门补全「检测侧」+ 启动失败隔离 + 软禁（2026-09-11）

> 起因（用户硬要求）：**更新框架后，所有不适配的必须先禁用**；并且要能**自动检测已适配**、**手动可开关**。

### 一、补上适配门缺失的「检测侧」

适配门此前只有**执行侧**（读 `compat-pending.json` → 锁启用 → 更新后解锁）——那份清单一直是人工/一次性脚本产物（v0.3.25 遗留），**检测侧从未实现**。这就是 `0.1.2-rc.1 → 0.1.5-rc.1` 升级时没有任何行被禁用的原因。本次补全：

- **升级前预扫并禁用**：扫描全部可开关行（受保护/核心行/自身除外），对目标框架判定 `fail` 的就地写 `disabled: true` + 记入清单，并在升级步骤里逐条展示；
- **启动失败隔离**：新框架**仍起不来**时，按启动日志定位肇事者（预设挂载失败 / loader 条目 / 找不到模块）→ 隔离（预设改名 `.broken-<ts>`、插件行写禁用）→ 重试（最多 3 轮）→ 仍失败则「安全模式」（禁用全部第三方行，先让服务起来）→ 最后才回滚整包；
- **判决逻辑全在 Node**：`planQuarantine()` 纯函数产出执行方案，PowerShell 只照做；被隔离项写入 `fw-quarantine.json`，服务起来后并入待适配清单，面板可见（谁被关了、为什么）；
- 生成脚本本身由测试交给 **PowerShell 解析器做语法校验**（含新隔离逻辑）。

### 二、软禁（用户定案：自动关，但可手动强行启用）

- 待适配行不再「硬锁死」：点启用先弹**风险提示**（说明强行启用可能让下次启动失败），确认后才放行（`/toggle` 的 `confirmRisky`），并记录 `riskyApprovedAt`；
- 保留一条**硬**门禁：启用前的 import 冒烟检查——模块根本加载不了属事实性崩溃，不允许覆盖（与「服务永不崩」一致）。

### 三、自动检测（只提示，不自动开）

- 打开控制台时重算待适配行的当前状态：插件已更新且源码扫描通过 → 行内提示「检测到已适配 vX，点『已适配，立即解锁』」——**绝不自动启用**。

### 四、总开关

- 「兼容门」两个自动行为各自可关：**升级时自动禁用** / **打开时自动检测**；关掉即回到纯手动（升级只提示、不动你的开关）。

**测试**：新增 `test-preflight-disable.mjs`（预扫禁用 11 项 + 隔离决策器 11 项）、`test-compat-soft-lock.mjs`（走真实路由验证三条定案行为：软禁风险确认 / 硬门禁不被覆盖 / 检测只提示 / 两个总开关，36 项断言）；`test-upgrade-script-syntax.mjs` 改为按内容定位并覆盖新脚本；12 套测试全绿（两套新测试均已进 CI）。

## v0.3.33 — 框架升级/回滚健壮性修复 + 预设配置迁移门禁（2026-09-10）

> 主题：修掉 `0.1.2-rc.1 → 0.1.5-rc.1` 那次升级暴露的三个真 bug，并把「agent 预设」纳入升级前门禁。

**当时的真实故障**：升级后服务反复拉不起来（自动回滚崩了、两次手动回滚也拉不起来），最后靠手动拉起 0.1.5 + 手改预设才恢复。复盘出四类问题，本版全部修掉：

- **启动器版本错配**：npx 缓存顶层的 `@deepseek-ai/dsh` 是 npm 时代的**真实目录**，pnpm 只能把新版装进 `.pnpm/`、换不掉顶层入口 → 桌面端 / `npx dsh` 拉起的仍是旧框架（版本错配 → 拉起失败 → 又提示升级，循环）。升级脚本现在校验**启动器可见版本**，发现是实体目录就改名备份（`dsh.npm-backup-<时间戳>`）后重装一次，让 pnpm 重建链接；版本校验也从 `.pnpm` 内部路径改为顶层可见路径（原先因此误报「pnpm 退出码 0 但版本未更新」，白等两轮）。
- **回滚脚本自身崩溃**：生成的回滚 PowerShell 里有 4 处把已带引号的路径又套了一层单引号（`'"D:\…"'`），空串还被写成字面量 `""` → 全树恢复被静默跳过；回滚体没有 try/catch，崩了只留一句 trap 消息、旧树半新半旧。现已修正引号/空串处理（含路径里 `$` 的转义），回滚体包 try/catch 并记录**出错位置**。
- **拉起失败无日志**：升级后拉起子进程的输出被丢弃，出问题只能盲调。现在统一经 `cmd /c … >> fw-relaunch.log 2>&1` 落盘（升级后 / 回滚后 / 异常兜底三处）。
- **预设不在适配门范围内（本次真正的坑）**：0.1.5 把 `@deepseek-ai/dsh-persona` 的配置字段 `text` 改名为 `prefix`（必填），而适配门只扫「已装插件包」，扫不到 `~/.dsh/.agent-presets/*/agent.cordis.yml` → 升级后预设挂载失败、服务起不来。新增**预设配置迁移门禁**：升级前按目标版本扫描全部预设与 profile host 组合，把新版不再接受的旧字段就地改名（留 `.bak`），并在升级步骤里逐条展示。

**测试**：新增 `test-preset-migration.mjs`（迁移/幂等/不误伤其它插件/版本门控共 11 项断言）与 `test-upgrade-script-syntax.mjs`（把两段生成的 PowerShell 抽出来真跑，再交给 PowerShell 解析器做**语法校验**，含「路径含 `$` 不被插值」断言），均已加入 CI。

## v0.3.32 — 打开插件页提速 + 软件源扫描（2026-09-08）

> 主题：修掉「打开就卡」的根因，并让多软件源一眼看清哪条最快。

- **索引补标改增量**：首屏只补前 50 条，点「加载更多」时按区间继续补（原先一次性对 500 条逐条请求 ≈ 2000 次，打满浏览器连接数导致整页变慢）；
- **服务端 /enrich 兜底**：客户端直连失败时走服务端补标（并发限流 12、24h 磁盘缓存、延后 1.5s 执行，不抢首屏带宽）；
- **修复 /enrich 缓存永不命中**：非官方插件此前 `official = null` 不满足缓存条件，每次打开都重新请求（实测「缓存命中」仍要 14.1 秒）；现在确定非官方即落 `official = false`（可缓存），抛错条目也写 1 小时短 TTL 缓存。首次 23.0s → 6.5s，缓存命中 14.1s → 4.5s；
- **软件源扫描（新）**：软件源弹窗新增「扫描软件源」——并发探测每个源的**可达性 / 响应延迟 / 该源上 dsh-plugin-console 的最新版本**，结果显示在每条源右侧（`✓ 358ms · v0.3.32` / `✗ 不可达`），并在下方汇总「N/M 个可达 · 最新版本来自哪个源」。公共镜像 + 内网私服混配时，一眼看出该把哪个设为主源；
- **测试**：新增 `test-registry-scan.mjs`（结构断言 + 不可达源降级 + 非 POST 405 门禁），已加入 CI 环境依赖套件。

## v0.3.31 — 自定义源全链路：索引源 / Git 源 / 合并模式 / 内网闭环（2026-09-08）

> 主题：四类「源」全部可自定义——内网、公网、混合都能配。

- **索引源可配置**：`indexSources` 主→备依次尝试；拉取失败回退落盘缓存（响应带 `offline` / `cachedAt`）；成功时返回 `sourceName`；索引源配置变更立即失效内存缓存（原先要等 10 分钟）；
- **索引合并模式**：所有索引源结果并发拉取、去重合并（公共索引 + 公司内网私有索引同屏可见），各源独立 8 秒超时，慢源不拖垮整体；
- **Git 源可配置**：`{owner}/{repo}` 地址模板，支持 Gitee / GitLab / 自建 Gitea / 任意镜像代理 / `file://` 本地裸仓库（完全离线）；5 处 git 调用统一走 `gitCloneUrls` 主备回退；
- **AI 赋能走 Git 源**：规划前用 Git 源把目标仓库预克隆到临时目录，子代理直接读本地 README / package.json / docs（内网 / 离线环境同样可调研，30 分钟后自动清理）；
- **无 package.json 的仓库**：含 SKILL.md → 自动转技能安装；否则失败并返回 `hint=repo-land`，前端一键「仓库落地」；
- **软件源弹窗**：加宽 420→760px、限高 + 内置滚动条、五分区折叠（软件源默认展开）、操作按钮悬停说明；
- **仓库落地**：接受任意平台仓库链接（GitHub / Gitee / GitLab / 内网 Gitea / 镜像代理前缀，循环剥离域名）；提示文案动态显示当前主 Git 源；
- **修复**：
  - `repo-clone` 未禁用 git 交互 → 克隆不存在/私有仓库会弹 Windows 凭据窗（统一 `GIT_TERMINAL_PROMPT=0` + `GCM_INTERACTIVE=never` + `ASKPASS=echo`）；
  - `market-index` 被客户端以 GET 调用落入 405 且错误被静默吞掉 → 静态索引长期未生效（客户端改 POST + 服务端 GET 兼容白名单）；
  - 私网 http 索引源报 `Protocol "http:" not supported` → 跳过 node https 兜底，暴露 curl 真实错误；
  - `styles.srcUrl` 未定义（源地址无样式）→ 补等宽字体 + 超长省略；
- **工程**：新增 `.github/workflows/test.yml`（语法检查 + 4 个硬门禁套件，环境依赖自动 SKIP）；测试可移植化（系统 tmpdir → 仓库内 `.testdir`）；修复 2 个既有失败测试；新增 `docs/roadmap.zh.md` 记录演进方向；
- 验证：端到端 29/29 PASS，7 个测试套件 ALL PASS；内网闭环实测（Verdaccio registry / 本地搜索服务 / `file://` 裸仓库）。

## v0.3.30 — 修复桌面端/框架类误装崩溃 + AI 步骤提示键泄漏（2026-09-06）

> 事故：室友把「dsh 桌面端」（独立客户端,非插件）在控制台点「添加到本地」→ 按 bundle 规则注册其组合补丁,
> 其中引用 `@deepseek-ai/dsh-root` 等**框架级行**（包在 npx 缓存/框架树,profile node_modules 不存在）→
> 下次 `dsh web` 启动 `ERR_MODULE_NOT_FOUND` → **整服务打不开**。

- **通用防线（register 前校验）**：注册任何 bundle 插件前,校验其 `cordis.patch.yml` 引用行的模块**全部能在 profile 解析**（**含 `@deepseek-ai/*` —— 正是事故中的框架级包**）;缺失 → **拒绝注册**并列出缺失清单 + 说明(该包不能作为插件安装);正常全家桶（web-all 引用全部可解析）放行,已离线仿真验证;
- **框架本体仓库拦截**：`deepseek-ai/deepseek-harness` 走安装/添加到本地 → 直接拒绝并提示「请用框架升级」(框架升级流程独立,不受影响);
- **AI 步骤提示翻译键修复**：`aiNeedSteps` → `aiEmpowerNeedSteps`（未勾选步骤点「同意并部署」不再显示键名 "AIneedstep",而是正常中文提示）;
- 验证:`node --check` ✅、`test-compat-gate` 15/15 ✅、`test-issue15-resolve` ✅、`test-bundle-guard` ✅（dsh-root 缺失去拦截/全家桶放行）。

## v0.3.29 — 聚合子包更新安全 + 全家桶交互完善（2026-09-06）

> 事故背景：更新 `@linxin666/dsh-i18n`(全家桶子包,自身又声明 `dsh.bundle.patch`)时,按"bundle 安装规则"被额外注册为独立 bundle,与全家桶内的 `web-ui-i18n` 行重复(两个 i18n);全家桶分组按"同根行数≥2"又把这两个重复行聚成假"全家桶"卡。另:全家族升级到 0.3.16 时,完整性检查在更新瞬时态(极个别包替换窗口/失败)把 16 行误判"缺失"并自动禁用。

- **防重复注册(`alreadyServed`)**：安装/更新时若包已被现有行提供(moduleName 已在组合中)→ 只更新包本身,**不再追加 bundles/注册新行**(bundle 与非 bundle 两条路径都防护);
- **全家桶分组收紧**：改为按**不同子包名**聚合——同包的重复行不再凑成"全家桶"卡;
- **完整性检查瞬时态加固(`transientAllow`)**：聚合更新时,本次作业刚同步过版本的包处于原子替换窗口,缺失≠真缺失 → 跳过"补装+自动禁用"判定(记入 pending 简报),下次校验再查;不传参时行为与旧版完全一致;
- **全家桶「更新」按钮**:批量检测出最新版且 ≠ 已装版本时,卡片出现「更新 vX」→ 点击开始整包更新(装聚合包+子包版本对齐+完整性+适配校验);「一键启用已适配」在无待适配行时改为友好提示(不再报"操作失败");
- **右上悬浮工具栏与官方设置头叠印修复(issue #16)**:浮层按钮全部实底不透明(消除半透明透底叠字);新增窄屏(≤1160px)媒体查询——整体下移,避开官方「打开配置文件」按钮区(宽屏保持原有右上位置不变);
- **「功能包」长按拖动**:长按 ~0.45s 进入拖动,位置夹在视口内,**持久化 localStorage**(`pc-toolbar-pos`),下次打开沿用上次位置;抽屉按钮组跟随主按钮;短按开关抽屉行为不变;
- 验证:`node --check` ✅、`test-compat-gate` 15/15 ✅、`test-issue15-resolve` ✅。

## v0.3.28 — 修复第三方插件详情/版本全空（issue #15，npm 全局安装 dsh 下）

> 现象：npm 全局安装 dsh 0.1.2-rc.1 时，`ctx.baseUrl` 落在框架安装树而非 profile node_modules。
> `resolvePackageJson` 以框架树为基准：官方 `@deepseek-ai/*` 恰好可见，**第三方插件全部解析失败**
> （被 `catch {}` 静默吞掉）→ 详情面板空白、版本/仓库/安装日期全 null，官方模块不受影响。

- **修复**：`resolvePackageJson(pkgName, baseDir, fallbackBase)` 新增 **profile 目录回退**——
  基准解析失败后改用 `~/.dsh/profiles/<profile>` 再试一次（createRequire + 物理路径双通道）；
  `entryPkgMeta` / `readPluginDetails` 及 5 个调用点统一传入 `profileDirOf(ctx)`（由
  `findPatchPath(ctx)` 推导，失败返回 null 不回落）；
- **验证**：`test-issue15-resolve.mjs` 场景模拟通过（dsh-better-sidebar / 控制台自身 /
  web-all 子路径在框架树 base 下解析为 null，回退后全部解出；`@deepseek-ai/dsh-settings`
  行为不变）；`node --check` ✅、`test-compat-gate.mjs` 15/15 ✅。

## v0.3.27 — 全家桶分组卡片 + 永不崩机制 + 适配门强化 + 子包删除安全（2026-09-04）

> 本次修复两起真实事故：① 记忆插件被自愈机制误禁用（`require.resolve('pkg/package.json')` 对 exports 受限包抛错）；② 删除`@linxin666/dsh-web-all`全家桶的单个子包（plugin-manager）时，旧逻辑把整个 bundle 移出清单，pnpm 卸载失败后重启导致**全家桶整体消失**。

- **全家桶分组卡片**：同根包子路径导出（模块名 = `pkg/sub`，web-all 0.3.14 式）自动聚合为一张全家桶卡（列表**底部**）；收起/展开、批量检测更新、**一键启用已适配**（adapt-unlock-all，仅解锁源码扫描通过的子包）、已知校验预览；子卡标题剥离 `web-all/` 前缀；
- **永不崩安全**：`probePluginImport` 启用前子进程动态 import 冒烟（捕获 loader 将遇到的解析/语法/导出错误）；`healPatchSafety` 补丁自愈（核心行误禁用自动恢复 + 启用态 insert 行模块缺失自动禁用，`CORE_PATCH_ROW_IDS` 保护）；`resolvePackageJson` exports 回退（物理路径直查 node_modules）——修复 `@openviking/dsh-memory-plugin` 被误禁用事故；
- **适配门强化**：源码扫描硬判据（v0.3.26 已入）；**迁移检测**（本地包声明 `dsh.migrate.to` → 查目标包 registry 最新版与兼容，提供「迁移并适配」）；deps-strict 软化（仅有声明/依赖范围、无 pkgDir 源码时不再误判 fail）；「待适配 v」徽标与顶部横幅移除（提示移入详情面板）；
- **子包删除安全**（事故修复）：bundle 行的「删除」= 仅写 `disabled: true` 停用该行，**不再移除 bundle 清单、不再 pnpm 卸载**（整体卸载走包管理器）；返回 `removed:'row'` + 说明文案，前端同步展示；
- **其他**：`packageNameOf` / `baseDirOf` 子路径归一；移除「强制启用（风险自担）」绕过（仅保留记忆插件 bug 修复）。

## v0.3.26 — 适配门源码扫描硬判据 + ★ 筛选补标强化（2026-09-04）

> 教训：v0.3.25 的适配门被 `@linxin666/dsh-web-ui-all@0.3.6` 的静态声明/依赖检查**假通过**——0.3.6 全家仍引用 `settingsNamespace` / `installSettingsSection`（0.1.2-rc.1 已删除），解锁后 loader 单行 import 失败导致**整个服务启动崩溃**。静态检查 ≠ 真实兼容，只有模块 import 的那一刻才是真相。

- **适配门硬判据**：框架 ≥ 0.1.2 时对已装包做**源码扫描**（`settingsNamespace` / `installSettingsSection`），命中即判 fail，绝不自动解锁（scanSettingsApiUsage，限深 3 层、上限 120 文件、单文件 400KB）；
- 解锁前提收紧为：**版本变化 + 声明/依赖通过 + 源码扫描干净** 三合一；
- **★ 只看官方**：静态索引加载后一次性补标（浏览器直连失败不覆盖服务端判定，合并保留）；`/enrich` 并发限流 12 + **24h 结果缓存**（`~/.dsh/plugin-console/enrich-cache.json`）+ 失败回退缓存——网络黑洞期 ★ 不再坍缩成 0/1 条；
- deepseek-ai 官方仓库（框架本体等）直接亮「官方」标；
- 验证：`test-compat-gate.mjs` 15/15；`dsh-pet@0.3.6` 扫描实测命中两个已删除符号。

## v0.3.25 — 框架升级适配门 + AI 赋能适配检测（2026-09-04）

> 起因：0.1.1-rc.2 → 0.1.2-rc.1 升级事故（新版 @linxin666/dsh-web-ui-all 与框架不兼容致服务无法拉起）。本版把"升级后旧插件强制禁用 → 更新并通过兼容校验后才可启用"固化为控制台机制。

- **框架升级适配门**：读取 `~/.dsh/plugin-console/compat-pending.json`（升级时生成的强制禁用清单），已禁用插件行显示「待适配 <框架版本>」徽标；启用按钮锁定，服务端 `/toggle` 对兼容门内行返回 409（不能绕过）；
- **更新并适配（一键解锁）**：兼容门内的插件走「更新并适配」→ 安装/更新完成后自动校验（扫描最新版 package.json 的 `dsh.engines.framework` / `engines.dsh` 显式声明 + `@deepseek-ai/*` 依赖范围）；版本已变化且校验未失败 → 自动移除 `cordis.patch.yml` 的 `disabled` 块、标记清单 `adopted` 解锁启用；聚合包更新会连带校验其同步的子包；
- **内置 semver 判定器**（零依赖）：支持 `^ ~ >= <= > < =`、AND/`||`、npm prerelease 规则（依赖判定严格、显式声明判定宽松）；
- **AI 赋能附带适配检测**：发起 AI 赋能（含禁用插件行旁的按钮）时，服务端预检 registry 最新版声明 + 兼容门命中情况，结果注入子代理提示词（要求计划中向用户解释适配结论），并在计划面板展示「框架适配检测」说明（不兼容标红）；
- **顶部横幅**：存在待适配插件时在「已安装插件」区提示数量与升级路径（旧版 → 新版）；
- **升级安全三件套（事故根因修复）**：① 框架安装根识别——修复 `require.resolve` 返回 `.pnpm` 内部 realpath 导致「重链跳过 / 依赖修复 0 个」、pnpm 在错误 cwd 把新 CLI 原位覆盖进旧 `.pnpm` 目录的根 bug（未定位到框架根时拒绝升级）；② 升级前框架全树 checkpoint（镜像 `.pnpm` 全部 `@deepseek-ai` 版本自包 + 顶层 scope + lock.yaml），升级失败自动全树回滚；③ 「拉起失败自动回滚并重试」不再只留「请手动运行」提示；安装失败回滚后跳过重链/依赖修复（避免对已恢复旧树二次破坏）；
- **一键回滚**：升级后框架卡片出现「回滚到上一版」按钮（/framework-rollback + framework-rollback.json），停服→全树恢复→自动拉起→健康检测，全程状态可见；
- 验证：`test-compat-gate.mjs` 15 项断言全过（semver 语义、声明/依赖判定、prerelease 宽松规则）。

## v0.3.24 — AI 赋能一键部署（正式版，2026-08-31）

- **AI 赋能**：输入 npm 包名 / GitHub 仓库，本地 AI 读取文档自动生成部署计划（纯插件 / 服务器组件 / 仅配置），计划-执行分离（面板逐步骤勾选确认），安全执行器（命令/路径白名单、破坏性命令拦截、日志脱敏），服务器类组件自动注册并生成控制卡片；
- **组件控制卡片**：页面左侧固定、与主面板顶边动态对齐；【打开】按钮直达服务器 Web UI；多服务器时下拉展开；查看插件/市场详情时自动隐藏；可折叠（状态本地记忆）；
- **内置 OpenViking 模板**：125ms 秒出计划（pip 安装/模型下载/ov.conf 写入/启动/健康检查 5 步，幂等可重跑）；
- **模型配置跟随 DSH**（settings.yaml + .credentials.yaml），支持 `~/.dsh/plugin-console/ai-empower.json` 独立区块覆盖；
- **更新检测**：semver + beta/next tag 识别（本地已是测试版最新时不再误提示）；
- **已安装技能区** 展示插件自带技能（如 openviking-memory，只读）；
- **修复**：issue #14 自定义端口 Host 校验 403（`webPort` 优先运行时真实端口）；ov.conf 路径转义（非法 JSON 曾致服务挂掉）；package.json BOM 清除 + 发布前自动校验；自定义端口下 AI 赋能执行器保留 @tag 版本号；
- 验证：test-harness.mjs / test-framework-upgrade.mjs 全部通过；beta.1/beta.2 经真实环境测试（OpenViking 全链路部署闭环、自升级、组件控制）。

## v0.3.23 — 修复自定义端口 Host 校验 403（issue #14）

- **修复**：`webPort(ctx)` 优先读取运行时真实监听端口（`ctx.webServer.port`），不再仅依赖 loader 配置并回退到写死的 3080；
- 场景：DSH 以 `--port 3082` 或系统分配端口启动时，`/plugin-console/*` 接口此前误报 403「Host 校验失败」，控制台读不出已安装插件/市场数据；
- 验证：`test-harness.mjs`、`test-framework-upgrade.mjs` 全部通过。

## v0.3.24 — AI 赋能：文档驱动的一键组件部署（未发布，待合并）

- **新增「AI 赋能」按钮**（AI 兜底按钮下方）：输入 npm 包名 / GitHub 仓库，本地 AI 读取文档自动生成部署计划；
- **计划-执行分离**：生成的结构化计划（纯插件 / 服务器组件 / 仅配置）在面板弹窗逐步骤勾选确认后执行，实时回显日志、可中断；
- **安全护栏**：命令白名单（curl/git/node/python/gh/npm/ov）、写入路径白名单（profile、~/.dsh、~/.openviking、~/.cache/openviking、D:/OpenVikingData）、破坏性命令拦截、日志密钥脱敏；
- **服务器组件自动控制**：识别为 service 类型的组件注册到组件清单，面板自动出现「启动/停止/状态」按钮（`~/.dsh/plugin-console/components.json`）；
- **内置预案**：OpenViking 等已知组件的部署事实（国内镜像、hf-mirror、中文路径 Unicode 坑、DeepSeek 凭据复用）随计划提示固化，避免 AI 重复踩坑；
- 新增接口：`/plugin-console/ai-empower/plan|status|run|cancel`、`/plugin-console/components`、`/plugin-console/component/start|stop|status`。

## v0.3.22 — 安全加固（PR #13）

- **URL 路径分段编码**：`fetchRawText` 对 `repo / branch / file` 做 `encodeURIComponent` 分段编码，防止用户可控参数导致 URL 注入/篡改；
- **frontmatter 正则白名单**：`summarizeSkillFrontmatter` 改用固定 `KEY_PATTERNS`，避免动态拼接正则引入注入；
- 合并自 PR #13（automated security fix），测试全部通过。

## v0.3.21 — 清理残余备份/旧子包

- **新增清理按钮**：插件面板最左下角增加「🧹 清理残余备份」悬浮按钮；
- **新增接口**：`POST /plugin-console/clean-residuals`，自动删除：
  - `.old-*` 残余备份目录；
  - 聚合包未声明的旧 `@linxin666` 子包；
- 实测已清理：
  - `dsh-web-ui-all.old-20260826-190144`
  - `@linxin666/dsh-client-ui-session-id`
  - `@linxin666/dsh-skins`
- 清理后无残余，服务正常。


## v0.3.20 — 聚合包更新修复 + 子包自动补齐/禁用

- **更新不再被“已安装跳过”拦截**：更新按钮带 `update: true`，服务端对更新任务不执行已有包快速跳过；
- **聚合包子包自动补装**：更新后读取新版聚合包 `dependencies`，缺失子包按声明版本自动安装，版本落后的自动更新；
- **解除 bundle 引用缺失阻断**：`verifyPackageBox` 不再因为新版聚合包引用了尚未安装的子包而拒绝更新，安装后由完整性检查补齐/禁用；
- **自动禁用兜底**：仍缺失/有问题的子包会在用户补丁层自动禁用，保证 DSH 能正常启动；
- 实测：`@linxin666/dsh-web-ui-all` 更新到 0.3.4 后自动补装 `@linxin666/dsh-client-ui-market`，并恢复启用，服务正常。


## v0.3.19 — Hub 自更新按钮 + monorepo 子包增强 + 安装并行竞速

- **Hub 自更新按钮**：检测到远程 npm 有新版本时，在 GitHub 登录标识左侧显示「下载更新」按钮，点击跳转对应 Release；无更新时自动隐藏；
- **monorepo 子包识别**：`packages/examples/plugins/skills/apps/src/lib` 等目录下的子包都会出现在仓库详情，并显示子包路径；
- **子包搜索增强**：`/search` 增加 GitHub code search 兜底，可直接搜到 `volcengine/OpenViking` 这类仓库的 `examples/dsh-memory-plugin` 子包；
- **安装通道并行竞速**：pnpm / curl 同时尝试，先成功者生效；
- **已有包检测**：目标包已在 `node_modules` 且包名匹配时，直接进入启用流程，避免重复下载/EPERM 卡死；
- 测试：核心测试 ALL PASS，OpenViking dsh-memory-plugin 实测跳过重复下载并成功启用。


## v0.3.18 — 安全加固（issue #9）

- **写路由跨站防护**：所有非 GET/HEAD 请求校验 `Origin` / `Sec-Fetch-Site`，防止恶意网页跨站驱动安装、重启、升级；
- **Host 校验**：防 DNS rebinding，只允许 `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`；
- **恢复完整 TLS 校验**：移除 `rejectUnauthorized: false` 与 `curl --insecure`，代码分发路径不再被 MITM 绕过；
- **敏感凭据拆分存储**：自定义搜索源 `Authorization` 头、Gitee clientSecret/token 改存 `plugin-console-sources.secrets.json`（0600），主配置不再明文落盘；
- 新增跨站/非法 Host 测试，核心测试 ALL PASS。


## v0.3.17 — 框架升级 pnpm 超时提升至 15 分钟

- **框架升级脚本超时策略调整**：`Install-Framework` 的 pnpm 总时长硬上限从 **10 分钟提升到 15 分钟**，
  避免弱网/大依赖树环境下子进程下载未完成就误判超时；
- 同步更新升级脚本日志文案与 README 说明。

## v0.3.16 — 升级框架版本比较加固 & npm 发布

- **升级目标版本改用数值比较**：服务端 `/framework-upgrade` 不再用字符串不等判断是否有更新，
  避免当前为稳定版 `0.1.1` 时被 `next=0.1.1-rc.3` 反向降级；与客户端 `verNum` 逻辑保持一致；
- **依赖树修复网络加固**：升级脚本里的框架配套包修复优先走 `npmmirror`，失败回退 `registry.npmjs.org`，
  并统一加 `--insecure`，避免本机证书链问题导致依赖修复静默失败；
- **自报名一致性校验补全**：`Verify-SelfNameConsistency` 现在真正计算部署目录完整包名（含 `@scope/name`），
  旧目录误装新代码时能正确告警，不再只比对代码内字符串；
- **测试修复**：`test-framework-upgrade.mjs` / `test-harness.mjs` / `test-skill-toggle.mjs` /
  `test-suite-install.mjs` 改为直接引用仓库源码，不再依赖已丢失的旧安装路径；三个核心测试 ALL PASS。


## v0.3.15 — 升级脚本自报名一致性校验（防错装崩溃）

- **升级后自报名一致性校验**（`Verify-SelfNameConsistency`）：校验面板自身
  `export const name` / client.js 注册 id 与部署目录名三者一致，不一致则日志告警
  （事故教训：把 @noob-stupid 代码装进 @deepseek-ai 目录 → `loaded without registering` 崩溃）；
- 端到端验证：旧名部署检查旧名 OK / 检查新名正确判定不匹配（PS5.1 + BOM 兼容）。

## v0.3.14 — 修复注册 ID 与包名不一致（issue #8）

- **client.js**：`__ModuleLoader__.load({ id })` / CSS `tagId` / `dataset.plugin` 3 处旧名
  `@deepseek-ai/dsh-plugin-console` → `@noob-stupid/dsh-plugin-console`；
  DSH 0.1.1-rc.2 严格校验 bundle 必须用真实包名注册（0.3.8 迁移 npm 包名时遗漏），
  旧名导致 `loaded without registering` 报错、插件加载失败；
- **index.js**：`export const name` 对齐新包名（一致性）；
- 端到端验证：全新 DSH_HOME + 0 插件原生 profile 安装修复版，6/6 通过。

## v0.3.13 — 框架一键升级（重大增强）

- **升级后自动重链框架配套包**：pnpm 升级只重建 `.pnpm`，顶层 `@deepseek-ai/*` 不自动切换
  （旧版 0.1.0-rc.7）→ 框架混版本（如 dsh-llm-deepseek 旧版无 vision 模型）。
  升级成功后自动扫描并重建顶层 Junction 指向 `.pnpm` 最新版（旧版备份 `.bak-<版本>`）；
- **版本数值比较**：修复字符串比较 bug（`0.1.10` 曾被判 < `0.1.9`），位数变化/大版本升级正确；
- **PS 5.1 兼容**：升级脚本改用 PS 5.1 兼容语法（原 `? :` 三元运算符在 powershell.exe 解析失败会崩）；
- 已随框架升级到 0.1.1-rc.2 实测：56 个包重链、0 误处理、服务健康。

## v0.3.12 — 框架 0.1.x 系列兼容

- **兼容性检测**：DSH 框架升级到 0.1.1-rc.2 后，`SUPPORTED_WEB_APP_PATTERN=/^0\.1\.0-/` 不匹配，
  面板误报"不受支持"警告；改为 `/^0\.1\.\d+/` 支持 0.1.x 系列（0.1.0/0.1.1 均 supported，
  0.2/1.0 等破坏性大版本仍正确标记不支持）。

## v0.3.11 — 全面测试修复（8 个 bug）

- **严重修复：补装逻辑污染框架**——peerDependencies 误当缺失依赖 + `@deepseek-ai/*` 无版本补装
  （npm dist-tags.latest 是远古版如 0.0.1-rc.1）覆盖框架正确版本 → webServer 起不来、服务崩溃；
  现在 missingDeps 只统计 dependencies，补装跳过 @deepseek-ai 框架内部包；
- **/repo 提速**：rawTextWithFallback 404 确定性快返（.gitmodules/SKILL.md 探测），14s → ~3s；
- **/sources 凭据脱敏**：Gitee clientSecret/token 绝不回传、clientId 打码、自定义源 headers 打码；
- **保护名单补全**：dsh-attachment 系（attachment-local / client-ui-attachment）禁止开关，
  停用附件存储曾致服务崩溃；
- 依赖补装误判修复（curl 成功安装却报缺失）。

## v0.3.10 — README 安装说明同步 npm 发布版

- README 中英：安装命令改为 `dsh plugin add @noob-stupid/dsh-plugin-console`（npm 路径），
  GitHub 源码安装保留为备选；
- marketplace/index.json：自身条目加 `name: @noob-stupid/dsh-plugin-console` 字段；
- 社区索引 PR：恢复 zhu1090093659/dsh-web-ui community 索引中的 dsh-plugin-hub 条目（#931）。

## v0.3.9 — npm 发布 + 框架升级检测修复

- **npm 发布**：包名 `@noob-stupid/dsh-plugin-console`（官方 scope `@deepseek-ai` 无权发布，注册自有 scope）；
  `dsh plugin --profile web add @noob-stupid/dsh-plugin-console` 官方路径安装；
- **框架升级检测修复**：客户端版本比较写死 `0.1.0-rc.N`，官方发布 `0.1.1-rc.2` 后解析为 -1 恒不显示升级——
  改为通用 semver 比较（maj/min/pat + rc 数字，正式版视为 rc.∞），支持跨 minor 升级；
- **GitHub release 检测与安装通道**：npm 上不存在的包（如面板自身旧名）从 GitHub release 检测/下载安装；
- **盒子实验验证**：安装前静态验证（包名/入口/bundle 引用），失败保留旧版本。

## v0.3.7 — 框架一键升级（pnpm 通道 + 黑框实时进度 + 在线安装）

- **框架一键升级**：deepseek-harness 卡片显示「框架升级 → vX」（latest 优先、相同时取 next 渠道），
  一键完成：备份配置与框架本体（回滚点）→ 在线安装（服务保持运行、页面不断）→ 版本校验 →
  自动重启生效；
- **实时进度**：升级弹出 `DSH-Upgrade` 窗口实时显示 pnpm 下载进度；面板进度卡片同步显示等待时长；
- **升级保护**：失败自动回滚（robocopy + 升级前校验回滚点）、版本校验防假成功、10 分钟硬超时、
  卡死检测（debug 日志无更新自动换 registry）、全局 trap 兜底、15 分钟残留状态清理、
  升级卡片终态关闭永久化；
- **pnpm 通道**：npm-cli.js 在 schtasks 任务环境启动即卡死（0 字节日志、网络请求都发不出）——
  升级改用 `corepack pnpm`（秒启动）+ 国内源 npmmirror + `dangerouslyAllowAllBuilds`
  （node-pty/koffi 原生模块正常编译）；
- **schtasks 环境适配**：cmd /c 原生重定向（PowerShell 重定向全失效）、start 独立窗口显示进度、
  运行时解析 bin.js（pnpm Junction 布局）、compat 检测插件目录兜底、客户端升级目标版本比较；
- 升级脚本：无引号 /tr、BOM、防桌面端误杀改名、重启任务自删、状态文件残留清理等累计 16+ 修复。

## v0.3.2 — 套装 bundle 安全策略（紧急修复）

- **bundle 自动装配默认跳过**：套装安装不再自动把 bundle 型插件写入 `dsh.profile.bundles`——第三方 bundle 需与当前 DSH 严格兼容（peer 依赖 / client inject / patch 语义），自动装配曾导致启动崩溃（`@dsh-external/dsh-super-injector` 案例）；现在跳过并给出官方装配指引（详情面板官方命令 / install.ps1）；
- **入口校验修复**：`packageEntryExists` 排除 `.d.ts` 与 `package.json` 自身（exports 的 `./package.json` 是合法导出但非运行时入口，曾导致校验恒过）；
- 预设 / 技能 / 普通插件装配不受影响；测试更新为「injector 安全跳过 + 双预设成功」ALL PASS。

## v0.3.1 — Suite install + official-install command

- **套装安装通道**：submodule 聚合仓库（如 `yjh051108/dsh-routing-suite`）一键装配——clone 套装 → 镜像逐个拉子模块 → 按类型装配：bundle 插件（构建产物缺失时自动拉 Release 预构建 tgz）/ 技能 / **agent 预设**（复制到 `~/.dsh/.agent-presets/`，预设优先于同名 npm 包）/ 普通插件；组件报告逐项展示；
- **安装链自动识别套装**：普通安装请求发现根 `.gitmodules` 自动转套装安装（不依赖前端标记）；
- **详情面板官方安装方式**：套装仓库显示纯命令（`git -c http.sslVerify=false clone --recurse-submodules` + `powershell -File install.ps1`，CMD/PowerShell 通用）+ 一键复制；浏览器直连查看时本地即时拼装；
- 「添加到本地」直接启动安装任务（服务端解析包名，黑洞期不再 40s 无反馈）；卡片/详情「套装」标签；
- `/repo` 元数据 3 秒超时降级（Promise.any 不再等最慢分支 41.5s）；SKILL.md 探测加 jsDelivr 快速通道；Release 下载支持 gh 绝对路径候选；
- 测试：`test-suite-install.mjs` 端到端（普通请求→自动转套装→injector bundle+双预设 ALL PASS）。

## v0.3 — Auto-collection CI + Skills support

- **自动收录 CI**：`.github/workflows/registry.yml` 每 6 小时重跑 `build-index`（也支持手动触发），
  自动提交刷新后的 `marketplace/index.json`——作者打上 `dsh-plugin` / `agent-skills` / `claude-skills` / `dsh-skill`
  标签后无需申请即可被收录；
- **Skills 支持**：
  - 索引新增技能段：`build-index.cjs --skills` 合并收录 `agent-skills` ∪ `claude-skills` ∪ `dsh-skill`（最多 300）；
  - 市场搜索框旁「插件 / 技能」双 tab 浏览技能库；
  - 技能一键安装：`git clone` → 复制 SKILL.md 及资源到 `~/.dsh/skills/<name>/`（frontmatter name 优先，
    SKILL.md 位于根或第一层子目录均可识别），不碰 npm、不写补丁、无需重启；
  - 类型识别新增「技能」徽标：搜索结果 / 详情 / 索引条目均自动检测 SKILL.md（raw 双通道竞速）；
  - `GET /plugin-console/skills-installed`：已安装技能清单，技能卡片显示「已装」；
- `build-index.cjs` 分页改为手动循环（`gh api --paginate` 对 search 单对象响应拼接后非法，CI/本地均可靠）。

## v0.2 — Static index market

- **静态插件索引**：嗅探 `dsh-plugin` topic 仓库生成 `marketplace/index.json`（按 star 500+ 个，
  jsDelivr CDN 分发）——终端市场浏览**零 GitHub API 调用、零限流**；
- **市场秒开**：`/market-index` 路由（CDN + 10 分钟宿主缓存）；GitHub 源空查询直接展示全量索引，
  分页浏览（每批 50 条）；
- **自动版本比对**：市场中已安装条目后台自动查 npm `dist-tags.latest`，卡片显示「更新 → vX」一键升级。

## v0.1 — Marketplace & plugin console foundation

- 插件管理面板：一键启用/停用（写用户补丁层，HMR 生效）、第三方插件列表、详情面板、基础设施保护；
- 多搜索源市场：GitHub 浏览器直连 + 服务端兜底、Gitee 仓库直装模式、自定义搜索源
  （URL 模板 + 请求头认证 + 私网 http）、多源汇总搜索（⊞）；
- ★ 官方筛选：可 `dsh plugin add` 直装（根包 `dsh.bundle` 官方 / 聚合仓库子包带 bundle）；
- 软件源管理：多 registry 主→备安装链、私有/内网源、删除保护；Gitee 登录（可选，仅提高限额）；
- 安装链：配置源 → curl 手动安装（node 网络黑洞兜底）→ git 通道 → EPERM 清理重试 →
  子包自动展开（聚合优先）→ 本地 AI 兜底（费用授权弹窗 + 不再提醒 + AI 兜底总开关）；
- 检测更新：curl 读 npm dist-tags + 子包配套检查（depsOutdated，防版本混搭冲突）；
- 框架层补丁：`cordis.patch.yml` 解析容错（issue #5，幂等脚本）；
- 安全：环回限定、自定义源白名单、AI 兜底零费用默认保障。
