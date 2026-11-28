# 工具治理真实 DSH 测试留痕

> 日期：2026-11-27
>
> 状态：**已完成（rc.1 live）；rc.5 待复测**
>
> 测试方式：临时将 live DSH 的 `@noob-stupid/dsh-plugin-console` 切换到本地工作区，通过真实 HTTP RPC 驱动 Agent；测试后已还原。
>
> 生产化补强（2026-11-28）：小目录自动跳过（minCatalogTools=10）、零分工具不再填满上限、CI 门禁、80 工具 Schema 成本基准（35,440B → 2,658B，-92.5%）。真实 host 80 工具测试已在 Electron 下对 **rc.5 asar** 复跑通过（catalog/restrict/search/activate/deny/composite/restore）；rc.1 live E2E 仍不能替代 rc.5 的真实 Agent 会话复测。

## 1. 环境

- OS：Windows 10.0.26200
- DSH：`0.2.2-rc.1`，live Web 进程，`127.0.0.1:3080`
- 插件：`@noob-stupid/dsh-plugin-console 0.5.116` + 本地未提交的工具治理/M2 代码
- 测试会话：`session-tool-governance-e2e`
- 工作区：`D:/dsh/dsh-plugin-hub`
- 真实宿主工具测试：`tests/test-tool-governance-host.mjs`

## 2. 临时切换与还原

### 切换

- live 插件原目录改名为：
  `C:/Users/花火/.dsh/profiles/web/node_modules/@noob-stupid/dsh-plugin-console.bak-tool-governance-20261127`
- 原路径创建 Junction，指向 `D:/dsh/dsh-plugin-hub`
- `C:/Users/花火/.dsh/profiles/web/cordis.patch.yml` 追加临时注释触发 HMR
- 测试前补丁备份：
  `D:/dsh/dsh-plugin-hub/.testdir/live-cordis-patch-before-tool-governance.yml`

### 还原

- 已删除 Junction，恢复原插件目录
- 已恢复测试前 `cordis.patch.yml`
- 还原后补丁 SHA-256 与备份一致：
  `53622ed41a36f9ee4dfa8bb97ffd4ec155a98d0002e54cfa97c65be346acb5af`
- live `/state`：`selfVersion=0.5.116`，`entries=239`，`loadFailed=0`
- 工具治理路由已恢复为旧版行为（不存在）
- 测试产生的 live 配置/遥测已移出 live：
  `D:/dsh/dsh-plugin-hub/.testdir/live-tool-governance-artifacts-20261127/`

## 3. 测试结果

### 3.1 HMR 加载与目录

**通过**

- 本地代码通过 HMR 加载成功
- `catalogCount=40`
- 识别到真实活跃 Agent，包含测试会话
- 基础工具按策略收敛，`capEnforced=true`

### 3.2 提示词组装防护

**首次失败，已修复**

首次真实会话在模型请求前失败：

```text
Cannot read properties of undefined (reading 'map')
```

原因：`system-prompt/assemble` 监听器假设下游返回值一定包含 `tools` 数组。

修复：增加 `result.tools` 类型与数组检查；缺失时原样返回下游结果。

回归测试：`tests/test-tool-governance.mjs` 新增 `prompt assembly listener tolerates missing tools array`。

### 3.3 工具搜索

**通过**

真实 Agent 调用：

```text
plugin_console_tool_search {"query":"web search"}
```

返回 `web_search`、`web_fetch`、`grep`、OpenViking MCP 工具等目录结果。

### 3.4 工具激活与下一步调用

**首次失败，已修复**

首次真实会话中：

```text
plugin_console_tool_activate {"names":["web_search"]}
→ Activated: web_search
```

但下一步 `web_search` 仍未进入调用面。

原因：代码错误地只用根作用域 `ctx.tools.schemas()` 生成 allow-list，导致 Agent 预设祖先作用域中的工具被过滤。

修复：

- allow-list 使用完整选中工具集合；
- 对作用域自有工具导致的 `unknown global tool` 进行重试剥离；
- 作用域自有工具仍由宿主保持可见，并计入 `scopeOwnedCount` / `capEnforced` 指标。

修复后真实会话：

```text
plugin_console_tool_activate {"names":["web_search"]}
→ 下一步 web_search {"queries":["DeepSeek Harness"]}
→ 成功返回 8 条来源
```

### 3.5 隐藏工具直接调用

**live 未形成直接 registry 拒绝证据**

真实 Agent 被要求直接调用 `lsp`，模型报告 `lsp` 不在可调用工具集合中，未发出真实 `lsp` 调用；因此 live 只能证明“工具未暴露”，不能替代 registry 层拒绝证据。

registry 层拒绝由真实宿主测试覆盖：

- `tests/test-tool-governance-host.mjs`
- 80 工具场景下，未激活工具直接 `ctx.tools.execute()` 返回 `isError=true`

### 3.6 Schema 优化工作室

**代码与自动化测试通过，live UI 未单独验收**

- 问题报告：`tests/test-tool-governance.mjs`
- 描述预览：`tests/test-tool-governance.mjs`
- 真实宿主目录：`tests/test-tool-governance-host.mjs`
- 原生 UI 渲染：`tests/test-tool-governance-ui.mjs`

### 3.7 声明式组合工具

**激活与嵌套执行均通过**

通过 live 配置接口注册：

```text
plugin_console_live_catalog_probe
```

首次真实 Agent 调用失败：

```text
plugin_console_live_catalog_probe {"query":"composite live test"}
→ Error: Tool batch execution failed
```

原因：live DSH `0.2.2-rc.1` 的 `ctx.tools.execute()` 已改为批量调用 API，而组合工具仍按旧版单次调用 API 传参。

修复：通过 `selectExecutor` 能力检测兼容新旧 API：

- 旧版：传入单次 `ToolExecutionInput`
- 新版：传入 `{ calls: [{ id, name, arguments }], agent, signal }`
- 从批量结果中提取对应嵌套结果

修复后真实 Agent 复测：

```text
plugin_console_tool_activate {"names":["plugin_console_live_catalog_probe"]}
→ Activated

plugin_console_live_catalog_probe {"query":"composite live test"}
→ Composite completed (1/1)
→ plugin_console_tool_search — ok
```

结论：

- 组合工具注册与激活成功；
- 组合工具入口可被模型调用；
- 嵌套 `plugin_console_tool_search` 执行成功；
- 新旧 DSH ToolRuntime API 均有自动化测试覆盖。

## 4. 自动化回归

- `tests/test-tool-governance.mjs`：通过
- `tests/test-tool-governance-composite.mjs`：通过
- `tests/test-tool-governance-host.mjs`：通过
- `tests/test-tool-governance-ui.mjs`：通过
- 完整离线单元：139 套通过（排除 5 个已知网络/`tar` 环境测试）

## 5. 最终状态

- live DSH 已还原，旧插件正常加载
- 本地代码保留在 `D:/dsh/dsh-plugin-hub`
- 测试会话 `session-tool-governance-e2e` 仍保留在 live 会话列表
- 两轮测试产物分别保存在：
  - `.testdir/live-tool-governance-artifacts-20261127/`
  - `.testdir/live-tool-governance-artifacts-20261127b/`
- 隔离的 3180 测试进程已停止
- 工具收敛、搜索、激活、实际调用、组合工具嵌套执行均已完成真实验收
