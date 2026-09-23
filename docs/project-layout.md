## Project layout

```
lib/index.js       Host plugin (/plugin-console/* routes + patch I/O + multi-source search + install)
lib/client.js      Browser bundle (ModuleLoader format, settings tab)
scripts/build-index.cjs        Index builder (plugins --limit 500 / skills --skills --limit 300)
scripts/apply-framework-patch.cjs   Framework patch (issue #5, idempotent)
.github/workflows/registry.yml Auto-collection CI (every 6h + manual dispatch)
marketplace/index.json         Generated static index (jsDelivr CDN)
deploy.ps1 / deploy.sh   One-click deploy scripts (Windows / Linux·macOS)
tests/             Test suites (19 · .mjs) + strict-ctx.mjs strict cordis test double — see tests/README.md
```
<img width="1878" height="945" alt="image" src="https://github.com/user-attachments/assets/b26f2f19-0ba4-4be7-9ca1-b3fd4c51a7a8" />
