# ladvin Plan 2 — Mode 2 (Team) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The local agent and one or more remote Claude Code teammates work on one goal together, exchanging messages, files and a shared task list while both run.

**Architecture:** A team member is an agentd task with `kind: "team"`. Its `claude` process stays alive between turns (stream-json waits on stdin), so local→remote messages are injected straight into stdin. Spike §2 showed a mid-turn message is folded into the running turn. Remote→local traffic (messages, shared files, task-list ops) is queued in an agentd outbox. The hub's poller pulls the outbox every second and acks it, so nothing is lost while the hub is away. Local delivery is pull-based: a PostToolUse hook and a Stop hook read the on-disk inbox, and `ladvin_team_inbox` can wait for new messages. The hub owns the canonical task list and mirrors it to each member's agentd.

**Tech Stack:** Same as Plan 1 (TypeScript, Bun for dev/tests/agentd, Node ≥ 20 for hub + hooks, MCP SDK, zod).

**Spec:** `docs/superpowers/specs/2026-10-23-ladvin-design.md` (§6.2, §6.4, §9, §11), plus `docs/spikes.md` §2 and §5.

**Deliberate departures from spec §9 (rulings):**
- Teammates get no `team_inbox` or `fetch_file` tools. Local messages are injected as user turns, so a teammate never needs to poll. Files the local agent sends are pushed into the teammate's `.ladvin/shared/`, so the teammate never needs to fetch.
- The canonical task list lives in the hub. Teammates' ops are queued and applied about 1 s later (hub poll), then mirrored back.

## Global Constraints

- Topology: messages flow only local ↔ remote. There is no remote → remote API.
- One active team per project directory. A second `ladvin_team_start` while one is active is refused.
- Hub gone: teammates finish their current turn and then sit idle. After an idle timeout (default 15 min, env `LADVIN_TEAM_IDLE_MS`) with no hub contact, agentd stops them. They can be resumed with `claude --resume`.
- Everything from a remote agent reaches the local agent wrapped by `wrapRemote(host, agent, body)`.
- Times shown to the local agent are normalized to the hub clock: `remoteTime - clockOffsetMs`. Times shown to a teammate are converted to its clock: `hubTime + clockOffsetMs`. Format: `HH:MM:SS.mmm`.
- Shared files: default cap 200 MB per file (env `LADVIN_MAX_SHARE_BYTES`). Only files inside the member's cwd can be shared. They land in `<cwd>/.ladvin/shared/` on the remote, and in `<projectDir>/.ladvin/shared/<teamId>/` locally, each with a `manifest.jsonl` (`name, from, size, sha256, note, time`).
- Local team state: `projectStateDir(projectDir)/teams/<teamId>/{team.json, inbox.jsonl, read-cursor}` plus `projectStateDir/active-team`. Hooks find it through `CLAUDE_PROJECT_DIR`, falling back to the hook input's `cwd`.
- Hook output (spikes §5): PostToolUse → `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"…"}}`; Stop → `{"decision":"block","reason":"…"}`. Never block when there is nothing unread.

## Review Focus

1. **A teammate sends while the hub is disconnected.** Expected: the message is delivered after `ladvin_team_resume` in a new session. → Task 5 test.
2. **The Stop hook loops forever.** Expected: it blocks only while there are unread messages, and those messages are marked read by the block, so the next stop is allowed. → Task 6 test.
3. **The same outbox entry is pulled twice** (ack lost after the hub wrote the inbox). Expected: it appears once in the local inbox, deduplicated by message id. → Task 4 test.
4. **A teammate shares a file outside its cwd, or one over the cap.** Expected: the tool returns an error to the teammate, and nothing reaches local. → Task 3 test.
5. **A message to a member that has gone idle-stopped.** Expected: the member is resumed with `--resume` and receives the message; it is not silently dropped. → Task 2 test.

---

## File Structure

```
packages/protocol/src/messages.ts     + TaskKind, TeamInfo, OutMsg, TeamTask, team.* / agent.team* schemas, TaskState "idle"
packages/agentd/src/runner.ts         + team mode (result → idle), inject(), stop(), idle sweeper
packages/agentd/src/outbox.ts         NEW  per-host outbox (append, pull by owner, ack)
packages/agentd/src/team-prompt.ts    NEW  TEAM_SYSTEM_PROMPT + message formatting
packages/agentd/src/server.ts         + team.join / team.send / team.pull / team.ack / team.syncTasks / team.stop, agent.team*
packages/agentd/src/agent-mcp.ts      + team tool set (team_send, team_tasks, share_file) for kind "team"
packages/agentd/test/fake-claude.ts   + {respond: Step[]} with $INPUT substitution
packages/hub/src/team/store.ts        NEW  TeamStore: team.json, inbox.jsonl, read cursor, active pointer
packages/hub/src/team/poller.ts       NEW  pull → inbox / shared files / task ops → ack, mirror tasks
packages/hub/src/team/time.ts         NEW  toLocal / toRemote / fmt
packages/hub/src/tools/team.ts        NEW  ladvin_team_start/send/inbox/tasks/end/resume
packages/hub/src/hook.ts              NEW  hook entry → dist/ladvin-hook.js
hooks/hooks.json                      NEW
skills/ladvin/SKILL.md                + team section
test/e2e/e2e.test.ts                  + team round trip over real ssh
```

---

### Task 1: Protocol additions + fake-claude `respond`

**Files:** Modify `packages/protocol/src/messages.ts`, `packages/agentd/test/fake-claude.ts`. Test: `packages/protocol/test/messages.test.ts`.

**Interfaces — Produces:**
- `TaskState` gains `"idle"` (a team member that is alive and waiting for input).
- `TaskKind = "delegate" | "team"`. `TaskInfo` gains `kind?: TaskKind` (absent means delegate) and `team?: { teamId: string; role: string }`.
- `TeamTask = { id: string; title: string; status: "todo" | "doing" | "done"; owner?: string; note?: string }`
- `TeamTaskOp = { op: "add"; title: string; owner?: string } | { op: "update"; id: string; status?: TeamTask["status"]; owner?: string; note?: string }`
- `OutMsg = { id: string; teamId: string; taskId: string; role: string; sentAt: string } & ({ kind: "message"; text: string } | { kind: "file"; name: string; path: string; size: number; sha256: string; note?: string } | { kind: "tasksOp"; op: TeamTaskOp })`. `id` is `m_` + 12 hex.
- Schemas:
  - `TeamJoinParams {owner, teamId, role, goal, cwd?, preset}` → `{taskId, cwd}`
  - `TeamSendParams {taskId, text, from: string}` → `{}`
  - `TeamPullParams {owner}` → `{messages: OutMsg[]}`
  - `TeamAckParams {ids: string[]}`
  - `TeamSyncTasksParams {teamId, tasks: TeamTask[]}`
  - `TeamStopParams {taskId}`
  - `AgentTeamSendParams {taskId, text}`
  - `AgentShareParams {taskId, path, note?}`
  - `AgentTasksOpParams {taskId, op: TeamTaskOp}`
  - `AgentTasksListParams {taskId}` → `TeamTask[]`
- fake-claude step `{respond: Step[]}`: after the main script, every further stdin line runs these steps. Any string field equal to or containing `$INPUT` is replaced with that line's `message.content`. Each response ends with a `result` unless one of the steps emitted one.

- [ ] **Step 1: Failing tests.** `TeamJoinParams` rejects an empty `role`. `OutMsg` round-trips one sample of each kind. `TaskState.parse("idle")` succeeds.
- [ ] **Step 2: Run** `bun test packages/protocol` — expect FAIL.
- [ ] **Step 3: Implement** the schemas and the fake `respond` step.
- [ ] **Step 4: Run** `bun test packages` — expect PASS (Plan 1 tests unaffected).
- [ ] **Step 5: Commit** — `feat(protocol): team messages, outbox entries, shared task list`

---

### Task 2: agentd runner team mode

**Files:** Modify `packages/agentd/src/runner.ts`. Create `packages/agentd/src/team-prompt.ts`. Test: `packages/agentd/test/team-runner.test.ts`.

**Interfaces:**
- Consumes: Task 1 types; the Plan 1 `Runner`.
- Produces:
  - `Runner.start(taskId, prompt)` reads `task.kind`. For `team`, it uses `TEAM_SYSTEM_PROMPT(goal, role)` instead of `DELEGATE_SYSTEM_PROMPT`.
  - In team mode a `result` event does **not** finish the run. It adds the usage, sets state `idle`, and keeps the process. Limits (wall, tokens) still apply.
  - `Runner.inject(taskId, text: string): Promise<void>`. If the run is live, it writes `userMessage(text)` and sets state `running`. If the task is `done` or `failed` with a sessionId (idle-stopped, agentd restarted), it resumes with `--resume` and the text, like `followup`. Otherwise it throws.
  - `Runner.stop(taskId, reason: string)` closes stdin gracefully. The state becomes `done`, with `failReason` set to the reason (e.g. `"stopped: idle timeout (resumable)"`, `"team ended"`).
  - `Runner.sweepIdle(now: number, lastHubContact: (teamId) => number, idleMs: number): string[]` stops idle team members whose team has had no hub contact for `idleMs`. It returns the stopped ids.
  - `team-prompt.ts`:
    - `TEAM_SYSTEM_PROMPT(goal: string, role: string): string` says the agent is a teammate with this role; that the coordinator (the local agent) only sees what it sends with `team_send`; that coordinator messages arrive as user turns prefixed `[ladvin message from <from> @ HH:MM:SS.mmm]`; to timestamp observations; to use `team_tasks` and `share_file`; and to end the turn when waiting.
    - `formatIncoming(from: string, at: Date, text: string): string`.
- [ ] **Step 1: Failing tests** (fake claude; `kind: "team"` tasks created through the store):
  - script `[{say:"hi"},{result:"turn1"},{respond:[{say:"got $INPUT"},{result:"r"}]}]` → after `start`, state becomes `idle` (not `done`), usage counted once.
  - `inject(id, "ping")` → state `running` then `idle` again; `stream.jsonl` contains `got [ladvin message from local @` … `ping`.
  - the argv of the spawned claude contains the team prompt's role text (check the `init.argv` that fake claude records).
  - `stop(id, "team ended")` → state `done`, `failReason` `team ended`, process exits.
  - **Review Focus 5:** stop with `"stopped: idle timeout (resumable)"`, then `inject(id, "wake")` → the process is respawned with `--resume <sessionId>`, and the stream shows `got … wake`.
  - `sweepIdle(now, () => now - 2000, 1000)` stops an idle member. With `lastHubContact` = now it stops nothing. It never stops a member whose state is `running`.
- [ ] **Step 2: Run** `bun test packages/agentd/test/team-runner.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test packages` — expect PASS.
- [ ] **Step 5: Commit** — `feat(agentd): team-mode runner — idle between turns, inject, stop, idle sweep`

---

### Task 3: agentd outbox, team RPCs, teammate MCP tools

**Files:** Create `packages/agentd/src/outbox.ts`. Modify `packages/agentd/src/server.ts`, `agent-mcp.ts`, `main.ts`. Test: `packages/agentd/test/team-server.test.ts`.

**Interfaces:**
- Consumes: Task 1 schemas; Task 2 `Runner.inject/stop/sweepIdle`.
- Produces:
  - `class Outbox { append(m: Omit<OutMsg,"id"|"sentAt">): OutMsg; pull(owner: Owner): OutMsg[]; ack(ids: string[]): void }`. Persisted at `<home>/outbox.jsonl` plus `<home>/outbox-acked.json`. `pull` returns un-acked messages of teams whose member tasks belong to `owner`, oldest first.
  - Server methods:
    - `team.join` creates a `kind: "team"` task in `queued` with `team: {teamId, role}`. The goal is stored as the prompt seed.
    - `team.send` calls `runner.inject(taskId, formatIncoming(from, now, text))`.
    - `team.pull` records `lastHubContact[teamId] = now` for every team of the owner, then returns `{messages}`.
    - `team.ack`.
    - `team.syncTasks` writes `<home>/teams/<teamId>/tasks.json`.
    - `team.stop` calls `runner.stop(taskId, "team ended")`.
    - `agent.teamSend` appends `kind: "message"`.
    - `agent.share` checks the path is inside cwd (same rule as `agent.attach`) and that size ≤ cap (`LADVIN_MAX_SHARE_BYTES`, default 209715200). It computes sha256 and appends `kind: "file"` with `path` relative to cwd.
    - `agent.tasksOp` appends `kind: "tasksOp"`.
    - `agent.tasksList` reads the mirror.
  - `agent-mcp.ts`: when the task is `kind: "team"`, it registers `team_send({text})`, `team_tasks({op: "list"|"add"|"update", title?, id?, status?, owner?, note?})` and `share_file({path, note?})` **instead of** the delegate tools. `team_tasks` list returns the mirror. Add/update reply `"Queued; the shared list updates within a few seconds."`
  - `main.ts serve`: runs `runner.sweepIdle(Date.now(), id => lastHubContact, LADVIN_TEAM_IDLE_MS ?? 900000)` every 30 s.
- [ ] **Step 1: Failing tests** (in-process server like Plan 1 `server.test.ts`):
  - join + start a teammate whose script calls `team_send {text:"hello"}` → `team.pull` returns one `message` with role and text. `team.ack` → the next pull is empty.
  - `team.send` → the teammate's `respond` step calls `team_send {text:"echo $INPUT"}` → pull shows `echo [ladvin message from local @`.
  - `share_file` of `cwd/a.txt` → a pull entry has `kind: "file"`, `path "a.txt"` and the correct sha256.
  - **Review Focus 4:** `share_file` of a path outside cwd, and of a file over the cap (`LADVIN_MAX_SHARE_BYTES=4`), → the tool result `isError` (fake claude records tool results into the stream as `{"type":"tool_result_seen","isError":…}`; add that to fake claude). No outbox entry is created.
  - `team_tasks add` → outbox `tasksOp`. After `team.syncTasks`, `team_tasks list` returns the synced list.
  - pull by another owner returns nothing.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test packages` — expect PASS.
- [ ] **Step 5: Commit** — `feat(agentd): team outbox, team RPCs, teammate tools`

---

### Task 4: Hub team store, time normalization, poller

**Files:** Create `packages/hub/src/team/{store.ts,time.ts,poller.ts}`. Test: `packages/hub/test/team-store.test.ts`.

**Interfaces:**
- Consumes: Task 1 types; Plan 1 `ConnectionPool`, `HostConnection.info.clockOffsetMs`, `wrapRemote`, `projectStateDir`, `ensureGitignore`.
- Produces:
  - `type TeamMember = { taskId: string; host: string; role: string; preset: Preset; cwd: string }`
  - `type Team = { teamId: string; goal: string; members: TeamMember[]; tasks: TeamTask[]; status: "active" | "ended"; createdAt: string }`. `teamId` is `team_` + 8 hex.
  - `type InboxEntry = { id: string; at: string /* hub time ISO */; role: string; host: string; taskId: string; text: string }`
  - `class TeamStore { constructor(projectDir: string); active(): Team | undefined; create(goal, members): Team; save(team): void; end(teamId): void; get(teamId): Team | undefined; appendInbox(teamId, e: InboxEntry): boolean /* false if id already present */; unread(teamId): InboxEntry[]; markRead(teamId): void; all(teamId): InboxEntry[] }`. The read cursor is a count of entries; files are under `projectStateDir/teams/<id>/`.
  - `time.ts`:
    - `toLocal(remoteIso, offsetMs): Date`
    - `toRemote(local: Date, offsetMs): Date`
    - `fmt(d: Date): string` (`HH:MM:SS.mmm`, local timezone)
    - `renderInbox(entries: InboxEntry[]): string` — each line `[HH:MM:SS.mmm] <role>@<host>: <text>`, wrapped per entry with `wrapRemote(host, taskId, …)`.
  - `applyOp(tasks: TeamTask[], op: TeamTaskOp, by: string): TeamTask[]`. `add` ids are `k1`, `k2`, …; `update` of an unknown id is ignored.
  - `class TeamPoller { constructor(o: {store: TeamStore; pool: ConnectionPool; owner: Owner; transportFor: (alias) => Transport; intervalMs?: number /* 1000 */}); start(): void; stop(): void; pollOnce(): Promise<number /* new inbox entries */> }`. For each distinct host of the active team, `pollOnce` calls `team.pull {owner}` and then:
    - `message` → `appendInbox` with time `toLocal(sentAt, offset)`.
    - `file` → `transport.download(<member cwd>/<path>)` into `<projectDir>/.ladvin/shared/<teamId>/<name>`, appends the manifest line, and adds an inbox entry `shared file <name> (<size> bytes) → <local path>`.
    - `tasksOp` → `applyOp`, `save`, `team.syncTasks` to every member host, and an inbox entry `task list: <op summary>`.

    It then calls `team.ack` with the ids it processed. Errors on one host don't stop other hosts.
- [ ] **Step 1: Failing tests:**
  - `TeamStore` create/active/end. A second `create` while active throws `a team is already active in this project (<teamId>)`.
  - **Review Focus 3:** `appendInbox` with the same id twice → second returns `false`; `unread` has one entry.
  - `unread` then `markRead` → `unread` is empty; `all` still holds the entry.
  - `toLocal("2026-10-23T10:00:01.000Z", 1000)` equals `2026-10-23T10:00:00.000Z`. `toRemote` is its inverse.
  - `applyOp` add/add/update gives ids `k1`, `k2`, and status `done` on `k1`.
  - `renderInbox` output contains `<ladvin-remote-content host="h" agent="t_1">`.
  - `pollOnce` against a fake pool whose `call("team.pull")` returns one message, one file and one tasksOp → three inbox entries, the file is downloaded through the fake transport, `team.syncTasks` is called, and `team.ack` gets all three ids.
- [ ] **Step 2: Run** `bun test packages/hub/test/team-store.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test packages` — expect PASS.
- [ ] **Step 5: Commit** — `feat(hub): team store, clock normalization, outbox poller`

---

### Task 5: Hub team tools

**Files:** Create `packages/hub/src/tools/team.ts`. Modify `packages/hub/src/hub.ts` (register tools; the poller starts when a team is active at hub start or on `team_start`/`team_resume`). Test: `packages/hub/test/team.test.ts`.

**Interfaces — Produces** (MCP tools, all errors through `guarded`):
- `ladvin_team_start({goal, members: [{host, role, cwd?, preset?}]})`:
  - Refused while a team is active.
  - Host must be known; preset defaults to `observer` and is capped by the host max (same message as delegate).
  - For each member: `team.join`, then `task.start` with prompt `Team goal: <goal>\nYour role: <role>\nStart by reading the shared task list (team_tasks list) and tell the coordinator your plan with team_send.`
  - Creates the team, starts the poller.
  - Returns the team id and a member table (`role  host  taskId  preset`).
- `ladvin_team_send({to, text, files?})`:
  - `to` is a member role, a taskId, or `"all"`. Unknown → error listing the roles.
  - Files are uploaded to `<cwd>/.ladvin/shared/<basename>` (size cap checked locally) and listed in the text.
  - Calls `team.send {taskId, text, from: "local"}`.
- `ladvin_team_inbox({wait_seconds?})` (max 300). If nothing is unread, it polls the store every 250 ms until `wait_seconds` elapses. It returns `renderInbox(unread)` and marks those entries read, or `No new messages.`.
- `ladvin_team_tasks({op: "list"|"add"|"update", title?, id?, status?, owner?, note?})`. Ops are applied locally with `applyOp` (`by: "local"`) and synced to every member host. Returns the rendered list (`k1 [doing] title (owner) — note`).
- `ladvin_team_end({summary?})`:
  - Sends every member `Wrap up now: send your final notes with team_send, then stop.`
  - Waits up to 60 s (env `LADVIN_TEAM_END_WAIT_MS`) until every member is `idle` or finished.
  - Runs `pollOnce`, then `team.stop` on each member, then marks the team ended and stops the poller.
  - Returns the final unread inbox.
- `ladvin_team_resume({})`:
  - For the most recent team of this project (active, or ended within 24 h if none is active): reconnects, starts the poller, runs `pollOnce`.
  - For members that are `done` with `failReason` starting `stopped:`, sends `team.send` "The coordinator is back; continue." (this resumes them per Task 2).
  - Reports member states and the unread count.
- [ ] **Step 1: Failing tests** (pattern of `delegate.test.ts`: `localTransport`, fake claude through `agentd.json` `claudeArgs`, scripts via env `FAKE_CLAUDE_SCRIPT`):
  - team_start with one member whose first turn calls `team_send {text:"plan: watch iostat"}` → `ladvin_team_inbox({wait_seconds: 10})` contains `plan: watch iostat`, a `[HH:MM:SS.` timestamp and the envelope.
  - `ladvin_team_send({to: "observer-role", text: "load step 1 at 500 rps"})` → the member's `respond` calls `team_send "ack $INPUT"` → inbox shows `ack` and `500 rps`.
  - the member's `respond` step `share_file out.log` after writing it → inbox shows `shared file out.log`, and the local file `<project>/.ladvin/shared/<teamId>/out.log` has the same bytes.
  - `ladvin_team_send` with `files` → the member's respond `ifExists .ladvin/shared/<name>` → team_send `saw file`.
  - `ladvin_team_tasks add` → the remote mirror `<remoteHome>/.ladvin/teams/<teamId>/tasks.json` has the task within 3 s. A member `team_tasks add` → `ladvin_team_tasks list` shows it within 3 s.
  - a second `ladvin_team_start` while active → error `already active`.
  - `ladvin_team_end` → members are `done` (`team ended`), the final note sent during wrap-up is returned, and `ladvin_team_start` works again afterwards.
  - **Review Focus 1:** with the hub closed (`pool.closeAll()` and poller stopped), the member sends via a timed script step (`{sleepMs: 1500}` then team_send `while you were away`). A new hub then calls `ladvin_team_resume` → `ladvin_team_inbox` contains `while you were away`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test packages` — expect PASS.
- [ ] **Step 5: Commit** — `feat(hub): team tools — start, send, inbox, tasks, end, resume`

---

### Task 6: Hooks

**Files:** Create `packages/hub/src/hook.ts` and `hooks/hooks.json`. Modify the root `package.json` (`build:hub` also builds `dist/ladvin-hook.js`). Test: `packages/hub/test/hook.test.ts`.

**Interfaces — Produces:**
- `runHook(event: "post" | "stop", input: {cwd?: string; stop_hook_active?: boolean}, env: {CLAUDE_PROJECT_DIR?: string}): string /* stdout, "" = no output */`. It finds the project dir, then the active team, then unread entries.
  - `post`: unread → `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"ladvin team: N new message(s)\n<renderInbox>"}}`, and marks them read.
  - `stop`: unread → `{"decision":"block","reason":"ladvin team: N unread message(s) from teammates — read and respond before stopping:\n<renderInbox>"}`, and marks them read. No unread (whether or not `stop_hook_active`) → `""`.
  - No active team → `""`. Any exception → `""` (a hook must never break the session).
- `hooks/hooks.json`: PostToolUse (matcher `*`) and Stop, each running `node "${CLAUDE_PLUGIN_ROOT}/dist/ladvin-hook.js" post|stop` with timeout 10.
- [ ] **Step 1: Failing tests:** use a temp `LADVIN_HOME` and a TeamStore with an active team and 2 unread entries.
  - `post` → JSON with `additionalContext` containing both texts; then `unread` is empty.
  - **Review Focus 2:** `stop` with unread → `decision: "block"`. Calling `stop` again (with `stop_hook_active: true`) → `""`.
  - no active team → `""`.
  - corrupt `team.json` → `""`.
  - **bundle:** after `bun run build:hub`, `node dist/ladvin-hook.js stop` with stdin `{"cwd":"<proj>"}` and env `CLAUDE_PROJECT_DIR=<proj>` prints the block JSON.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** `hook.ts`. Its `main` reads stdin JSON, calls `runHook`, prints the result and always exits 0.
- [ ] **Step 4: Run** `bun test packages` plus `claude plugin validate .` — expect PASS, no errors.
- [ ] **Step 5: Commit** — `feat: PostToolUse/Stop hooks surface teammate messages`

---

### Task 7: Skill, e2e over ssh, real run

**Files:** Modify `skills/ladvin/SKILL.md`, `test/e2e/e2e.test.ts`, `README.md` (status line plus a team example), `docs/spikes.md` (real-run notes).

- [ ] **Step 1: Skill.** Add a "Team mode" section covering:
  - when to team up vs delegate (live back-and-forth, correlating observations across machines);
  - agree on a plan in `ladvin_team_tasks` first;
  - timestamp observations; at sync points use `ladvin_team_inbox(wait_seconds)`;
  - teammates only see what you `ladvin_team_send`, and you only see their `team_send`;
  - end with `ladvin_team_end`;
  - the performance-hunt example from spec §2.
- [ ] **Step 2: e2e.** Add a test: team_start on the docker host (fake teammate script via `~/.fake-claude-script.json`, using `respond`) → inbox receives the plan → team_send → inbox receives the ack → teammate share_file → the file arrives through real scp → team_end. Run `bun run test:e2e` — expect PASS.
- [ ] **Step 3: Rebuild bundles** and run `bun test packages/hub/test/bundle.test.ts`, updating its expected tool list with the six team tools. Expect PASS.
- [ ] **Step 4: Real run on kata54** with real `claude` (`--plugin-dir`, coordinator in `-p` mode). kata54 is a shared server, so generate no load.
  - team_start with one `observer` member on kata54, goal "send `uptime` twice, about 5 s apart, each with its timestamp";
  - the coordinator sends one question mid-run ("what is the disk usage of / ?"), waits on the inbox for the answer, then ends the team.
  Record in `docs/spikes.md`: the round-trip latency, whether the normalized timestamps are sane, and whether the mid-turn question was answered.
- [ ] **Step 5: Commit** — `feat: team mode docs, e2e, real run notes`
