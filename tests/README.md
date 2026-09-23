# tests/ — 测试套件（19 个 `.mjs` + 1 个严格测试替身）

这些都**不随 npm 包发布**（`package.json` 的 `files` 只含 `lib/`、`cordis.patch.yml`、`SECURITY.md`）。
放在 `tests/` 只是为了仓库根目录干净——根目录原来堆了 21 个 `.mjs`。

## 怎么跑

从**仓库根目录**跑（不是 `tests/` 里面）：

```bash
node tests/test-compat-gate.mjs        # 适配门（内置零依赖 semver 判定器）
node tests/test-harness.mjs            # state / toggle / 校验 / 环回保护
node tests/test-install-smoke.mjs      # 真装真卸冒烟（临时 DSH_HOME，需网络）
node tests/test-route-inventory.mjs    # 47 条路由清单 + 契约
node tests/test-upgrade-script-syntax.mjs   # 生成的 PowerShell 升级/回滚脚本真解析
```

想一次跑完（本地全量 18 个）：

```powershell
# Windows PowerShell
Get-ChildItem tests\test-*.mjs | ForEach-Object { node $_.FullName }
```

```bash
# bash
for f in tests/test-*.mjs; do node "$f"; done
```

**为什么必须从根目录跑**：脚本里的 `ROOT` 是"本文件所在目录的上一层"，即仓库根，
所有 `lib/**` 读取、`package.json` 读取、`.testdir/` 临时目录都基于它。
（各文件里写的是 `dirname(dirname(fileURLToPath(import.meta.url)))`，改动这行会让测试找不到 `lib/`。）

## 文件一览

| 文件 | 覆盖什么 |
|---|---|
| `test-harness.mjs` | state / toggle / 校验 / 环回保护（搜索视网络 SKIP） |
| `test-compat-gate.mjs` | 适配门：内置 semver 判定器（声明 + 依赖兼容规则）15 项 |
| `test-compat-soft-lock.mjs` | 兼容门三条定案：软禁可确认放行 / 只提示不自动解锁 / 两个总开关；走真实路由处理器 |
| `test-preflight-guard.mjs` | 预扫禁用守卫：子串巧合不误判 / 框架自带包永不自动禁用 / 幂等 |
| `test-preflight-disable.mjs` | 预扫禁用 11 项 + 启动失败日志分析器 + 隔离决策器 11 项 |
| `test-quarantine-merge.mjs` | `fw-quarantine.json` 合并：BOM、校验通过才销毁、写失败必须留记录、幂等 |
| `test-format-contract.mjs` | **跨进程落盘格式契约**（升级脚本与用户都直接读这些格式，分层重构时一个字都不能改） |
| `test-route-inventory.mjs` | 路由清单 + 契约（含 `reconcileLockfile` 多包对账、依赖来源保真） |
| `test-framework-upgrade.mjs` | 框架升级：备份快照 / 版本变化检测 / 补丁状态 / 回滚可用性 + 客户端接线 |
| `test-upgrade-script-syntax.mjs` | 把生成的 PowerShell 升级 / 一键回滚脚本抽出来**真解析**（只解析不执行） |
| `test-bundle-guard.mjs` | bundle 引用防线：`dsh-root` 缺失必须 reject，全家桶必须 allow |
| `test-issue15-resolve.mjs` | 场景模拟（issue #15）：npm 全局安装时 `resolvePackageJson` 的回退解析 |
| `test-preset-migration.mjs` | 预设迁移 / 幂等 / 不误伤其它插件 / 版本门控 11 项 |
| `test-skill-toggle.mjs` | 技能启用 / 禁用 / 目录真实增删 |
| `test-registry-scan.mjs` | 软件源扫描：结构断言 + 不可达源降级 + 非 POST 405 门禁 |
| `test-suite-detect.mjs` | 套装识别：空 body / 垃圾页不算套装、四种竞速结局（离线确定性） |
| `test-suite-install.mjs` | 套装安装全路径 + 「整条安装路径账本为空」断言 |
| `test-install-smoke.mjs` | 真装真卸冒烟（Linux CI 上跑，专门用来抓 `git.exe`、corepack 路径这类硬编码） |
| `strict-ctx.mjs` | **严格 cordis 测试替身**（不是测试，是别删的基础设施，见下） |

## `strict-ctx.mjs` 为什么存在（别删）

2026-09-22 的 0.3.59 事故：为了给单测留"安装通道实现注入缝"，代码写成了 `ports?.installChannels`（属性访问）。
单测喂进去的 `ctx` 是**手写普通对象**，读任何属性都返回 `undefined` → **测试全绿**；
而生产路径上 `ports` 就是 cordis 的 `ctx` 代理，读一个没写进 `inject` 的名字会**同步抛**：

```
cannot get property "installChannels" without inject
```

结果每一次安装都失败。抢修两版之后才做根因修复：**把 cordis 的语义复刻成测试替身**
（`ctx.get(name)` 合法、未 inject 的属性访问抛错并记账本、`symbol`/`then` 这类特殊名字透传），
`test-suite-detect.mjs` 与 `test-suite-install.mjs` 全程换用它。
同类缺陷（"单测全绿 / 生产必炸"）从此在提交前就会被拦下。

## CI

`.github/workflows/test.yml` 三个硬门禁步骤，**全部按 `tests/...` 路径调用**：
语法检查（`node --check` 全量）→ 单元测试（9 个纯离线套件）→ 真装真卸冒烟 → 环境依赖套件（无本地 profile 时自动 SKIP）。
