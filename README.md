> **English**: [README.md](README.md) | **中文**: [README.zh.md](README.zh.md)

---

<img width="1170" height="609" alt="image" src="https://github.com/user-attachments/assets/b802d606-14ba-4151-9956-ff642ed12b0a" />

# DSH Plugin Gating Hub (dsh-plugin-gating-hub)

*Renamed from `dsh-plugin-hub` — old URLs redirect.*

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![GitHub stars](https://img.shields.io/github/stars/Noob-stupid/dsh-plugin-gating-hub?style=flat-square&logo=github)](https://github.com/Noob-stupid/dsh-plugin-gating-hub/stargazers)
[![License](https://img.shields.io/github/license/Noob-stupid/dsh-plugin-gating-hub?style=flat-square)](LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/Noob-stupid/dsh-plugin-gating-hub?style=flat-square)](https://github.com/Noob-stupid/dsh-plugin-gating-hub/commits/main)
[![Registry CI](https://img.shields.io/github/actions/workflow/status/Noob-stupid/dsh-plugin-gating-hub/registry.yml?label=registry%20CI&style=flat-square)](https://github.com/Noob-stupid/dsh-plugin-gating-hub/actions/workflows/registry.yml)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh_plugin-4D6BFE?style=flat-square)](https://github.com/topics/dsh-plugin)
[![npm version](https://img.shields.io/npm/v/@noob-stupid/dsh-plugin-console?style=flat-square)](https://www.npmjs.com/package/@noob-stupid/dsh-plugin-console)
[![npm downloads](https://img.shields.io/npm/dm/@noob-stupid/dsh-plugin-console?style=flat-square)](https://www.npmjs.com/package/@noob-stupid/dsh-plugin-console)
[![GitHub Release](https://img.shields.io/github/v/release/Noob-stupid/dsh-plugin-gating-hub?style=flat-square)](https://github.com/Noob-stupid/dsh-plugin-gating-hub/releases)[![dsh.so security](https://www.dsh.so/badge/dsh-plugin-hub.svg)](https://www.dsh.so/artifact/dsh-plugin-hub)
[![dsh.so install](https://www.dsh.so/badge/install/dsh-plugin-hub.svg)](https://www.dsh.so/artifact/dsh-plugin-hub)

> **Framework upgrade safety & plugin version gating for DeepSeek Harness (DSH)**: one-click
> framework upgrade with **auto-rollback on failure** → **one-click rollback to the previous
> version** after an upgrade → plugins the new framework cannot load are **auto-disabled** →
> the **plugin upgrade gate** refuses a version the host can't take.
> A **built-in multi-source plugin market & index** (500+ plugins / 300+ skills, zero GitHub
> API calls) rides on top as the **discovery layer** — and **every source is swappable**: install
> source (incl. a private intranet registry), search source (URL template + headers), index source
> (self-hosted intranet index), Git source (incl. a local `file://` bare repo), so plugins can be
> installed on an **intranet-only or fully offline** machine.

## Why DSH Plugin Gating Hub

- 🛡️ **Framework upgrade safety, end-to-end** — one-click upgrade: config backup + full-tree
  checkpoint (rollback point) → online install (service stays up, page never disconnects) →
  version verification → auto-restart. A failed install **auto-rolls the whole tree back**,
  version check catches fake success, 15-min hard timeout + stall detection — the framework is
  never left broken. → [details](docs/upgrade-safety-adapt-gate.md)
- ↩️ **One-click rollback to the previous version** — after an upgrade the framework card keeps
  a 「roll back to previous」 button: stop service → restore full tree → relaunch → health check,
  state visible throughout.
- 🚫 **Incompatible plugins auto-disabled** — the **adapt gate** force-disables plugins the new
  framework cannot load (enable locked; the server rejects `/toggle` with 409 — unbypassable);
  「Check update → Update & adapt」auto-verifies and unlocks them.
- 🔒 **Plugin upgrade gating** — a version/declaration gate (`dsh.engines.framework` /
  `engines.dsh` + `@deepseek-ai/*` ranges, built-in zero-dependency semver engine) decides
  whether a plugin version may run on this host, so an upgrade can't silently take plugins out.
- 🧩 **Built-in discovery layer** — multi-source plugin market (GitHub / Gitee / custom sources)
  plus the static index of `dsh-plugin` repos (500+ by stars) and a Skills tab (up to 300);
  browse, search, one-click install, **zero GitHub API calls** (served via CDN).
  **Every source is swappable** — private intranet npm registry, custom search source (URL template +
  headers), self-hosted index source, Git source (incl. local `file://` bare repo) — so an
  **intranet-only / offline** machine can still browse and install.
- 🤖 **AI Empower** — give the console a package name or GitHub repo, the local AI
  reads its docs and drafts a safe, confirmable deployment plan (install / config /
  start / health-check); server components get an automatic control card.
  → [details](docs/ai-empower.md)

## Install

```sh
# npm release (recommended: prebuilt, no git / build authorization needed)
dsh plugin --profile web add @noob-stupid/dsh-plugin-console

# or install from GitHub source (needs git; allowBuilds authorization on first add)
dsh plugin --profile web add github:Noob-stupid/dsh-plugin-hub
```

Then restart the dsh service → refresh the page → **Settings → Plugins → Plugin Console**.

<details><summary><b>More install options</b> (deploy script / hand it to an AI)</summary>

### Option 2: deploy script (fallback when network is restricted)

Windows (PowerShell):

```powershell
git clone https://github.com/Noob-stupid/dsh-plugin-hub "$env:TEMP\dsh-plugin-console" 2>$null; & "$env:TEMP\dsh-plugin-console\deploy.ps1"
```

Linux / macOS:

```bash
git clone https://github.com/Noob-stupid/dsh-plugin-hub /tmp/dsh-plugin-console 2>/dev/null; bash /tmp/dsh-plugin-console/deploy.sh
```

The script copies the plugin into `$DSH_HOME/profiles/<profile>/node_modules/` and
idempotently appends an enable entry to `cordis.patch.yml`. Afterwards:

1. Restart the dsh service (host code changes need a process restart; CLI restarts the
   process, the desktop client exits and reopens);
2. Refresh the page → Settings → Plugins → **Plugin Console**.

### Option 3: hand it to an AI in one sentence

> Install the DSH plugin hub (dsh-plugin-hub): run `dsh plugin --profile web add @noob-stupid/dsh-plugin-console` (npm release); if there is no dsh CLI, clone https://github.com/Noob-stupid/dsh-plugin-hub to `~/.dsh/profiles/web/node_modules/` and register it in `cordis.patch.yml` (id: plugin-console, name: @noob-stupid/dsh-plugin-console). Restart dsh web afterwards.

Requires: DSH ≥ 0.1.0-rc.6 (web profile, with `dsh-client-modules` / `dsh-host-plugin-inventory`).

</details>

---

## Highlights

| | Benefit | Detail |
|---|---|---|
| 🤖 | **AI Empower ** | Give the console a package name or GitHub repo — the local AI reads docs, drafts a **deployment plan** (install / write config / start service / health check) and executes it safely after your confirmation; server-type components get an automatic control card |
| 🛡️ | **Framework upgrade safety & adapt gate ** | Force-disables plugins incompatible with the new framework (enable locked; 「Check update → Update & adapt」auto-verifies and unlocks); full-tree checkpoint before upgrade, automatic rollback on relaunch failure, one-click rollback to the previous version |
| 🏠 | **Family-bundle cards & safety ** | Same-root subpath exports group into one family card (collapse/expand, batch check-update, one-click unlock-adapted, known-check preview); never-crash safety (pre-enable import probe + patch auto-heal + exports fallback); adapt-gate source-scan hard criterion & migrate detection; deleting a bundle sub-row disables only that row |
| 🚀 | **Server component cards** | Left-side floating card auto-aligned to the main panel: start / stop / status / **open Web UI** buttons, multi-server dropdown, collapsible |
| 🧩 | **Plugin & skill hub** | Auto-collected index of `dsh-plugin` topic repos (**500+** by stars) plus a **Skills tab** (`agent-skills` ∪ `claude-skills` ∪ `dsh-skill`, up to 300) — browse, search, one-click install, no GitHub API calls |
| 🤖 | **Auto-collection CI** | GitHub Actions reruns `build-index` every 6 hours (manual trigger available); authors just add the `dsh-plugin` / `agent-skills` / `claude-skills` / `dsh-skill` topic — no application needed |
| ⚡ | **Instant, rate-limit-free** | The index is served as a static `marketplace/index.json` via jsDelivr CDN (10-min host cache); terminal users make **zero GitHub API calls** |
| 🔄 | **Version detection & one-click update** | Semver-based; installed entries match npm `dist-tags.latest` / `beta`; subpackage mismatch warnings prevent mixed-version breakage |
| 🔀 | **Multi-source** | GitHub / Gitee (direct-repo mode) / custom search sources (URL template + header auth + private http); `⊞` merges GitHub + all custom sources in parallel |
| 🔒 | **Safe by default** | Loopback-only routes; AI fallback behind an explicit cost-consent modal; infrastructure rows are toggle-protected |

<details>
<summary><b>📑 目录 / Table of Contents</b></summary>

- [Highlights](#highlights)
- [AI 赋能与服务器组件控制](#ai-赋能与服务器组件控制)
- [One-click install](#one-click-install)
- [Usage](#usage)
- [Features](#features)
- [How it works](#how-it-works)
- [Compatibility](#compatibility)
- [Project layout](#project-layout)
- [HTTP endpoints](#http-endpoints)
- [安全](#security)
- [Known limitations](#known-limitations)
- [Help & Ecosystem](#help--ecosystem)
- [Contributing](#contributing)
- [Changelog](#changelog)
- [License](#license)
</details>

---

## Usage

1. Restart DSH → open the Web GUI → **Settings → Plugins → Plugin Console**.
2. **Installed list**: toggle plugins on/off (HMR applies within ~1s), search by name/id,
   expand details (version, repository, README summary).
3. **市场**: empty query on the GitHub source opens the static index (instant);
   type a query to search live. Switch sources via the login pill (GitHub / Gitee / custom);
   `⊞` merges all sources; `★` filters to `dsh plugin add`-installable packages.
4. **Skills tab**: switch 插件/技能 next to the search box to browse and install skills
   (cloned into `~/.dsh/skills/<name>/`).
5. **Install**: click 添加到本地 → the chain runs in the background (safe to leave the page);
   「检测更新」/「更新 → vX」 appear automatically for installed entries.

---

## Screenshots · 界面一览

> 入口挂在**官方插件管理页自己的插槽**（`plugins.bundle.config`，key = 包名）：装完之后它出现在
> 「设置 → 插件 → 已安装」里我们这一条下面，用的是官方容器与官方风格 —— 不是 DOM 注入，官方更新也不怕。

**1 · 已安装列表里的入口**（官方页，点开我们这条即见）

![Entry inside the official plugins page](docs/images/official-plugins-page.png)

**2 · 「升级安全」面板**（就地展开：运行模式 / 框架版本 / 回滚点 / 环境指纹 / 补声明 / 契约预检 / 各功能入口）

![Upgrade safety panel expanded in place](docs/images/upgrade-safety-panel.png)

**3 · 框架升级 / 回滚**（可选目标版本、常驻的升级进度、一键回滚上一版）

![Framework upgrade and rollback panel](docs/images/framework-upgrade-rollback.png)

**4 · 门控明细**（谁被隔离、为什么：升级预扫 or 启动失败隔离，附来源与时间）

![Compatibility gate detail list](docs/images/compat-gate-detail.png)

---

## Features

### Installed plugins (one-click toggle + details)

- **Shows only third-party plugins by default** (extra/non-bundled), tagged
  "Third-party" with a delete entry; click "All" to see the full list (1.5s flash feedback);
- Lists every plugin entry (name, load state, enabled state); search by name/id;
- Disable = append `- id: X` + `disabled: true` to the user patch layer, effective via HMR;
- Enable = remove that entry; bundle-layer rows disabled by default are overridden with
  `disabled: false`;
- Tags "Patch-disabled / Patch-forced" distinguish user patch state;
- **Infrastructure protection**: host transport/hmr/storage/settings chain plugins
  (70+ rows) are marked "Protected" and cannot be toggled — disabling them would break HMR;
- **Details panel**: version, repository/homepage links and a README summary for each plugin;
- **Version check**: 检测更新 reads npm `dist-tags.latest` (curl channel, works even when
  node networking is blocked) and warns about subpackages that need syncing (depsOutdated).

### Framework one-click upgrade (deepseek-harness card)

- The **deepseek-harness** card shows **「框架升级 → vX」** when a newer framework version is
  available (stable `latest` preferred; `next` channel when `latest` equals the installed
  version); clicking runs the full flow: backup config + framework snapshot (rollback point)
  → **online install** (service stays up, page never disconnects) → version verification →
  **auto-restart to apply**;
- **Real-time progress**: a `DSH-Upgrade` console window pops up showing live pnpm download
  progress; the in-panel progress card shows the waiting time;
- **Upgrade protection**: failed installs **auto-rollback** (robocopy, backup verified before
  upgrade), version check catches fake success, 15-min hard timeout, stall detection
  (no debug-log updates → auto switch registry), global trap fallback, and 15-min stale-state
  cleanup — the framework is never left broken;
- **pnpm channel**: npm-cli.js freezes at startup in the schtasks task environment (0-byte
  debug log, no network requests ever sent); upgrades use `corepack pnpm` (starts in ~0.4s,
  installed rc.8 in 11.5s) against the **npmmirror (China) registry**, with
  `dangerouslyAllowAllBuilds` so native modules (node-pty/koffi) compile;
- **Runtime bin resolution**: under the pnpm layout `@deepseek-ai/dsh` is a Junction — the
  relaunch step resolves `bin.js` at runtime (follows the Junction to the current version)
  instead of using a path baked in at script-generation time;
- **Card dismiss semantics**: terminal states (done/failed) are permanently dismissed on ✕
  (persisted); in-progress dismissal is session-only and the card returns after a refresh.

### Marketplace (multi-source)

- **Source switcher**: click the login pill to switch between **GitHub / Gitee / custom
  sources** (persisted); title, loading text, placeholder and note all follow the source;
- **GitHub**: default query `dsh-plugin`, browser-direct with server fallback;
- **Gitee**: official search API is retired, so it uses **direct-repo mode** — enter
  `owner/repo` (Chinese paths and full URLs supported) to find and install a repository;
- **Custom sources**: add in Source Manager (URL template with `{q}`/`{page}` placeholders),
  optional **header auth** (e.g. `Authorization: Bearer ...`), and **local/private http URLs**;
- **Multi-source summary**: the `⊞` toggle searches GitHub + all custom sources in parallel,
  merging results with source labels;
- **★ official filter**: shows only packages installable via `dsh plugin add` — root packages
  with a `dsh.bundle` manifest (official) or aggregate repos whose **subpackage carries
  `dsh.bundle`** (subpackage-installable); markers are enriched by the server (curl dual-channel)
  with a client-side fallback;
- **Type badges**: 官方 / 聚合 / 技能 (repo contains SKILL.md) recognized automatically.

### Static index market (plugin & skill tabs)

> **Hybrid architecture**: browsing uses the static index (instant, zero GitHub API calls),
> searching uses live channels (GitHub search API / multi-source parallel) — they complement
> each other: a brand-new repo can be found by live search even before it enters the index.

- Empty query on the GitHub source shows the **static index** (`marketplace/index.json`,
  jsDelivr CDN + 10-min host cache): 500+ plugins by stars, instant, **zero GitHub API calls**;
- **插件 / 技能 tabs** next to the search box: the skills tab lists auto-collected
  `agent-skills` ∪ `claude-skills` ∪ `dsh-skill` repos (up to 300);
- **Auto version check**: installed entries in the market are checked against npm
  `dist-tags.latest` in the background — cards turn into **「更新 → vX」** buttons;
- **Skill install**: skill entries install by git-clone into `~/.dsh/skills/<name>/`
  (frontmatter `name` wins over repo name; SKILL.md found at repo root or first-level
  subdirectory). Installed skills show a grey 「已装」 badge.

### Source Manager

The floating "Sources" button (right of the title row, semi-transparent) opens the manager:

![Source Manager](https://github.com/user-attachments/assets/ef712900-65ae-4f6f-9584-bacdd8d34ea1)

- **Install sources (registry)**: add / inline edit / set primary / restore defaults;
  private and intranet addresses supported; **deletion is protected** (install-critical);
- **Search sources**: built-in GitHub, Gitee + custom search sources (add/remove, `🔒` shows
  header count);
- **Gitee login (optional)**: direct mode needs no login; login only raises rate limits —
  create a third-party app (gitee.com → Data management → Third-party apps, scopes
  user_info, projects), fill client_id / client_secret, save, then authorize.

---

<img width="393" height="525" alt="56ccd0b3-f174-4365-848b-64013b27d604" src="https://github.com/user-attachments/assets/5a2816ce-12d9-4001-b895-1e422c11d423" />

## Framework compatibility

Measured on isolated instances (fresh `DSH_HOME`, real HTTP probes) — **supported: framework ≥ `0.1.5-rc.2`**, no workarounds needed.

| | 0.1.7-rc.2 (current) | 0.1.5-rc.2 / 0.1.2-rc.1 |
|---|---|---|
| Official plugins page (`@deepseek-ai/dsh-client-ui-plugin-manager`) | present | **not shipped by the framework at all** |
| The official-style **Upgrade safety** entry | shown (hosted in that page's own `plugins.bundle.config` slot) | not shown — there is no page to host it |
| Classic **Plugins** tab (`settings.plugins.tab`) | shown | **shown** |
| Server-side features (upgrade / rollback / gating / marketplace) | all available | **all available** (every route answered 200 in the matrix) |
| Errors | none | **none** (the slot registration degrades silently) |

So on an older framework the plugin is **the old UI with the full feature set** — the new entry simply has nowhere to live. It never white-screens and never throws.

Verification matrix, raw logs and the one framework-side caveat (`0.1.2-rc.1` ships `patchReload: "live"` for a web tree without the HMR service → boot exits 1 after ~10s; unrelated to this plugin) are recorded in `.testdir/fw-old-matrix/report.md`.
## Documentation

- [AI Empower 与服务器组件控制](docs/ai-empower.md)
- [Framework upgrade safety & plugin adapt gate](docs/upgrade-safety-adapt-gate.md)
- [**契约规则库 Upgrade contract rules**](docs/contracts/README.md) — 框架每次变更会打断什么、怎么发现、怎么修（数据在 `lib/contracts/rules.json`，**欢迎 PR 补充**：每个事故都应该变成一条规则）
- [How it works](docs/how-it-works.md) · [Compatibility](docs/compatibility.md) · [Project layout](docs/project-layout.md)
- [HTTP endpoints](docs/http-endpoints.md) · [Local AI fallback & consent](docs/ai-fallback.md)
- [Framework patch (cordis.patch.yml)](docs/framework-patch.md) · [Security & disclaimer](docs/security-disclaimer.md)

---

## Known limitations

- Host code changes require a **service restart** (the panel's restart button is
  watchdog-safe); client changes just need a page refresh;
- Live GitHub search depends on GitHub reachability (browser-direct + server fallback;
  during network-blackout windows retry later);
- Version detection works for npm-published packages; skill-type repos have no version concept;
- The static index is capped (500 plugins / 300 skills per build); authors bump their star
  count or wait for the 6h CI cycle to enter the index;
- Skills are discovered by `dsh-skill-filesystem` — if the current profile does not enable
  that plugin, installed skills stay dormant until it is enabled and DSH restarted.

---

##帮助

- **Panel missing**: restart dsh → refresh → Settings → Plugins → Plugin Console.
- **Toggle does nothing**: infrastructure rows are "Protected" (by design); normal toggles
  take effect via HMR within 1-3s.
- **Compatibility warning**: a breaking upstream release arrived; see Compatibility.
- **Search empty/fails**: GitHub uses browser-direct (falls back to the server channel);
  Gitee is direct-repo mode (enter `owner/repo`); check custom-source URL/headers; retry
  during network blackout windows.
- **★ filter empty**: ★ shows only `dsh plugin add`-installable packages (official +
  subpackage-bundle aggregates); markers are backfilled in 1-3s — no false "none" report.
- **Install fails**: confirm the repo has package.json and the package is published; npm
  failures fall back to git install; switch the primary source if npmmirror is unstable.
- **Skill not found by DSH**: enable `@deepseek-ai/dsh-skill-filesystem` in the profile
  (`cordis.yml`) and restart; skills live in `~/.dsh/skills/<name>/`.

---

## Ecosystem & discoverability

- Listed on [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) (the community main list) and [DSH Directory](https://dsh.directory);
- This hub's own auto-collection index (500+ plugins / 300 skills, refreshed by CI every 6h) includes **any** repo tagged `dsh-plugin` / `agent-skills` / `claude-skills` / `dsh-skill` — tag your repo and it appears in the market automatically, no application needed;
- If you build DSH plugins, this panel is your distribution channel: one-click install for every user of the hub.

## Support

If this panel saves you time or makes DSH more fun to use:

- ⭐ **Star this repo** — it directly helps more DSH users find it;
- Share it with DSH users or in DSH communities;
- Submit your own plugin (tag it `dsh-plugin`) to grow the ecosystem;
- Found a bug or want a feature? [Open an issue](https://github.com/Noob-stupid/dsh-plugin-hub/issues).

---

## Contributing

Contributions of all kinds are welcome — issues, PRs, docs, translations.

- **Guidelines**: [CONTRIBUTING.md](CONTRIBUTING.md)
- **Code of Conduct**: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- **Security policy**: [SECURITY.md](SECURITY.md) (report vulnerabilities privately)
- **Issue templates**: bug reports & feature requests via the [new issue](https://github.com/Noob-stupid/dsh-plugin-hub/issues/new/choose) page

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

---

## License

MIT

---

---

## Preview (experimental · not for production)

The layered-refactor preview lives in its **own repository**: [**`Noob-stupid/dsh-plugin-hub-refactor`**](https://github.com/Noob-stupid/dsh-plugin-hub-refactor)

- **What it is**: the monolithic `lib/index.js` (8547 lines) split into layers — `lib/index.js` **141 lines** + `lib/server/**` **38 modules**; **feature-equivalent to `0.3.57`**, maintainability only;
- **Verified**: 19 test suites green · 8 architecture-guard assertions · **route inventory identical** (`status` + response fields) against the stable build;
- **Not yet exercised**: real framework upgrade / rollback, restart guardian, component start/stop, real AI run, Gitee OAuth (~10–25% long-tail risk, subjective);
- **For everyday use** stick to npm `@noob-stupid/dsh-plugin-console@0.3.67`, or `main` of this repo.
