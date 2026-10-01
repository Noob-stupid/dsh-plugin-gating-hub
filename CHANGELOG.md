# Changelog

All notable changes to dsh-plugin-hub.

## v0.5.33 — 四项真机缺陷收口（扫描误禁 / 解锁按钮门控 / i18n 重复键 / 框架否决原因）+ web profile 补回两条预设声明行（2026-10-01）

> 本版**只做改错与加法**。四条改错方向一致：**把误报关掉、把真报留住**（每条都带反向断言，
> "门禁不许被修软"）；不新增常驻 UI（新信息全部落在**既有行 / 既有悬浮提示**的位置上）；
> **不改任何既有 i18n 键的语义**。profile 侧只在 `preset-router-standard` / `preset-router-react`
> 两个 `insert` 块里各补**一条** `router-bootstrap` 声明行，其余内容一字未动
> （含全部注释、`pressure-sensor` 行、deactivating 段、desktop managed 段）。

### 改错

- **①-1 「已删除 API」扫描误报：好插件被判不兼容，框架升级预扫会把它的行误禁。**
  现场（诊断到行号）：`dshmarket` 被判 `check:'fail'`（= 源码仍引用 0.1.2 起已删除的
  `settingsNamespace` / `installSettingsSection`）。逐条核对它的命中：
  `dshmarket/lib/settings.js:45 / :53 / :73` 三处全在**注释**里；`dshmarket/lib/routes.js:3136`
  的 `settingsNamespace: settingsNamespaceState(),` 是一个 **HTTP 载荷对象的属性名**
  （值是该包自己的局部函数）；该包对 `@deepseek-ai/dsh-settings` 的 **import 零命中**
  （它早已内联那两个 helper）。旧判据（标识符边界 + 排除局部定义）挡不住这两类：注释里的名字与
  对象键上的名字都不是"引用"，却都在**代码行**上、也不是本地定义。
  **新判据**：① 先掩掉注释、字符串/模板/正则字面量（等长空格替换，保留换行与列偏移），
  只保留**模块说明符字符串**（否则无从知道某个绑定来自哪个包）；② 只在**真的对这个包**的
  import/require 绑定子句里取名字（ESM 具名/默认/命名空间成员、CJS 与动态 `import()` 的解构/命名空间）；
  ③ 对象键、局部同名函数、别的包的**同名**导入、注释与字符串里的名字 —— 一律不算。
  真机复核：`dshmarket@1.66.7` 原始文本里还压着 **8 处裸名字**，扫描结果 **0 命中**；
  同一台机器上**真正**引用该 API 的 `@morlay/session-rdb@0.0.11`
  （`lib/index.mjs:3` 真 `import { settingsNamespace } from "@deepseek-ai/dsh-settings"`，
  `:1751` 真调用）**仍被判命中** —— 门禁没有被修软。
- **①-2 「已适配，立即解锁」按钮缺门控（文案自相矛盾 + 点了必 409）。**
  旧行为：只要 `entry.pendingCompat === true` 就渲染这个按钮，**不检查 `entry.adoptable`**，
  而同一张卡片正文那行用的是正确判据（`adoptable`）⇒ 卡片说"不适配"、按钮说"已适配"；
  点下去 `POST /plugin-console/adapt-unlock` 必得 409（适配校验 fail），补丁与行状态零变化
  ⇒ 用户观感"点不动"。现在按钮条件是新增的纯判据 `canAdaptUnlock(entry)`
  （`pendingCompat === true` **且** `adoptable` 是服务端 `detectAdoptablePending` 给出的对象）；
  不可适配时**不给这个承诺**（不显示"已适配"文案），原因照旧由既有那行如实展示
  （`pendingCompatHint` + 既有 `checkNote` / reason），**不新增常驻 UI**。
  服务端 409 文案同步改成「为什么不行 + 出路 + 本次未改动」：
  `适配校验未通过：<源码扫描/依赖的具体原因>。出路：先点「检测更新」把它更新到兼容当前框架 <版本>
  的版本（更新完成会自动重跑源码扫描，通过即解锁）；若它已不再需要，可在补丁里删掉/禁用这一行。
  本次未改动补丁与适配门清单。`
- **①-3 `failed` i18n 键重复 →「挂载失败」被印成「操作失败」。**
  中英两本字典里都写了**两次** `failed:` —— 阶段名的 `挂载失败` / `Mount failed` 之后又写了一条
  动作义 `操作失败` / `Operation failed`；同一个对象字面量里**后写的静默覆盖前一条**，
  于是 `phaseLabel → PHASE_KEYS.failed → t("failed")` 印出来是"操作失败"。
  现在**分工明确**：阶段名用 `failed`（每本字典恰好 1 条），**动作失败**用既有的
  `safetySwitchFailed`（原 47 处 `t("failed")` 调用点全部改走它，改完共 53 处使用该键），
  源码里 **0 处** `t("failed")`。顺手清掉同类缺陷的另一条：`recentFailures` 在中英字典里各重复
  一次（值相同、无可见影响）—— 现在两本字典**各自 0 重复键**，并加了通用防线断言。
- **② web profile 补回两条丢失的预设声明行**（`profiles/web/cordis.patch.yml`，用户文件）：
  `preset-audit` 实测 `missing=2` —— `router-standard/agent.cordis.yml:69-70` 声明
  `./router-bootstrap.mjs`、`router-react/agent.cordis.yml:57-58` 声明 `./router-bootstrap-v1.mjs`，
  两个目标文件都在，但补丁里**没有**指向这两个目录的 `file:///…` 行（`preset-router-react` 的
  `plugins:` 之下当时**全是注释、零条真实行** ⇒ 解析出来是 `null`，而 `@deepseek-ai/dsh-agent-preset`
  的 `Config.plugins` 是 `z.array(z.any()).required()`）。
  补的形态**照抄**既有 `preset-router-spec` 的 bootstrap 行（补丁 `107-108`）：10 空格
  `- id: router-bootstrap` + 12 空格 `name: file:///<绝对路径，percent-encoded>`，
  路径由 `pathToFileURL(dshHome()/.agent-presets/…)` 生成（**不手写**）。
  改前备份 `cordis.patch.yml.bak-preset-repair-2026-10-01T06-09-07-535Z`（26767 字节，
  与改前**逐字节一致**）；`480 → 484` 行，逐行比对**差异恰好 4 行新增**（0 处删除/改动）；
  三套 YAML 解析交叉通过（框架同款 dialect `js-yaml JSON_SCHEMA + !!js` 标签 /
  `js-yaml DEFAULT_SCHEMA + !!js` / `yaml`(eemeli, 显式注册 `!!js`)）+ 仓库自己的 `parsePatchRows`；
  隔离实例（真 `.agent-presets` + 补丁副本 + **真分发器** `handle()`，不碰 3080）实测
  `GET /plugin-console/preset-audit`：**missing 2 → 0、blockers 2 → 0、ok false → true**，
  且真 profile / 预设文件逐文件 SHA256 一致（审计全程只读）。

### 加法

- **①-4 框架 peer 预检「否决」的本地复算（补上诊断缺口）。**
  现场：补丁里写着启用（或压根没写 `disabled`）、运行时却没挂载（`fiberPhase === null`），
  面板一个字都不说为什么。真实机制在框架侧（不是我们的 bug）：`@deepseek-ai/dsh-app-boot` 的
  `evaluatePluginCompatibility()`（:286-313）只看 `peerDependencies` 里的 `@deepseek-ai/dsh` /
  `@deepseek-ai/dsh-*`（`workspace:^|~|*` 视为"等于当前运行时"，其余按 semver 且
  `includePrerelease`），`preflight()`（:2063-2109）判不满足就**只在内存里**把 `row.disabled = true`
  （**不写用户补丁**）、原因只 `process.stderr.write` 一行。
  本机典型现场：profile 顶层压着 `@deepseek-ai/dsh-schedule@0.0.1-rc.3` 残影，它的 7 条 dsh peer
  写 `^0.0.1-rc.3` → 对运行中的 `0.2.0-rc.2` 必然不满足，而补丁尾部还是
  `- id: schedule / disabled: false`。新增 `lib/server/domain/peer-veto.js`（**同一判据**的本地复算）
  + `GET /state` 的 `entries[].veto = { kind, reason, hint } | null`，只对「补丁要求启用 **且**
  `fiberPhase === null`」的行计算；`kind` 分得开：`peers`（peer 不满足，短句写明"需要什么 / 当前什么"，
  如 `被框架否决：peer 不满足（需要 @deepseek-ai/dsh-agent@^0.0.1-rc.3 等 7 项，当前 0.2.0-rc.2）`）
  与 `missing`（包解析不到 / 清单读不出来，措辞与出路都不同）。客户端把它渲染在**既有行**里
  （`entry.veto.reason` 一行 + 出路放既有 `title` 悬浮位），**不新增常驻面板行**。
- 新增域模块 `lib/server/domain/settings-api-scan.js`：①-1 的判据（掩码 + 绑定子句解析）从 544 行的
  `compat.js` 搬出 —— `lib/server/**` ≤600 行的架构棘轮保持绿；
  `REMOVED_SETTINGS_SYMBOLS` / `referencesRemovedSymbol` / `scanSettingsApiUsage` 三个名字继续由
  `compat.js` 导出，**对外契约不变**。

### 测试与门槛（全部离线，进 `.github/workflows/test.yml` 硬门槛）

- 新增四套，全部接进 `test.yml` 的 **Unit tests (hard gate)** 步骤：
  · `tests/test-settings-api-scan.mjs`（①-1：纯注释 / 对象键 / 字符串 / 别的包同名导入 / 前缀巧合
  都不报；**真** import、别名、命名空间成员、CJS 解构、动态 `import()` **必须仍报** —— 反向断言；
  `dshmarket` 已装源码 0 命中**且**夹具仍压在误报形态上（原始 8 处裸名字）；真载体
  `@morlay/session-rdb` 必须仍命中）；
  · `tests/test-adapt-unlock-gate.mjs`（①-2：`canAdaptUnlock` 真值表含 `adoptable=null → false`；
  渲染点真的用这个判据且旧形状已消失；409 文案含「为什么 + 出路」且补丁/清单**逐字节不变**；
  **可适配行照旧 200 解锁** —— 反向断言）；
  · `tests/test-i18n-keys.mjs`（①-3：中英两本字典**各自** 0 重复键且检测器用构造样本自校验；
  `failed` 每本恰好 1 条且是阶段义；0 处 `t("failed")`；`PHASE_KEYS` 解析链没断；英文键不许有中文缺失）；
  · `tests/test-peer-veto.mjs`（①-4：不满足 / 满足 / 包不存在三态；`workspace:` 协议与空范围；
  非 dsh peer 不参与；**真跑 `GET /state`** 断言 `entries[].veto` 如实下发；真机残影
  `dsh-schedule@0.0.1-rc.3` × 当前框架必须判不满足；0 本机路径扫描）。
- 两处**既有夹具**的说明符改正（**不改判据**）：`tests/test-preflight-disable.mjs` 与
  `tests/test-compat-soft-lock.mjs` 的"不适配包"原先写
  `import … from "@deepseek-ai/dsh-client-ui-settings"` —— 那个包从来没有导出过这两个 helper
  （属于不合形状的夹具：判据是"真的 import 了已删除的 API"，说明符就该是那个包本身）。
  判据收紧之后夹具一并改正为 `@deepseek-ai/dsh-settings`；真机上的真实载体见
  `@morlay/session-rdb`（已作为实时反向断言写进 `test-settings-api-scan.mjs`）。
- 架构守卫 `tests/test-architecture-guard.mjs` 12 条断言全绿（`lib/server/**` 84 个文件全部 ≤600 行）；
  「0 本机路径」扫描（`lib/**` + `tests/**` + `scripts/**` + 顶层清单与 workflow，共 178 个文件）**0 命中**。

### 未验证 / 已知项（如实列出，不粉饰）

- **② 的 profile 修复只做到文件级验证**：三套 YAML 交叉 + 逐行差异 + 隔离实例的 `preset-audit`
  （missing 0 / blockers 0）都过了，但**"框架真的按新行把预设挂起来"要等服务重启后才见分晓**
  （本轮按要求**未重启** 3080 与桌面端）。重启后请在新的会话里看一眼预设选择器。
- **② 顺带发现（未改，超出本轮"只补两条"的授权范围）**：两个 `preset-router-*` 块声明的 composition
  远小于磁盘上各自的 `agent.cordis.yml` —— 修复后 `preset-router-spec` = 18 条 /
  `preset-router-standard` = 2 条（`pressure-sensor` + 新补的 `router-bootstrap`）/
  `preset-router-react` = 1 条（只有新补的 `router-bootstrap`）。任务明确要求"只补这两条缺失行、
  其它一字不动"，故**未动**其余行；`router-react` 这一条同时把它从 `plugins: null`（schema 非法）
  救回合法数组。这是否是预期状态（例如其余行本应由别处合并进来）本轮**未验证**。
- **①-4 的 peer 判据是"本地复算"**：框架用 node-semver 的 `{ includePrerelease: true }`，
  仓库既有的 `semverRangeMatchLoose` 与它最接近但**偏宽松**。这里**故意用宽松那一支** ——
  只有连宽松读法都不满足时才说话（与 ①-1 同一纪律：宁可不说，不可错说）。代价是**可能漏报**
  少数否决（表现回退成"什么都不显示，但绝不会错说原因"）。`kind:'peers'` 的含义是
  "**大概率**就是框架否决它的原因"，**不是**框架自己给出的结论。
- **①-4 的面板可见性未做浏览器实测**：`entries[].veto` 的字段与渲染都在本轮改过的文件里，
  但 `GET /state` 的服务端代码要**重启**才生效，页面渲染也没在真浏览器里复看过（本轮未重启实例）。
- **①-1 的"不再误禁"是判据级验证**：`dshmarket` 0 命中是**只读复算**（跑真机已装源码），
  没有在真机上重跑一次完整的"框架升级预扫"来实际观察它是否真的不再被写 `disabled: true`。
- **①-2 / ①-3 的真机渲染未复看**：`canAdaptUnlock` 真值表、渲染点判据接线、字典与 `PHASE_KEYS`
  解析链都是静态 + 单测级验证；浏览器里那张卡片没看（本轮未重启实例）。
- **CI 上会"响亮 SKIP"的断言**（没有本机 profile 时如实打印 SKIP 原因，不假装 PASS）：
  `test-settings-api-scan.mjs` 的 ④ / ③′（`dshmarket`、`@morlay/session-rdb` 真机夹具）与
  `test-peer-veto.mjs` 的 ①′（`dsh-schedule` 残影）。

## v0.5.32 — 别的更新通道改了框架也守住门（自动预检 + 有证据自动禁用 + 安全启动快照 + 桌面端自动回观察者，2026-09-29）

> 用户诉求（原话）：「走**别的**更新通道（官方桌面端更新器 / 手动 pnpm / npx 缓存变化）改了框架后，
> 我们**仍要自动守门**」，并且要「能挽救『改完打不开』的局面」。
> 本版**只做加法与改错**：不改变 observer / managed 的既有语义，不动 `/framework-upgrade` 的接管行为，
> **常驻 UI 与 0.5.31 逐像素一致**（i18n 键零净增），新信息全部走既有的瞬时提示通道。
>
> ### 边界（据实说明，别指望它做不到的事）
>
> **服务已经彻底起不来那一刻，我们的代码不在运行** → 无法由我们执行禁用。本版能做的是：
> ①「知道该拦谁」（指纹变化即自动预检）；②在**服务还能起来**（或下次启动前）把有**确证证据**的行禁掉；
> ③每次自动禁用都留了**一条命令回滚**的本钱。「服务之外的全自动看门狗」（计划任务 / 启动器钩子）
> 本版**未做** —— 那要动用户的启动器或系统计划任务，需单独授权。
> 框架侧确有"不杀宿主"机制：`packages/boot/app-boot/src/index.ts:658-663` 的 `assertEntriesLoaded()`
> 只把 `entry.fiber === undefined && !entry.disabled` 判为致命（`:698` 同语义）⇒ 给坏行写
> `disabled: true` 它就不再让启动断言失败，这正是本版买的那张票。

### 加法

- **D1 · 指纹变化 → 自动预检（只读）**：新增 `lib/server/domain/auto-preflight.js`（判定/节流/超时/记录）
  与 `lib/server/domain/auto-preflight-run.js`（只读扫描器）。`GET /plugin-console/compat-status` 在
  `compareFingerprint` 报 `changed=true` 时**后台**跑一次预检（**不下载、不安装、不改补丁、不联网**），
  产成「兼容清单（受影响行）+ 隔离计划（建议禁用哪些行及理由）+ 本次变更摘要（框架版本 from→to、
  新增/消失的包、指纹 reasons）」。**同一指纹只自动跑一次**（以指纹为 key 持久化到
  `dshHome()/plugin-console/auto-preflight.json`）；失败/超时**如实记录原因**（`state=failed|timeout`，
  「未完成，可手动重跑」）且允许重试；**绝不阻塞状态查询**（预检在后台，响应先回）。
- **D5 · 有确证证据 → 自动禁用会拖垮服务的行**（触发源从「我们升级」扩到「指纹变化 / 启动失败记录」）：
  新增 `lib/server/domain/auto-disable.js`。**只禁有证据的行**：行引用的包**确证解析不到**
  （`package-unresolvable`）/ `file://` 目标确实不存在（`file-target-missing`）/ 启动失败日志**点名**；
  证据不足的形态（子路径解析不到、依赖副本陈旧）与**解析不确定**（没有基准、解析器抛错）一律
  **只报告不写盘**。0.5.30 已立的安全栏逐条带上：`@deepseek-ai/*`（框架自带）与**受保护/核心行永不禁用**
  （复用 `framework.js:483/493` 的两类判据）、**禁前先写 last-known-good 快照**（快照失败则**放弃禁用**）、
  **幂等零写盘**、**每次留一条可读记录**（`dshHome()/plugin-console/auto-disable.log`，追加式 JSONL：
  时间/行 id/证据/快照 id/备份路径/恢复命令）。开关 `compat-gate.json#autoDisableOnEvidence`
  **默认启用**；关掉 = **只报告 + 等用户点**（零写盘），走既有 `POST /plugin-console/compat-ack`。
- **D2 · 安全启动材料（只作为自动禁用的回滚本钱）**：新增 `lib/server/domain/safe-boot.js`。
  每次确认服务正常（状态查询成功 + 指纹未变 + 补丁结构合法）落一份快照：补丁**逐字节副本** +
  框架版本 + 环境指纹 + 此刻启用/禁用行清单 + 时间戳；写在 `dshHome()/plugin-console/safe-boot/`
  （**不是** profile 目录，不污染用户 profile）；**原子写**（临时文件 + rename）+ sha256；
  保留最近 3 份 + **永不删**「用户标记为良好」的那份；同名同毫秒冲突自动加序号（不静默覆盖）。
- **D3 · 恢复原语（路由 + 离线脚本共用同一套判据）**：新增 `lib/server/routes/safe-boot.js`
  （`POST /plugin-console/safe-boot`，白名单动作 `list` / `restore-last-good` / `disable-suspects` /
  `mark-good`；只认动作名，**绝不接受命令串**）与 `scripts/safe-boot.mjs`（零依赖、
  **服务未运行也能跑**）。`restore-last-good` = 改前再备份 + 严格校验 + 逐字节恢复 + 读回核实；
  `disable-suspects` = **只**给点名行追加 `disabled: true`（**不删任何行**）。
- **D4 · 桌面端宿主启动 → 自动拨回观察者**：`compat-mode.json` 增 `source`
  （`manual` / `auto:console-upgrade` / `auto:desktop-host`，**缺字段按 `manual` 兼容**）。
  复用既有 `detectHostShape()` 判据；**只在「上次不是用户手动设定」时才自动改** —— 用户手动拨过
  之后**永不自动改**；已是 observer（或本次已判定过）→ **零写盘**。
- 新增 `lib/server/domain/patch-yaml-check.js`：严格但**不误杀**的补丁结构校验
  （真机两份 56 KB 补丁实测 0 误报；`preset-yaml` 那把尺子是按预设文件校准的，量补丁会整片假红）。

### 改错

- **`writeCompatMode` 幂等零写盘**：模式与来源都没变时不再重写状态文件（此前"每次自动判定都写一份"）。
- **`readCompatMode` 增 `fileSource`**：把「记录来源（file/default）」与新增的「模式来源
  （manual/auto:*）」分开，避免把两件事塞进同一个字段名。
- **自动预检记录的终态写入只 upsert 自己那一条**：实测踩到过"多指纹并发收尾互相覆盖"，
  被覆盖的那条会**永远停在 pending**（面板永远显示"正在自动预检…"）。
- **指纹 key 路径归一**：`C:\x` 与 `c:/x` 是同一棵树 —— 不归一会把"同一个环境"算成两次变更。
- **`planDisableRows` 增两道安全栏**（框架自带行 / 受保护模块行）：自动与手动两条禁用路径一并受保护。
- **关掉自动禁用开关后不再冒出旧提示**（真机路径实测发现）：`lastAutoDisable` 是内存里的"上一次结果"，
  开关关掉后那条"已自动禁用 N 行"还会继续冒 —— 看起来像"刚刚又被禁了一次"，而补丁其实一个字节都没动。
  现改为**读时判据**（关闭且上次是 `auto-disabled` → 不下发提示）。
- **`preflightRoots` 抽成可注入形式**（`routes/framework-preflight.js`）：让自动预检与既有手动预检
  **共用同一套扫描面推导**，避免两套推导分叉成"自动预检看不见用户装的那个包"的静默漏报。
- **测试改错**：`tests/test-compat-state.mjs` 的"没有记录"断言改判 `fileSource`（`source` 已成为模式来源）。

### 测试与门槛（全部离线，进 CI 硬门槛）

- `tests/test-auto-preflight.mjs`：D1（同指纹只跑一次 / 失败与超时如实报 / **不阻塞**（慢桩下响应仍先回）/
  指纹未变不下发上个环境的结论 / 真实扫描器结构完整且标注"不联网" / 受影响行排序与隔离计划剔除核心行）。
- `tests/test-safe-boot.mjs`：D2/D5（原子写无 `.tmp` 残留 / sha256 可校验 / 保留 3 份 + 永不删良好 /
  逐字节恢复 + **改前再备份** / 被改坏的快照**拒绝使用**且零字节改动 / 只禁点名行且其余逐字节不变 /
  框架包与核心行永不禁用 / 解析不确定不写盘 / **禁前先快照** / 幂等零写盘 / 可读记录 /
  开关关闭只报告 / 补丁不存在时如实拒绝不创建文件 / 快照落在 `dshHome()` 而非 profile）。
- `tests/test-desktop-host-mode.mjs`：D4（四种结局 / **手动优先** / 老记录按 manual 兼容 /
  **零写盘（内容 + mtime 双判据）**）+ **本机绝对路径与用户名 0 出现**的扫描断言（本轮 17 个文件，
  允许清单逐条写理由；含"扫描断言本身有效"的反向自证）。
- `tests/test-route-inventory.mjs`：`/safe-boot` 进路由清单（62 条）与 client↔server 方法契约
  （55 个调用点：无 body → GET / 有 body → POST 都必须被声明且走得到）。
- 本机 `node tests/run-all.mjs` → **74 套，失败 2 套**（`test-bundle-guard` / `test-issue15-resolve`）；
  这 2 套**已用 `git stash` 在干净树上复现同样失败**：跑测试的会话在桌面端实例里、`DSH_PROFILE_DIR`
  指向 desktop profile，而 `dsh-better-sidebar` 只在 web profile → 与本次改动无关。
- 架构守卫 ALL PASS：`lib/index.js` **142 行**（棘轮 142，未上调）；`lib/server/**` 82 个 `.js`
  只有 `routes/framework-upgrade.js` 超 600（仍是唯一受限例外）。

### 未验证 / 已知项

- **服务已彻底起不来那一刻我们执行不了禁用**（代码不在运行）—— 这是物理边界，不是缺陷；
  「服务外全自动看门狗」（计划任务 / 启动器钩子 / 桌面端按钮）**本版未做**，需用户单独授权。
- **D5 的"启动失败点名"证据链在生产环境仍拿不到**：启动失败隔离只由**我们自己的升级脚本**触发
  （`routes/framework-upgrade.js:213-214` 生成 `fw-analyze-boot.mjs` + 候选快照，`:572` 起在生成的
  PowerShell 里调用 `planQuarantine`）—— 官方更新器 / 手动 pnpm / 桌面端 `/restart` 都不走这段。
  因此"别人升级把服务搞挂"时，这条证据来源目前是空的（指纹变化那条证据照常可用）。
- **自动禁用未在真实故障现场复现"确证缺失"**：全部是离线夹具（私有 `DSH_HOME` + 自造补丁/包树）。
- **桌面端真机上的 D4 自动回观察者未实测**：只做了判据注入 + 假 ctx 真跑路由（离线），
  真机 IPC/进程形态与注入不同。
- `scripts/safe-boot.mjs` 的 `--home` / `--profile` 推导只做了夹具级验证，未在真实 `DSH_HOME` 上跑恢复。
- 两个 live profile 只做**文件级同步（未重启）**：服务端路由要等对应实例重启才生效。

## v0.5.31 — 通用性/去本机化批次（3 条本机写死 + 去标识化，2026-09-29）

> 本版是**可移植性专项**：把源码、注释、文案、文档里残留的「开发机色彩」（本机盘符、本机用户名、
> 本机缓存目录、仓库外私有方案稿路径）清出去，并修掉三条**只因本机环境恰好满足才没爆**的真缺陷。
> **win32 上的现有行为一字不改**；非 win32 从"静默假成功"改为"明确拒绝"。
> 判据不是"肉眼看着干净"，而是对**所有已跟踪文件**（208 个，202 个可解码文本）跑同一份扫描：
> 本机用户名（含中文）与其百分号编码、POSIX 家目录前缀、npm 凭据键名、私钥块头
> **各 0 命中**；剩余命中全部落在下面的允许清单里（第三方包名 / npm 环境变量名 / token 形状正则 /
> 通用示例路径 / `homedir()` 派生）。

### 改错：三条 🔴（本机写死 / 非 Windows 假成功）

- 🔴① **`lib/server/domain/framework.js` 把开发机的 npx 缓存盘符写进了源码**
  （`'<盘符>:\node_cache\_npx'`，随 npm 发给所有用户）。缓存根改为**全部由「环境变量 / 用户自己的配置 /
  用户目录」派生**：`NODE_CACHE` → `npm_config_cache` / `NPM_CONFIG_CACHE` → 用户级 `~/.npmrc` 的
  `cache=`（npm 自己的配置来源）→ `~/.npm/_npx` → `%LOCALAPPDATA%\node_cache\_npx`。
  顺带修掉同族的两处：`LOCALAPPDATA` 缺失时旧代码会拼出**相对路径** `node_cache/_npx`（相对 CWD）；
  `readdirSync` 失败会把异常抛给调用方（本函数契约是「定位不到返回 null，不抛」）。
  `scripts/apply-framework-patch.cjs` 里同一份候选同步改掉。

- 🔴② **`lib/server/domain/ai.js` 的 Python 解释器候选全是 Windows 形态**，且第一条写死本机绝对路径
  （`<盘符>:\python314\python.exe`）—— 非 Windows 上永远解析不到，`${python}` 会退化成 Windows 专有名字。
  改为**按平台分支**：win32 用 `homedir()/AppData/Local/Programs/Python/Python314/python.exe` + PATH 上的
  `python.exe`；POSIX 用 `/usr/bin/python3`、`/usr/local/bin/python3`、PATH 上的 `python3`/`python`；
  解析不到时返回**本平台的命令名**（由执行阶段如实报错），不在解析期抛。配套：run-cmd 白名单补 `python3`
  （否则非 win32 上 `${python}=python3` 会被自己的白名单拒掉）。
  同一文件里 OpenViking 数据根由「无条件返回 `'D:/OpenVikingData'`」改为三分支：环境变量
  `DSH_OPENVIKING_DATA_ROOT` → win32 保留历史默认 → 其他平台 `${home}/.openviking/ascii-data`；
  AI 提示词改用占位符 `${asciiData}`，文案里不再写盘符。旧实现在非 Windows 上返回的是**相对路径**，
  会被写进服务进程的 CWD（"ASCII 数据根"根本没生效）。写盘白名单同步收敛到同一条派生。

- 🔴③ **非 Windows 上「一键框架升级/回滚」会假成功**（`lib/server/routes/framework-upgrade.js`、
  `lib/server/routes/framework.js`）。该通道整体建立在 Windows 机制上（`schtasks.exe` 计划任务 +
  PowerShell + `Get-NetTCPConnection`），非 Windows 上 `execFile('schtasks.exe')` 必然 ENOENT，
  而旧实现会：先 `writeFileSync` 一个「脚本已通过 detached 启动」的状态文件 → 再 exec 不存在的
  `powershell.exe`（静默失败）→ **照样** `upgraded = true` 并回 `ok: true, steps: ['框架升级脚本已启动…']`。
  用户看到"已启动"，实际一个字节都没动。现在把平台守卫插在**入参校验（400 分支）之后、任何副作用
  （备份 / 预禁用 / 写脚本 / 建计划任务）之前**：非 win32 → `501` + 结构化拒绝载荷
  （`code: 'unsupported-platform'` + 手动升级出路），**绝不返回 `ok:true`**、不写状态文件、不 spawn；
  回滚路由挂同一个守卫。"请求本身不合法"仍如实 400，"平台做不到"绝不假成功。

### 加法

- **新测试 `tests/test-framework-upgrade-platform.mjs`**（18 断言，进 CI 硬门槛）：用 `process.platform`
  注入 + 注入 `fetchJson` **真跑**两条路由，断言非 win32 → 501、`ok !== true`、`upgraded` 不存在、
  备份/预禁用**零调用**、不写 detached 状态文件、不生成脚本；win32 → 判据返回 `null`、路由包装器返回
  `false` 且不写响应（行为不变）；外加接线顺序（校验 → 守卫 → 副作用）与 `deps.fetchJson` 真通道兜底。
  全程离线，本机与 Linux CI 两侧都能验"另一侧"的行为。
- `lib/server/routes/index.js`：deps 表增 `fetchJson: fetchJsonUrl` 注入缝（默认即真通道，生产行为不变）。
- `tests/test-preset-declare.mjs` 新增 **③′**：原夹具路径全是 ASCII，导致「不吃空格、不出现裸中文」
  两条断言**恒真**（空断言）→ 补一个真含空格 + 非 ASCII 的目录夹具把它变成有效断言，
  并断言编码后 `fileURLToPath` 仍指回真实文件。
- `tests/test-preset-migration.mjs`：yaml 解析基准不再写死 `C:/Users/<本机用户名>/…`，改由 `dshHome()`
  派生；原来的静默 `console.log('SKIP …')` 改为**计数 SKIP** 并在汇总行点明「N 段未验证」。
- `.gitignore` 预防性规则：`*.bak-*`、`_tmp_*`、`.trash-*`、`.npmrc`、`.env`（都是"本机残留/私密配置"
  形态；当前仓库没有被跟踪的此类文件）。
- **去标识化（只动注释/文案/文档，不动逻辑）**：24 个 `lib/**` 文件里指向仓库外私有方案稿的分层注释 →
  改指仓库内**有约束力**的落点（`tests/test-architecture-guard.mjs` 的分层断言）；另清掉 8 处别的机器
  路径注释（`components` / `github-login` / `release-source` / `exec` / `fsx` / `framework` / `dep-source`
  / `client.js` 的本地裸仓库示例）。README / README.zh / CONTRIBUTING / SECURITY 的仓库 URL 统一为现名
  `Noob-stupid/dsh-plugin-gating-hub`（**保留** `-refactor` 预览线仓名不动），两处过期版本文案改
  "最新发布版"；12 套测试夹具的本机用户名/盘符 → 中性占位（`C:\Users\user`、
  `file:///C:/Users/%E7%94%A8%E6%88%B7/…`、`C:\Harness\…`、`C:\nodejs`、`C:\npx-cache`），
  路径形状/空格/怪字符保留，断言语义不变。

### 测试与门槛

- 本机 `node tests/run-all.mjs` → **71 套，失败 0 套**（exit 0；70 个测试文件，其中 `test-dep-pin`
  按设计跑两遍：带 `DSH_TEST_SKIP_NETWORK` 与不带各一次）。
- 架构守卫 ALL PASS：`lib/index.js` **142 行**（棘轮 142，未上调）；`lib/server/**` 76 个 `.js` 只有
  `routes/framework-upgrade.js` 超 600（**699 / 例外上限 700**，仍是唯一受限例外）。
- 1 红测试修复：`tests/test-issue15-resolve.mjs` 框架基准改用 `frameworkBases()` 多基准（`25fb988`），
  离线沙箱改放 `tests/.testdir` 而不是 `%TEMP%`（`c89578e`）。

### 未验证 / 已知项

- **非 Windows 的升级/回滚只做了平台注入验证，没有真机 Linux/macOS 运行**：本机与 CI 都是
  `process.platform` 注入 + 假 ctx 真跑路由，证明的是「判定与拒绝路径正确」，不是「非 Windows 上能升级」
  ——本来也不支持。
- `%LOCALAPPDATA%\node_cache\_npx` 这条候选保留了 `node_cache` 这个**目录名**（本机把 npm cache 重定向到
  那里的历史形态；npm 默认是 `%LOCALAPPDATA%\npm-cache`）。它是"够用的启发式"，未穷举所有重定向形态；
  稳妥判据是读 npm 自己配置的 `cache=`（已实现）与 `~/.npm/_npx`。
- **`D:/OpenVikingData` 是有意保留的例外**（1 处代码 + 2 处文档说明）：win32 下的历史默认值，保留是为了
  **不动用户既有数据位置**；想换位置可设 `DSH_OPENVIKING_DATA_ROOT`，非 win32 一律走 `homedir()` 派生。
- 两个 live profile 只做**文件级同步（未重启）**：服务端路由要等对应实例重启才生效。

## v0.5.30 — 补丁自愈误禁用真存在包（改错）+ 两条只读体检（加法，2026-09-29）

> ### ⚠️ 真机现象：用户的 `preset-router-*` 三条预设**在补丁里被自动停用**
>
> `~/.dsh/profiles/web/cordis.patch.yml` 尾部在 **2026-09-29 01:05:44** 被追加了 4 个块：
>
> ```yaml
> - id: preset-router-spec
>   disabled: true
> - id: workflow-worker-thread
>   disabled: true
> - id: preset-router-standard
>   disabled: true
> - id: preset-router-react
>   disabled: true
> ```
>
> 这 4 条**不是用户写的**，是 `healPatchSafety()`（`GET /state` 每 ≤2 分钟触发一次的补丁自愈）
> 自己写进去的。同一时刻 desktop profile **没有**被写。
>
> ### 根因：自愈判定"模块缺失"只用了**单基准**
>
> 旧实现：`resolvePackageJson(moduleName, profileDir) !== null` —— 只拿 **profile 目录**当解析基准。
> 而框架 0.2.0-rc.1 把 `@deepseek-ai/*` 的实体全部搬进 `.pnpm` **内部**那层
> （`<npx 缓存>\node_modules\.pnpm\@deepseek-ai+dsh@0.2.0-rc.1_<hash>\node_modules\@deepseek-ai\…`），
> profile 顶层只剩 0.1.5-rc.2 的残影（本机实测 239 个 `*.stale-*` 目录）。于是：
>
> | 包 | 单基准（profile 目录）| 真机事实 |
> |---|---|---|
> | `@deepseek-ai/dsh-agent-preset` | ❌ 解析不到 → 写 `disabled: true` | ✅ 真存在（`preset-router-*` 声明行全靠它）|
> | `@deepseek-ai/dsh-workflow-ptc` | ❌ 解析不到 → 写 `disabled: true` | ✅ 真存在（框架新工作流引擎）|
>
> 也就是：**自愈把"框架真带、但不在 profile 顶层"的包一律当成"用户引用了不存在的包"，
> 然后把用户正在用的行关掉了**。这不是提示，是写盘。
>
> ### 附带查实：`patch-audit` 的框架基准也差一层（同一 bug 的第二个副本）
>
> 只读体检 `routes/patch-audit.js` 里同样有取框架基准的代码，写的是
> `dirname(dirname(pkgPath))` —— `pkgPath` 形如 `<…>/node_modules/@deepseek-ai/dsh/package.json`，
> **两层 dirname 只退到 scope 目录** `<…>/node_modules/@deepseek-ai`（实测该路径下没有 `dsh`）。
> 于是 `bases` 里那一项永远解析不到任何包，只剩兜底值 —— 体检结论看着"有基准"，其实那一维是空的。

### 1. 改错：补丁自愈改**多基准并集** + 语义收紧 + 幂等零写盘

- **新模块 `lib/server/infra/framework-root.js`**（L0 infra，只依赖 `infra/paths.js`）：
  - `frameworkBases(baseDir, profileDir)` —— 框架运行时解析基准，**有序取并集**：
    ① `@deepseek-ai/dsh` 所在那层 `node_modules`（= `.pnpm` 实体内部，框架内置包真正的家）
    ② 从 ① 向上第一个含 `.pnpm` 的目录 ③ 都拿不到时用 profile 目录兜底（**绝不返回空数组**）。
    取层用 **`dirname` × 3**（package.json → dsh → `@deepseek-ai` → `node_modules`），
    并对"基准本身就叫 node_modules"的写法退一级再试。
  - `isFrameworkModuleName()` / `basePackageName()` / `isUnder()` / `FRAMEWORK_SCOPE`。
  - **`routes/patch-audit.js` 改为复用它** —— 两处判据从此只有一份（各写一份的话，
    框架下次再挪目录只会有一处被修好；本次事故正是"一处跟上了、另一处没跟上"）。
- **`lib/server/domain/patch.js` · `healPatchSafety(patchPath, deps)`** 三条硬约束：
  - **确证缺失才禁用**：解析器报 `uncertain` / 一个基准都没有 / 解析器抛异常 → 只进 `uncertain` 报告，**不写盘**。
  - **框架命名空间 `@deepseek-ai/*` 永不自动禁用**：命中只进 `skipped: [{reason:'framework-owned'}]`。
    它们是框架自带包，随版本增删由框架自己管；写 `disabled: true` 等于用旧判断把新框架的组件停掉。
  - **幂等零写盘**：没有真正需要修复的内容时一个字节都不写（`healedAt=0`）；算出的新内容先与原文
    **逐字节比较**才落盘。`GET /state` 每 ≤2 分钟就调一次本函数，过去即使无事也整份重写用户补丁。
  - **写盘失败如实回报**：`written:false` + `writeError` 带真因 + `healedAt=0`（不谎报"已修复"）；
    写盘后**读回核实**，不一致也算 `writeError`。
  - 返回值扩展为 `{ healed, autoDisabled, skipped, uncertain, healedAt, written, writeError }`。
- **`lib/server/infra/package-resolve.js`**：`makePackageResolver` 收纳两种基准写法 ——
  base 是"含 `node_modules` 的目录"（如 profile 目录）时探针放 `<base>/__patch_audit_probe__.js`，
  base 本身就叫 `node_modules` 时探针放它内部（否则会去找 `<…>/node_modules/node_modules`，
  把真存在的包判成不存在）。`listAvailablePackages` 行为不变。
- **`lib/server/routes/state.js`**：`patchHeal` 下发 `written` / `writeError` / `skippedFrameworkOwned` / `uncertain`；
  自愈本身抛异常也如实进 `patchHeal`（过去是 `catch {}`，面板看不出任何异常）。
- **新测试 `tests/test-patch-heal-safety.mjs`**（278 行，全离线：私有临时沙箱 + 自造桩包树，
  **不碰真实 profile、不用网络**），8 段 35 断言，已接进 CI 硬门槛：
  ① 多基准解析器（`.pnpm` 内层命中 / 两种基准写法 / `dirname×3` 而非 `×2` 的取层回归 / 空基准不假装命中）
  ② **单基准失败不再导致禁用**（profile 顶层解析不到、框架树能解析 → 零写盘零禁用）——本事故的直接回归
  ③ **无缺失时零写盘**（文件 SHA256 逐字节比对 + 连续两次幂等）+ 解析器抛异常/无基准只报告
  ④ **真缺失时仍如实禁用**（判据不许被修松）+ 二次调用幂等
  ⑤ 框架自带包永不自动禁用 + 不误伤第三方包
  ⑥ 写盘失败如实回报（`written=false` / `writeError` 带真因 / `healedAt=0` / 文件确实没变）
  ⑦ 核心行误禁用仍会被恢复（既有语义不回归）
  ⑧ 本机有真实 profile 时**真调真机框架树**（`dsh-agent-preset` / `dsh-workflow-ptc` 必须解析到，
  已移除的 `dsh-workflow-worker-thread` 必须仍报"解析不到"）；CI 无 profile 则**响亮 SKIP**

### 2. 改错：desktop 补丁 3 处行仍指向**已被框架移除**的包

- 框架 0.2.0-rc.1 移除了 `@deepseek-ai/dsh-workflow-worker-thread`（引擎重构为 `…-workflow-ptc`），
  而 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 **L312 / L610 / L916** 仍写着旧包名。
  该行解析失败 → 隔离组里 `workflowEngine` 没有提供方 → `dsh-tool-workflow` / `dsh-tool-ralph`
  （`inject` 含 `workflowEngine`）永久 waiting → 老会话 resume 失败，真机报错原文：
  `RemoteError: tool-workflow (@deepseek-ai/dsh-tool-workflow): waiting for workflowEngine …`
- 只改这 3 行的包名 → `@deepseek-ai/dsh-workflow-ptc`（**以实测为准**：registry 上
  `dsh-workflow-ptc` 有 7 个版本、含框架实际使用的 `0.2.0-rc.1`；`dsh-workflow-worker-thread`
  已从框架 `.pnpm` 树消失）。备份 + 严格 YAML 解析 + 读回核实 + 逐行 diff（只 3 行变）。
- 体检前后对比（隔离实例，真分发器 + 真框架树）：**desktop `patch-audit` blockers 4 → 0**；
  web profile 的 3 条同名 blocker 同批修掉 → 也 **0**。

### 3. 加法：两条**只读**体检接口 + 框架残留识别

- **`GET /plugin-console/patch-audit`**（`domain/patch-composition-audit.js` + `routes/patch-audit.js`）：
  把补丁里的每一行"行 → 包"拿到**真实 Node 解析器 + 多基准**上核对，分四类输出：
  解析失败=blocker（已 `disabled` 的降级为 warning）、`file://` 目标缺失=blocker、
  子路径解析失败=warning、只改配置的行=合法补丁形态。**只报告、绝不代改**；
  改名建议只来自真机确证表（`KNOWN_RENAMES`，逐条带证据），猜不到的只列候选。
- **`GET /plugin-console/preset-audit`**（`domain/preset-audit.js` + `routes/preset-audit.js`）：
  磁盘预设（`.agent-presets/*/agent.cordis.yml`）的**文件型**自声明 ↔ profile 补丁里的
  `file:///` 声明行跨源对账，输出 stale / missing / orphan / targetMissing。
  **目标按目录归属匹配**（`router-*` 三个预设各有同名 id `router-bootstrap`，只能靠目录区分）。
- **`domain/framework-residuals.js` / `domain/framework-cleanup.js`**：识别框架升级留下的
  `*.stale-<版本>-<时间戳>` 残影目录与 `framework-backups`，区分"可清 / 在用"，**只报告不代删**。
- **`infra/registry-versions.js`**：registry 版本查询（多源、超时、只读）。
- **`domain/compat.js` / `routes/compat.js` + `lib/client.js`**：兼容提示可手动关闭
  （按版本 ack + 展示模式；**只影响展示，不改 `supported` 判定**）。
- **`routes/framework-preflight.js` / `domain/exec.js` / `routes/plugins.js`**：升级前预检接线与
  pnpm 通道健壮性。
- **测试**：新增 `tests/test-patch-composition-audit.mjs`（177 行，含真机抓到的"缩进 2 时假绿"回归、
  89 条假缺失回归）、`tests/test-preset-audit.mjs`（126 行）、`tests/test-framework-residuals.mjs`（141 行）、
  `tests/test-compat-notice.mjs`（71 行）、`tests/test-patch-heal-safety.mjs`（278 行）；
  `tests/test-route-inventory.mjs` +72 行固化**方法契约**（声明 GET 的路由必须住在 405 守卫之前，
  否则恒 405 —— 0.5.29 活体实例上这两条接口正是如此）。
  **五套新测试全部接进 `.github/workflows/test.yml` 的硬门槛**（此前只在本机 `tests/run-all.mjs` 里跑，
  等于没进门禁）。

- 标志/行为不变：**所有既有写入形态、既有备份命名、既有判据语义一字未改**；
  只有"什么算确证缺失"与"要不要写盘"这两处被收紧。`CORE_PATCH_ROW_IDS` 与核心行恢复逻辑原样保留。

### 4. 本版一并收口的既有成果（此前工作区内的 22 项改动）

第 3 节里的 `patch-composition-audit` / `preset-audit` / `framework-residuals` / `framework-cleanup` /
`registry-versions` / `compat-notice` / 405 修复等内容，对应此前工作区里那 22 项未提交改动；
本版把它们与本节的 A/B/C 三项修复**一起**发出去（`0.5.30` 是唯一一版）。

### 未验证 / 已知项（如实列出，不粉饰）

- **`tests/test-issue15-resolve.mjs` 在本机红**（`官方: @deepseek-ai/dsh-settings: noFallback=null withFallback=null`）。
  这是**环境漂移**、与本批改动无关：把 `lib/server/infra/paths.js` 换成 **clean HEAD** 的版本逐条重跑，
  四个 case 结果**逐字相同**（三个第三方 FOUND、官方那个 null）。真因是框架 0.2.0-rc.1 把
  `dsh-settings` 实体留在 `.pnpm` 内部（顶层只有 `dsh-settings.stale-0.1.5-rc.2-*` 残影），
  而该测试硬编码的 `frameworkBase` 指向框架包自身（`…/@deepseek-ai/dsh`，不是 `node_modules`）。
  CI 上该测试因无本机 profile 而 **SKIP**（`DSH_TEST_FRAMEWORK_BASE` 未设）。
- **`GET /state` 的 `patchHeal` 新字段（`written`/`writeError`/`skippedFrameworkOwned`/`uncertain`）
  只在隔离实例上验过**；3080 本体未重启（由用户自行重启），所以线上尚未产生这两个字段。
- **preset-audit 报 web profile 有 1 条 `stale`**（`router-spec` 的 `router-bootstrap` 行指向 v1，
  而预设目录自己声明 v10）。这是**既有真实差异**，本版**只报告不代改** —— 改哪一边要用户定。
- **desktop 补丁 L38 的 `@linxin666/dsh-client-ui-skin-center`** 在"没有第三方 node_modules"的
  纯净隔离沙箱里会报 blocker；接上真实 `node_modules` 后为 0 blocker（该包是用户装的第三方插件）。
- 未做：把 `healPatchSafety` 的新返回值接进 `lib/client.js` 的界面展示（本版只保证接口如实下发）。

## v0.5.29 — 预设卡片「加载失败」：写声明行前校验插件契约（改错 + 加法，2026-09-27）

> ### ⚠️ 真机现象：`router-spec` 卡片红框「加载失败」，另两条同来源的预设却正常
>
> 桌面端（官方桌面端实例，PID 19387）预设选择器里三张卡：**`router-react`、`router-standard` 正常**，
> **`router-spec` 顶着一枚红框「加载失败」**。那枚徽标是**框架自己的**文案
> （`@deepseek-ai/dsh-client-ui-agent-preset` 的 i18n 串 `brokenBadge: "加载失败"`），
> 数据源是 `agentPresets.list()[].broken` —— 也就是框架注册表算出来的**装配诊断**。
>
> **真实错误原文**（从活体实例直接读回，不是推测）：
>
> ```
> BROKEN  router-spec
>         persona (@deepseek-ai/dsh-persona): invalid config:
>           - $.prefix missing required value (at prefix)
> ```
>
> 本机复现路径：起一个隔离实例（临时 `DSH_HOME`，预设目录整份照抄真机字节），
> 经 `POST /api/agentPresets/list` 读回（信封 `{type:'client-request',rpcId,method,payload}`）。
>
> ### 根因：装配落盘的 composition 用了框架 schema **读不到**的键名
>
> - 框架 `@deepseek-ai/dsh-persona@0.1.7-rc.2` 的 Config 是 `prefix: z.string().required()`
>   （`+ suffix/complete/includeRuntimeContext`，**没有 `text`**）。
> - 真机 `~/.dsh/.agent-presets/router-spec/agent.cordis.yml` 第 40 行写的是 **`config.text`**；
>   同一句文案在 `router-react` 里写的是 `config.prefix` —— 这两个预设的 plugins 列表
>   **顶层 id 完全相同（18 条）**，逐行比对**只有 persona 这一处**落在 schema 外
>   （另一处差异是 `router-bootstrap` 的文件名与 `routerMode` 值，那是设计差异不是缺陷）。
> - 于是装配该行时框架抛 `$.prefix missing required value`；注册表 `activate()` 把异常吞成
>   `record.broken`（只打一条 `logger.warn`），`list()` 把 `broken` 交给界面 → 徽标永久亮红。
>
> ### 为什么改前一条判据都拦不住 / 为什么"早就有的迁移"没生效
>
> 1. `preset-yaml.js` 只判**结构**（空文件 / tab 缩进 / 未闭合引号 / 缩进跳级）——
>    `text:` 结构完全合法，`!!js`、块标量、注释都照旧。
> 2. `file:///` 目标**确实存在**、包名**确实存在** —— 那两个维度也是干净的。
> 3. 仓库里**早就有** `text → prefix` 的迁移表（`presets.js` 的 `PRESET_CONFIG_MIGRATIONS`），
>    但它挂在**框架升级**那一步（`routes/framework-upgrade.js` → `migrateAgentConfigsForUpgrade`）。
>    而预设落盘不止"升级"一条路 —— **装预设型子包 / 源码装配 / 手工放文件都会写
>    `agent.cordis.yml`，那些路完全不经过升级步骤**。本机事实佐证：
>    `router-spec/agent.cordis.yml` 是当天 21:27 装配落盘的，升级步骤根本没参与；
>    同一时刻生成的 web profile 补丁里 persona 是 `prefix`（老世代内容），
>    桌面 profile 补丁里是 `text` —— **同一个预设、两条路，走岔了**。

### 1. 改错：写声明行**之前**校验插件契约，命中即如实拒绝写入

- **新模块 `lib/server/domain/preset-rows.js`**（L1 domain，纯函数、可注入、无 IO）：
  - `parseCompositionRows()` —— 把 composition 解析成「行 id → name / config 直属子键」。
    **先归一 CRLF**（真机磁盘上的 `agent.cordis.yml` 就是 CRLF，行尾 `\r` 会让行级判据整体失配；
    自测真抓到过：归一一条都不命中）。
  - `validatePresetPluginRows()` —— 三类判据，**全部在动手写之前**：
    - ① 行结构：不是映射 / 没有非空 `name` / composition 里一条插件行都没有（框架
      `entryListProblem` 同样会拒）；
    - ② `file:///` 引用目标**必须存在**，且必须能真的解码成磁盘路径
      （坏百分号编码 `%zz` 在 URL 层"合法"，到加载器才知道读不了 —— 正是要在写行前拦下的形状）；
    - ②′ **相对引用**（`./x.mjs`）在预设目录里**必须存在**：声明行落在 profile 补丁里，
      相对基准已变成 profile 目录，预设目录里又没有那个文件可改写 → 留着必然加载失败。
      改前行为是"照写、留给读回核实判红"，而那时**用户补丁已经被改动了**
      （自测真抓到过这个形状：`ok:false` + `reason:verify-failed` + 补丁已写坏）——
      现在拦在写之前，**拒绝 = 一个字节都不写**；
    - ③ **已确证的框架契约**：`@deepseek-ai/dsh-persona` 必填 `prefix`。命中即判红，并**如实点名**
      是哪个行 id、哪个包、缺哪个键、**框架会抛的原文**，外加上路。
  - `PLUGIN_ROW_CONSTRAINTS` —— 判据表**故意不猜**：只收「拿真机错误 + 框架真 schema 双向确证过」的条目，
    没有证据的插件一律放行。宁可漏判，也绝不因为猜错而把一个**本来可用**的预设挡在门外
    （那是把缺陷换个方向；与 `preset-yaml.js` 的宽严分寸同一取舍）。
- `preset-declare.js` 接线：`buildPresetDeclaration()` 在 `validateAgentConfig`（结构）之后、
  写行之前调契约校验；不通过 → `ok:false` + `reason`（`unresolvable-plugin-file` /
  `invalid-plugin-rows`）+ `detail`（逐条明细 + 出路）+ `problems`，**绝不写一行必然「加载失败」的声明**。

### 2. 加法：把「旧键迁移」挂到**写行那一刻**，并让迁移表全仓唯一

- **同一张表**：`PRESET_CONFIG_KEY_MIGRATIONS` 现在定义在 `preset-rows.js`，
  `presets.js` 的 `PRESET_CONFIG_MIGRATIONS` 从它取（升级那条路与写行这条路**判据不再分叉**）。
- **新函数 `migratePluginRowKeys()`**（纯文本、不碰盘）：只改 `name:` 精确命中该插件的行，
  且**仅当该行 config 里还没有真键** —— 已有 `prefix` 就一个字节都不动，
  **绝不覆盖用户自己写的值**；非 persona 行的 `text` 一动不动（不误伤别的插件）。
- **版本判据的取舍（很要紧）**：低于迁移引入版本 → 不迁（老框架要的正是 `text`）；
  但**版本未知时按最新处理并迁移** —— 声明行这套机制只在框架 0.1.7-rc.x 起存在，
  能走到这里的场景必然 ≥ 0.1.7；反过来若按"版本未知就不动"处理，就会在拿不到版本时
  **又写出那行必然「加载失败」的声明**，把本函数存在的意义整条抹掉（真机 D-⑦ 现场正是"拿不到版本"）。
- 声明结果的 `note` 如实点名迁移（`@deepseek-ai/dsh-persona 的 text → prefix（第 40 行）`），
  与既有的「相对文件已改写为 file: URL」同一句式，**不出现 `undefined`**。

### 3. 测试（全离线，已进 `test.yml` 硬门槛）

- **新增 `tests/test-preset-rows.mjs`（52 条断言）**：判据（persona 缺 prefix / `file:///` 不存在 /
  坏 file: URL / 相对引用不存在 / 行无 name / 空 composition）；**不误杀**
  （CRLF、块标量 `>-` persona 里的伪键、空 config、无 config、disabled 行、非 persona 的 `text` 全放行）；
  迁移（命中行/值一字不差/已有 prefix 不覆盖/两键并存不覆盖/非 persona 不动/CRLF 也能迁）；
  版本判据（低版本不迁、**未知版本照迁**）；接线（`declarePresetRow` 拒绝写坏行 + **补丁零字节改动**、
  真机形状写成且行里是 `prefix`、file: URL 改写正确、读回核实 6 项全过、二次声明幂等）。
- `tests/test-preset-declare.mjs` 的一个夹具补齐了它引用的两个 `.mjs` 文件
  （新判据正确地拒绝了那个"引用了不存在文件"的夹具 —— 这正是它该做的）。

### 4. 真机验收（官方桌面端，3080 全程未重启）

- **改前（活体取证）**：隔离复现实例（预设目录整份照抄真机字节）读回 → `router-spec` 报
  `persona (@deepseek-ai/dsh-persona): invalid config: - $.prefix missing required value (at prefix)`；
  同一读回里 `router-react` / `router-standard` **没有这一条**。
- **改后（隔离实例端到端）**：用修复后的代码重新生成声明行 → 同一条读回里 **persona 那条诊断消失**
  （`router-spec` 的剩余行与另两条完全一致）。
- **真机 profile 修复（可审计）**：对 `profiles/desktop/cordis.patch.yml` 调**产品自己的**
  `declarePresetRow()`：
  - 改前备份：`plugin-console/profile-sync-backups/cordis.patch.yml.bak-0529-presetfix-<ts>`
    （SHA256 `0f0814ec…4ba1`，55495 B）+ 预设源文件备份（SHA256 `9cadb89e…6d84`）；
  - 结果：`ok=true status=updated`，迁移 `@deepseek-ai/dsh-persona 的 text → prefix（第 40 行）`，
    读回核实 **6/6 通过**；框架视角严格 YAML 解析 OK（顶层 11 条、三条 `insert` 行齐、`plugins` 18 行）；
  - 复验：`persona.config = {"prefix":"You are a helpful software engineer assistant."}`，
    三条 `preset-router-*` 行都在、各 31 条 composition 行**全部通过**新契约判据；
  - 补丁 SHA256 `11ad1eb2…b627`（55502 B，**+7 字节** = `text`→`prefix` 的 2 字节 + 一处相对引用改写为
    `file:///` URL 的 5 字节）；**预设源文件 `agent.cordis.yml` 一个字节都没动**（SHA256 与备份一致）。
- **未改动** `developerTools`（那是用户自己的开关）；**未重启 3080 网页实例**。

### 5. 顺手查实的**另一件事**（不是本版根因，独立记录）

`@deepseek-ai/dsh-workflow-worker-thread` 在框架 0.1.7-rc.2 的安装树里**没有实体**
（`.pnpm` 下无对应目录），只有一份**陈旧孤儿**留在 `node_modules/@deepseek-ai/` 顶层且版本是
`0.1.5-rc.2`；`profiles/node_modules/@deepseek-ai/dsh-workflow-worker-thread` 也是指向它的 junction。
后果：预设里那条 `workflow-worker-thread` 行装配时 `never started`
（框架 `auditRows` 把它记成可诊断项，**不**导致整个预设挂载失败 —— 所以卡片照常显示）。
由于三条 `preset-router-*` 的该行完全相同、而真机上另两条卡片正常，判定它是**环境性**问题
（框架安装树陈旧残留：0.1.5 时代留下的顶层包没被清掉，0.1.7-rc.2 又不再分发它），
**不是**本次「加载失败」的根因，本版**不改**它；留作独立跟进。
（`@deepseek-ai/dsh-persona` 那一条与本缺陷无关：它在 0.1.7-rc.2 树里是**正常实体**。）

### 6. 发布门槛证据

- 本地干净全量：**59 套测试 / 0 失败**（含新增 `test-preset-rows.mjs` 52 条断言；
  `test-architecture-guard.mjs` 绿：`lib/server/**` 单文件均 ≤ 600 行 —— `preset-rows.js` 272 行、
  `preset-declare.js` 545 行）。
- CI（GitHub Actions `tests`，push 触发）：run [36329283413](https://github.com/Noob-stupid/dsh-plugin-gating-hub/actions/runs/36329283413)
  commit `f08c05e`，**5 个 step 全绿**（Syntax check / Unit tests / Real install-uninstall smoke /
  Real channel smoke / Environment-dependent tests），耗时 5m11s。

## v0.5.28 — 预设机制迁移：装配预设时同时写**声明行**（改错 + 加法，2026-09-27）

> ### ⚠️ 框架 0.1.7-rc.x 起，预设**不再靠目录发现**，改为 profile 补丁里的**声明行**
>
> 这是本版要跟上的**机制迁移**，只读诊断结论如下（都可在本机复现）：
>
> - **0.1.5 及更早**：`@deepseek-ai/dsh-agent-presets` 扫描 `$DSH_HOME/.agent-presets/` 目录发现预设
>   （该包常量 `USER_PRESET_DIR = '.agent-presets'`，逐项用 `PRESET_ID = /^[a-z0-9][a-z0-9-]*$/` 校验）。
> - **0.1.7-rc.2 起**：该包**不在依赖图、也没被挂载**（`node_modules/@deepseek-ai/` 下已无实体）；
>   `dsh-agent-preset-registry` 的 `definitions` 是**内存 Map、没有任何 fs 调用** —— **目录发现被彻底移除**。
> - **现行载体**：profile `cordis.patch.yml` 里的一行
>   ```yaml
>   - insert:
>       - id: preset-<x>
>         name: '@deepseek-ai/dsh-agent-preset'
>         config:
>           id: <预设 id>          # 必填
>           name: <显示名>          # 给了 name 才会出现在「自定义」分组
>           description: <说明>
>           order: <数字>
>           plugins: [ ... ]        # 就是旧 agent.cordis.yml 的内容
>   ```
>   schema 见 `@deepseek-ai/dsh-agent-preset@0.1.7-rc.2/lib/index.js:13-25`（`id`/`plugins` 必填）。
> - **相对路径基准变了**：声明行的 `./x.mjs` 相对**profile 目录**（不是预设目录）→ 必须改写成 `file:///<绝对路径>`。
>
> **后果**（本版要修的真 bug）：本插件 0.5.27 及以前只把预设写进 `~/.dsh/.agent-presets/`，
> 然后提示"**新建会话时选择**" —— 在新框架上这是**一句谎话**：
> 没有声明行的预设**不会出现在选择器里**（官方桌面端「自定义」分组为空正是这个原因），
> 而老会话 `resume` 还会直接失败：`RemoteError: Unknown agent preset: <id>`。

### 1. 加：装配预设时**同时生成声明行**（产品缺口修复）

- **新模块 `lib/server/domain/preset-declare.js`**：一句话职责 —— **幂等地**把 `preset-<id>` 声明行写进目标
  profile 的补丁文件。行为逐条：
  - `config.id/name/description/order` 取自预设目录（`preset.yml` → `name/description/order`，
    **缺省有合理默认**：name 回退目录名、description 不回退（可选字段，不编）、order 回退 `1000`（不抢内置预设位置））；
    `plugins` 取自 `agent.cordis.yml`；
  - `plugins` 里所有**确实存在于预设目录**的相对文件（`./x.mjs`）→ `file:///` + 绝对路径
    （`pathToFileURL`，中文用户名按 URL 规则百分号编码，例：`file:///C:/Users/%E7%94%A8%E6%88%B7/…`）；
    预设目录里**不存在**的同名文件**原样保留** —— 那种相对引用在 profile 下本来就不通，没有依据替它猜路径，不猜；
  - 行 id 固定 `preset-<id>`（与官方内置 `preset-standard` / `preset-minimal` / `preset-ptc` / `preset-cordis` 同一命名法）；
  - **同 id 行已存在 → 原地更新，绝不重复插入**（重复会让注册表 `Duplicate agent preset: <id>` 直接抛）；
    顺手清掉历史遗留的重复同 id 行；
  - 内容逐字节一致 → **一个字节都不写、也不建备份**（真正的幂等）；
  - 真写盘时先备份 `.bak-preset-<时间戳>`（同毫秒自增后缀，绝不互相覆盖），**再写**；
  - **写后读回核实**：真解析回来逐字段比对（行在、模块名对、`config.id`/`name`/`description`/`order` 一致、
    `plugins` 与磁盘 `agent.cordis.yml` 逐行一致、无残留相对引用）；任一条不通过 → `ok:false + 原因`；
  - 写入前清掉顶层 `[]` 占位符（issue #7 事故：`[]` 后面再跟条目是非法 YAML，`dsh` 启动直接崩）。
- **接线（加法，安装路径全部自动带上这一步）**：
  - `assemblePreset`（唯一的预设落盘实现）新增 `patchPath` / `profileDir` 两个**可选**入参：
    给了就声明并进 `declaration` 字段；**都没给就一个字节都不写**，且 note **如实**说
    "文件已就位，但当前框架版本需要声明行才能显示"（绝不宣称"新建会话时选择"）；
  - `tryPresetSourceChannel`（批次 D-③ 源码通道）、`installPresetsCarriedByPackage`（批次 D-⑥ 随包分发）、
    `overwritePreset`（「覆盖该预设」显式动作）、`runSuiteInstallJob`（套装路径）四条路全部把目标 profile 传下去；
  - `install-job.js` 的目标 profile 由 `findPatchPath(ports)` 推导（= `dirname(patch)`），
    **绝不写死任何本机路径**；
  - 结构字段随 `presetInstalled[].declaration` 一并下发（老客户端忽略，向后兼容）。
- **文案改错**（这是本次最容易继续骗人的地方）：所有"新建会话时选择"改为**按实际落盘/声明结果生成**：
  - 声明成功 → 「已声明为预设行 `preset-x`（写入 `<profile>/cordis.patch.yml`）；**重启实例后**在新会话可选」；
  - 声明未写成 → 「**文件已就位，但当前框架版本（0.1.7-rc.x 起预设改为声明行）需要声明行才能在界面上显示** ——
    本次声明未写成（<具体原因>）。出路：在目标 profile 的 `cordis.patch.yml` 里补一行 …」，并**不再说**"重启实例后即可选"
    （那时还没写成，重启也不会出现它）；
  - 覆盖到的位置：`preset-install.js`（`assemblePreset` 的 note + 新 `declarationClause`/`declarationClauseForReports`）、
    `preset-source.js`（通道 note）、`preset-in-package.js`（`job.presetNote` + 结构化 summary）、
    `suite.js`（`suiteNote` + 报告项）、`lib/client.js`（中英两套 i18n 短句）。
- 测试：新增 `tests/test-preset-declare.mjs`（**77 断言**，进 CI 硬门槛、全离线）：行形状、相对引用改写
  （含"预设目录里不存在 → 原样保留"与"已是绝对路径 → 一动不动"）、幂等、原地更新 + 备份、
  重复行清理、`[]` 占位符清理、读回核实（真解析 + 篡改必须判红）、**七条失败路径**都必须如实报、
  `assemblePreset` 接线（给 patchPath 就声明 / 不给就一个字节不写 / 声明抛异常不把装配带崩）。
  另更新 7 套既有用例的旧文案断言（`test-preset-{source,overwrite,channel-wiring,in-package}`、
  `test-{real-preset-e2e,suite-install}`），并给 `assemblePreset` 的调用点补 `await`
  （装配现在是 async：写声明行要走串行写队列，忘了 `await` 会"明明写成了却报没写成"）。

### 2. 改错：升级前契约预检的"用户预设扫描面"**少了一个点**（真 bug）

- `lib/server/routes/framework-preflight.js` 原本是 `join(dshHome(), 'agent-presets')` —— **不带点**，
  而框架的目录是 `<DSH_HOME>/.agent-presets`。于是预检的"用户预设扫描面"**一直指向一个不存在的目录**：
  静默扫到 **0 个文件**，预设里的 V3 生产方**从来没被预检看见**（升级前"0 blocker"的结论因此是**假绿**）。
- 改为单一推导点 `userPresetsRoot()`（`join(dshHome(), '.agent-presets')`）并导出；
  同步修 `lib/server/domain/format-scan.js` 顶部同样写错的注释（`~/.dsh/agent-presets/**` → `~/.dsh/.agent-presets/**`）；
  `lib/client.js` 的预检说明文案同步为 `.agent-presets`。
- 测试：`tests/test-format-preflight.mjs` 的夹具目录从 `agent-presets` 改为 **`.agent-presets`**（原来那个错字
  让"预设 2 处 blocker"之类的断言一直对一个**空目录**下结论），并补三条断言：
  扫描面**等于** `<dshHome>/.agent-presets`、预设扫描面**真的能扫到文件**（不再静默 0 文件）、
  路由报告里的 `roots` 也是同一个路径。

### 3. 改错：两处"本机色彩"的文案通用化（纯文案）

- `lib/server/domain/ai.js`：`用户名含中文` → `用户名/路径含非 ASCII 字符`（规则本来就是通用的：
  路径里有非 ASCII 字符时各语言的 Rust/原生向量库会报 `UnicodeDecodeError`，与用户名具体是不是中文无关）。
- `lib/server/routes/components.js`：报错示例（本机真实目录）→
  `C:\repos 或 \\server\share\repos`，并说明"任意绝对路径均可"。

### 测试与门槛

- 全量本地套件：**65 套 / 全 exit 0**（新增 1 套、修改 8 套）。
- `tests/test-architecture-guard.mjs` 绿：`lib/server/**` 单文件 ≤600 行、`lib/index.js` ≤142 行、
  依赖方向、`domain` 层不出现 `ctx`、无自由变量、导入绑定只读、`ctx/ports` 属性访问白名单。
- 新增 `tests/test-preset-declare.mjs` 进 `test.yml` **硬门槛**。

### 未验证项（如实列出，不假装已验）

- **框架侧"选择器里真的出现这三条预设"**：本版只做到"框架把它注册进了 loader 树"
  （真机桌面端 `/plugin-console/state` 的 `entries` 里出现 `include:preset-router-*` 且 `fiberPhase=active`），
  **没有**在真实 UI 里逐条点选、也没有跑一次带预设的会话（那需要新建会话 + 真实模型调用）。
- **预设挂载后的运行期行为**（路由/注入是否按预期生效）：不在本次范围内，未验证。
- **其他框架版本**（0.1.5-rc.2 及更早、0.1.7-rc.1）：只按 rc.2 的 schema 实现；更早版本走目录发现，
  写声明行的效果**未实测**（预期是"多一行无害的声明"，但未验证）。
- **非 Windows / 非中文用户名**：`file:///` 生成走 `pathToFileURL`（通用），但只在 Windows + 中文用户名下实测过。

## v0.5.27 — D-⑥ 预设随包分发不再被当成普通插件装（改错 + 加法，2026-09-27）

> **与 v0.5.26 的关系（更正）**：D-⑥ 的修复**不在 0.5.26 的 npm 产物里**。npm 上 `0.5.26` 的产物由
> commit `0312b62` 构建（registry `gitHead=0312b62a6a3b3bc5c9a1dccff1c210b352ab10b3`、`fileCount=74`）；
> 实测下载该 tarball：**74 个文件**，其中**没有** `lib/server/domain/preset-in-package.js`、
> 也**没有** `tests/test-preset-in-package.mjs` —— 两者都由 `e123fa1` 引入。本版（`0.5.27`）是 D-⑥
> **第一次**进入发布物。v0.5.26 段的「测试与门槛」「未验证项」按归属留在 v0.5.26 段，未搬动。

### 1. D-⑥（真机验证发现的**第三个缺陷**）：预设随包分发被当成普通插件装

真机现场（官方桌面端实例、0.5.25，卡片"子包"列表第三件的等价调用）：
`POST /install {repo:'yjh051108/dsh-routing-suite', packageName:'dsh-router-standard'}`
→ release 通道按包名反查到**它自己的仓库** `yjh051108/dsh-router-standard` 的 release v0.3.0 资产
（`dsh-router-standard-0.3.0.tgz`）→ 装成 `node_modules/dsh-router-standard@0.3.0`。那个包体里
**没有 `main`/`exports`、也没有 `dsh.bundle`**，只有 `preset/`（**两个**预设目录：`router-spec` /
`router-standard`；该资产实测 27 个文件、其中 14 个在 `preset/` 下）+ `docs/`。旧行为两个后果：

- ① **预设一个字节都没进** `~/.dsh/.agent-presets` → 用户依然用不上（预设才是他要的东西）；
- ② 却照样 `appendInsert` 了一行 `- insert: {id: dsh-router-standard}` → 注册一个**加载不了的模块行**
  （2026-09-06「装 dsh-desktop 后服务崩」事故同族：补丁行指向的模块没有入口）。

根因：判据只按**仓库**分类（有没有 `.gitmodules` / 是不是预设型子包名），没按**落地物**分类 ——
而"包里带 `agent.cordis.yml`"是**装完之后一定能看到**的事实（registry tarball / release 资产 /
git 规格三条路都会发生）。

- 加：新模块 `domain/preset-in-package.js`（`findCarriedPresets` / `installPresetsCarriedByPackage` /
  `settlePresetOutcome`）——任何通道装成功后、**写补丁行/声明依赖之前**先看落地物里有没有预设；
  有 → 走 `preset-install.js#assemblePreset`（**复用**既有装配：只补不覆盖 / 结构校验 / 备份 / 读回核实），
  按 `presetDone` 收口，**绝不写补丁行、绝不声明依赖**，并把来源记进 `preset-sources.json`
  （面板的「覆盖该预设」因此能重新取源码）。同名冲突照 0.5.26 的语义走**显式覆盖**动作。
- 测试：新增 `tests/test-preset-in-package.mjs`（**27 断言**，进 CI 硬门槛）：三种包体形状的预设识别、
  装配落盘 + job 收口（含"只补不覆盖时现有文件 sha 不变"与"下发覆盖动作"）、
  `runInstallJob` 端到端**不写补丁行/不声明依赖**、以及**反例**（普通插件包照旧写补丁行 + 声明依赖）。
- 测试基建修正：该用例的 `ports.loader.entries()` 必须喂一个 `cordis:include` 条目 ——
  否则 `findPatchPath` 会兜底到 `<DSH_HOME>/profiles/web/cordis.patch.yml`，
  于是"补丁行没被写"的断言落在**根本没被写过**的文件上（假绿）。

> **上游观察（本轮真机取证）**：release 资产里的预设是**旧快照**。
> `dsh-router-standard-0.3.0.tgz`（上游 release v0.3.0 资产，62363 B）里的
> `preset/router-standard/agent.cordis.yml` 是 **14248 B**
> （sha256 `ED1E515E96321AA6488E9D3C699C85AAAEFF0F7BB582C93D0DFBC6AE50DB6C68`）；
> 仓库源码 `yjh051108/dsh-routing-suite` 同路径是 **16232 B**
> （sha256 `27F13A9D9C60722AEF93AA8B765D464B8BD3946E766F8352FAF445878268CEA6`）。
> 资产里还多出 `router-bootstrap-v1/-v5/-v6/-v7/-v8.mjs` 这批**旧世代**引导文件
> （仓库源码现在是 `-v34` 世代 + `gitbash-executor.mjs`，`router-bootstrap.mjs` 85212 B vs 资产 16680 B）。
> 也就是说：**release 通道拿到的预设比仓库源码旧**。本版默认「只补不覆盖」恰好避免了用这份旧资产
> **盖掉用户已在用的预设**；要仓库版本必须显式点「覆盖该预设」—— 该动作按 `preset-sources.json`
> 记录的出处**重新取源码**（不是拿 release 资产）。

### 测试与门槛

- **干净全量（本机，无并发写者，一次跑完）**：`node tests/run-all.mjs` → **63 次套运行全部 exit 0**
  （62 个 `tests/test-*.mjs`；`test-dep-pin.mjs` 按 CI 的分法在 "unit" 与 "真 registry" 两组各跑一次）、
  **0 FAIL**、墙钟 **519.2 秒**。断言计数：各套自报格式不一（`PASS n / FAIL 0` 形式可统计的合计 **719** 条，
  其余为 `ALL PASS` / `15 passed, 0 failed` / `36 条` 等），**没有一套报失败**。
- 响亮 SKIP（打印原因、不假装 PASS）：`test-dep-pin` 在 unit 组 **2 组 SKIP**（该组本来就带
  `DSH_TEST_SKIP_NETWORK=1`）、`test-lockfile-repair` **1 组**真实环境未验证；而真 registry 组里的
  `test-dep-pin` 这次 **0 组 SKIP**（真网络可用）。
- CI（`tests` 工作流，commit `0bdf5ae` → run **36317841184**）：`Syntax check (hard gate)`、
  `Unit tests (hard gate)`、`Real install/uninstall smoke (temp DSH_HOME)`、
  `Real channel smoke (ghproxy / npmmirror)`、`Environment-dependent tests` **五步全绿**。
- 真机（官方桌面端 0.5.27）实测见 Release notes。

### 未验证项

- **「覆盖该预设」在真机上对"用户在用预设"的完整往返**：本机 `.agent-presets/router-standard` 是用户
  **自己改过**的版本（283 行、带一行自定义 `- id: pressure-sensor` / `name: ./pressure-sensor.mjs`，
  该文件上游没有），而仓库源码是 307 行且**没有**这一行 —— 覆盖会把它换成上游版本（整目录备份可回滚）。
  是否替用户按这个按钮由用户决定；离线侧由 `tests/test-preset-overwrite.mjs`（39 断言，真
  `runSuggestedAction` + 真 git + 本机裸仓库）覆盖。
- **`del /f /q` 对"被别的进程长期占用"文件的最终结局**（沿用 v0.5.26 的未验证项）。

## v0.5.26 — 独立对抗式复核抓到的 6 处缺陷（F1–F5 / F7，2026-09-27）

0.5.25 发布后由**独立对抗式复核者**（独立上下文、只负责证伪）在已发布代码上抓到的问题，本版逐条修掉。
**只发一版。** 全部是"改错 + 加法"，没有重构、没有新依赖。

> ### ⚠️ 行为变更（用户最需要知道的一条）
> **预设装配默认只补缺失文件，绝不覆盖你在用的同名预设。**
> 需要仓库版本时，请在安装结果卡片上**显式**点「覆盖该预设」—— 它会先把原目录**整份备份**成
> `<预设名>.bak-<时间戳>`，再逐文件覆盖，写完读回核实。
> 这与上游 `install.ps1` 的语义一致（上游：「预设已存在 → 请先手动删除」= 跳过）。

### 1. F1（高·必修）：**用户点的那一件必须排最前**

已发布代码 `install-job.js` 在"根包 private → 自动展开子包"那一步把展开出来的子包**统统排在用户点的那件之前**
（`candidates = [...subs, ...candidates]`）→ 第一件装成、或"已检测到本地已安装"就 `break`：
**用户点第三件，装的却是第一件（或什么都没装，面板却报成功）**。
- 改：用户**显式点名**的候选（`job.packageName`，即卡片子包列表每一件按钮发的那件）**永远排最前**，
  自动展开的只作后备追加在后；候选循环"第一件成功即收口"的语义**一个字不改**（改了会让自动展开的抢在用户选择之前）。
  "聚合包优先"只对"没给包名"的情形保留（那条路走 `candidates = subs`，不经过这里）。
- 语义边界也钉死了：**点名的那件已安装 → 如实报「已检测到本地已安装 <那一件>」**（`curlNote` 里名字对得上），
  不再因为前面的自动候选已安装就误报"成功装了别的"。
- 测试：`test-preset-channel-wiring.mjs` 新增 ③b（点名第三件 → 第一个候选就是它、最终装的就是它；
  自动展开仍写进 `job.subpackages`）+ ③c（点名件已安装 → 如实报"已安装"、零通道调用、
  `packageName` 不被别的包覆盖）+ 反例（不指定包名时仍按子包列表顺序第一件优先）。**35 断言全绿。**

### 2. F2（中—高·必做）：预设装配**默认不得覆盖**用户在用同名预设

实测一次装配改写了 3 个在用预设、**11 个文件**（`router-standard` 4 个，含 `agent.cordis.yml`）。
有备份、有逐条报告（不静默），但**与上游 `install.ps1` 语义相反**（上游：已存在 → 请先手动删除 = 跳过）。
- 改（默认安全）：**只补缺失文件，绝不覆盖已存在的同名文件**；被跳过的同名文件**逐条点名**
  （`skipped` 字段 + note），并提示"如需覆盖，请点「覆盖该预设」"。默认模式**不建备份**
  （一个字节都没改，建备份只会让用户误以为目录被动过）。
- 加法（显式授权覆盖）：新白名单动作 **`overwrite-preset`**（结构化 payload `{action, presetName, repo}`，
  服务端自拼；沿用 `allow-builds` 的模式：**改前整目录备份 + 写后读回核实 + 绝不接受客户端命令串**）。
  它按记录（`plugin-console/preset-sources.json`）**重新取一次源码**（临时 clone 目录早已清理），
  再走"备份 → 覆盖 → 读回核实"。任意命令字段仍一律 **400**。
- 面板：新增**中英双语**短句按钮「覆盖该预设 / Overwrite this preset」，只在服务端下发
  `suggestedAction.kind === "overwrite-preset"` 时出现（平时一个像素都不多占）；长解释（含"会先整目录备份"）
  进悬浮 title。服务端经 `installJobView` 下发，所以切走页面再回来按钮仍在。
- 测试：`test-preset-overwrite.mjs`（新增，39 断言）——① 默认不覆盖（**用户原文件 sha256 一字不变**、
  无 `agent.cordis.yml` 覆盖、零 `.bak` 新增、冲突逐条点名、note 给出出路）② 点 `overwrite-preset` 才覆盖
  （整目录备份存在、**备份里是用户原来的内容**、落盘 = 仓库版、写后读回核实通过、独有文件仍在）
  ③ 任意命令仍 400 **且零文件改动**（7 条负例 + 目录清单/sha256 复核）。

### 3. F3（中）：装配**前**校验 `agent.cordis.yml` 可解析

实测：非法 YAML 覆盖了原本可用的文件（`overwritten=["agent.cordis.yml"]`）→ 下次新建会话挂载该预设就报错。
- 加法：新模块 `domain/preset-yaml.js`（**纯函数**结构校验）。只钉**能确证损坏**的形态，宁松勿误杀：
  ① 空内容/全是注释（框架挂载它等于空预设）② 行首缩进里有 **tab**（YAML 禁止）③ 明显**未闭合的引号**
  ④ 缩进**跳级**（截断与坏编辑的典型形状）。`!!js` 自定义标签、`>-`/`|-` 块标量、注释、CRLF 一律按合法处理
  （块标量内容整段跳过——**这是校准后加的**：第一版把 persona 那种多行散文逐行当"非法条目"，
  实测把三个真机预设全部误杀）。
- 改：装配**写盘之前**校验；不通过 → 该预设**整个拒绝装配**（不做半成品目录）并**如实报告**
  （点名文件 + 说清问题），用户手上的文件一个字节都不动。
- 校准证据：对 **33 个真实 `agent.cordis.yml`**（三个在用预设 + 框架自带预设 + profile 里已装插件的预设）
  跑判据 → **0 误杀**；对 8 种合成损坏形态 → 全部正确拒绝。
- 测试：`test-preset-source.mjs` 新增 F3 段（空文件/tab/缩进跳级/未闭合引号四种形态均拒绝装配、
  在用文件 sha256 不变、理由具体、校验发生在备份之前）。

### 4. F4（低）：同一毫秒重复装配共用同一备份路径

旧实现 `backup = ${dest}.bak-${now()}` —— 同一毫秒的两次装配拿到**同一个**路径，第二次把第一次的备份
**覆盖**掉：用户以为有两个回滚点，其实只剩一个。
- 改：`uniqueBackupPath()` —— 路径已存在就自增后缀（`-2`、`-3`…）直到不冲突。
- 测试：同时间值两次真装配 → 备份路径不同，且**两个备份各自完整**（第一个存 `user1`、第二个存 `user2`）。

### 5. F5（低·判据边界）：`sourceChannelGate({state:'known', sizeKb:null})` 被当 0 MB 放行

旧代码 `const kb = Number(sizeKb); Number.isFinite(kb) && kb >= 0` —— `Number(null) === 0`、
`Number('') === 0`、`Number(false) === 0`，于是**"尺寸读不到"被当成"0 MB 的空仓库"放行源码通道**
（真会去拉一个可能几百 MB 的仓库）。
- 改：判据落在**原始值**上（`typeof sizeKb === 'number' && Number.isFinite(sizeKb) && sizeKb >= 0`）；
  `state='known'` 但尺寸不是有限数 → **不放行**，且 note 如实写出"读到的到底是什么"
  （`null` / `undefined` / 空串 / `false` / `NaN` / `Infinity` 分得开 —— 为此**去掉了参数解构默认值**，
  因为 `{ sizeKb = null }` 会把"键存在但值是 undefined"也填成 null，原始值就被抹掉了）。
  数字 `0`（真空仓库）**仍照旧放行**。
- 测试：`test-repo-size-gate.mjs` 新增 7 种坏值 × 2 条断言 + 两条反例，**60 断言全绿**。

### 6. F7（低·预先存在）：`rmdir /s /q <文件>` 兜底对**文件**无效

`clean-residuals` 清陈旧 `fw-quarantine.json.applied-*`（**文件**）时，`rmSync` 瞬时失败 → shell 兜底用
`rmdir`（只能删目录）→ `exit=267 The directory name is invalid` → **误报"清理失败"**（文件其实好好的）。
- 改：新判据 `shellDeleteCommand()`（**唯一真源**，异步/同步两个兜底共用）：文件 → `del /f /q "path"`；
  目录 → `rmdir /s /q "path"`；**目标已不存在 → 视为已达成**（不是失败）。读不出类型时走目录形态
  （保持旧行为不倒退）。"失败不阻塞"语义一字未改。
- 测试：`test-clean-residuals.mjs` 新增 F7 段（判据三种形态 + 真 `cmd.exe` 真删文件/目录 + 同步兜底 +
  "已不存在" + 端到端：陈旧快照被清掉且 `failed` 为空）。

### 7. 顺带搬移（架构硬顶，零语义变更）

- 新增 `domain/preset-install.js`（装配：只补不覆盖/显式覆盖/校验/备份/读回核实），
  `domain/preset-source.js` 改为 re-export —— **写盘逻辑全项目只有一份**。
- 新增 `domain/bundle-refs.js`（`readBundlePatchRefNames` 原地搬出）。
- `domain/install.js` 的预设视图字段抽成 `preset-install.js#presetJobView`。
- 三条都在 `lib/server/**` ≤ 600 行的架构守卫下（`install.js` 曾到 604、`install-job.js` 曾到 601，已回落）。

### 测试与门槛

- **干净全量（61 套本地用例，一次跑完、无并发干扰）**：**61/61 套 exit 0**、
  **断言 1591 PASS / 0 FAIL**、11 处**响亮 SKIP**（打印原因，不假装 PASS）、墙钟 ≈ 472 秒。
- 新增测试 `tests/test-preset-overwrite.mjs` 已进 `test.yml` **硬门槛**；`test-preset-source.mjs`、
  `test-preset-channel-wiring.mjs`、`test-repo-size-gate.mjs`、`test-clean-residuals.mjs` 的增强断言同样在门槛内。
- 真机（官方桌面端）实测见 Release notes。

### 未验证项

- **预设"覆盖"动作在真机上的完整往返**：真实桌面端实例上点「覆盖该预设」并观察
  `~/.dsh/.agent-presets/<name>.bak-*` 与覆盖后挂载，本轮**未做**（真机只验证了默认"只补不覆盖"那一半：
  三个在用预设的文件 sha256 未变）。逻辑由全离线套件（真 git + 本机裸仓库 + 真 `runSuggestedAction`）覆盖。
- **`del /f /q` 对"被别的进程长期占用"文件的最终结局**：本机实测能删掉，但"占用者始终不放"的极端情形
  没有构造夹具（只断言了失败时不阻塞、且错误文本如实回报）。
- **F3 的结构校验不是通用 YAML 解析器**：它只拒绝四类能确证损坏的形态（见 §3）。
  比这更隐晦的非法 YAML（例如深层 flow 语法错误）**仍会写下去** —— 这是刻意取舍：
  宁可漏判也不能误杀真预设（校准：33 个真文件 0 误杀）。

## v0.5.25 — 预设类子包拿不到（根因改错 + 稀疏取源码 + 预设装配，2026-09-27）

真机事故（用户实测 `yjh051108/dsh-routing-suite` 三件套**只装到两件**）：该仓库 `graded/`
（`@dsh-external/dsh-graded-mode`）与 `injector/`（`@dsh-external/dsh-super-injector`）的 release 里有
产物、装得上；**第三件 `preset/`（= `dsh-router-standard`，"思维模式路由预设"）npm 双 404、
release 无资产 —— 它只存在于仓库源码里**。而 0.5.18 的批次 A-③ 把判据写成
「**根包未发布（private）→ 禁用 git/archive 通道**」（本意是治 `zhu1090093659/dsh-web` 429 MB 被白拉），
该仓库根包恰好也是 private（真机实测 **1334 KB**）→ 源码通道被一并跳过，第三件连一次机会都没有。
**一刀切的错在于：真正的成本是仓库体积，不是"根包是否 private"。** 本版四条（改错 + 加法）。

### 1. 改错：private 根不再一刀切禁源码通道，改按**仓库体积**判定

- 新模块 `domain/repo-size.js`：用 GitHub API `/repos/{owner}/{repo}` 的 `size`（KB）**探测体积**
  （复用既有 http 多通道：`githubJson` 官方+镜像竞速且带 gh CLI 兜底、`curlJson` 走系统网络栈，
  外层预算与 `fetchRepoMeta` 同一个 `META_BUDGET_MS`；**成功才落 6 小时缓存**，失败不缓存——
  免得一次网络抖动把仓库永久钉成"尺寸未知"）。阈值默认 **20 MB**，可用 `DSH_GIT_MAX_REPO_MB`
  配置（夹在 1 MB ~ 4096 MB；非法值回落默认而不是"全禁"）。
- 纯判据 `sourceChannelGate({state,sizeKb}, thresholdMb)` 三种结局，**note 一律非空**（不静默）：
  · **小仓库**（≤ 阈值）→ **放行** git / archive / 稀疏取源码，note 写明体积与上限；
  · **巨仓**（真机 dsh-web = 429.0 MB）→ **仍禁**，note 说清尺寸（MB／KB 都给，避免四舍五入看不出）、
    原因与**出路**（「仓库落地」克隆到本地目录 / 本地镜像 / 已发布的聚合子包）；
  · **尺寸未知**（探测失败/超时/404）→ **保守但不沉默**：保持禁令 + note 说明"尺寸未知，已保守跳过源码通道"。
- `domain/install-job.js` 的两处 private 根分支改为同一个入口 `gatePrivateRoot(job, noteChannel, …)`：
  写 `job.privateRoot / job.repoSize / job.gitChannelBlocked / job.sourceChannelBlocked` 并记备注。

### 2. 加法：稀疏/定向取源码（让"巨仓里的小目录"也取得下）

- `domain/repoland.js`：`runGitClone` 抽出通用 `runGitArgs(argv, {timeout,cwd,…})`（**同一套**停滞判据 +
  kill-tree + wait-for-exit，**不新造进程管理**），并新增 `GIT_SPARSE_FLAGS = ['--filter=blob:none','--sparse']`；
  `gitCloneRepo(..., { sparse: [...] })` 走稀疏克隆（`.tryN` / 探活 / `.trash-*` 降级 / archive 兜底全部照旧），
  非空目录列表时再 `git sparse-checkout set <dir>`。
- **不支持时报错降级到普通 clone**：`sparseUnsupportedReason(stderr)` 认出两类真机情形（旧 git 不认
  `--filter`/`--sparse`；没有 `sparse-checkout` 子命令），`gitCloneRepo` 的下一轮改用普通 clone 并把原因
  写进错误清单；`fetchPresetSource` 对 `sparse-checkout` 不可用同样降级并在 notes 里说明——
  **绝不静默降级，也绝不因为"稀疏不可用"把候选判死**。
- 真机实测（本机 ghproxy）：骨架 `92 125 B`（工作区只有根目录文件）、
  `sparse-checkout set preset` 后 `1 089 586 B` 且**只有 `preset/` 多出来**（`graded/`、`injector/` 缺席）；
  整仓 clone 对照 `2 342 446 B / 17.3 秒`。

### 3. 加法：预设型子包按 preset 装配（复用套装路径的既有逻辑，不复制粘贴）

- 新模块 `domain/preset-source.js`：
  · `findPresetDirs` 从 `suite.js` **原样搬来**（`suite.js` 改为 re-export —— 两条路径共用**同一份**判据，
    测试直接断言 `suiteFindPresetDirs === findPresetDirs`）；新增 `isPresetDir`（只认 `agent.cordis.yml/.yaml`）、
    `looksLikePresetPackageName`（`dsh-router-standard` / `dsh_router_standard` / `@scope/dsh-preset-*`…，
    只作**便宜初筛**，最终判据永远是"目录里真的有 agent.cordis.yml"）。
  · **`assemblePreset`（唯一实现）**：装配到 `<DSH_HOME>/.agent-presets/<name>`；**已存在同名预设时绝不静默覆盖** ——
    先整目录备份成 `<name>.bak-<ts>`（暂存/备份失败就**不合并**并如实报错），再逐文件合并并逐条报告
    （新增 / 覆盖 / 内容一致）；用户独有文件保留。旧 `suite.js` 里那三行是 `rmSync(dest)` + `copyTree`，
    会**无声抹掉**用户手上的同名预设（真机 `.agent-presets` 下就有三个在用的）——一并改掉。
  · `tryPresetSourceChannel`：候选 → 子包目录用 **`git ls-tree` 在本地定位**（零额外网络）→
    `git sparse-checkout set <subdir>` → 装配；`job.presetInstalled / presetSource` 留下结构化结果。
- `domain/install-job.js` 新增「通道 n+1c：预设源码装配」（在 registry/curl/release 全部失败、展开之后）：
  成功后**提前收口**，`job.presetDone=true` → **绝不写补丁行、绝不声明依赖**（预设不是 npm 包，
  写补丁行会让下次启动崩 —— 2026-09-06 事故同族），`candidateDone/packageName` 与普通成功安装对齐。

### 4. 一并修掉的缺陷（过程中发现）

- **★ 用户点名的那一件被"自动展开的子包"挤到后面（真机验证时发现的第二个根因，批次 D-⑤）**：
  市场卡片上"子包"列表里每件的「添加并启用」按钮发的是 `{repo, packageName: <该子包>}`，而
  `install-job.js` 在"根包 private → 自动展开子包"那一步把展开出来的子包**统统排在它前面**
  （`candidates = [...subs, ...candidates]`）→ 第一件装成、或"已检测到本地已安装"就 `break`：
  **用户点第三件，装的却是第一件**。真机实测复现（桌面端 0.5.24/0.5.25 实例，
  `POST /install {repo:'yjh051108/dsh-routing-suite', packageName:'dsh-router-standard'}` →
  `packageName` 变成 `@dsh-external/dsh-graded-mode`、`status=done`、预设一个字节都没落盘）。
  修法：用户明确点名的包**排最前**，自动展开出来的子包追加在后；"聚合包优先"只对"没给包名"的
  情形保留（那条路走 `candidates = subs`，不受影响）。反例断言：不指定包名时仍按子包列表顺序。
- **git 规格装成"别的包名"被当成成功**：`git+<repo>` 装的是**仓库根包**，候选是子包时名字根本不同
  （真机 dsh-routing-suite：根包 private、名字 `@dsh-external/dsh-super-injector`，候选是 `dsh-router-standard`）。
  旧代码无条件把 `installedName` 记成候选名 → 补丁行指向不存在的模块 → 启动崩溃。
  现在装完**读回真实包名核实**（`git-channel.js#installedPackageName`），不一致就当作"这个 git 源装不出该候选"
  并留下具体原因；读不到时按"无法核实"放行但记备注（不误杀）。
- **`tests/test-suite-install.mjs` 会改动用户线上预设**（本版首次实现时真发生了：真机 `.agent-presets` 下
  多出 6 个 `.bak-*` 目录、文件被上游版本合并）：该用例的安装通道虽然全部打桩，但**预设源码通道是一条真实通道**。
  已改为把作业跑在**临时 home 的 profile 副本**上（仍要求真实 profile 存在才跑，保持 env-dependent 语义），
  线上目录全程只读；并顺带把这条用例升级成**真网络端到端断言**（预设真的落盘 + 不写补丁行/不声明依赖 + 用了稀疏）。

### 5. 面板文案（装完告知落盘路径；失败给具体原因与下一步）

- `installJobView` 新增 `presetNote / presetInstalled / presetSource / repoSize`（老客户端忽略即兼容）。
- `lib/client.js`：预设装配成功走**独立分支**（而不是混进普通插件文案）——
  「预设已装配：<名字>（落盘 <路径>；**新建会话时选择**）」，并**不再 2.5 秒后自动刷新页面**
  （刷新会把落盘路径冲掉）；中英双语键 `presetInstalledMsg / presetDot`。
- **失败不再笼统**：安装失败时把服务端一直在下发、但面板从未展示的 `channelNotes` 逐条显示
  （短句进消息栏、全部进悬浮 title；中英键 `diagChannelNotes`）——体积门禁、稀疏降级、预算跳过等
  原因与"下一步"都在里面。

### 测试（全部进 `.github/workflows/test.yml` 硬门槛）

- `tests/test-repo-size-gate.mjs`（新增，44 断言）：纯判据边界（恰好等于阈值 / 多 1 KB / 0 KB / 非数字 /
  非法阈值）、env 夹取、探测成功·404·超时 + 缓存语义（**成功才落缓存**）、门禁落到 job 的三种结局、
  **dsh-web 429 MB fixture 必须仍被禁且 note 含 429.0 MB**，以及 **162 行边界矩阵**
  （仓库 小/大 × 根包 已发布/private/未发布 × 子包 有 npm/仅 release/仅源码 × 类型 插件/bundle/预设 ×
  探测 成功/超时/404），**每行一条断言**。
- `tests/test-preset-source.mjs`（新增，66 断言）：预设包名判据正反例、`isPresetDir`/`findPresetDirs`
  （含与 `suite.js` 的 re-export 同一性）、`assemblePreset` 的备份+合并+用户独有文件保留+越权目录名拒绝、
  真 git 稀疏取源码（`graded/`、`injector/` 必须缺席）、**稀疏不可用的两条降级路径**、
  `tryPresetSourceChannel` 全流程与"不是预设型"的如实报错、git 装成别的包名被识破。
- `tests/test-preset-channel-wiring.mjs`（新增，31 断言）：通道顺序（… release → 展开 → **预设装配**；
  预设成功时 git 一次都不调）、`runInstallJob` 全链路**绝不写补丁行/绝不声明依赖** + 预设真的落盘、
  **点名的那一件排最前**（第二个根因的回归断言 + "没给包名时仍第一件优先"的反例）、
  反例（名字不像预设 → 零副作用、git 照旧被尝试）、面板契约（服务端字段 + 客户端中英文案 + 失败路径
  显示 channelNotes + 预设通道失败时 lastError 是具体原因）。
- `tests/test-real-preset-e2e.mjs`（新增，22 断言，真网络）：真打 `yjh051108/dsh-routing-suite` →
  体积 1334 KB 放行 → 稀疏骨架 92 125 B（只有根目录文件）→ `sparse-checkout set preset` 后
  `1 089 586 B` 且**只有 `preset/`** → 隔离 `DSH_HOME` 下 `router-standard/agent.cordis.yml` 真的落盘
  （**16 538 B**，首行 `# The \`router-standard\` agent preset: …`）；镜像不可达时**响亮 SKIP**（不假装 PASS）。
- `tests/test-suite-install.mjs`：改用临时 home + 升级为真网络端到端断言（见 §4）。

### 本地全量回归（61 套 / 0 失败）

`node tests/run-all.mjs` → unit 46 套 + real smoke 5 套 + env-dependent 9 套 + 真 registry 1 套，
**61 套全绿**。0.5.18–0.5.24 的关键修复逐项重跑结论见 PR/发版说明（停滞判据、git 独立预算、展开顺序、
通道 0 不短路、release 预算可见、子包分支、探活降级、报错带字节数、archive、落地复用、npmName 首选、
套装回落、`link:` 写回 + lock 对账、体检 sourceLinked、动作负例 400、runner 转义 + 桌面端 pnpm、
ignored-builds 分类、allow-builds 显式动作）。

此外，真机（官方桌面端实例，`POST /install {repo:'yjh051108/dsh-routing-suite', packageName:'dsh-router-standard'}`）
验证时还**复现并修掉了第二个根因**：点名的那一件被自动展开的子包挤到后面（见 §4 第一条）——
修前该调用装成的是 `@dsh-external/dsh-graded-mode`、预设一个字节都没落盘。

### 未验证项

- 巨仓（> 20 MB）路径上的**真实**稀疏取源码没有跑（没有体积合适又能验证的公开巨仓做确定性夹具）；
  该分支由 162 行矩阵 + 本机裸仓库夹具覆盖，真网络只覆盖了"小仓库放行"这一侧。
- `DSH_GIT_MAX_REPO_MB` 只做了单元与注入验证，**没有在真机 profile 上改成非默认值跑过**。
- 稀疏克隆对 `--filter` 的服务端支持差异（GitLab / 自建 Gitea / 部分镜像可能只警告不报错）只在
  ghproxy + 本机裸仓库两种源上实测过。

## v0.5.24 — 构建脚本未获批准不再算失败 + 显式「允许这些构建脚本」（改错 + 加法 + 文档，2026-09-27）

上接 0.5.23：桌面端实例的 pnpm 终于能跑起来之后，**同一个 pin 动作仍然 exitCode=1**。
真机定位（官方桌面端实例、pnpm 11.7.0）：根因**不是 runner**，而是 pnpm 11 的 `strictDepBuilds`
默认为 true + pnpm 自己写在 profile `pnpm-workspace.yaml` 里的 `allowBuilds` 占位
（`cloudflared` / `cpu-features` / `ssh2`）→ 装完之后抛 `ERR_PNPM_IGNORED_BUILDS` 并以 1 退出，
而这次操作真正要做的事（写清单 + 对齐 lock）**其实已经做完了**。本版三件事（A/B/C）+ 过程中发现的
一个真缺陷一并修掉。

### A. 改错：把 `ERR_PNPM_IGNORED_BUILDS` 如实呈现为「目标状态已达成」

- `domain/install-diagnose.js`（加法）新增分类 **`ignored-builds`**（识别 `ERR_PNPM_IGNORED_BUILDS`
  与 `Ignored build scripts` 全部文案变体；排在泛化的 `allowBuilds` 之前，后者语义一字未动）+
  纯函数 `ignoredBuildsFrom(text)` 从 `Ignored build scripts: cloudflared@0.7.3, …` 里**点名**依赖
  （scoped 包名不吃错；认不出就返回空数组，绝不编造）。
- 动作执行路径（`domain/plugin-actions.js`）：**清单与 lock 已达目标状态**（读回核实：清单是 `link:` 且
  lock 里有该 `link:` 条目）时，这类报错**不再报成失败** → `ok:true`、结果里带 `kind:'ignored-builds'`
  与 `ignoredBuilds:[…]`，`exitCode` **如实回报（1 就是 1，绝不抹成 0）**，note 就是这句话：
  「依赖已钉住（清单+lock 已就位）；pnpm 因构建脚本未获批准而报错 —— 这不会执行任何脚本，也不影响加载；
  如需放行请点「允许这些构建脚本」」。反例（清单/lock 未就位）仍如实报失败（`ok:false` + `partial`）。

### B. 加法（选项 2 的核心）：显式动作「允许这些构建脚本」

- 新的白名单动作 `action: 'allow-builds'`（`domain/allow-builds.js`）：在 profile 的
  `pnpm-workspace.yaml` 里补上**具体包名**的放行项（`allowBuilds: <name>: true`；只有
  `onlyBuiltDependencies` 就补进那个列表；两个键都没有就新建 `allowBuilds` 块；形态不允许——例如写成
  行内 flow 映射——才退回 `strictDepBuilds: false` 并在 note 里写清副作用）。要求逐条落地：
  ①改前备份 `.bak-<时间戳>` ②保持 LF / 无 BOM ③写后读回核实并回报
  `{changed, added[], file, sha256Before/After, backup, verified}` ④其它字段一字不动（写后按行比对核实）
  ⑤**只有用户点击才执行**（安装/检测路径绝不调用它）。
- 安全边界（写进注释 + 测试钉死）：**绝不自动执行；绝不下载/执行任何脚本** —— 该模块只做文本改写
  （readFile/writeFile/copyFile），不 spawn 任何进程、不碰 argv；动作只影响"pnpm 下次安装是否还会因未
  批准而报错"。真正的构建由 pnpm 在用户之后自己发起的安装里执行，note 里如实说明。
- 客户端（`lib/client.js`）：动作框在**这个场景**下多出第二个动作「允许这些构建脚本」（+ 既有「复制命令」），
  短句进面板、长解释进悬浮 title、中英双语；点它发的是**结构化 payload**（`{action:'allow-builds'}`），
  仍不接受任何命令字符串。
- 测试：`tests/test-allow-builds.mjs`（新增，进 CI 硬门槛）钉死最小改动/备份/读回核实/未点击时文件
  sha256 不变/点名不在名单里的包必须 400/源码无 exec·spawn；`tests/test-plugin-actions.mjs` 追加
  A-③ 的**真 pnpm** 证据（pnpm 自己产出 `ERR_PNPM_IGNORED_BUILDS` → `ok:true`、exitCode 如实、
  note 逐字）与按钮渲染断言（有/无、执行中、成功、失败、中英切换）。

### 过程中发现的真缺陷（一并修）

- **放行之后，pnpm 那一步会真的构建，时间远超原先 180s 的等待上限**：真机实测
  `pnpm add link:…`（`allowBuilds` 全 true）**18m59.6s** 才结束、exitCode=0（cpu-features 走 node-gyp
  编译、cloudflared 下二进制、ssh2 编原生绑定）——旧的 180s 上限会把一次**成功**的安装杀成"失败"。
  修法：profile 处于"已放行但还没构建过"时把这一步的等待上限提到 30 分钟（其余情况一个字不变，仍是 180s），
  并在 note 里说明本次会真的构建。

### C. 文档（随本版发出）

`README.md` / `README.zh.md` 的「多源 / Multiple sources」章节新增
**「下载安装通道与依赖形态 / Download-install channels and dependency forms」**：五条通道
（① pnpm registry ② curl tarball ③ GitHub Release 资产 ④ git 克隆 ⑤ archive）的对照表、
「有 npm 包走 ①/② 写版本号、没有就降级 ③/④/⑤ 写 `link:`」的结论，以及加速器/镜像的环境提醒。

### 未验证 / 不确定

- 30 分钟的等待上限只在真机验证到"19 分钟那次能跑完"这一侧；一次**真正卡死**的安装最坏会占住请求
  30 分钟（客户端此刻显示「执行中…」；浏览器自身若在 ~5 分钟丢弃连接，服务端仍会跑完并把结果留在下一次
  调用里 —— 未在本机造出该场景）。
- 形态兜底 `strictDepBuilds: false` 只有单测覆盖（本机的真机 profile 一直是 `allowBuilds` 占位形态）。

## v0.5.23 — 桌面端实例「所有 pnpm 操作跑不了」两处根因（改错 + 加法，2026-09-27）

用户报告：**官方桌面端实例**（桌面端安装目录，Electron 跑的 `@deepseek-ai/dsh-desktop-host`）里，
凡是走 pnpm 的功能一律失败，报 `Error: ENOENT … pnpm-lock.yaml`。真机定位到两处根因，一处**改错**、
一处**加法**，既有候选与兜底语义一个字没动。

### ① 改错：cmd-corepack 的命令串被 Node 转义成 `\"corepack\"`（先于本轮存在）

`infra/exec.js` 的 `cmd-corepack` 分支原来把 `['corepack','pnpm',…]` 用 `JSON.stringify` 拼成带
**真引号**的命令串，再作为**单个 argv 元素**交给 `spawn` —— Windows 上 Node/libuv 按 MSVCRT 规则把
段内引号转义成 `\"`，cmd 实际收到 `\"corepack\" \"pnpm\"`：

```
'\"corepack\"' 不是内部或外部命令，也不是可运行的程序或批处理文件。
```

本机对着一个「只回显参数」的临时 `.cmd` 逐一实测三种形态：

| 形态 | 结果 |
| --- | --- |
| `"a" "b"` + 默认转义（旧代码） | 收到 `\"a\" \"b\"` → **失败**（复现本轮缺陷） |
| `"a" "b"` + `windowsVerbatimArguments` | cmd 的 `/s` 把首尾引号一起剥掉 → **也失败** |
| `""a" "b""` + `windowsVerbatimArguments` | **正确解析成两个参数** ✓ |

修法（纯函数，便于离线断言）：

- `cmdCommandLine(parts)`：段内各段加引号 + cmd 元字符 `^ & | < > ( )` 逐个 `^` 转义
  （实测 `"a&b"` 在引号内仍会被 cmd 当命令分隔符断开、`"a^b"` 的 `^` 会被吃掉，所以必须转义）；
  **产出永不含 `\"`**。
- `cmdCorepackCommand(args)` = `cmdCommandLine(['corepack','pnpm',…])`。
- `cmdShellArgv(commandLine)` = `['/d','/s','/c', '"' + commandLine + '"']`（整条再包一层引号）。
- runner 标 `verbatim: true` → `runPnpmWithFallback` 透传 `windowsVerbatimArguments` →
  `execFileWithKillTree` 交给 `spawn`。

已知边界（如实写进注释，不假装覆盖）：`%VAR%` / `!VAR!` 是 cmd 自己的展开，任何引号都挡不住；
我们生成的 argv（包名、registry、布尔选项、绝对路径）不含这两个字符。

### ② 加法：认不出桌面端自带运行时（候选全落空）

桌面端 host 自己就是用这套形态跑 pnpm 的（`dsh-desktop-host` 的 `packageManager`，真机命令行原样）：

```
command: process.execPath                                  // <桌面端安装目录>\DeepSeek Harness.exe
args:    ['--expose-internals', <resources>\runtime\pnpm\bin\pnpm.mjs]
env:     { ELECTRON_RUN_AS_NODE: '1', PATH: '<resources>\runtime\bin;<原 PATH>' }
```

而我们的候选只有「node 旁边的三种 corepack.js 布局 + `cmd /c corepack pnpm` + PATH 上的 `pnpm`」：
host 二进制旁边没有 `corepack.js`，PATH 里只有 `runtime\bin`（没有 `pnpm.cmd`）→ **三条全落空**，
于是退回那条被转义坏的 cmd 形态。

新增候选（插在 `node-corepack` **之后**、`cmd-corepack` **之前**；既有三个候选与顺序原样保留）：

1. **桌面端运行时**：`process.resourcesPath` 下的 `runtime/pnpm/bin/pnpm.mjs`，照抄 host 形态
   （`bin = execPath` 或 `DSH_DESKTOP_NODE_EXECUTABLE`，`argv = ['--expose-internals', <pnpm.mjs>, …]`），
   并**显式带 `ELECTRON_RUN_AS_NODE=1`** —— 不带它 Electron 二进制会当 **GUI 应用**启动，
   等于弹一个新窗口、还可能以 exit 0「假装成功」，比失败更糟；
2. **PATH 扫描**：`<dir>\pnpm\bin\pnpm.mjs`（node 直跑）、win 的 `<dir>\pnpm.cmd`（经 cmd，走修好的形态）、
   posix 的 `<dir>/pnpm`（直接执行）；
3. **环境线索**：PATH 条目里的 `<…>\runtime\pnpm\bin` 与 `<…>\runtime\bin`（同级 `runtime\pnpm\bin\pnpm.mjs`）。

全部候选都走注入的 `exists`；新增 `env / resourcesPath / delimiter / nodeBin` 四个注入点只为离线单测，
默认值就是当前进程的事实 —— 生产调用方一个字都不用改。兜底语义不变：只有「执行方式本身不可用」
（`ENOENT` / `Cannot find module`）才换下一个，真正的失败立即抛出。

### 真机证据（官方桌面端实例，端口 19387）

修复同步进 desktop profile 并重启桌面端后：

- **进程内**（`POST /plugin-console/run-suggested` → `pin-dependency`）跑的那一步已经是桌面端自带的 pnpm：

  ```
  Command failed: <桌面端安装目录>\DeepSeek Harness.exe --expose-internals
    <桌面端安装目录>\resources\runtime\pnpm\bin\pnpm.mjs add link:%USERPROFILE%/.dsh/plugin-src/… 
  ｜真实输出：Progress: resolved 55, reused 46, downloaded 0, added 45, done …
  ```

  （旧代码在这一步连 corepack 都解析不到；现在 pnpm 真的跑完并把 45 个包对齐了。）
- **host 同款运行时**（同一个 Electron 二进制 + `ELECTRON_RUN_AS_NODE=1` + `--expose-internals`，
  走生产解析路径）：runner = `desktop-pnpm-mjs`，`pnpm --version` → **`11.7.0`**；
  `pnpm install --lockfile-only --no-frozen-lockfile --registry …` → **exitCode 0**。
- **隔离项目**（不出网，`link:` 规格）：`pnpm add link:<目录>` → `Done in 304ms using pnpm v11.7.0`，**exitCode 0**。

### 测试（进 CI 硬门槛）

新增 `tests/test-pnpm-runners.mjs`（36 条断言）：cmd 命令串不含 `\"`、argv 形如
`['/d','/s','/c', …]`、元字符 `^` 转义、桌面端形态（resourcesPath / PATH 线索 / `DSH_DESKTOP_NODE_EXECUTABLE`）、
PATH 扫描（win `.cmd` / posix / `pnpm.mjs`）、**既有候选与顺序回归**、**兜底语义回归**
（ENOENT 换下一个、真失败立刻抛、全不可用时报"已尝试"清单）、
`verbatim`/`env` 只在 runner 明确要求时生效（既有候选拿到的还是同一个 execOpts 对象）、
win32 / linux / darwin 三分支各断言一次；最后在**真 cmd.exe** 上做负对照 / 正对照
（旧形态必失败、新形态把含空格与 `&` 的参数原样送达；非 win32 平台如实 SKIP，不假装 PASS）。

### 未验证 / 不确定项（如实记录）

- **桌面端 profile 上 `pnpm add` 仍以 exitCode 1 结束，但这不是 runner 的问题**：pnpm 11 的
  `strictDepBuilds` **默认 true**（pnpm 自带 dist 源码原话：`// strictDepBuilds (the v11 default)`；
  它自己的 `pnpm dlx` 就显式关掉它），而该 profile 的 `pnpm-workspace.yaml` 里有一份
  **pnpm 自己写下的** `allowBuilds` 占位（`cloudflared / cpu-features / ssh2: set this to true or false`）
  → 安装**已完成**（`added 45, done`）之后 pnpm 抛 `ERR_PNPM_IGNORED_BUILDS` 并以 1 退出。
  本轮**没有**动它：命令行加 `--config.strictDepBuilds=false` 能让它不再报错（实测安装确实 `Done in 558ms`），
  但该形态在**当前镜像对 lightningcss-* 平台包请求超时**的情况下进程不退出（实测 240 秒仍未退出，
  被我们自己的超时杀掉）；而 `allowBuilds` 写成 `true` 等于放行这三个包的构建脚本，是**用户的安全决策**。
  建议的收尾（留给用户/下一轮）：在 desktop profile 的 `pnpm-workspace.yaml` 里显式写
  `strictDepBuilds: false`（只影响"要不要因为被忽略的构建脚本而报错"，不会执行任何脚本），
  或跑一次 `pnpm approve-builds` 逐包授权。
- 桌面端实例的 `selfVersion` 只有在**同步 profile 并重启桌面端**之后才会变成 0.5.23（网页端 3080 按约定
  **不重启**：磁盘上同步后它仍以旧代码在跑，重启后才生效）。

## v0.5.22 — 动作执行器补上「未知 pnpm 选项降级」+ 一组真 pnpm 断言（改错，2026-09-27）

0.5.21 的动作执行器自己拼 `pnpmAddArgs`（带 `--fetch-timeout/--fetch-retries` 两个加固选项），
却**绕过了** `infra/exec.js#runPnpmAdd` 的未知选项降级 —— 而 CI 的 corepack 解析到 **pnpm 12**，
这两个选项在 pnpm 12 上是 `error: unexpected argument`（直接退出）。CI 实测（run 36297375092，Unit 硬门槛）：

```
=== C1 真机路径（真 pnpm、不出外网）：动作的 pnpm 那一步真的跑起来 ===
Error: ENOENT: no such file or directory, open '…/profiles/web/pnpm-lock.yaml'
```

—— 动作的 pnpm 那一步在 pnpm 12 上必然失败（于是 lock 根本没被写出来）。这正是仓库里 0.3.x 那条
「**加固不允许变成装不上**」的教训在动作通道上的复现。

改错（`domain/plugin-actions.js#runAddWithReleaseAgeRetry`）：与 `runPnpmAdd` 同一条规矩 ——
第一次原样跑；失败且文案是 `Unknown option` / `unexpected argument` 时，**去掉加固选项重试一次**；
再看失败原因是不是供应链闸，是才为这一条命令追加 `--config.minimumReleaseAge=0` 重试并如实回报
（放宽的判断顺序不变，绝不因为"选项不认识"就误放宽）。

加法（测试，进 CI 硬门槛）：
- `tests/test-plugin-actions.mjs` 新增**真 pnpm** 组：动作走真实执行器（不注入 runner），断言
  `ok=true` / `exitCode=0` / 清单是 `link:` / lock 里真有这条条目 / `node_modules/<包名>` 被 pnpm
  **真的**换成指向 `plugin-src` 的链接（`lstatSync().isSymbolicLink()`）——证明"执行"不是只写两个文本文件；
- 同文件新增 pnpm 12 文案的降级断言（带加固选项 → 抛 `unexpected argument`；去掉后必须成功，
  且断言第二次 argv 里确实没有加固选项）；
- 真 pnpm 组的 lock 读取改成防御式（写不出来时报"动作失败 + 原始输出"，而不是让用例自己崩）。

验收：本机全量 **55 套全绿**；CI `tests` 双 step 全绿（含上面那组真 pnpm）。

## v0.5.21 — 依赖锁体检不再把来源型依赖（`link:` / `file:` / URL / git）当"解析不到"（改错，2026-09-27）

0.5.20 的写回规则把 registry 上查无此包的依赖钉成 `link:<DSH_HOME>/plugin-src/<包名>` 之后，
**依赖锁体检**仍按**包名**去 registry 探这些依赖，于是：

- 真机实测（桌面端实例，desktop profile，体检接口原样输出）：
  `packages404 = @dsh-external/dsh-super-injector, @dsh-external/dsh-graded-mode` →
  `problems=[fetch-404, lockfile-outdated, supply-chain-age]` → `repair.applicable=false, blockedBy=[fetch-404]`
  —— 明明 lock 与清单完全一致，用户却被告知"有依赖解析不到"、而且**重建按钮被永久挡住**；
- `lockfile-outdated` 同样是假阳性：`drift` 拿盘上的版本号（`0.0.1-rc1`）去比 lock 里的
  `version: link:../../plugin-src/…`，两者形态不同必然"漂移"。

改错（`domain/lockfile-health.js`，纯函数，唯一真源 `isSourceSpec`）：

- 体检**跳过**来源型 spec 的 registry 探测（它们本来就不经 registry 解析），并在响应里**单列**出来
  （新增字段 `sourceLinked`，说明"为什么没探测它"，不是静默跳过）；
- `diffLockfile` 的两个方向都判来源（spec 是来源、或 lock 解析是来源）→ 不再计入 `drift`；
- `specSatisfiedBy` 与体检探测共用同一份 `isSourceSpec` 判据（消灭两处各写一条正则的老问题）。

改错后的真机实测（同一个 desktop profile）：体检不再报 `fetch-404`／`lockfile-outdated`，
点「重建 lock」得到 `noop`（当前不需要重建）而不是 `blocked`；供应链闸提示照旧**只提示**、不绕过。

同批加法（一路顺带，只有两处，都不改语义）：动作执行结果在 `!run.ok` 时**总是**带一句
"pnpm 那一步没跑成（exitCode=…）"，执行框的悬浮 `title` 里也带上 `exitCode` ——
真机桌面端实例实测：该进程里 corepack 解析不到（`cmd /d /s /c "corepack" "pnpm" …` 的引号被转义成
`\"corepack\"`，见 `infra/exec.js#resolvePnpmRunners` 的 `cmd-corepack` 分支），pnpm 那一步会失败，
而"清单 + lock 已是 link:"这个**目标状态**仍会达成 —— 两种事实都要用户看得见。
（该 runner 问题**先于本版存在**，影响该实例里所有走 pnpm 的功能；本版只做如实回报，未改 runner 选择逻辑。）

验收：新增/扩展断言在 `tests/test-lockfile-health.mjs`（不探来源型依赖、不进 `packages404`、
不算漂移、`sourceLinked` 列出、重建得到 `noop`），`tests/test-route-inventory.mjs` 的
`/lockfile-check` 契约加上 `sourceLinked` 字段；本机全量 **55 套全绿**，CI `tests` 双 step 全绿。

## v0.5.20 — 非 registry 包一律按 `link:` 写回（清单/lock/文案三处一致）+ 可执行的「建议动作」执行框（2026-09-27）

本版**只做改错与加法**：不动内核结构、不删既有能力；registry 可解析的包**行为逐条不变**（有回归断言）。

### 背景：真机上的一颗雷 + 一句谎报

desktop profile 的 `dependencies` 里写着 `@dsh-external/dsh-graded-mode: 0.0.1-rc1`，
而 `registry.npmmirror.com` 与 `registry.npmjs.org` **双双 404**（该包只存在于 GitHub release 资产里，
同族还有 `@dsh-external/dsh-super-injector` 与 web profile 的 `dsh-github-login@0.1.0`）；
同一个 profile 的 `pnpm-lock.yaml` 里**根本没有**这条依赖。后果：

- **下一次任何 pnpm 操作**（开关插件、`dsh plugin add/remove`、装任何新插件）都会
  `ERR_PNPM_FETCH_404`，而报错指向 npm registry —— 用户根本联想不到是几天前面板的安装留下的；
- 更糟的是**面板当时报的是「已按 link: 形式记录依赖」**：那句文案是硬编码的，从未读回磁盘真实值。

### 一、写回形态由 registry 可解析性决定（改错）

`domain/manifest.js#planDependencySpec`（新）：安装成功后的「安装即声明」不再无条件写磁盘版本号，
先按配置的源（npmmirror → npmjs）探这个包的**这个版本**：

| 探测结论 | 写进 `dependencies` 的形态 |
| --- | --- |
| 可解析 | `<版本号>`（**回归：与之前完全一致**） |
| 查无此包 / 查无此版本（404） | `link:<DSH_HOME>/plugin-src/<包名>`（先把已装副本物化过去） |
| 本次没探到（网络/镜像不可达） | 仍写版本号，但**如实记 note** + 下发「钉住」建议动作（绝不冒充已钉住） |

选 `link:` 而不是 `file:` 的理由：① 两个 profile 的 lock 本来就带 `excludeLinksFromLockfile: false`
（明确为 link 依赖准备）；② `link:` 只建链接，不经 registry 解析、不经 tarball 完整性校验，
删 lock / 清 node_modules / 换机都能装上（本机真 pnpm 实测：`pnpm add link:<绝对路径>` 会把
`node_modules/<包名>` 从真实目录换成 Junction，并在 lock 的 importer 段写下
`specifier: link:<绝对路径>` + `version: link:../../plugin-src/…`）；③ `file:` 在本机
`nodeLinker: hoisted` 下按普通依赖处理（多一层副本/打包语义），更容易出现版本漂移。

写清单之后**总是**做一次 lock 对账（对齐时零成本：只在漂移时才跑 pnpm）；
且 `aligned()` 现在要求**清单 / node_modules / lock 三处齐**才算对齐 —— 旧判据只看"链接还在"，
lock 里没有这条也算对齐，`lockUpdated` 会谎报 `true`（本次一并修掉）。

### 二、文案按实际写入形态生成（改错）

`domain/selfupdate.js#reconcileLockfile` 在写回**之后**读回 `package.json` 的真实值再生成说明：
只有清单里真的是 `link:…` 才说「已按 link: 形式记录依赖（<真实值>）」；没写成就点名
「计划写入 X，实际是 Y —— 写回**未生效**」并附可复制命令 + 结构化动作；`errors` 也进 note（不再吞）。
`misrecorded` 指纹从"裸版本号 + URL 解析"扩展到"裸版本号 + **任何来源钉住**"（`link:` / `git+` / URL），
真机上那种「清单是版本号、lock 是 `link:`」的隐形状态因此能被自愈。
`routes/compat.js#declare-installed`（补声明）走同一套判据与同一份源配置。

### 三、可执行的「钉住 / 修复」动作框（加法）

- **服务端** `POST /plugin-console/run-suggested`（`routes/actions.js` + `domain/plugin-actions.js`）：
  只接受 `{ action, packageName, version, profile }`；出现 `command`/`cmd`/`argv`/`args`/`exec`/
  `shell`/`script`/`run`/`spawn`/`bin` 任一字段即 **400 且一次都不执行**（有断言：零执行）。
  argv 全部由服务端自己拼：`pin-dependency` 走 `infra/exec.js#pnpmAddArgs`，
  `reconcile-lock` 直接复用 `lockfile-health.js#runLockfileRepair`（仍**不带**任何绕过供应链闸的开关）。
  `profile` 字段只作回显 —— profileDir 一律取当前实例，绝不按请求体挑目录。
  供应链闸（pnpm 11 的 `minimumReleaseAge` 默认 24h；本控制台自己刚发布的版本必然落在这个窗口里）
  只在它**确实**拦住命令时，为**这一条命令**追加 `--config.minimumReleaseAge=0` 重试一次，
  并在结果里显式回报 `relaxedReleaseAge: true`（面板原样展示，绝不写进任何配置文件）。
- **下发**：安装结果新增 `job.suggestedAction = { kind, label, command（仅供展示/复制）, payload }`
  —— 老客户端忽略该字段即可（向后兼容）。
- **面板**：安装结果卡片旁的小执行框（短说明 + 等宽只读命令 + 「执行」「复制」+ 执行中 +
  结果/错误回显 + 可关闭；中英双语；只用既有 `styles.*`，长解释挂悬浮 `title`）。
  有建议动作时**不再自动刷新**页面（旧行为 2.5 秒 reload，用户根本来不及点）。
  执行结果走 `callAction`：服务端把"动作失败"也当**结果**返回，不能被 `call()` 的统一错误约定
  吞成一句没信息量的 `HTTP 200`。

### 验收（真跑，非仅单测）

- 本机全量 **55 套全绿**（含真 pnpm / 真 registry 那套）；CI `tests` 双 step
  （Unit tests 硬门槛 + Real install/uninstall smoke）全绿；
- 新增 `tests/test-dep-pin.mjs`：非 registry 包 → 清单是 `link:`（桩 + 真物化）、写后 lock 有条目、
  **真 pnpm** 断言「随后 `pnpm install --lockfile-only` 退出码 0」、反证「裸版本号形态下同一条命令
  必然失败」、文案与实际值一致（含"写回未生效时绝不出现已按 link: 记录"的负例）、
  registry 可解析的包仍写 `<name>@<版本>`；
- 新增 `tests/test-plugin-actions.mjs`：路由/白名单/payload 契约、任意命令 400 且零执行、
  **用假 React 真渲染执行框**（有/无、执行中、成功、失败、中英切换、复制、关闭）。

### 未验证 / 不确定项（如实记录）

- `link:` 的**物理落地**（`node_modules/<包名>` 从真实目录换成指向 `plugin-src` 的 Junction）
  发生在下一次**完整** pnpm 安装（或点一次「钉住」动作）时；本版只保证清单与 lock 三处一致、
  且 `pnpm install --lockfile-only` 退出码 0（按验收要求只跑 `--lockfile-only`）。
- 本机 pnpm 11.21 的 `minimumReleaseAge`（24h）默认闸会让**刚发布 <24h** 的控制台版本拦住任何
  lockfile 校验 —— 这不是本插件引入的，但会在每次发版后的一天内影响 `pnpm` 操作；
  动作框在这种情况下会显式回报"已放宽一次（有安全代价）"，其余通道（体检/重建）口径不变：只提示不绕过。

## v0.5.19 — 套装链两处改错：根克隆失败必须回落普通通道 + 套装判定前先看根包（子包）是否已发布（内核零改动）（2026-09-27）

本版**只做改错与加法**：不动内核结构、不删既有能力、不改公开行为语义。三处改动全部落在
「选哪条通道 / 失败怎么回落」上，成功路径（真套装仓库照旧装配、已发布插件的普通安装）**行为不变**。

### 背景：真机点装 `zhu1090093659/dsh-web`（429 MB 聚合仓）

市场卡片点「添加到本地」时前端发的是 **`kind:'suite'`**：`lib/client.js#addLocal` 先判
`item.hasSuite === true` 就直接 `startSuiteJob()`，而 enrich 的 `hasSuite` 只看仓库根目录
`.gitmodules` 的**内容**（该仓库根目录确实有一份 508 B 的真 gitmodules）。本机 live 缓存实测
`zhu1090093659/dsh-web@dev = {hasSuite:true}` —— 所以真机走的是 `routes/install.js` 直接调
`runSuiteInstallJob` 这条路，**根本不经过 install-job 的候选循环**。

于是套装第一步就 clone 整个仓库（429 MB），而真正能装上的子包 `@linxin666/dsh-web-all`
（5.97 MB，npmmirror / npmjs 均 200）**没有任何机会被尝试**。旧代码让这条路必然失败且**没有回落**：
`runSuiteInstallJob` 整个函数只有一个 try/catch，`notASuite`（把决定权交回普通通道）**只在
"克隆成功但 `.gitmodules` 为空"时才返回** —— 克隆失败等于没有任何回落，用户只看到一个失败的任务。

> ⚠️ 0.5.18 新增的 archive 通道让"克隆必败"**不再成立**：本机实测**同一个 ghproxy.net 域名**下
> archive 7.2 MB/s、codeload 18.4 MB/s（15 秒实测下了 100~270 MB）—— 429 MB 会被真的拉下来，
> 然后进入 22 个子模块的套装装配。所以本版不是"等它失败再兜"，而是**在克隆之前就把通道选对**。

### 一、套装根克隆失败 → 回落普通通道，不再把作业判 failed（改错①）

- `domain/suite.js#runSuiteInstallJob`：单独包住根克隆，失败即
  `return { notASuite: true, reason: '套装仓库克隆失败（…），已自动回落普通插件安装' }`，
  **不再置 `job.status='failed'`**；
- `domain/install-job.js` 与 `routes/install.js` 的回落文案一律改用 `result.reason`
  —— 克隆失败与"内容不符"是两回事，不能都报成后者（会把用户带偏）；
- 顺带给根克隆留了 `deps.gitClone` 注入缝（沿用 `runInstallJob` 的 deps 风格，生产调用方不传第三个参数）。

### 二、套装判定前先看根包是否已发布（改错②）

`domain/suite.js` 新增唯一入口 `shouldRunSuiteInstall(job, probes)`，判据顺序（每一步只做"确认"、不做"猜测"）：

1. 读根 `package.json`（结果缓存进 job，下游复用，不重复联网）→ 有 `name` 且 registry 上**确实存在**
   → **插件通道**（不判套装、不克隆仓库）；
2. 否则仍按 `.gitmodules` 的**内容**判是否套装（2026-09-19 假阳性事故的口径不变）；
3. 判成套装后再问一句 registry：根包没发布、但**子包**已发布（真机 dsh-web 就是这种）→ **插件通道**
   —— 仓库里有已发布的可安装单元时，按包名装才是"装得上 + 能随 lock 更新"的那条路；
   子包也都没发布（子模块是纯 git 组件）→ **照旧走套装装配，能力一点没少**。

「registry 上存在」只认**确定性命中**：404 / 超时 / 不可达一律当"查不到"——网络问题不能推翻 `.gitmodules` 判据
（否则一次网络抖动就会把套装安装悄悄变成插件安装）。探测结果缓存在 `job.repoMeta` / `job.rootPkgProbe` /
`job.subpackageProbe` 上，下游候选循环直接复用。

### 三、套装作业入口的同一道判据（改错③：显式「安装套装」也要过）

`runSuiteInstallJob` 入口再判一次（结论缓存在 `job.suiteDecision` 上，install-job 已判过时**零联网**直接复用）；
`routes/install.js` 把真实探测（`fetchRepoPackageEx` / `subpackageCandidates` / `probeGitmodules`）传进去。
判定为"插件通道"时**在克隆之前**返回 `notASuite`，由调用方**既有**的回落逻辑接管
（路由的 `runSuiteThenFallback` → `runInstallJob`）。

### 验收（真跑，非仅单测）

- 新增 `tests/test-suite-fallback.mjs`（**已进 CI 硬门槛**，27 条断言；前两段纯离线，后两段真 git/pnpm
  但源与 registry 都在本机 —— 不碰外网、不碰 live profile）：
  - ① 注入桩让根克隆抛错 → 必须返回 `notASuite`、**不得**置 failed、reason 带错误原文；
  - ② 克隆成功但 `.gitmodules` 为空 → 仍走原回落路径（不回归）；
  - ③ 已发布根包 → 不进套装分支；无发布物 → 仍按 `.gitmodules` 判；有已发布子包 → 进插件通道；
  - ③″ 显式套装请求（真机那条路）+ 有已发布子包 → **克隆之前**就回落，**一次 git 都没碰**（`cloneCalled === 0`）；
    真套装（子包都没发布）→ 照旧克隆装配（能力没删）；
  - ④ 真跑：根目录有 `.gitmodules` 但克隆必败（本机 RST 桩源）→ 真的回落普通通道，并按包名从本机
    registry 桩**真装成功**（真 pnpm，`node_modules` 里确有该包 + 补丁行写入）；
  - ⑤ 真跑对照：小仓库走 `file://` 裸仓库 git 克隆成功 → 套装装配照旧完成；
  - ③′（需外网）：本机实测真 `zhu1090093659/dsh-web` → `suite=false`、`preferred=@linxin666/dsh-web-all`、
    6.7 秒、**一次 git 都没碰**（本机 `api.github.com` 直连不可达，靠 gh CLI 通道读到 8 个子包）；
    CI runner 上该接口的**未认证**访问会被限流 → 测试如实打印 SKIP 原因，不假装 PASS
    （所以本套放在确定性的 Unit 硬门槛步，而不是需要外网的 smoke 步）。
- 全量测试：**52 套失败 0 套**（unit 39 套 / 真网络冒烟 4 套 / env-dependent 9 套；本套在 CI 模式
  `DSH_TEST_SKIP_NETWORK=1` 下 25/25 —— ③′ 打印 SKIP 原因、不假装 PASS；带外网时 27/27）。
  CI：run 36270544741（unit / real install smoke / real channel smoke / env-dependent 四步全绿）。

### 未验证 / 不确定项

- **本机官方桌面端实例（19387）的真机 E2E 在本版发布后执行**：点市场卡片（前端 `hasSuite=true` 时实际发的是
  `kind:'suite'`）→ 断言"不触发克隆、不拉 429 MB、最终装成 `@linxin666/dsh-web-all`"；结果随交付回报补记
  （若与预期不符会另发修复版，不会只留在回报里）。
- **显式套装通道的"拒绝"是判据触发，不是用户点不动**：前端只有在 `hasSuite === true` 时才发 `kind:'suite'`，
  而新增的第三处判据会在"根包/子包已发布"时把这类请求改道插件通道 —— 对**子包已发布**的仓库这是有意的行为变化
  （对纯 git 组件的真套装无影响）。若将来遇到"就是要装套装、但子包恰好也发过 npm"的仓库，需要新增一个显式覆盖开关。
- archive 通道对超大仓库的下载仍**没有体积上限**（0.5.18 引入，本版未改）：对没有已发布子包的巨型套装仓库，
  仍会走归档下载 + 逐子模块装配，耗时可能超出 8 分钟作业预算（作业预算目前只在候选循环里检查）。
- `zhu1090093659/dsh-web` 的默认分支是 `dev`，子包列表由 `gh api` + raw 读取（本机 `api.github.com` 直连不可达，
  靠 gh CLI 通道）；若某天 gh CLI 也不可用，则判据 ③ 会退回"读不到子包 → 仍按 .gitmodules 判套装"。

## v0.5.18 — 多源下载链路的七处「改错 + 加法」：git 停滞判据 / 通道预算 / 展开时机 / archive 通道 / npmName 首选候选（内核零改动）（2026-09-27）

本版**只做改错与加法**：不动内核结构、不删既有能力、不改公开行为语义，**成功路径行为不变**
（新增能力都在失败/慢路径上接管，或用"索引给了答案就跳过探测"这类**更快**的方式替代原有步骤）。
唯一有意的行为变化（改错）：`private: true`（未发布到 npm）的根包候选**不再尝试 git 克隆通道** ——
真机证据是这一步会去 clone 一个 429 MB 的仓库且 ghproxy 上 git 协议 0 B/s，纯白等。

### 一、git 通道：停滞判据 + 独立预算 + 只对「有进度」的源长超时重试（改错，A-①②⑧）

**问题**（2026-09-27 真机实测，同一台机器同一个 ghproxy.net 域名）：

| 传输 | 实测 |
|---|---|
| archive（普通 HTTP GET） | **4 MB/s** —— 429 MB / 105 秒下完 |
| git 协议 | **0 B/s** —— `git clone` 挂满整个超时，一个字节都不传 |

而旧代码有三处让这种源把整次安装拖死：

1. `runGitClone` 没有任何停滞判据，只能等自己的超时（默认 180 秒）；
2. git 通道**不封顶**：一个 git 源就能吃掉 8 分钟的作业预算，后面的候选与本来可用的通道再没机会试；
3. 「同源 1.75 倍长超时重试」是**无条件**的 —— 0 B/s 的源再等一次只是把白等拉长。

**修法**：

- `domain/repoland.js`：给 git 传全局选项 `-c http.lowSpeedLimit=1 -c http.lowSpeedTime=20`
  （必须排在子命令 `clone` 之前）→ 连续 20 秒 <1 B/s 由 **git 自己**中止并报
  `Operation too slow. Less than 1 bytes/sec transferred the last 20 seconds`；
- `infra/exec.js`：同一套判据的 **env 形式**（`GIT_HTTP_LOW_SPEED_LIMIT/TIME`）进 `gitEnv()` 与
  `buildPnpmEnv()` —— `pnpm add git+https://…` 内部自己 spawn git，我们传不了命令行选项；
  实测只带 env、不带 `-c`，git 同样 20.4 秒退出；
- 首轮 `gitCloneRepo` 超时 **180 秒 → 60 秒**（停滞判据已经把"只连不传"提前到 ≈20 秒判死）；
- 每个失败记录带上 `bytesReceived`（`.git/objects` 落盘字节数，即进度）：
  **只有 >0 B 的源**才用 1.75 倍长超时重试；0 B 的源如实写「本次收到 0 B（无进度，不再用更长超时重试）」；
- 新增 `domain/git-channel.js`：git 通道**独立预算**（默认 120 秒，`DSH_GIT_CHANNEL_BUDGET_MS` 可配，
  夹在 15 秒~8 分钟），且**不得超过作业剩余预算**；单个 git 规格超时 = min(60 秒, 剩余)；
  预算耗尽即停手，并在 `job.channelNotes` 留一条面板可见的原因。

**验收（真跑，非仅单测）**：

- `tests/test-git-stall-guard.mjs`（**已进 CI 硬门槛**）：真 git 对着本机"只连不传"的 TCP 桩源
  **20.4 秒**退出并报 `Operation too slow`；走完整 `gitCloneRepo` 时主源 20.6 秒判死后**自动落到
  备用源并克隆成功**（旧行为：每个源白等 60/180 秒）。
- `tests/test-git-budget.mjs` + `tests/test-real-git-budget.mjs`（真 pnpm + 真 git）：git 预算 15 秒时
  **15.6 秒收尾**，git 规格只真跑 1 次（拿到 14999ms 超时），随后展开出的下一个候选**照旧被尝试**
  （日志顺序：`… git:…:14999 → race → pnpm:@probe/agg → curl → release`）。
- `tests/test-clone-bytes.mjs`：0 B / 20480 B / 字段缺失三种文案；端到端 8192 B 触发长超时重试、
  0 B 不触发。

### 二、懒惰展开搬到 git 之前 + 根包未发布时禁 git（改错，A-③）

**问题**（真机事故：点装 `zhu1090093659/dsh-web` 全家桶，★8032）：该仓库根包 `private`、未发布到 npm，
旧顺序是"所有通道（含 git）都失败 → 才展开子包"，于是必然这样走：registry 404 → **直接进 git 通道
clone 那个 429 MB 的巨仓**（ghproxy 0 B/s，白等且注定失败）→ 真正能装的聚合子包
`@linxin666/dsh-web-all`（5.97 MiB）**连一次尝试机会都没有**。

**修法**：懒惰展开搬进 `tryCandidateChannels` 的 **registry 类通道之后、git 通道之前**（展开实现由
调用方注入，返回新增候选数；展开自身失败只记备注、绝不短路）；根包 `private === true` 时置
`job.gitChannelBlocked`，对该仓库**禁用 git 克隆通道**并把原因写进 `channelNotes`。
`expanded` 参数的既有语义一个字没改（触发展开的那一轮仍按旧语义试 git）。

**验收**：`tests/test-expand-order.mjs`（CI 硬门槛）钉死事件序列
`race → pnpm → curl → release → expand → git`（展开严格早于第一个 git 规格）、展开抛错不短路且留痕、
`gitChannelBlocked` 时 git 一次都不试而 registry 类通道照旧按包名施工。

### 三、通道 0 异常不再短路 + release 预算跳过必须可见（改错，A-④⑤）

- **A-④**：并行竞速那段（含其后紧跟的 `backfillMissingDeps`）旧代码不设防 —— 竞速实现抛一次异常
  （abort 竞态、curl 摘要计算、`_tmp_` 清理）就把作业判 failed，**后面的串行通道一个都不再试**。
  现在整段包 `try/catch`，异常记进 `lastError` + `channelNotes` 后继续往下走；另有细分：
  "curl 赢了但依赖补齐失败"只影响提示，**绝不把已经装好的包判成失败**。
- **A-⑤**：release 通道因候选预算被跳过时，旧代码只在 `lastError === null` 时才写一句 ——
  而最常见的情形（curl/pnpm 也失败）面板上完全看不出"release 通道根本没试"。现在原因**总是**
  写进 `job.channelNotes`（`installJobView` 已下发）；`lastError` 仍保留旧语义不覆盖真实错误。

**验收**：`tests/test-channel-robustness.mjs`（CI 硬门槛）。

### 四、读子包不再写死分支（改错，B-⑥）

真机 `dsh-web` 的默认分支是 **dev**（不是 main），而旧代码在懒惰展开里写死
`fetchSubpackageNames(repo, 'main')`（读不到再手工换 `master`）；meta 探测在黑洞期失败时 `branch`
恒为 main → 子包永远读不到 → 又是「未发现子包」的假失败。

**修法**：`market.js` 新增纯函数 `subpackageBranchOrder(branch)` —— 以**已拿到的** `meta.default_branch`
打头，再回退 main / master（去重保序；拿不到分支时与旧代码一致）；`fetchSubpackageNames` 接受单个分支名
或分支数组，解析逻辑原样抽成 `fetchSubpackageNamesOnBranch` 并支持 `deps` 注入。

**验收**：`tests/test-subpackage-branch.mjs`（CI 硬门槛）覆盖 dev-only / main-only / master-only
三分支与静态断言（install-job 里不再有写死 main 的读子包调用）。

### 五、探活判据换成 GET info/refs + 探活失败降级到最后一轮 + 归因文案（改错，B-⑦）

三个缺口：① 探活失败的源被判**永久跳过**（一次瞬时抖动就让唯一可用源再没机会）；
② 探活用 `HEAD /` 只验"域名活着"，200 的错误页/登录页/根本不是 git 服务的镜像照样算活；
③ 报错不区分"网络不可达"与"本地代理/证书拦截" —— 装了 Steam++ 这类加速器时用户看到的是
`unable to get local issuer certificate`，重试永远没用。

**修法**：`probeSourceAliveDetail` → `GET <url>/info/refs?service=git-upload-pack`，2xx 时校验响应首行是
pkt-line（`^[0-9a-f]{4}# service=git-upload-pack`）；403/405 仍按活着处理、响应体读不到时保守按活着处理、
`file://` 本地裸仓库直接算活着（旧代码一律判死 → 完全离线/内网共享盘场景永远用不上）；
`classifyProbeFailure` 把证书/代理类归为「本地代理/证书拦截（…）—— 检测到本机加速器/代理，建议关闭后重试」；
探活失败的源**降级到最后一轮**再试一次。

**验收**：`tests/test-probe-alive.mjs`（CI 硬门槛）+ 实网探针（ghproxy 的 info/refs = 存活、直连 github = 不可达）。

### 六、新增 archive 通道：git 协议拉不动时改走 HTTP 压缩包（加法，C-⑨）

**修法**：`domain/archive-source.js` —— 下载（curl `-f -L --max-time`）→ 解压
（`tar -xzf --strip-components=1`，另有 `flattenSingleDir` 兜底）→ `git init && git add -A && git commit`
→ 落地，返回与 `gitCloneRepo` 同形的结果（`source=archive:<源id>`、`archive:true`、`branch`、`bytes`、`gitNote`），
**上层无感**。超时/杀树/等退出一律复用 `infra/exec.js#execFileWithKillTree`；半成品目录复用
`infra/fsx.js#disposeDir`（删不掉就 `.trash-*` 降级）；失败记录带"本次下载到多少字节"。
分支自动回退 main → master → dev；成功判据是"解压出来有没有内容"（**不是**有没有 package.json ——
套装/技能/示例仓库都没有它）。`DEFAULT_SOURCES.archiveSources` 两条默认源（ghproxy 主 + codeload 备），
可在「软件源 → archive 源」增删/设主源（中英双语界面）。

**验收**：
- `tests/test-archive-channel.mjs`（CI 硬门槛）：默认模板逐字核对、主备顺序、分支回退、成功路径三步
  （下载→解压→建仓）、超时/空目录失败路径与字节数文案、`disposeDir` 降级、无 package.json 但有内容必须成功。
- `tests/test-real-archive.mjs`（**真网络**，CI 真实通道冒烟步骤）：git 通道对着"只连不传"桩源全废 →
  archive 真下载 `octocat/Hello-World`（258 B，分支自动回退到 master）→ 落地并建仓成功
  （`git rev-parse HEAD` 可读，全程 **9.1 秒**）；超时路径 28.4 秒内结束、无 `.archive*` 残渣。

### 七、已落地仓库优先复用（加法，C-⑩）

**修法**：`findLandedRepo(repo)` 在 `listLandedRepos()` 的落地清单里按 owner/name 匹配
（大小写不敏感、容忍 `.git` 后缀），命中还要求目录里**有 package.json**（没有它的多半是半成品/技能仓库）；
`gitCloneRepo` 开头先复用：命中就 `copyTree` 到 dest 并返回 `{ source:'landed', reused:true, from }`，
**一个网络请求都不发**。

**验收**：`tests/test-landed-reuse.mjs`（CI 硬门槛）。

### 八、市场索引加 `npmName` 字段 + hub 侧当首选候选（加法，C-⑪）

**修法**：新增 `marketplace/npm-name-hints.json`（人工核对过的 仓库→包名 映射；当前 1 条：
`zhu1090093659/dsh-web → @linxin666/dsh-web-all`）；`scripts/build-index.cjs` 生成索引时补 `npmName`，
`scripts/apply-npm-names.cjs` 可就地给已提交的 `index.json` 补（完全离线）；`marketplace/index.json 的索引条目现在带 `npmName`；hub 侧 `market.js#npmNameHintForRepo` 读**与 /market-index 同源**的落盘索引缓存，
命中时 `runInstallJob` 直接**只用它**作候选并跳过"读根 package.json → 展开子包"一整轮 + 禁 git 通道。
兼容旧索引：没有该字段 → 行为与改动前完全一致；索引是外部数据，包名要过合法性校验。

**验收**：`tests/test-real-npmname-hint.mjs`
- 离线：缓存命中/大小写/未收录/老索引无字段/缓存损坏/非法包名 六连；
  hint 路径下 **GitHub 探测一次都没被调用**、**没有任何 git 调用**、第一跳 pnpm 规格即聚合包本身；
- 真网络（npmmirror）：hub 的 curl 通道真装 `@linxin666/dsh-web-all@0.4.3` —— **0.7 秒**，
  落地 6,259,500 B vs registry 声明 `unpackedSize` 6,259,487 B（**5.97 MiB**，sha512 摘要校验通过）。

### 工程约束与未验证项

- `lib/server/**` 单文件 ≤ 600 行、架构守卫（domain 不吃 ctx、静态 import、无自由标识符、行数棘轮）
  全绿；为此把「失败清场 + 授权文案」原样搬进 `domain/install-cleanup.js`、把 git 通道策略搬进
  `domain/git-channel.js`（install-job.js 继续 re-export，调用点与测试的 import 面未变）。
- 新测试全部进 `.github/workflows/test.yml` 硬门槛；真网络的两套（archive / npmName）单独成
  「Real channel smoke」步骤。
- **未验证 / 已知边界**：
  - archive 通道只接在**克隆路径**（`gitCloneRepo` → 套装装配 / 仓库落地）上；install-job 的
    "git 通道"仍是 `pnpm add git+…`（pnpm 自己 spawn git），**未**改造成"先 archive 落地再本地装"。
  - `privateRoot` 禁 git 后，若某仓库的根包虽然 private 但**本身**就是可装插件，将失去 git 兜底
    （仍可从「仓库落地」或命令行 `dsh plugin add github:…` 安装）——这是按需求刻意取舍。
  - `npmName` 目前只有 1 条人工核对映射；其余仓库仍走"探测 + 展开"，行为不变。
  - archive 建仓（`git init/add/commit`）失败时**不算失败**：内容可用即返回，失败原因写进 `gitNote`
    （429 MB 这类大仓库的首个 commit 可能很慢）。

## v0.5.17 — pnpm 通道杀树后「等子进程真退出」+ 删不掉时 rename 降级成 `.trash-*`（改错 + 加法，内核零改动）（2026-09-27）

本版是**两处健壮性补强**，都属「改错 + 加法」：安装/升级/门控的**成功判定与公开行为语义未变**
（成功路径代码一字未动）；唯一有意变动的对外表述是**失败文案**——从「请手动删除」改成「已改名降级为
`.trash-*`，稍后自动清理」（用户指定）。

### 一、pnpm 通道：杀完树要**等它真的退出**才收尾（改错）

**问题**（`lib/server/infra/exec.js#execFileWithKillTree`）：超时/中断时是
`killTreeNow(); finish(killedError(…))` —— **同一个 tick** 完成，约 **+1ms** 就抛
「已终止整棵进程树」，而整棵树实际还要一会儿才从进程表/句柄表消失：

- POSIX：SIGKILL 的「投递 → 目标被调度死亡 → 被 init 收割」是**异步**的（CI run `36246293996` 实测约 120ms）；
- 本机 Windows：`taskkill /F /T` 虽是同步等待，但**目录项/句柄释放仍晚一拍** —— 本次探针实测
  `killTree` 同步耗时 228ms、目录第一次删得掉于 **+277ms**（此时 pid 早已消失）。

于是调用方（`pnpmRemove` 后立刻删目录、install 失败清场、`.tryN` 残留清理）仍会撞「文件被占用」。
**注意这是 pnpm 通道独有的缺口**：git 通道早在 `domain/repoland.js#waitChildExit` 里就等了。

**修法**：杀完树后**有界等待**它真退出，然后才 resolve/reject。

- 轮询 `processAlive(pid)`：上限 **2000ms**、间隔 **60ms**（`opts.killWaitMs` / `killWaitPollMs` 可调，
  `killWaitMs=0` 即显式退回旧行为）；
- 到点仍未退出**不阻塞**：照原路径收尾，并把 `waitedMs` / `exited` **如实**写在错误对象上
  （`runPnpmWithFallback` 包装时一并保真，否则上层看不到）；
- 收尾（超时/中断/超 maxBuffer 三条失败路径）等待期间 **close/error 不许抢答** —— 否则带
  `pid/timedOut/exited` 的 `killedError` 会被一句 `code=null 的普通失败` 顶掉；
- **成功路径零改动**：`{stdout,stderr}` 的 resolve 形状与既有字段一字未变（有回归断言钉死）。

### 二、删不掉时 rename 降级成 `.trash-<ts>` + 后台清理（加法；不再要求手动删除）

**问题**：`removeDirVerifiedWithRetry`（3 轮 × 250ms + `rmdir` 兜底）仍失败时，旧代码只能报错，并把
「可手动删除后重试：`Remove-Item -Recurse -Force …`」/「当前环境可能禁止删除，请手动删除」甩给用户。

**修法**：新增 `lib/server/infra/fsx.js#disposeDir(dir)` —— 先 `removeDirVerifiedWithRetry`，
**仍失败就同父目录 rename** 成 `.trash-<时间戳>-<随机>`。rename 只改目录项、不动内容，所以
「目录里有进程正在用的文件」这类占用通常挡不住它；改完原路径就空出来了，调用方可以继续
（install 能落新包、`.tryN` 能重来、删除能收尾）。返回结构化结果
`{ status:'removed'|'trashed'|'failed', removed, trashed, ok, path, trashPath, reason, attempts,
rounds, method, lockFailure }`（`ok` 的含义是"**原路径已经让开**"）。

调用点（grep 定位后逐个接）：`repoland.js` 的 `.tryN` 残留与 clone 前的 dest 清理、
`install-job.js` 的失败清场（候选包目录 + pnpm `_tmp_` 半成品）、`routes/components.js`
（落地失败清场 + `/repo-remove`）、`routes/skills.js`（技能删除）。面向前端短句统一由
`disposeNote()` 生成：**「目录正被占用，已改名降级为 `.trash-*`，稍后自动清理」**，
**任何分支都不再出现「请手动删除 / Remove-Item」**。

**后台清理（加法、尽力而为、绝不阻塞主流程）**：`cleanupTrashDirs` / `startTrashCleanup` 在
**插件启动钩子**与**每次安装开始前**各触发一次（即发即忘），扫 `tmpdir` / profile `node_modules` /
`~/.dsh/skills` / repos 下的 `.trash-*`（深度 ≤2）：最多处理 **20 个**、单个最多等 **1s**（到点就
不管它、留到下次），任何异常都吞掉只记日志，返回 `{ scanned, removed, kept, skipped, more, ms, dirs, error }`
如实统计（不假装扫全、不假装成功）。

### 三、借自哪两家（如实标注）

- **② 的 `isLockFailure` + rename 降级**：借自 **2BingLing/dsh-market** ——
  `plugin/core/src/installer.ts` 的 `isLockFailure()`（占用/权限类失败的判据正则**逐字沿用**：
  `EPERM|EACCES|EBUSY|being used by another process|resource busy|in use by another|Access is denied|Cannot create file`）
  与「目标已存在/setup 失败时先把目录 `renameSync` 成 `<dest>.bak-<ts>` 让开」的做法。
  我们把 `.bak-` 换成 `.trash-<ts>-<rand>` 并**补了后台清理**（借来的做法只让开、不回收）。
- **① 的「杀完树等它真退出」**：不是外部项目 —— 是**我们自己 git 通道已有**的
  `waitChildExit` 思路搬进 `infra/exec.js`，让 pnpm 通道与 git 通道**共用同一份语义**
  （同一类坑不各踩一次）。本次顺带把判据从"监听 close/exit"收紧为"轮询 `processAlive`"，
  并新增 `waitedMs/exited` 两个可被上层读取的字段。

### 四、验证

- **CI 全绿（本版门禁，双 step）**：commit `8e55625` → run **`36253556394`**：
  `Unit tests (hard gate)` ✅ + `Real install/uninstall smoke (temp DSH_HOME)` ✅
  （另有 `Environment-dependent tests` ✅）。
  此前同一批改动的 run `36253340149`（commit `e5e366a`）**红在 Unit tests**：CI（Ubuntu）抓到
  **Linux 允许删除"活进程的 cwd"**（Windows 才会拦），我原来的"占用"夹具跨平台假设错了 ——
  已按平台改夹具（POSIX 用只读子目录 = 删不掉但能改名；Windows 专属的滞后实测在 POSIX 上
  **如实 SKIP 并写明原因**，不假装 PASS），见 commit `8e55625`。
- **本机全量**：`node tests/test-*.mjs` **39 套逐条 exit=0**（原 37 套 + 本版新增 2 套）；
  `node --check` 全绿；`.github/workflows/test.yml` 的硬门槛清单里加入了两个新测试。
- **真实测试（真进程 / 真文件占用 / 隔离目录，原始输出见 commit 与测试文件）**：
  - ① `tests/test-killtree-wait.mjs`（PASS 23 / FAIL 0）：注入桩钉死顺序
    「先杀树 → 再轮询探活 → 最后才 settle」（含封顶、`killWaitMs=0`、close/error 抢答、包装保真）；
    **真机**：故意超时 1500ms → 错误到手瞬间被杀 pid 已不存在、整棵树（父 + 孙）无残留、
    **目录第 1 次尝试即删除成功（滞后 0ms）**；
  - ② `tests/test-trash-fallback.mjs`（PASS 38 / FAIL 0）：注入桩覆盖
    「删除永远失败 → 必须走 rename 且返回 `trashed`」「rename 也失败 → 明确双原因且文案无
    『请手动删除』」「上限 / 单条超时 / 异常全吞 / 即发即忘入口永不 reject」；
    **真机**：目录内有正在运行的 exe → 先验「真的删不掉」→ `disposeDir` 走 rename 成功
    （耗时 110ms、占用进程仍在跑）、`.trash-*` 真存在且删不掉的那个文件跟着搬走 →
    占用未解除时后台清理 `kept`（不谎报）→ 杀占用进程后后台清理 `removed=1`、`.trash-*` 消失。
  - 另一条真机证据：`tests/test-install-smoke.mjs`（真 pnpm + 真 git + 真 registry，本机直连跑通）
    **ALL PASS** —— pnpm 装/卸与 git 克隆两条真实通道都过了本次改动。

### 未验证 / 不确定项（如实列出）

- **① 的实战价值在 Windows 上有限**：本机 `taskkill /F /T` 本来就是同步等待，实测 `waitedMs` 多为 0；
  这条修复的价值主要在 **POSIX**（SIGKILL 异步、实测约 120ms 窗口）**以及"保证"本身**
  （不再出现"杀完立刻抛、以为句柄已释放"）。**没有**在 Linux 真机上测出"修复前 vs 修复后"的
  前后对照（本机是 Windows），Linux 侧证据 = CI 跑绿 + 既有的有界等待断言。
- **② rename 的边界（实测，未夸大）**：目录里有**正在运行的 exe** → 删不掉但**改名成功** ✅；
  目录是**活进程的 cwd** → 改名 `EBUSY`；目录内有以 **share=None** 打开的**文件句柄** → 改名 `EPERM`
  （父目录项被锁）。后两种改名也失败时如实返回 `status:'failed'`（不再让用户手动删除，后台会继续试）。
- **`.trash-*` 里若是只读子目录（POSIX）**：`clearReadonly` 只清**文件**的只读位、不清目录位
  （既有行为，本版**未改**），所以这类降级目录在被恢复权限前清不掉 —— 后台清理会 `kept` 留着下次。
  它至少已经把原路径让开了（这就是降级的目的）。
- **`routes/plugins.js` 的 `/clean-residuals` 未接 disposeDir**（仍是 `removeDirVerifiedAsync`）：
  它是用户手动触发的清理界面，按项如实报告成功/失败、且文案里本就没有「请手动删除」；
  改它需要同时改前端 i18n 文案（`count`/`removed` 计数口径），超出本版「改错 + 加法」范围。
  它留下的 `.trash-*` 会被后台清理接手。
- **两个 live profile 只做文件级同步 + spec/lock 行更新（未重启）**：新代码要等对应实例重启才生效；
  本次**不重启**用户实例（3080 / 桌面端）。
- 本次门禁 = **用户指定的 CI 双 step 全绿**；**未**另跑"全新实例 clean-install 门槛"。


## v0.5.16 — 修「装了 pnpm 12 就一个插件都装不上」（CI 抓到的真事故）+ POSIX 杀树按 /proc 兜底（改错，内核零改动）（2026-09-27）

本版是**修错版**：把 CI 抓到的一个真事故修掉 —— **装了 pnpm 12 的机器走 pnpm 通道任何插件都装不上**，
而这失败恰恰是我们自己在 0.5.13 为「加固」加的参数造成的。另带一个已在 CI 验证的 POSIX 杀树兜底
（孙进程不再必然残留）与两处测试自身的问题。安装/升级/门控的**成功判定与公开行为未变**。

### 一、pnpm 12 装不上（本版核心，CI 抓到的真事故）

**事故**：CI 的 corepack 在 Linux runner 上解析到 **pnpm 12.6.0**，而 pnpm 12 的 `add` **不认**
0.5.13 为加固加的 `--fetch-timeout/--fetch-retries`：

```
error: unexpected argument '--fetch-timeout' found

Usage: pnpm add --registry <REGISTRY> <PACKAGE_NAMES>...
（exit code 2）
```

0.5.13 的兜底判据 `unknownPnpmOption()` **只认 pnpm 11 的文案**
（`[ERROR] Unknown options: 'fetch-timeout', 'fetch-retries'`）。pnpm 12 把这段换成了 clap 风格后，
「去掉加固选项重试一次」的降级分支**永不触发**：第一跳直接 exit 2 →
**装了 pnpm 12 的机器走 pnpm 通道任何插件都装不上**。加固的本质是"让安装更稳"，
**绝不允许变成"装不上"**，这是本次事故最严重的地方（不是 CI 的环境问题，是产品缺陷）。

**修法**（`lib/server/infra/exec.js`，判据一行）：`/Unknown option|unexpected argument/iu` ——
**两代文案都认**；调用方（`runPnpmAdd`）看到这个错误就跑一次
`pnpmAddArgs(..., { fetchFlags: false })` 去掉加固选项重试。pnpm 11 / pnpm 12 两代真实文案各补断言
（`tests/test-pnpm-env.mjs`），并新增一条端到端降级断言：**用 pnpm 12 的真实文案喂进去，必须触发降级、
且第二跳真的不带加固选项**（正是过去不触发的那条路）。

**顺带修掉"排查时看不见真因"**：`tests/test-install-smoke.mjs` 里失败信息用
`error.message.split('\n')[0]` 截取，恰好把真实原因切掉 —— pnpm 的话在 message 的**第二行起**
（`Command failed: <命令行>\n<stderr>`），于是 CI 只留下「Command failed: <命令行>」，
当次谁也看不出为什么。现在原样带出 `code=` + 压平空白后的前 500 字符（③④⑥ 三处）。

### 二、POSIX 杀树兜底：按 /proc 逐个 SIGKILL（`9bfe686`）

**问题**：POSIX 分支的兜底过去是「成组 kill 失败就直接 `kill(pid)`」，那等于**承认孙进程必然残留** ——
pnpm 派生的 git / tar / node-gyp / 子 pnpm 会变成孤儿继续跑，占着 `node_modules` 与 `.git` 里的文件。

**改动**（`lib/server/infra/exec.js`）：新增 `posixDescendants()` —— 读 `/proc/<pid>/stat` 的 `ppid` 建索引
+ BFS 找出整棵子树（**纯读、任何一步读不到就返回 `[]`、绝不抛**）；成组 kill 失败时按**叶子到根**
逐个 `SIGKILL`。

- **为什么不用 `pkill -P`**：slim 容器 / 最小镜像未必装了 procps，而 `/proc` 是内核接口；
- **macOS**（无 `/proc`）→ 返回 `[]`，退化成「只杀直接子进程」，**不比旧行为差**；
- **返回值语义不变**（仍是"有没有成功发出过 kill"）；**Windows 分支一字未动**；
- `deps` 注入点（`platform/kill/procDir/readdir/readFile`）只为单测，生产调用不传。

### 三、测试自身：瞬时采样改有界等待（`9bfe686`）

CI（run `36246293996`）只红一条：`④ 链路父子进程同样已被回收`。同一 run 的 ①③ 链路父子探活都 PASS，
而 ④ 是**瞬时采样**：超时错误产生于 `07.3133s`，它在 `07.3155s`（**+2.25ms**）就判了「还活着」。
根因是**测试自己抢跑** —— SIGKILL 的「投递 → 目标被调度死亡 → 被父/init 收割」是异步的
（直接子进程此时常常还是未被 node 收割的僵尸），**不是生产代码没杀掉进程**。

改动（`tests/test-pnpm-kill-tree.mjs`）：④ 与 ①③ 统一用 `waitUntil` **有界等待**（8s，父与孙都必须死，
**真残留照样 FAIL**），并把实测等待时长打进断言信息（下次能一眼区分「慢」与「永远不死」）；
`缺 PID_FILE.2 就 if 静默跳过` 改成**硬断言**；新增 ⑦ 节 POSIX 分支桩测（本机 Windows 跑不到那条路）：
`spawn` 必须 `detached` / 成组成功只发一次 `kill(-pid)` / 成组失败后按 `/proc` ppid 链杀孙进程 /
无关进程不误杀 / 一个都杀不掉才返回 `false` / 抖动回归 + 负向对照（旧实现「只 `kill(pid)`」必须被判「没杀干净」）。

### 四、验证

- **CI 全绿（本版门禁）**：main 上 run `36251545628`（merge commit `9fc3bf6`）
  —— `Unit tests (hard gate)` ✅ + `Real install/uninstall smoke (temp DSH_HOME)` ✅；
  此前 main **连续三次红**（`36237465134` / `36246293996` / `36250604784`）都是本节第一条那个原因。
  CI 的真装真卸冒烟正是"pnpm 12 + corepack"的真机现场，**这条修好才算真修好**。
- **本机**：`node --check`（lib + 全部 `tests/test-*.mjs`）通过；CI 的 19 条 Unit tests 逐条本地跑过
  全部通过；`tests/test-pnpm-env.mjs` = PASS 18 / FAIL 0（含新增的 pnpm 12 降级断言）。
- 覆盖面：pnpm 11（本机 11.21.0 文案）与 pnpm 12（CI 真实文案）**两代都有断言**，
  且**不改变**「真实安装失败不重试、原样抛出」的既有语义（有断言钉死）。

### 未验证 / 不确定项（如实列出）

- **本机没有 pnpm 12 真机做真装真卸**：pnpm 12 的覆盖 = CI 的真装真卸冒烟步（真 pnpm 12.6.0 + 真 registry）
  + 注入 pnpm 12 真实文案的离线单测；本机（Windows，pnpm 11.21.0）只覆盖了 pnpm 11 的真实路径。
- **未做"版本感知加固"**：曾考虑先探测 `pnpm --version` 再决定带不带 `--fetch-timeout/--fetch-retries`
  （`>=12` 不带 / `<=11` 带 / 探测失败不带）。本版**没做**，理由：探测要落在所有安装通道的唯一入口上，
  而 runner 解析（`resolvePnpmRunners`）本身是**多候选按序回退**的（corepack 三种布局 + PATH 兜底），
  一次探测未必等于真正执行安装的那个 pnpm；corepack 冷启动还可能要现下载 pnpm，给安装热路径加一个
  网络相关的子进程并不可取。现有文案匹配的代价只是 pnpm 12 上**多一次瞬失败的 `pnpm add`**
  （参数解析即 exit 2，不走网络），随后降级重试即可装上 —— 收益太小、风险在"所有插件安装"的热路径上，故不做。
- **macOS「无 /proc」的退化路径只有桩测**（返回 `[]` 且不抛）；POSIX 兜底的真 Linux 证据 = 本次 CI 跑绿。
- **两个 live profile 只做了文件同步（未重启）**：新代码要等对应实例重启才生效；本次**不重启**用户实例。
- 本次门禁 = **main CI 全绿**（用户指定），**未**另跑"全新实例 clean-install 门槛"。

## v0.5.15 — 依赖锁体检/重建 + 测试目录的两个既有问题收尾（改错 + 加法，内核零改动）（2026-09-27）

本版把 3 个**已改完但未发布**的修复一起发出来，并新增「依赖锁体检 / 显式重建」能力。全部改动都是
「改错 + 加法」：既有安装/升级/门控路径的判定语义与公开行为未变（新分类只改**失败文案的定性**，
不改成功判定、不改重试上限）。

### 一、随本版一起发布的 3 个既有修复

- **宿主形态（`c112c75`）**：桌面端外壳托管的实例**禁止** kill + relaunch —— 桌面端 App 自己管进程，
  控制台再拉一次会变成"双实例抢端口"。判据来自 `domain/framework.js#detectHostShape`，
  `/framework-upgrade` 与 `/framework-rollback` 共用同一份 `shellHostedRefusal`（回滚路由过去漏了这个守卫）。
- **克隆清理（`e86afdf`）**：杀进程树之后**先等进程真的退出**，再按轮核实删除；`rmSync` 静默落空时
  用外部 `rmdir` 兜底，仍失败就如实报"被占用"（不谎报成功）。真机复现过"目录非空导致 clone 重试全灭"。
- **git 源策略（`2b57c48`）**：同源用更长超时重试，并**记住上次成功的源**（源顺序从"每次从头试"变成
  "上次成功的先试"）；仍保持"报首个真实错误 + 尝试清单"的既有语义。

### 二、测试目录的两个既有问题（本轮修）

- **`tests/diag-blocks.mjs` 长期红（全量 35/36）**：它是一个**诊断脚本**（只打印、无断言），读的
  `lib/server/domain/framework-install-script.js` **从未入库**（生成器现在在
  `lib/server/infra/fw-integrity-check.js`），于是每次运行抛 ENOENT。
  - **删除**它（诊断脚本不占测试名额）：同样的诊断能力移到 `scripts/diag-blocks.mjs`，
    读不到文件时**明确打印 `SKIP <来源> —— 原因`**，不再崩、也不假装成功；
  - **新增真测试** `tests/test-upgrade-script-blocks.mjs`：把抽取器的前提变成硬断言 ——
    ① 四个源文件必须真实存在；② 每个结束标记必须配对到开始标记（配不上 = 脚本块被静默丢弃）；
    ③ 升级脚本 / 一键回滚脚本 / 结构校验生成器 / 重启脚本四类块各就各位；
    ④ **通用护栏**：`tests/*.mjs` 里静态引用的仓库文件必须存在（正是这次事故的机制化拦网）。
  - 目标是"绿得有意义"：没有删断言、没有把失败改成永远 PASS，也没有补一个空壳文件骗绿。
- **live profile 的 lockfile 阻塞（真问题，隔离环境已复现）**：web profile 的 `plugin remove` / 任何 pnpm
  全量解析都失败，三条独立原因叠加：① 声明的 `dsh-github-login@0.1.0` 在 npmmirror 与 npmjs **双双 404**；
  ② `pnpm-lock.yaml` 陈旧残缺（importers 写 0.5.4、manifest 写 0.5.14，7 个依赖缺 4 个）；
  ③ pnpm 供应链闸 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`（新发版本不足 24h）。本版**只新增诊断与修复能力**，
  **不替用户改 profile**（用户环境修复另行确认）。

### 三、新增能力（加法）

- **失败分类新增三个分支**（`domain/install-diagnose.js`，纯函数）：
  - `fetch-404`：registry 抓取 404，**能点名具体包名**（从 pnpm 报错的 URL 还原，含 `@scope%2fname` 编码形态）；
    文案明写"本控制台**不会**为了让 lock 重建成功而静默丢弃你的依赖"。
  - `lockfile-outdated`：`ERR_PNPM_OUTDATED_LOCKFILE` / `ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY` —— 定性为
    "不是网络问题，是 lock 与清单对不上"，并指向下面两条路由。
  - `supply-chain-age`：`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` —— **只提示**"可用
    `--config.minimumReleaseAge=0` 显式绕过（有安全代价）"，retry 保持 `later`，**绝不自动绕过**。
  - 另外给诊断结果加了 `packages` 字段（面板能显示"是哪个依赖"），`not-found` 保留用于非 registry 解析的 404。
- **新模块 `domain/lockfile-health.js`**（L1 domain，纯函数 + 注入 IO）：
  `readManifestDeps` / `parseLockImporters` / `diffLockfile`（清单 vs lock vs 磁盘三方对账）/
  `freshReleases`（发布时间判定）/ `probeVerdict` / `repairArgsFor` / `runLockfileCheck` / `runLockfileRepair`。
- **两条新路由**（`routes/lockfile.js`，已进 `tests/test-route-inventory.mjs` 的 57 条清单与字段契约）：
  - `POST /plugin-console/lockfile-check`：**纯只读**体检（不写文件、不跑 pnpm），返回 ①②③ 的判定与清单；
  - `POST /plugin-console/lockfile-repair`：**必须用户显式调用**。先只读体检，遇到 404 依赖就
    **停下并点名**（`action: 'blocked'`，一个文件都不写）；否则跑一次
    `pnpm install --lockfile-only --no-frozen-lockfile --registry <主源>`（argv 由 `repairArgsFor` 唯一产出，
    **永远不含**绕过供应链闸的开关），跑完**复检** lock 与清单是否真的对齐才报成功。
- **面板与 i18n**：「升级安全」面板新增「依赖锁体检」一行（体检按钮 + 仅在服务端判 `applicable` 时出现的
  「重建 lock（显式）」按钮），短句进面板、长 hint 挂 title；三个新分类的短句中英各一份（`diagKindFetch404` /
  `diagKindLockfileOutdated` / `diagKindSupplyChainAge`），并由 `test-format-contract.mjs` 钉死中英各一处。

### 四、验证

- **全量 38 套测试全绿**（原 36 套：删 1 套无断言的诊断脚本 + 新增 3 套）；
- 新增离线单测 `tests/test-lockfile-health.mjs`（纯函数 + 注入 IO：只读性、404 阻塞、argv 无绕过开关、
  复检才报成功、真 fs 逐字节只读）；新增 `tests/test-upgrade-script-blocks.mjs`；
- **隔离 profile 真实环境验证** `tests/test-lockfile-repair.mjs`（真 registry + 真 pnpm，DSH_HOME 指向临时目录）：
  ① 体检点名真 404 依赖（npmmirror 实测 404）；② 重建在 404 依赖上 `action=blocked` + 给出包名 + 清单与 lock
  逐字节未变；③ 去掉假依赖后重建成功、lock 与清单对齐、`package.json` 未被改动；④ 随后控制台自己的
  pnpm 通道 `add` / `remove` 跑通（包真落到磁盘、lock 里也记下、remove 后目录与清单都干净）。

### 未验证 / 不确定项（如实列出）

- **用户真实 profile 未做任何修复**：本轮只在隔离 profile 验证能力。live web profile 里那个 404 依赖
  （`dsh-github-login@0.1.0`）仍需用户自己决定（该包源码在本地有检出，是否修好再发版由用户定）。
- **两个 live profile 只做了文件同步（未重启）**：服务端路由与客户端 i18n 要等用户重启对应实例才生效；
  浏览器里的实际像素（新面板那一行、按钮点击）未人工验证。
- `minimumReleaseAge` 的判定口径是"registry 的 `dist-tags.latest` 发布时间 < 24h"（pnpm 自身策略更复杂，
  含依赖树的传递版本）；镜像不返回 `time` 字段时**不判定**（不猜）。
- 重建只跑 `pnpm install --lockfile-only`：不写 node_modules、不改 `package.json`；**未验证**在 pnpm 6/7
  （lockfileVersion 5/6）上的重建表现（本机 pnpm 10/11 + lockfileVersion 9 实测）。
- CI 未实际触发（workflow 里已加新测试，Linux 上真实 registry 部分会自动打印 SKIP + 原因）。


## v0.5.14 — 补齐其余 git clone 调用点的杀树（改错，内核零改动）（2026-09-26）

延续 0.5.13：把"超时只杀直接子进程 → git 孙进程占住 .git 文件 → 目录删不掉 + 误导报错"这一类问题清干净。

- `ai-run.js`（AI 赋能克隆仓库，超时 120s）与 `skills.js`（技能安装克隆，120s）改用 `execFileWithKillTree`
- `components.js` 经核实**没有 git clone**（仅 taskkill），未改 —— 不做无意义改动
- **未改**：curl 通道（自带 `-m 60` 自终止）与 Release 通道（`gh release download`，单进程、不派生孙进程）
  —— 经代码核实这两条**不会**出现该故障形态；其超时仍有 job 级失败分类兜底
- 新增静态护栏 `tests/test-git-clone-killtree-guard.mjs`（若有 git clone 必须走杀树版 + 杀树实现单一化）

验证：**31 套测试全绿**；真实测试 REAL-3（真克隆 + 故意超时）通过、`git.exe` 残留 **0**。
## v0.5.13 — 融合社区高星市场的安装健壮性（改错 + 加法，内核零改动）（2026-09-26）

调研 GitHub 上星最多的 13 家 DSH 插件市场/管理器（详见报告），把它们的下载安装优点以**改错 + 加法**方式融合：

- **超时/中断杀整棵进程树，覆盖全部通道**（借鉴 dsh-market / dsh-plugin-shop / Sanqi）：新增
  `infra/exec.js#execFileWithKillTree`（spawn + 超时/中断/超 buffer 三条失败路径先杀树），pnpm 通道改用它；
  git 通道复用同一份实现（此前两处各一份）。真机验证：真 pnpm 卡在假 registry 上 6.0s 被杀，父/孙进程均回收。
- **pnpm 健壮性注入**（借鉴 Sanqi）：追加 `CI=true` 等 env，并为 `pnpm add` 注入 `--fetch-timeout/--fetch-retries`；
  实测 **pnpm 11 不读同名 env**（只有 CLI 选项生效），且 `pnpm remove` 不认这些选项会报错 → 选项只加在 add，并带"不认就降级重试一次"。
- **失败分类 → 定向重试一次**（借鉴 dsh-market）：新增 `domain/install-diagnose.js`，网络类超时用更长超时**只重试一次**，
  其余分类只写 `job.diagnosis` 提示。**`allowBuilds` 只提示、绝不代写白名单**（与 dsh-plugin-shop 的安全取舍一致）。
- **装后校验 + 下载物摘要校验**（借鉴 dsh-market 的"镜像不完整"诊断 + shop 的 sha256）：
  新增 `domain/install-verify.js` —— 校验入口 main/exports 存在性、补丁行与包名一致、bundle 引用可解析，
  失败给出「镜像可能未同步完整」+ 重装/换源建议；tarball 摘要校验（有摘要才校验，**只记录不拒装**，避免误杀镜像重打包源）。
- **面板可见**：上述三字段接入控制台 UI（短句诊断 + 悬浮详情），中英双语。

测试：新增 4 套（kill-tree / pnpm-env / diagnose / verify）→ **30 套全绿**；真实验收 4 项通过
（pnpm 真装 + 摘要与 npmmirror 逐字符一致 / 真 pnpm 超时杀树无残留 / git 真克隆 + 故意超时无残留 git / 全量测试）。
**未验证**：POSIX `kill(-pid)` 未在真 Linux/macOS 跑过；CI 未实际触发。
## v0.5.12 — README 还原 + 顶部「Web & Desktop 双支持」小字（2026-09-25）

用户在 GitHub 网页上误改了 README（提交 `7dd319a` "Update README.md"：顶部插入 `desktop:` / `web:` 标签行、
并替换掉原有的官网截图行）。按用户要求：

- **还原** `README.md` 到 `7dd319a` 之前的内容（恢复原截图行，移除插入的标签行）
- **顶部新增小字**（两语各一行，`<sub>`）：
  - `README.md`：`<sub><b>Web</b> & <b>Desktop</b> — both supported.</sub>`
  - `README.zh.md`：`<sub>同时支持 <b>Web</b> 与 <b>Desktop</b> 两种形态。</sub>`

仅 README + 版本号，代码零改动。
## v0.5.11 — 还原面板「运行模式」文案（语义只留在 README）（2026-09-25）

0.5.10 把「启动失败隔离不受模式影响」那段说明拼进了面板「运行模式」行内，用户反馈**太长、影响美感**。
按用户要求还原：

- 面板文案全部还原为 0.5.9 的原文（观察者 / 托管两条描述、切换提示均回原文）
- `safetyModeNote` 键与行内拼接一并移除（面板那一行恢复成"运行模式"+ 一行模式描述）
- **语义说明只保留在 README**（`### Run mode` / `### 运行模式`），面板不再承载长文

代码行为零改动；25 套测试全绿。
## v0.5.10 — 运行模式语义对齐（代码行为不变，文案与 README 说清）（2026-09-25）

用户提问「门控是运行期检查吧？不升级也能禁用吧？（如果是运行模式）」时核实发现：**运行模式目前并不约束启动失败隔离**
（全仓库 `readCompatMode()` 只有两处调用：`/compat-status` 上报 + 升级路由的 `autoSwitchToManaged`），
也就是"模式"实际只表示**谁主导升级**，隔离/禁用在两种模式下都会执行。

按用户决定（选项 B）**保持行为不变，把语义说清**：

- 面板文案：观察者标注为**默认**；托管改为"走本控制台升级时自动切到这个模式"（原文误标为"默认"）
- 新增共用说明键 `safetyModeNote` 并渲染在「运行模式」行内：
  「启动失败隔离不受模式影响：服务起不来时会自动定位肇事插件并禁用（预设文件改名 .broken-*，找不到肇事者则进安全模式）」
- README.md / README.zh.md 各加一节 `### Run mode (managed / observer)` / `### 运行模式（托管 / 观察者）`，写明：
  模式只决定谁主导升级；**启动失败隔离永远生效**（起不来的控制台什么都门控不了，救火链路必须无条件跑）

代码行为零改动；25 套测试全绿。
## v0.5.9 — README 兼容性说明（元数据版，代码未动）（2026-09-25）

老框架兼容性经隔离实测后在两个 README 里写明：

- **支持框架 ≥ `0.1.5-rc.2`**（隔离实例、真实 HTTP 探针，无需变通）
- 老框架（如 0.1.5-rc.2 / 0.1.2-rc.1）**框架本身不带官方插件页** → 「升级安全」新入口无处可挂、不显示；
  原「插件」tab 照常，服务端功能（升级/回滚/门控/市场）一个不少，**全程无报错**（静默降级）
- README.md 新增 `## Framework compatibility`，README.zh.md 新增 `## 框架兼容性`
- 附带记下框架自身的一个坑：`0.1.2-rc.1` 给没有 HMR 服务的 web 树配 `patchReload: "live"` → 启动约 10s 后 exit 1（与本插件无关）

代码不变（仅 README + 版本号），25 套测试仍全绿。
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

**实测对照**（真 pnpm 10.34.5 + 真 corepack，临时 profile；详见仓库外私有方案稿第 23 节）：

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
  一律改为「删完**核实**再报成功」。本机实测同一个 `rmSync` 在盘根删得掉、在 `C:\Users\…\.dsh\…` 与
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
- **回滚脚本自身崩溃**：生成的回滚 PowerShell 里有 4 处把已带引号的路径又套了一层单引号（`'"<盘符>:\…"'`），空串还被写成字面量 `""` → 全树恢复被静默跳过；回滚体没有 try/catch，崩了只留一句 trap 消息、旧树半新半旧。现已修正引号/空串处理（含路径里 `$` 的转义），回滚体包 try/catch 并记录**出错位置**。
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
- **安全护栏**：命令白名单（curl/git/node/python/gh/npm/ov）、写入路径白名单（profile、~/.dsh、~/.openviking、~/.cache/openviking、ASCII 数据根）、破坏性命令拦截、日志密钥脱敏；
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
