## 项目结构

```
lib/index.js       宿主端插件（/plugin-console/* 路由 + 补丁读写 + 多源检索 + 安装）
lib/client.js      浏览器端 bundle（ModuleLoader 格式，设置页 tab）
scripts/build-index.cjs        索引构建（插件 --limit 500 / 技能 --skills --limit 300）
scripts/apply-framework-patch.cjs   框架层补丁（issue #5，幂等，可重复应用）
.github/workflows/registry.yml 自动收录 CI（每 6 小时 + 手动触发）
marketplace/index.json         生成的静态索引（jsDelivr CDN 分发）
deploy.ps1 / deploy.sh   一键部署脚本（Windows / Linux·macOS）
tests/             测试套件（19 个 · .mjs）+ strict-ctx.mjs 严格 cordis 测试替身 —— 见 tests/README.md
```
<img width="1878" height="945" alt="image" src="https://github.com/user-attachments/assets/b26f2f19-0ba4-4be7-9ca1-b3fd4c51a7a8" />
