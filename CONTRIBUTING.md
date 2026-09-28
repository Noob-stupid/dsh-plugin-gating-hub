# 贡献指南 Contributing

感谢你对 dsh-plugin-hub 感兴趣！无论你是提 bug、建议功能还是直接改代码，都欢迎。

## 提 Issue

- **Bug 报告**：请使用 [Issue 模板](https://github.com/Noob-stupid/dsh-plugin-gating-hub/issues/new/choose)，附上：
  - DSH 版本与插件版本（面板「已安装」里可见）
  - 复现步骤（尽量最小化）
  - 期望与实际的差异
  - 日志/报错全文（脱敏密钥）
- **功能建议**：说明场景与收益，避免只写一句话。

## 提 PR

1. Fork 本仓库，从 `main` 新建分支（命名建议：`feat/xxx`、`fix/xxx`）；
2. 保持变更聚焦：一个 PR 只做一件事；
3. 服务端改动请自测：`node --check lib/index.js` + `node test-harness.mjs` + `node test-framework-upgrade.mjs`；
4. 客户端改动请自测：`node --check lib/client.js`，并尽量附上改动前后的截图；
5. 提交信息用中文/英文均可，说明动机；
6. PR 描述使用 [PR 模板](https://github.com/Noob-stupid/dsh-plugin-gating-hub/blob/main/.github/PULL_REQUEST_TEMPLATE.md)。

## 本地开发

仓库无运行时依赖，大部分脚本只用 Node 内置模块：

```bash
# 语法与测试
node --check lib/index.js
node --check lib/client.js
node test-harness.mjs          # 服务端行为（路由/Host 校验/权限）
node test-framework-upgrade.mjs
node test-skill-toggle.mjs     # 技能开关
node test-suite-install.mjs    # 套装安装
# 市场索引构建（需要 gh CLI + GH_TOKEN）
node scripts/build-index.cjs --limit=500
node scripts/build-index.cjs --skills --limit=300
```

**发布流程**（仅维护者）：bump 版本 → `CHANGELOG.md` 更新 → tag → `gh release create` → `npm publish`（`prepublishOnly` 会自动检查 package.json 无 BOM）。

## 行为准则

参与交流请遵守 [行为准则](CODE_OF_CONDUCT.md)：友善、尊重、不问常识问题前先搜一下。

## 问题与安全

发现安全漏洞请不要开公开 Issue，按 [安全政策](SECURITY.md) 私下报告。
