# 契约规则库（Upgrade contract rules）

> 规则数据：[`lib/contracts/rules.json`](../../lib/contracts/rules.json) · 读取实现：[`lib/server/domain/contract-rules.js`](../../lib/server/domain/contract-rules.js)

## 这是什么

DSH 每次框架变更都可能**打断某些东西**——不是版本号对不上那么简单，而是：

| 变更类型 | 真实例子 | 后果 |
|---|---|---|
| 消息契约（contract-edge） | `0.1.7-rc.1` 要求消息来源带 producer-owned kind | 一发消息就报 `format v4 message requires a producer-owned source kind`，整个会话打不开 |
| 依赖 API（dependency-api） | `@deepseek-ai/schemastery` 3.18.4 才提供 `Schema.prototype.volatile()` | `.volatile is not a function`，插件导入失败 |
| 配置 schema（config-schema） | `0.1.5-rc.1` 把预设 `persona.text` 改成 `persona.prefix` | 升级后服务起不来 |
| 被删 API（removed-api） | `dsh-settings` 命名空间 API 移除 | 属性式读取未声明的名字在真实 ctx 上同步抛错 |
| 装载器契约（loader-contract） | 补丁层必须是顶层 YAML 数组 | `overlay … must be a top-level YAML array`，服务拒绝启动 |

这些坑的共同点是：**包级适配门（peerDependencies / 版本范围）看不见它们**。所以本仓库把它们
沉淀成一份**数据化规则库**，由「升级预检」读取。

## 为什么做成数据而不是写在代码里

1. **触发源解耦**：门控不能寄生在「我们自己的升级按钮」上。规则外置后，只要框架版本从 A 变成 B
   ——不管是本控制台升的、官方桌面端自带升级器升的、还是手动 pnpm 升的——都能拿规则库比对。
2. **社区可贡献**：规则库是能被直接 PR 的产物。谁踩了坑，把证据贴进来即可。
3. **可测试**：`tests/test-contract-rules.mjs` 会校验字段合法性、id 唯一性、`since` 可解析，
   并交叉检查「声称自动检测的规则」是否真有对应实现——**不许登记幻影规则**。

## 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 稳定标识（小写连字符）。被测试和文档引用，**改名等于破坏兼容** |
| `since` | ✅ | 从哪个版本起成立（用于判断目标版本是否需要这条规则） |
| `kind` | ✅ | `contract-edge` / `dependency-api` / `config-schema` / `removed-api` / `loader-contract` |
| `severity` | ✅ | `blocker`（不改就会炸）/ `warn`（提示） |
| `title` | ✅ | 一句话人话标题 |
| `detect` | ✅ | 怎么发现 |
| `fix` | ✅ | 怎么修；能自动修的必须写清备份策略 |
| `implementedBy` | — | 本控制台里承担检测的实现（模块/探针 id）；**留空 = 仅登记、尚未自动检测**（诚实标注覆盖率） |
| `evidence` | ✅ | 真实报错原文或 issue 编号。**没有证据的规则不收** |

## 怎么贡献

1. 在 [`lib/contracts/rules.json`](../../lib/contracts/rules.json) 的 `rules` 数组里加一条，
   `evidence` 写上真实报错原文（或本仓库 issue 链接）。
2. 如果它有自动检测，在 `implementedBy` 里写明实现位置；没有就留空——留空也算合格贡献，
   因为「知道有这个坑」本身就有价值。
3. 跑 `node tests/test-contract-rules.mjs`，然后开 PR。

## 与「升级预检」的关系

`POST /plugin-console/framework-preflight` 的响应里带 `rules` 字段（规则总数 / blocker 数 /
自动检测覆盖数 / 规则 id 列表），面板据此显示规则库覆盖情况；`source: 'unavailable'` 表示
规则文件缺失，**此时不应把「零发现」当成安全**。
