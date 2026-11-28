# 工具治理 / 插件调度 交接文档

> 2026-11-28 · 交接给同事
>
> 仓库：`Noob-stupid/dsh-plugin-gating-hub`
>
> 工作区：`D:\dsh\dsh-plugin-hub`（下文路径均为占位，按实际 checkout 替换）
>
> 当前版本：`0.5.116`，**工具治理尚未发版**
>
> HEAD：`1989d90`（CI success）
>
> 设计文档：`docs/tool-governance-design.zh.md`
>
> 架构图：`docs/tool-governance-architecture.svg` / `.png`

---

## 0. 先看这一页

已经做出来的是一套**可运行的工具治理底座**：

- 工具目录、按 Agent 作用域限制可见工具；
- `plugin_console_tool_search` / `_activate`；
- 声明式 composite（含并行和确认点）；
- 冲突/Schema 报告与描述覆盖；
- telemetry、golden task 评测、真实模型 A/B；
- CI 门禁、真实宿主 80 工具测试。

但用户最终要的不是“少暴露工具”，而是：

> **插件能力之间的合理调度、交接、协作，让整体更快/更聪明。**

所以当前代码应定位为：

> **能力准入 + 检索/组合 + 评测的底座**，不是最终“插件治理/调度器”。

本交接文档重点说明：

1. 设计文档哪些已完成、哪些没有；
2. “反馈工具描述更新”能不能后续做、怎么做安全；
3. 往“插件调度/插件交流”走需要补什么；
4. 下一任可以直接从哪里开始。

---

## 1. 当前完成度 vs 设计文档

### M1：可用治理闭环（基本完成）

| 设计项 | 状态 | 说明 |
|---|---|---|
| 工具目录 Catalog | ✅ | `lib/server/agent/catalog.js`；名称、描述、Schema 字节、来源推断、冲突候选 |
| Agent 作用域 restriction | ✅ | `runtime.js`；只使用宿主 `ctx.tools.restrict` |
| `tool_search` / `tool_activate` | ✅ | 真实宿主测试通过；激活下一步生效 |
| 描述压缩 | 🟡 | 有 `optimizeDescription` + `descriptionOverrides`；**人工在 UI 里预览/应用**，没有自动反馈闭环 |
| 基础 telemetry | ✅ | `events.jsonl`、滚动、内存 summary；不记录完整参数/输出 |
| 工具治理概览页 | ✅ | `[tool govern]` 面板；是否完全走官方原生 slot 仍需 live UI 验收 |
| 80 工具可见性/执行一致性 | ✅ | `test-tool-governance-host.mjs`；Electron 对 rc.5 asar 也跑过 |
| 小目录自动跳过 | ✅ 新增 | `minCatalogTools=10`；工具少时不加 restriction |
| 原生工具保护 | ✅ 新增 | `read/write/edit/glob/grep/bash/web_search/web_fetch` 始终可见，不占第三方 active 名额 |

### M2：组合与优化工作室（基本完成）

| 设计项 | 状态 | 说明 |
|---|---|---|
| 冲突检测 | ✅ | 名称相似/描述重叠候选 |
| Schema 问题报告 | ✅ | `buildSchemaReport`；缺失描述、短描述、重复等 |
| 优化预览与应用 | ✅ | UI schema workshop + `descriptionOverrides`；仍是人工确认 |
| 声明式 composite | ✅ | `composite.js`；支持步骤、依赖、并行、确认点 |
| 组合执行记录 | 🟡 | 有结果与 telemetry；没有独立的组合版本/回放 UI |
| 组合推荐/从会话提炼 | ❌ | 设计 9.3 的后续扩展，未做 |

### M3：评测、灰度与高级路由（只完成评测层）

| 设计项 | 状态 | 说明 |
|---|---|---|
| Golden task 自动化 | ✅ | `agent/evaluator.js`；10 条检索层任务 |
| 策略 A/B（检索层） | ✅ | baseline vs governed 的 recall/precision/active/Schema |
| 真实模型 A/B | 🟡 首轮 | `scripts/eval-tool-governance-model.mjs`；6 任务、24 工具 |
| 灰度发布 | ❌ | 只有“停用治理 → 恢复原工具视图”，没有按比例/按用户灰度 |
| 自动回滚 | ❌ | 没有策略级自动回滚 |
| 本地 embedding 路由 | ❌ | 只有中文意图别名 + 词法 |
| 子 Agent 治理 | ❌ | 只覆盖根 Agent |
| 从会话推荐 composite | ❌ | 未做 |
| 完整模型端到端 Agent E2E | ❌ | 目前是“真实模型 + 真实工具 Schema”，不是完整 DSH Agent 执行 |

### M4：插件调度 / 插件交流（尚未开始）

用户真正想要的方向，目前只有设计思路，没有实现：

- 能力契约（输入/输出/副作用/成本/延迟）；
- 任务 DAG 规划；
- 并行/预算/重试/降级调度；
- artifact 交接；
- 插件/Agent 间 handoff；
- 多插件端到端评测。

---

## 2. 真实评测结果（不要美化）

### 2.1 检索层 golden task

`lib/server/agent/evaluator.js`：

- 10 条任务；
- recall **1.000**；
- 平均 active **8.4**；
- Schema **35,440B → 3,721B（-89.5%）**。

这是“该用的工具有没有进 active 集合”，**不是模型端到端成功率**。

### 2.2 真实模型工具选择 A/B

`scripts/eval-tool-governance-model.mjs`：

- 真实 DeepSeek 模型；
- 6 个任务：硬件沙盒、OpenViking 记忆、仓库搜索、Web 搜索等；
- 24 个工具：DSH 原生 + breadboard + OpenViking + 市场/杂项；
- baseline：全部工具；
- governed：active 集合 + search/activate。

| 指标 | baseline | governed |
|---|---:|---:|
| 任务成功 | 6/6 | 5/6 |
| prompt tokens | 10,359 | 5,354（-48.3%） |
| 失败点 | — | `hw-run`：search/activate 多步，5 步内没到 `run_simulation` |

结论：

> **首轮治理省了 token，但没有提升成功率，反而少成功 1 个。**
>
> 这正是为什么下一步不能继续只做“过滤”，而要做“减少往返 + 调度/交接”。

---

## 3. 反馈工具描述更新：能不能后续做？

**能，而且应该做。** 当前已有前半段：

- `buildSchemaReport` 能发现描述缺失、过短、重复、参数说明不足；
- `descriptionOverrides` 能在线覆盖某个工具的描述；
- UI 有 schema workshop，可预览/应用；
- 不修改第三方包，只改治理层看到的描述。

缺的是**闭环**：

```text
telemetry（选择/失败/参数错误）
  → 聚合出“哪个工具经常被误选/调用失败”
  → 生成描述修改建议
  → 预览“原文 vs 建议 + 预期收益”
  → 用户确认
  → 写入 descriptionOverrides（版本化/可回滚）
  → 用 golden task / 真实模型 A/B 验证
```

### 建议的安全边界

1. **只生成建议，不自动改**；
2. 只改治理层的有效描述，不改第三方包文件；
3. 不改参数 Schema 语义，不扩大权限；
4. 每次修改有 `id/version/原描述/新描述/证据/回滚`；
5. 证据不足（样本少、失败原因不明）不提示；
6. 应用后跑一次 A/B；没有改善就提示回滚。

### 建议的数据结构

```json
{
  "id": "desc-fix-20261128-001",
  "tool": "hw_run_simulation",
  "current": "Run a real project ...",
  "proposed": "Run a hardware simulation ... requires projectPath ...",
  "evidence": {
    "wrongSelections": 3,
    "failedCalls": 5,
    "lastSeenAt": "..."
  },
  "status": "proposed|applied|rejected|reverted",
  "createdAt": "...",
  "appliedAt": null
}
```

这项工作适合作为 **P1**，不需要改动宿主内核。

---

## 4. 往“插件调度/插件交流”走的规划

### P0：收尾与验收（先做）

- rc.5 真实 DSH Agent 端到端复测（不是只跑 ToolRuntime host test）；
- 修 `hw-run` 这类多步任务：步预算、初始选择、search 结果引导；
- 确认默认策略（当前 `enabled: true`，`minCatalogTools=10`，第三方 cap 12，原生 protected）；
- 决定是否发版（当前未 bump/tag/publish）。

### P1：反馈与描述优化（1–2 周量级）

- telemetry 聚合误选/失败；
- 描述修改建议 + 预览 + 应用/回滚；
- 结果反馈排序（成功工具加权、失败降权，带时间衰减）；
- 混合检索：别名 + BM25（可选），不每轮调 LLM；
- 重跑同一组真实模型 A/B，记录轮数/token/成功率。

### P2：能力契约 + 任务 DAG（真正的“调度”）

- 能力注册：

```text
capability: run_hardware_simulation
plugin: breadboard
tool: hw_run_simulation
inputs: { projectPath, duration }
outputs: { readings, artifacts }
sideEffects: hardware
cost: { latencyMs, tokens, risk }
```

- 任务规划：用户任务 → 能力 DAG；
- 调度：拓扑排序、可并行并行、预算/超时/重试/降级；
- 交接：artifact（文件/JSON）或 peer session；
- 观测：每一步谁调了谁、失败在哪、能否回滚。

### P3：插件间协作/多 Agent

- 通过 connection-card / peer session 做显式 handoff；
- 插件能力目录 + contract；
- 多插件端到端评测：成功率、墙钟时间、轮数、handoff 失败率；
- 这时才谈“整体更 nb”。

---

## 5. 关键文件地图

| 文件 | 作用 |
|---|---|
| `lib/server/agent/catalog.js` | 目录、Schema 统计、冲突、描述压缩、中文意图别名 |
| `lib/server/agent/policy.js` | baseline/protected/pinned/recent/activated + 任务评分 |
| `lib/server/agent/runtime.js` | restriction、Agent 生命周期、search/activate、telemetry、schema report |
| `lib/server/agent/composite.js` | 声明式组合工具、并行、确认点、嵌套执行 |
| `lib/server/agent/telemetry.js` | events.jsonl、轮转、summary |
| `lib/server/agent/evaluator.js` | 10 条 golden task、检索层 A/B |
| `lib/server/domain/tool-governance-store.js` | 配置、审计、原子写、protectedTools |
| `lib/server/routes/tool-governance.js` | state/config/schema-report/schema-preview/evaluation |
| `lib/client.js` | `[tool govern]` UI、schema workshop、composite、评测按钮 |
| `scripts/eval-tool-governance-model.mjs` | 真实模型 A/B（需 API key） |
| `scripts/safe-boot.mjs` | `--diagnosis`；#28 诊断入口 |
| `scripts/fw-watchdog.mjs` | #28：HOST 活着但 UI 加载失败只读探针 |
| `tests/test-tool-governance*.mjs` | 单测/规模/bench/composite/host/UI/M3 |
| `tests/test-framework-diagnosis.mjs` | #28 诊断（含快照 diff） |

---

## 6. 如何跑

### 离线测试

```bash
node tests/test-tool-governance.mjs
node tests/test-tool-governance-scale.mjs
node tests/test-tool-governance-bench.mjs
node tests/test-tool-governance-m3.mjs
node tests/test-tool-governance-composite.mjs
node tests/test-tool-governance-ui.mjs
node tests/test-route-inventory.mjs
node tests/test-i18n-keys.mjs
node tests/test-architecture-guard.mjs
```

### 真实宿主 80 工具（ToolRuntime）

```bash
node tests/test-tool-governance-host.mjs
```

如果本机找不到 host package，会显式 SKIP；CI 不把它当硬门禁。

### rc.5 桌面 asar（Electron）

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
$env:DSH_HOST_PACKAGE_JSON='<desktop-install>\resources\app.asar\dsh\package.json'
& '<desktop-install>\DeepSeek Harness.exe' tests\test-tool-governance-host.mjs
```

### 真实模型 A/B

```bash
node scripts/eval-tool-governance-model.mjs
```

需要 `DEEPSEEK_API_KEY`（环境变量或 `~/.dsh/.credentials.yaml`），脚本不会打印 key。
结果写到 `docs/tool-governance-model-eval.json`。

---

## 7. 已知风险 / 待拍板

1. **产品定位**
   - 当前名字叫“工具治理”，但用户真正要的是“插件能力调度”；
   - 建议对外叙述改成“能力准入 + 调度”，不要只讲少暴露工具。

2. **原生工具保护**
   - 默认 `protectedTools` 包含 read/write/edit/glob/grep/bash/web_search/web_fetch；
   - 第三方 cap 仍是 12，但总可见数可能 >12；
   - 需要确认 UI 指标和文档口径。

3. **默认开启**
   - `enabled: true`、`minCatalogTools: 10`；
   - 10+ 工具的真实 Agent 会被收窄；是否默认关闭/首次确认，待产品拍板。

4. **模型 A/B 成本**
   - 当前 6 任务 × 2 组，调用成本很小；
   - 扩到多插件/多轮会明显增加费用，需要预算和缓存策略。

5. **M2 “并行/确认”**
   - 代码已支持，但 live UI/真实组合任务验收不足；
   - 不要只看单测就宣称完整。

6. **#28 诊断**
   - 快照 diff 与 watchdog UI 探针已加，**不自动改核心包**；
   - 框架回滚仍是主要恢复路径；核心包替换只给命令/建议。

---

## 8. 下一任建议先做哪三件

1. **rc.5 真实 Agent E2E**：用 3 个第三方插件 + 3 个多插件小项目，记录成功/轮数/耗时/token；
2. **修多步开销**：search 结果更聚焦、activate 后下一步直接可用、步预算/提示优化；
3. **反馈描述闭环**：telemetry → 建议 → 预览 → 确认 → 版本化覆盖 → A/B。

然后再进入 P2 的能力契约/DAG 调度，不要继续加“分类/过滤”。

---

## 9. 相关文档

- 设计文档：`docs/tool-governance-design.zh.md`
- 真机测试留痕：`docs/tool-governance-live-test.zh.md`
- 架构图：`docs/tool-governance-architecture.svg` / `.png`
- 真实模型结果：`docs/tool-governance-model-eval.json`
- issue #28 诊断：`docs/framework-rollback-desktop.md`（如有）、`lib/server/domain/framework-diagnosis.js`
