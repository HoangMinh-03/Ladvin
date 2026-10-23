# ladvin — design

> **ladvin — lazy dev plugin.** Let the Claude Code session on your machine delegate work to, and team up with, Claude Code agents on your SSH servers — and see what the whole fleet is burning, in one place.

Status: design, pre-implementation. Date: 2026-10-23.

Notation: **[owner]** = decided by the project owner. **[call]** = decided by the designer on the owner's behalf; reasonable to revisit. Everything else is left to the builder.

---

## 1. Intent

Developers increasingly run Claude Code on more than one machine: the laptop, a company server, a GPU box, a staging VPS. Today each of those is a separate island — you SSH in, start `claude`, babysit it, copy results back by hand, and you have no idea how much quota the whole set is consuming.

ladvin turns the local Claude Code session into the hub of a small fleet. The local agent can **hand work to** a remote agent and read its report later, or **work alongside** a remote agent on one larger job, exchanging messages and files while both are running. A fleet-wide **burn meter** shows token usage per agent and per account.

It is an open-source hobby project, published on GitHub as a Claude Code plugin. **[owner]** It should be fun, easy to try, and honest about its limits.

## 2. Goals

1. **Mode 1 — Delegate (master–sub). [owner]** The local agent gives a remote agent a task. The remote agent runs to completion without further conversation. The local agent then reads its report (and any files it attached) and decides what to do next.
2. **Mode 2 — Team. [owner]** The local agent and a remote agent cooperate on one larger goal, exchanging messages and files *while both are working*. Canonical examples from the owner:
   - **Performance hunt:** local agent drives a load test (k6, JMeter, …) against a server; the agent on that server watches the system (CPU, memory, I/O, logs, slow queries, pools). They correlate observations by time to identify the bottleneck — e.g. "p99 jumps at 500 RPS" ↔ "DB connection pool exhausted at that moment".
   - **Cross-environment resources:** passing files between the two environments — heap dumps, flamegraphs, logs back to local; scripts, configs, builds up to the remote.
3. **Star topology only. [owner]** Local is always the hub. Remote agents never talk to each other directly, in either mode.
4. **Burn meter.** Token usage per remote agent, per host, and per Claude account, including the local session, with time-window views. Secondary to the communication features. **[owner]**
5. **Attach to any agent visually** from the local terminal: tmux, WezTerm, macOS Terminal.app. **[owner]**
6. **Lazy setup.** Install the plugin, run one command per host, give a task in natural language. A stranger should get their first delegated task running in under ~5 minutes on a host that already has `claude` logged in. **[call]**

## 3. Non-goals (v1)

- Remote ↔ remote communication. **[owner]**
- Full compliance with the A2A (Agent2Agent) specification. Vocabulary is borrowed (task, message, artifact) so a later A2A bridge is natural. **[call]**
- Windows as a **remote** host (no tmux). Windows is supported as the **local** host. **[call]**
- Logging into Claude on the remote on the user's behalf. The user runs `claude` login on each host once, themselves. **[call]**
- Human *takeover* of a remote agent's session (typing into it as if it were interactive). v1 attach is view-only plus "send a message via ladvin". **[call]**
- Non-Claude agents.
- A GUI or web dashboard.

## 4. Anti-goals (fails even if it "works")

- Opening network ports on remote hosts, or requiring a relay server. Everything rides on the user's existing SSH.
- Remote agent output being treated as instructions by the local agent (prompt-injection bridge between machines).
- Setup that needs reading the source to get going.
- Silently burning quota: a runaway remote agent the user cannot see or stop.

## 5. Constraints

- **Platforms. [call]**
  | | Windows | macOS | Linux |
  |---|---|---|---|
  | Local (hub) | yes | yes | yes |
  | Remote | no (v1) | x64, arm64 | x64, arm64 |
- Remote prerequisites: `sshd` reachable with key auth, `tmux`, `claude` installed and logged in. Nothing else (no Node/Bun/Python required).
- Local prerequisites: Claude Code, OpenSSH client (`ssh`, `scp`) on PATH, Node.js ≥ 20 (to run the local MCP server).
- Must be installable as a Claude Code plugin from the GitHub repo via the plugin marketplace mechanism (`.claude-plugin/marketplace.json` in the repo).
- Repo, docs, code comments and README in English (public project). **[call]**
- License: MIT. **[call]**

## 6. Architecture

```
 LOCAL MACHINE                                         REMOTE HOST (×N)
┌────────────────────────────────────┐                ┌──────────────────────────────────┐
│ Claude Code (master / team lead)   │                │ ladvin-agentd  (persistent)      │
│   │  MCP tools, slash cmds, hooks  │                │   ├─ state in ~/.ladvin/         │
│   ▼                                │   ssh (stdio,  │   ├─ agent A: tmux session       │
│ ladvin-mcp (local hub, Node)       │◄──JSON-RPC────►│   │    claude -p stream-json     │
│   ├─ host registry, connections    │  ControlMaster)│   │    + ladvin MCP tools        │
│   ├─ team router, inbox, task list │                │   ├─ agent B ...                 │
│   ├─ burn aggregator               │   scp (files)  │   └─ usage scanner (~/.claude)   │
│   └─ terminal adapters             │◄──────────────►│                                  │
└────────────────────────────────────┘                └──────────────────────────────────┘
```

### 6.1 Components

1. **Plugin shell** — `.claude-plugin/plugin.json`, `.mcp.json`, slash commands, one skill, hooks.
2. **`ladvin-mcp` (local hub)** — a stdio MCP server started by Claude Code from the plugin. TypeScript, bundled to a single JS file committed in the repo (`dist/ladvin-mcp.js`) and run with `node`, so users need no build step. **[call]** It owns: host registry, SSH connections, routing for team mode, the burn aggregator, terminal adapters.
3. **`ladvin-agentd` (remote daemon)** — TypeScript compiled with `bun build --compile` into standalone binaries for linux-x64, linux-arm64, darwin-x64, darwin-arm64, published on GitHub Releases. **[call]** It runs persistently on the remote (inside its own tmux session `ladvin-agentd`), survives SSH disconnects, owns the remote agents, persists state under `~/.ladvin/`, and exposes a Unix socket. **[call]**
4. **Shared protocol package** — one TypeScript module of message types used by both hub and agentd. **[call]**

### 6.2 Lifecycle **[call]**

- There is **no local background daemon** in v1. The hub lives as long as the Claude Code session.
- Remote agents and agentd keep running when the local session ends. Delegated tasks finish and store their reports on the remote; the next session's hub reconnects and collects them.
- Team mode requires the local session to be alive (the local agent is a team member). If the hub disconnects, the remote teammate's outgoing messages are queued by agentd and delivered on reconnect.
- **Hub gone during a team:** teammates finish their current turn, then pause (no new input). After an idle timeout (default 15 min, configurable) agentd stops them. Team state (members, task list, inbox, session ids) is persisted on agentd and in local state, so `ladvin_team_resume(team)` in a later session reconnects, resumes paused teammates (`claude --resume <session>`), or restarts stopped ones from their session.
- **agentd restart/crash:** running agents are its children and die with it; on restart agentd marks them `failed (agentd restarted)` and keeps their session ids so they can be followed up. Upgrading agentd is refused while agents are running unless forced. Agents surviving agentd restarts is a non-goal for v1.

### 6.4 Ownership and local state **[call]**

- **Owner = local project directory.** Every task and team records the absolute project directory (the Claude Code cwd) of the session that created it, plus the local machine id. Any later session in the same project directory can see, collect, follow up and cancel them; sessions in other directories see them only through `/ladvin:hosts` and `ladvin_status(host=…)` (read-only summary). Two sessions in the same directory may both read a report; reading is not consuming.
- **One active team per project directory.**
- **Local state** lives in `~/.ladvin/state/<hash of project dir>/` (tasks index, teams, inbox, burn cache) — not in the project tree, so nothing is accidentally committed. Downloaded artifacts and shared files still go into the project's `.ladvin/` (ladvin adds `.ladvin/` to `.gitignore` if a `.gitignore` exists).
- **Hooks** are separate processes; they read this on-disk state, locating it by the `cwd` field in the hook input. The hub writes inbox/budget state to disk on every change. No in-memory-only state that hooks need.
- **agentd accepts multiple concurrent clients** (several local sessions, or several local machines), each identified by machine id + project dir.

### 6.3 Transport **[call]**

- The hub reaches a host by spawning `ssh <host> ~/.ladvin/bin/ladvin-agentd bridge`, which connects stdio to agentd's Unix socket (starting agentd first if it isn't running). Messages are newline-delimited JSON-RPC 2.0.
- SSH ControlMaster multiplexing is used where supported (macOS/Linux local) to make reconnects and `scp` cheap. On Windows local, plain connections (OpenSSH for Windows lacks ControlMaster support).
- Host aliases come from the user's `~/.ssh/config`; ladvin never stores passwords or keys.

## 7. The agent runtime on the remote **[call]**

- Each remote agent is one `claude` process in headless streaming mode: `claude -p --input-format stream-json --output-format stream-json --verbose`, with a ladvin-specific appended system prompt, a working directory, and a permission mode (see §11).
- agentd writes to its stdin and reads its stdout. The raw JSON stream is persisted to `~/.ladvin/agents/<id>/stream.jsonl`.
- Each agent also gets a tmux session `ladvin-<agent-id>` that runs `ladvin-agentd view <agent-id>`: a human-readable live rendering of the stream (assistant text, tool calls, results). This is what "attach" shows.
- agentd injects a **ladvin MCP server into each remote agent** (via `--mcp-config` pointing to agentd itself in a stdio sub-mode) to give the remote agent its ladvin tools (§8, §9).
- **Verify early (risk):** that stream-json input accepts a new user message while the agent is mid-turn (queued until the turn ends) or only between turns. Team mode's message delivery depends on this. If only between turns, agentd queues and delivers at turn end; the design tolerates either, but latency differs.

## 8. Mode 1 — Delegate

### Local agent tools (MCP)
| Tool | Purpose |
|---|---|
| `ladvin_delegate(host, task, cwd?, files?[], preset?)` | Start a remote agent with a task. Optional files are uploaded first into its working area. Returns `task_id`. |
| `ladvin_status(task_id? \| host?)` | State (`queued/running/done/failed/cancelled`), elapsed time, tokens burned so far, last activity line. |
| `ladvin_report(task_id)` | The report and list of artifacts. Fails with a clear message if still running. |
| `ladvin_fetch(task_id, artifact)` | Download an artifact into `.ladvin/inbox/<task_id>/` in the local project. |
| `ladvin_cancel(task_id)` | Stop the remote agent. |

### Remote agent tools
| Tool | Purpose |
|---|---|
| `ladvin_attach_artifact(path, note?)` | Mark a file as part of the result. |
| `ladvin_report(summary, status, details?)` | Submit the final report. The appended system prompt tells the agent it must call this before finishing. If it ends without calling it, agentd uses its final assistant message as the report and flags `report_missing: true`. |

### Done and follow-ups **[call]**
- A delegated agent is **done** when it calls `ladvin_report`, or, failing that, at the first `result` event of its stream. agentd then closes its stdin and lets the process exit. Its Claude session id is kept.
- `ladvin_followup(task_id, text)` resumes that session (`claude --resume <session>` in stream-json mode) with a new message, as a new run of the same task; the report is replaced and older reports are kept in history.
- Hard limits per task: max wall time (default 2 h) and optional max tokens; exceeding either cancels the agent and reports `failed (limit)`.

### Report shape
`{ task_id, host, status: "success"|"partial"|"failed", summary, details, artifacts: [{path, size, note}], usage: {input, output, cache_read, cache_write}, started_at, ended_at, report_missing }`

## 9. Mode 2 — Team

A **team** = the local agent + one or more remote teammates, with a shared goal, a shared task list, and message passing. Messages only flow local ↔ remote; the hub refuses remote → remote. **[owner]**

### Local agent tools
| Tool | Purpose |
|---|---|
| `ladvin_team_start(goal, members: [{host, role, cwd?, preset?}])` | Create a team and spawn remote teammates with the goal and their role. |
| `ladvin_team_send(team, to, text, files?[])` | Message a teammate, optionally with files. |
| `ladvin_team_inbox(team, wait_seconds?)` | Read pending messages; optionally block up to N seconds for the next one. |
| `ladvin_team_tasks(team, op, …)` | Shared task list: list / add / claim / update / complete. |
| `ladvin_team_end(team, summary?)` | Tell teammates to wrap up, collect final notes, stop them. |

### Remote teammate tools
`team_send(text, files?[])` (always to local), `team_inbox(wait_seconds?)`, `team_tasks(op, …)`, `share_file(path, note?)`, `fetch_file(name)`.

### Getting messages into the agents' attention
- **Remote:** agentd injects each incoming message into the teammate's stdin as a user turn, formatted as `[ladvin message from local @ <timestamp>]: …` (see §7 risk).
- **Local:** the local agent is an interactive session, so ladvin cannot push text into it arbitrarily. Instead **[call]**:
  - a **PostToolUse hook** appends "N new ladvin messages: …" as additional context after any tool call when the team inbox is non-empty;
  - a **Stop hook** blocks the local agent from ending its turn while a team is active and has unread messages, telling it to read them;
  - `ladvin_team_inbox(wait_seconds)` lets the local agent deliberately wait (e.g. "run load step, then wait 30s for the server's observations").
- Exact hook output fields to be checked against current Claude Code hook docs during build.

### Time correlation (for the performance-hunt case)
- Every message, task update and file event carries `sent_at` (sender clock) and `hub_received_at`.
- On connect, the hub estimates each host's clock offset (a few ping round-trips) and messages shown to agents include times **normalized to the hub's clock**, so "at 14:03:12" means the same instant on both sides. **[call]**

### Files
- `share_file` / `ladvin_team_send(files)` transfer via `scp` over the existing SSH configuration. Files land in `<team workdir>/.ladvin/shared/` on the receiving side with a manifest (`name, from, size, sha256, note, time`). **[call]**
- Default size cap 200 MB per file, configurable. Transfers are only to/from the shared directory and the agent's working directory — no arbitrary paths. **[call]**

## 10. Burn meter

- **Source (remote):** agentd scans `~/.claude/projects/**/*.jsonl` (Claude Code transcripts, which carry per-message `usage`) on its host, incrementally (remembering file offsets), and attributes usage to ladvin agents where it can (by session id) and to "other" otherwise. **Source (local):** the hub scans the local machine's transcripts the same way.
- **Account identity:** usage is grouped by the Claude account each host is logged into (read from the Claude Code config on that host — exact field to verify during build). This matters because several hosts on one subscription share the same rate-limit windows.
- **Views:** per agent, per host, per account; rolling 5-hour window and current week; burn rate (tokens/min).
- **Honesty rule:** Anthropic's exact plan quotas are not public, so ladvin never estimates them. However, Claude Code's `rate_limit_event` (docs/spikes.md) reports **real utilization** of the 5-hour and 7-day windows. Whenever a ladvin agent on an account sees one, ladvin shows that value together with its age. When none has been observed, it shows "—". Budgets can be set as utilization % or as billable tokens. **[call, revised in Plan 3]**
- **Surfaces:** `ladvin_burn()` MCP tool (so the local agent can throttle itself — e.g. avoid spawning more agents near the budget), `/ladvin:burn` command (table), and an optional statusline script the user can point `statusLine` at (documented in README; ladvin does not edit user settings). **[call]**
- **What is counted [call]:** "billable-ish tokens" = input + output + cache-write tokens. Cache-read tokens are shown separately and **not** counted toward budgets (they dominate raw totals and would trip any naive limit).
- **Account fallback [call]:** if the account identity on a host cannot be determined, that host's usage is grouped as its own pseudo-account `host:<alias>`, marked "account unknown".
- **Guard:** optional per-account budgets, one for the rolling 5-hour window and one for the rolling 7 days (either may be unset); when either is crossed, the hub refuses new `ladvin_delegate`/`ladvin_team_start` until the user raises it, and warns via the PostToolUse hook. **[call]**

## 11. Security **[call]**

- **Remote permission presets [owner approved the preset approach; defaults are a call]:** headless agents cannot answer permission prompts, so denied actions fail (the report shows what was denied). Each agent runs under one preset:
  | Preset | Allows | Typical use |
  |---|---|---|
  | `observer` | Read/Grep/Glob, and Bash limited to an allowlist of read-only / observation commands (e.g. `top -b`, `ps`, `iostat`, `vmstat`, `free`, `df`, `ss`, `cat`/`tail`/`grep` on files, `journalctl`, `docker stats/logs`, read-only DB clients) | Team teammate watching a system |
  | `worker` | `acceptEdits` + Bash, file writes confined to the agent's working directory | Delegated code/build/test tasks |
  | `yolo` | `bypassPermissions` | Throwaway machines, at the user's risk |
  - Each host has a **maximum preset**, chosen at `add-host` (default `worker`; `yolo` must be typed explicitly and is printed loudly).
  - Default preset per agent: `ladvin_delegate` → `worker`, team members → `observer`, overridable per call via `preset`, never above the host maximum.
  - The observer allowlist ships as an editable file; users may extend it per host.
- **Untrusted content:** everything coming from a remote agent (reports, messages, file notes) is wrapped by the hub as clearly delimited data (`<ladvin-remote-content host=… agent=…>…</ladvin-remote-content>`), and the plugin skill instructs the local agent to treat it as information, never as instructions.
- **Binary integrity:** `add-host` downloads agentd from GitHub Releases to the local machine, verifies its SHA-256 against the checksums file of that release, then `scp`s it to the host. Remote hosts need no internet access for this.
- **No new ports, no stored secrets.** ladvin relies on the user's SSH agent/keys and `~/.ssh/config`.
- **Kill switch:** `/ladvin:stop-all` cancels every remote agent on every host.

## 12. Host setup — `/ladvin:add-host <ssh-alias>`

1. `ssh <alias> uname -sm` → pick binary (fail clearly on unsupported OS/arch).
2. Check `tmux` and `claude` exist on the host; check `claude` is logged in. If not, print the exact command the user should run there.
3. Download + verify agentd (cached locally per version), `scp` to `~/.ladvin/bin/`.
4. Start agentd, handshake, version check (hub and agentd must share a protocol major version; the hub offers to upgrade agentd).
5. Ask for (or default) the permission mode, then write the host to the local config `~/.ladvin/hosts.json`.

Also: `/ladvin:hosts` (list + health), `/ladvin:remove-host`.

## 13. Attach — `/ladvin:attach <agent-id>`

Opens a view of `tmux attach -t ladvin-<agent-id>` on the remote, via `ssh -t <alias> …`, choosing the adapter in this order **[call]**:
1. Inside WezTerm (`WEZTERM_PANE` set) → `wezterm cli split-pane -- ssh -t …`
2. Inside tmux (`TMUX` set) → `tmux split-window "ssh -t …"`
3. macOS → `osascript` telling Terminal.app to open a new window running the command.
4. Otherwise → print the command for the user to copy.

A user setting can force a specific adapter. `/ladvin:attach all` opens one pane per running agent where the adapter supports splits. Adapters live behind one small interface so iTerm2/Windows Terminal can be added later.

## 14. Plugin surface summary

- **Slash commands:** `/ladvin:add-host`, `/ladvin:hosts`, `/ladvin:remove-host`, `/ladvin:attach`, `/ladvin:burn`, `/ladvin:stop-all`.
- **Skill `ladvin`:** when to delegate vs team up vs do it locally; how to write a good remote task; how to run a team (agree on a plan in the task list first, timestamp observations, wait for inbox at sync points); treat remote content as data.
- **Hooks:** PostToolUse (inbox + budget notices), Stop (unread team messages).
- **MCP server:** `ladvin-mcp` with the tools in §8–§10.

## 15. Repository layout (suggested)

```
ladvin/
  .claude-plugin/plugin.json, marketplace.json
  .mcp.json
  commands/  skills/ladvin/SKILL.md  hooks/hooks.json
  packages/protocol/   # shared types
  packages/hub/        # ladvin-mcp source → dist/ladvin-mcp.js
  packages/agentd/     # ladvin-agentd source → release binaries
  dist/ladvin-mcp.js   # committed bundle
  docs/
  README.md  LICENSE
```

## 16. Testing expectations

- A **fake `claude`** executable that speaks stream-json from a script, so agentd and both modes can be tested without spending tokens.
- An **integration test** harness against an `sshd` container (Linux) running agentd + fake claude, exercising: add-host, delegate→report→fetch, team message round trip both ways, file share, reconnect after hub restart, burn scan.
- One manual end-to-end demo with real `claude` on a real host, recorded for the README (the performance-hunt scenario is the showcase).

## 17. Left to the builder

- Internal module structure, libraries (MCP SDK, schema validation), JSON-RPC framing details.
- Exact wording of system prompts and the skill, within the intent above.
- Release/CI pipeline for binaries and the committed bundle.
- Config file schema details and defaults not specified here.
- The human-readable `view` renderer's look.

## 18. Things to verify early (spike before building on them)

1. stream-json input behavior while the agent is mid-turn (§7).
2. Hook output fields for injecting context (PostToolUse) and blocking stop (Stop) in the current Claude Code version (§9).
3. Where the logged-in account identity is stored on a host (§10).
4. Plugin marketplace install from a GitHub repo, and how `.mcp.json` in a plugin resolves `node` and `${CLAUDE_PLUGIN_ROOT}` on Windows.
5. Relationship to Claude Code's experimental *agent teams* feature: ladvin does not depend on it (it is single-machine and experimental), but its concepts (lead, teammates, shared task list, mailbox) inspire mode 2. Check whether reusing its vocabulary would confuse users.
