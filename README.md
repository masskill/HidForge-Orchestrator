# HidForge Orchestrator

**English** · [Українська](README.uk.md) · [Русский](README.ru.md)

A local, Windows-first orchestrator for AI coding agents: **Claude Code, Codex CLI, Antigravity (`agy`), Cursor Agent CLI**, plus JSON plugins (Gemini CLI, OpenCode) and API-only providers (DeepSeek, Kimi, MiniMax, Qwen, GLM, Grok, Mistral, OpenRouter — your key in `.env`, paid requests only when enabled).

You describe a goal. HidForge turns it into a graph of tasks (DAG) and runs several agents in parallel, each in its own isolated git worktree. Every result goes through independent checks, then waits for your **Approve & Merge**. You end up with one consistent repository, and the state survives restarts.

Everything runs on your own computer. HidForge uses the CLIs you have already installed and signed in to — it never asks for, stores or forwards API keys, tokens or cookies.

> **Status: v0.5 (beta).** Overall progress is 94% ([ROADMAP](docs/ROADMAP.md)). What was verified and how: [TEST_REPORT](docs/TEST_REPORT.md).

---

## Contents
- [What it does](#what-it-does)
- [Agent support](#agent-support)
- [Requirements](#requirements)
- [Installation](#installation)
- [First run](#first-run)
- [How to use](#how-to-use)
- [Settings](#settings)
- [Updates, diagnostics, backups](#updates-diagnostics-backups)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [For developers](#for-developers)
- [Documentation](#documentation)
- [License](#license)

## What it does

| Area | Features |
|---|---|
| **Planning** | LLM planner (read-only): goal → validated task DAG → drafts you review. Manual tasks with dependencies, roles, allowed paths and check commands |
| **Chat** | Talk to an agent about the project: each reply is a read-only run in a temporary copy of the repo, so it can read the code but never changes it. History is kept per project |
| **Execution** | Parallel agents in separate git worktrees; DAG scheduler with priorities, retries with backoff, timeouts and stall detection; one writer per workspace; recovery after restart |
| **Quality** | Gates: allowed paths, conflict markers, check commands (each command needs your approval once). AI reviewer (QA + Security), either advisory or required. Repair loop with findings. Integrator task when a post-merge check fails |
| **Control** | Live logs, diff, Approve & Merge / Reject with feedback, stop / retry, project budget and per-task cost limit |
| **Visibility** | Pages: Projects, Overview, Tasks (table / kanban / graph), Planner, Chat, Agents, Event log, Costs, Reports and decisions (ADR), System, Settings |
| **Product** | Installer (no admin rights), launch without a terminal, fast-forward updates, diagnostics, automatic daily backups |
| **Optional** | WSL2 and VPS-over-SSH backends (experimental, off by default) |

UI: dark mint design system, vanilla JS, no build step ([DESIGN_SYSTEM](docs/DESIGN_SYSTEM.md)).

## Agent support

| Agent | State |
|---|---|
| Claude Code | ✅ real tasks, planner and reviewer verified end to end |
| Antigravity `agy` | ✅ real tasks, planner and reviewer, without permission bypass |
| Cursor Agent CLI | ✅ verified once you allow trust for HidForge worktrees in Settings (without `--force` / `--yolo`) |
| Codex CLI | 🟡 read-only sessions work. Writing files is blocked by the Codex Windows sandbox on the tested PC (see [Troubleshooting](#troubleshooting)). HidForge picks the newest `codex.exe` from the Codex desktop app, otherwise `codex` from PATH |
| Gemini CLI, OpenCode (JSON plugins) | 🟡 installed and detected; real tasks not verified (sign-in postponed) |
| Mock Agent | ✅ built in: demo mode and tests, no AI calls and no costs |

An agent that is not installed or not signed in is shown as unavailable, with the reason. The rest of the app keeps working.

## Requirements
- Windows 10/11 x64. Linux and macOS should work but are not tested.
- **Node.js 24 or newer** (uses the built-in `node:sqlite` and runs TypeScript without a build step).
- **Git 2.x** with `worktree` support (tested with 2.54).
- Optional: one or more agent CLIs, installed and signed in under your own account (`claude`, `codex`, `agy`, `cursor-agent`). Without them you can still use the Mock Agent.

Not needed: Docker, tmux, WSL2, a server, a domain, paid APIs.

## Installation

1. Install [Node.js 24+](https://nodejs.org/) and [Git for Windows](https://git-scm.com/download/win).
2. Download the code:
   ```powershell
   git clone https://github.com/masskill/HidForge-Orchestrator.git
   ```
   ```powershell
   cd HidForge-Orchestrator; npm install
   ```
3. Create the shortcuts. The installer only checks Node.js and Git and creates **HidForge Orchestrator** on the desktop and in the Start menu. It installs nothing else and needs no admin rights:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
   ```
4. Sign in to the agent CLIs you want to use, once, in their own way: run `claude`, `codex`, `agy` or `cursor-agent` in a terminal and follow its login. HidForge reuses that login.

Remove the shortcuts (your data stays): `powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Uninstall`.

## First run
- Double-click **HidForge Orchestrator**. The server starts without a terminal window and the UI opens in your browser at `http://127.0.0.1:4317`. Starting it again just opens the running instance.
- Or from a terminal: `npm run dev`. With a demo project and Mock agents (no quota used): `npm run demo`.
- Stop the server: **Settings → About → Stop server**.
- Server log: `%LOCALAPPDATA%\HidForge\hidforge.log`. Data (database, worktrees, backups): `%LOCALAPPDATA%\HidForge`.

## How to use
The interface is in Ukrainian; button names below are translated.

1. **Open a project.** On the Projects page, enter the path to a Git repository and click Open, or create the demo project. The repository should be on a branch with no uncommitted changes when you merge.
2. **Check the agents.** The Agents page shows installed CLIs, versions, sign-in state and why an agent is unavailable.
3. **Plan.** On the Planner page, write the goal, pick an agent (or `mock`) and click Generate plan. The agent works read-only and proposes a task DAG. Review it, then click Add as drafts (or Discard).
   Or create tasks by hand with **+ Task**: title, instructions, acceptance criteria, role, agent (`auto` picks one by the cost-first / balanced / quality-first policy), permissions (`read-only` / `workspace-write`), dependencies `#id`, allowed paths (globs), check commands.
4. **Run.** Click Run plan. Independent tasks start in parallel (2 at a time by default). Dependent tasks wait until their dependencies are merged.
5. **Watch.** Open a task to see the live log, evidence and diff. If a gate needs to run a check command for the first time, you get Allow / Deny.
6. **AI review (optional).** In **Settings → AI reviewer** choose `off` (default), `advisory` (informs only) or `required` (merge only after an `approve` verdict; `request_changes` sends the task back to the agent with the findings). The reviewer works read-only in a separate temporary worktree.
7. **Decide.** Click **Approve & Merge**, or **Reject** with an explanation — the agent gets it in the next repair attempt. A merge conflict breaks nothing: the task becomes `blocked`, and Retry merges the base branch into the task branch and asks the agent to resolve the conflict.
8. **Review the results.** The Overview, Costs and Reports pages show the summary, spending and a markdown report with the decision log (ADR).

## Settings
In the UI (**Settings**): theme, number of parallel agents, auto-selection policy, project budget, AI reviewer, role templates (instructions, read-only, allowed agents), Cursor trust for worktrees, optional WSL / SSH agents.

Startup settings live in a `.env` file (copy [.env.example](.env.example)). It holds no secrets:

| Variable | Default | Meaning |
|---|---|---|
| `HIDFORGE_DATA_DIR` | `%LOCALAPPDATA%\HidForge` | database, worktrees, backups |
| `HIDFORGE_PORT` | `4317` | UI/API port, always on `127.0.0.1` |
| `HIDFORGE_MAX_CONCURRENT` | `2` | parallel agents (also changeable in the UI) |
| `HIDFORGE_STALL_TIMEOUT_SEC` | `600` | stop an agent that prints nothing for this long |

**Costs.** HidForge stops starting new tasks when the reported spending reaches the project budget. The per-task limit is passed to Claude Code as `--max-budget-usd`. USD comes from Claude Code; tokens are counted for all agents that report them.

## Updates, diagnostics, backups
Check for an update, then update. Only fast-forward from `origin`; HidForge refuses if you have local changes:
```powershell
powershell -ExecutionPolicy Bypass -File scripts\update.ps1 -Check
```
```powershell
powershell -ExecutionPolicy Bypass -File scripts\update.ps1
```
Diagnostics: Node, Git, data folder and free space, database integrity, schema version, backups, project repositories, agents. Safe while the server is running:
```powershell
node scripts\doctor.ts
```
The same is in **Settings → Diagnostics and backups**. A consistent copy of the state (`VACUUM INTO`) is made at startup at most once a day into `%LOCALAPPDATA%\HidForge\backups`; the last 10 are kept. To restore: stop the server, delete `hidforge.db-wal` and `hidforge.db-shm`, and copy the backup over `hidforge.db`.

## Security
- Never uses `--dangerously-skip-permissions`, `--yolo`, `danger-full-access` or similar flags. Interactive workspace trust is not bypassed. Cursor trust is enabled only by you.
- Processes start without a shell. Check commands run only after your approval. A hard deny-list (git push/reset, rm/del, powershell/cmd/bash, curl/wget, npm publish, deploy, shell operators …) can never be allowed, including quoted names, full paths and git global options.
- Provider tokens, keys and cookies are not stored. Secrets are masked in logs.
- The API listens only on `127.0.0.1`, checks the `Host` header, and requires a token for changes. The UI has a strict CSP.
- Agents write only to their own worktree. Changes outside the allowed paths fail the gate. Nothing reaches your branch without your Approve & Merge.

Threat model and details: [docs/SECURITY.md](docs/SECURITY.md).

## Troubleshooting

| Problem | What to do |
|---|---|
| An agent shows as "not installed" | Check that the CLI runs in a terminal (`claude --version` etc.). Then click «Перевірити знову» (Check again) on the Agents page |
| An agent is "not signed in" | Run the CLI in a terminal and sign in once. HidForge never asks for passwords or keys |
| Codex: `sandbox initialization error`, files not written | The Codex sandbox folder `%USERPROFILE%\.codex\.sandbox-bin` is owned by Administrators. Fixing its owner or permissions is your decision (it is a security setting). Test without spending quota: `codex sandbox -- cmd /c echo ok` |
| Cursor does not start a task | Enable Cursor trust for HidForge worktrees in Settings |
| Merge refused: "uncommitted changes" | Commit or stash your changes in the project repository, then merge again |
| The UI does not open | Run `node scripts\doctor.ts`, then look at `%LOCALAPPDATA%\HidForge\hidforge.log` |
| Port 4317 is busy | Set `HIDFORGE_PORT` in `.env` |

## FAQ
**Do I need a server, a VPS or a domain?** No. HidForge runs on your PC and opens only at `127.0.0.1`. A VPS is an optional backend for running agents on another machine (to free up the PC, for a Linux environment or for isolation); it is off by default.

**Does it use paid APIs?** Not by itself. Agents run through your own CLI subscriptions. The Mock Agent costs nothing.

**Is my code sent anywhere?** Only to the agent provider you choose, through its own CLI.

**Can I add another agent?** Yes, with a JSON plugin in `%LOCALAPPDATA%\HidForge\plugins` (see the examples in `plugins/`). Plugins that try to bypass permissions are rejected.

## For developers
```powershell
npm run typecheck; npm run lint; npm test; npm run build
```
Built version: `npm start`. Smoke tests on real CLIs use a little of your subscription quota (one tiny task per agent):
```powershell
node scripts\smoke-real.ts claude agy
```
```powershell
node scripts\smoke-planner.ts claude:haiku agy
```
```powershell
node scripts\smoke-review.ts claude:haiku agy
```
Progress by stage: `node scripts\progress.ts`.

Project layout:
```
src/            core (TypeScript, run directly by Node 24)
  orchestrator.ts  scheduler, runs, gates, merge, recovery
  planner.ts       LLM planner: goal → validated DAG → draft tasks
  reviewer.ts      AI reviewer (QA + Security)
  chat.ts          project chat with a read-only assistant
  oneshot.ts       shared one-shot read-only agent session
  report.ts        project report and ADR decision log
  maintenance.ts   diagnostics and backups
  store.ts, db.ts  SQLite: single source of truth, migrations, state machine
  workspace.ts     git worktrees, diff, allowed paths, merge
  adapters/        Mock, Claude, Codex, Cursor, agy, JSON plugins, WSL, SSH
  proc.ts          spawn without a shell, process-tree kill, secret masking
  server.ts        REST + SSE + static files
web/            UI: styles/tokens.css, styles/ui.css, ui.js (components), app.js (pages)
plugins/        JSON plugin specs (Gemini CLI, OpenCode)
test/           unit and e2e tests (real processes, git, SQLite)
scripts/        installer, launcher, update, doctor, smoke tests, progress
```

## Documentation
The project documents are in Ukrainian.
- [ARCHITECTURE](docs/ARCHITECTURE.md) — components and data flows
- [ADR-001](docs/ADR-001-architecture.md) — architecture decision
- [SECURITY](docs/SECURITY.md) — policies and threat model
- [ROADMAP](docs/ROADMAP.md) — stages and progress
- [ROUTING](docs/ROUTING.md) — automatic choice of agent, model and effort (priority table, rules)
- [TEST_REPORT](docs/TEST_REPORT.md) — what was verified and how
- [DESIGN_SYSTEM](docs/DESIGN_SYSTEM.md) — UI tokens and components
- [UPSTREAM_AUDIT](docs/UPSTREAM_AUDIT.md) — audit of upstream projects
- [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)

## License
[MIT](LICENSE) © 2026 masskill. Third-party sources and attribution: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
