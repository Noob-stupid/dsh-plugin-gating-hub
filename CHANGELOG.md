# Changelog

All notable changes to dsh-plugin-hub.

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
