# 框架回滚在桌面端能不能支持 —— 只读可行性结论（0.5.84，2026-10）

> 本文只回答"能不能、要什么前置条件、有什么风险"，**没有改动任何回滚行为**。
> 回滚路由今天在桌面端仍然是**明确拒绝**（409 + 说明），见 `lib/server/routes/framework.js#routeFrameworkRollback`
> 里的 `refuseWhenShellHosted`。本文的每一条事实都可以用只读命令复现（见文末「复现方式」）。

## 一句话结论

**当前形态下不支持，也不建议支持**：桌面端真正加载的框架在一个 182 MB 的签名 `app.asar` 里，
而我们的回滚记录与框架基准都指向 **npx 缓存树**里的另一份副本 —— 就算把那份恢复成功，桌面端也不会加载它；
要真的改 asar，就必须重打这个归档，代价是破坏安装包的代码签名与自动更新链、并有把应用弄成"打不开"的风险
（正是用户明令不许出现的那类故障）。这件事的归属是**官方更新器**，不是插件。

## 一、现场事实（只读实测）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 桌面端框架代码在 `resources/app.asar` 里 | 该文件 182,794,869 字节；`resources/app.asar.unpacked/` 只放了解包出来的原生/大件（office kit、fflate 等），**没有框架 JS 的可写副本** |
| 2 | 普通 Node 进程**读不进** asar | `fs.readFileSync('<…>/resources/app.asar/dsh/package.json')` → `ENOENT`；`existsSync` → `false`。asar 是单文件归档，只有 Electron 打过补丁的 fs 认识它 |
| 3 | 我们的"框架在哪"指向 npx 缓存树 | `frameworkBases('<profile>')` → `<npm cache>/_npx/<hash>/node_modules`；`framework-rollback.json` 的 `fwRoot` / `checkpointDir` 也在这棵树里 |
| 4 | 两边的版本**已经不一致** | 桌面端可执行文件的 FileVersion = `0.2.1-rc.2`；而我们解析出来的框架版本 = `0.2.0-rc.2` |
| 5 | 插件拿不到官方重启通道 | 见 `lib/server/domain/restart.js` 顶部取证：桌面端 IPC 表里没有 restart/relaunch，外壳只认 `shutdown` |
| 6 | 今天的回滚在桌面端**已经是拒绝** | 路由第一行就是 `refuseWhenShellHosted(res)`；`tests/test-restart-official-path.mjs` 钉着这条 |

事实 4 是这次调研里最值得单独记一笔的：**面板显示的框架版本可能本来就是错的**（我们读的是 npx 树，桌面端跑的是 asar）。
它不是回滚的问题，但和回滚是同一个根因 —— "我们以为的框架"和"真正在跑的框架"不是同一份。

## 二、为什么"把 npx 树恢复回去"不够

回滚脚本做三件事：停服 → 把 `<fwRoot>` 全树恢复成检查点里的样子 → 拉起新的 `dsh`。
在桌面端这三步都不成立：

1. **恢复的目标错了**：`fwRoot` 是 npx 树；桌面端从 asar 加载 ⇒ 恢复了也没人用。
2. **拉起的方式不存在**：桌面端只有一个实例，宿主是外壳的子进程；插件没有 restart 通道，
   而"杀进程 + 自己 spawn"恰恰是 2026-10-10 那次「应用无法启动或已意外停止」的成因（用户红线）。
3. **真正要改的那份不可写**：asar 是归档文件，改它等于重打包。

## 三、如果要支持，需要哪些前置条件（缺一不可）

1. **官方提供"框架版本钉住"**：桌面端启动时能从两个已安装的框架版本里选一个（例如
   `resources/runtime/frameworks/<version>/` 这种"版本并存 + 启动时选择"的形态），而不是把这个版本藏进 asar。
2. **官方提供"按版本重启"的外壳命令**：能通过 IPC/命令行让外壳自己用指定版本重启整个应用
   （等价于官方那条 `app.relaunch()`）。插件只发请求、不碰进程。
3. **一份 asar 之外可读的框架清单**：路径 + 版本 + 哈希。今天的 `resources/runtime/versions.json` 只声明
   node / pnpm 版本，没有框架版本 —— 于是"到底在跑哪一份"插件无法确认。
4. **完整性/签名的说法**：要么这些版本目录不参与签名校验，要么由官方在打包时就带上多个版本；
   插件自己改归档这条路必须排除（会破坏 Authenticode 签名与自动更新链）。
5. **检查点目录与"当前运行的框架"对得上**：今天的检查点是 npx 树的快照；支持桌面端后要有桌面端自己的检查点，
   并明确"回滚桌面端"到底回滚的是 asar 里的哪一份。

## 四、风险（按严重度）

| 风险 | 说明 |
|---|---|
| 应用打不开 | 改 asar / 半途恢复都能留下"启动就崩"的现场；桌面端崩溃只有一句「应用无法启动或已意外停止」，用户无从自查 |
| 破坏签名与更新 | `DeepSeek Harness.exe` 带 Authenticode 签名（`publisherName: CN=Hangzhou DeepSeek …`），改资源后签名失效 ⇒ SmartScreen 拦截、官方更新器可能拒绝覆盖 |
| 版本漂移被掩盖 | 现在面板已经可能显示错版本（事实 4）；若在此基础上做回滚，用户会以为"回滚成功"而实际加载的还是 asar 里那份 |
| 检查点体积 | 本机 `framework-backups/` 2.1 GB，其中 2,166 MB 就是当前回滚点那一份；`framework-rollback.json` 的 `checkpointDir` 正指向它。为"其实用不上"的回滚养着 2.1 GB，是实打实的成本 |
| 双实例争端口 | 任何"停掉再拉起"的插件侧实现都会踩 EADDRINUSE（独立实例那里我们靠启动器等端口解决，桌面端没有这个自由度） |

## 五、现在能诚实做到的事（都是只读/加法，已具备或已收敛）

- 桌面端回滚按钮**明确拒绝**并说清出路（官方更新器 / 客户端里重启）—— 已实现，测试钉着。
- 面板可以把"回滚不可用"的原因摊开（`host.hosted` + `notice`）—— 已实现（0.5.53）。
- 磁盘体检把"这份 2.1 GB 是回滚点，不能删"如实标出来，并给出剩余可清理项 —— 0.5.84 已实现
  （`GET /plugin-console/disk-audit`）。
- **待办（未做，需要用户拍板）**：把"面板显示的框架版本 = asar 里的版本"这件事修正。
  可行路径只有"官方给出 asar 之外的框架清单/版本号"，在那之前**不要在面板上编一个版本号**；
  现在能做的诚实表述是"这个数字来自 npx 缓存树，可能与桌面端实际加载的不一致"。

## 六、复现方式（全部只读）

```powershell
# 1) asar 存在且是一个单文件
Get-Item <安装目录>\resources\app.asar | Select-Object Length
# 2) 普通 node 读不进 asar（应输出 ENOENT / false）
node -e "const fs=require('fs');try{fs.readFileSync('<安装目录>/resources/app.asar/dsh/package.json')}catch(e){console.log(e.code)}"
# 3) 我们的框架基准指向 npx 树
node -e "import('./lib/server/infra/framework-root.js').then(m=>console.log(m.frameworkBases(process.env.DSH_PROFILE_DIR, process.env.DSH_PROFILE_DIR)))"
# 4) 桌面端 exe 版本 vs 解析版本
(Get-Item '<安装目录>\*.exe' | Select-Object -First 1).VersionInfo.FileVersion
```

> 注：以上路径全部用占位符书写，本仓库不记录任何本机绝对路径（`tests/test-peer-veto.mjs` ④ 会扫这类串）。
