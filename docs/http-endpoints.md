## HTTP endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/plugin-console/state` | GET | Plugin list + patch state + compat + running install jobs |
| `/plugin-console/toggle` | POST | Enable/disable an entry (writes user patch layer) |
| `/plugin-console/uninstall` | POST | Remove entry + uninstall package (bundle-aware) |
| `/plugin-console/search` | POST | Multi-source search (github/gitee/custom, `multi` merge) |
| `/plugin-console/repo` | POST | Repo metadata: package.json, private root, dsh hint, **hasSkill** |
| `/plugin-console/enrich` | POST | Server-side type markers (official/aggregate/skill) |
| `/plugin-console/install` | POST | Install (plugin or `kind: skill`), returns a job id |
| `/plugin-console/install-status` | POST | Poll an install job |
| `/plugin-console/check-update` | POST | npm latest version + subpackage mismatch check |
| `/plugin-console/market-index` | POST | Static index (jsDelivr CDN, 10-min cache) |
| `/plugin-console/skills-installed` | GET | Installed skills under `~/.dsh/skills` |
| `/plugin-console/sources` | GET/POST | Registry & search-source manager, Gitee OAuth setup |
| `/plugin-console/gitee-oauth-url` / `gitee-oauth-callback` | GET | Gitee OAuth flow |
| `/plugin-console/ai-consent` | POST | Approve/cancel the AI-fallback step |
| `/plugin-console/restart` | POST | Watchdog-safe self-restart (panel button equivalent) |
| `/plugin-console/framework-upgrade` | POST | One-click framework upgrade (full-tree checkpoint → online install → rollback protection) |
| `/plugin-console/framework-rollback` | POST | One-click rollback to the previous version (stop → full-tree restore → auto relaunch → health check) |
| `/plugin-console/self-update` | POST | Update the console itself (latest npm tarball into the profile) |
| `/plugin-console/ai-empower/plan` / `status` / `run` / `cancel` | POST | AI Empower: plan (with framework compat pre-check) → status polling → confirmed run → cancel |
| `/plugin-console/components` / `component/start` / `stop` / `status` | GET/POST | Server component registry and start/stop/status |
| `/plugin-console/runtime-guard` | GET | Current run mode + runtime-guard thresholds (read by the client at boot) |
| `/plugin-console/runtime-health` | POST | Client guard reports (`ws-fail` / `polling-storm`), config, and record clearing |
| `/plugin-console/preset-contract` | GET | Daily read-only session-preset contract check (`?force=1` to recompute) |
