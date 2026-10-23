# Spike findings (2026-10-23)

Claude Code 2.1.309, Windows 11 local, `--model haiku`. Commands were run from a scratch directory.

## 1. stream-json event shapes

Command: `echo '{"type":"user","message":{"role":"user","content":"say hi in 2 words"}}' | claude -p --input-format stream-json --output-format stream-json --verbose --model haiku --strict-mcp-config`

Events seen, in order: `system/hook_started`, `system/hook_response`, `system/init`, `system/commands_changed`, `assistant`, `rate_limit_event`, `result/success`. Every event carries `session_id`.

Trimmed samples (used as parser fixtures):

```json
{"type":"system","subtype":"init","cwd":"D:\\x","session_id":"4eb81060-480d-46a2-97cf-30837cec85fa","tools":["Bash","Read"]}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi there!"},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":2,"cache_creation_input_tokens":17636,"cache_read_input_tokens":17250,"output_tokens":7}},"session_id":"4eb81060-480d-46a2-97cf-30837cec85fa"}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1792740600,"rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":0.11,"resetsAt":1792740600},"seven_day":{"utilization":0.02,"resetsAt":1793282400}}},"session_id":"4eb81060-480d-46a2-97cf-30837cec85fa"}
{"type":"result","subtype":"success","is_error":false,"result":"Hi there!","session_id":"4eb81060-480d-46a2-97cf-30837cec85fa","num_turns":1,"total_cost_usd":0.0037,"permission_denials":[],"usage":{"input_tokens":2,"cache_creation_input_tokens":17636,"cache_read_input_tokens":17250,"output_tokens":7}}
```

Usage mapping: `input_tokens → input`, `output_tokens → output`, `cache_read_input_tokens → cacheRead`, `cache_creation_input_tokens → cacheWrite`. `result.usage` covers the turn. `result.permission_denials` lists denied tool calls, so reports can show what the preset blocked.

## 2. Input sent while the agent is mid-turn

A Node script started the agent with `--allowedTools Bash`, asked it to run `sleep 20` then say `DONE-ONE`, and sent a second message ("what is 2+2? SECOND=<n>") 6 s later, while the tool was still running.

```
2.5s  tool_use sleep 20
6.0s  second message sent
23.4s tool result
24.4s assistant: "DONE-ONE\n\nSECOND=4"
24.4s result success (one result for both)
90.0s stdin closed → 90.8s exit 0
```

- A message sent mid-turn is **folded into the running turn** at the next model call (after the current tool result). It is not rejected or lost. Both messages got a single `result`.
- After `result`, the process **stays alive** while stdin is open, and exits 0 when stdin closes.

## 3. Resume

`claude -p --resume <session_id> --input-format stream-json --output-format stream-json --verbose` continues the session (the agent quoted its previous reply). The session id is unchanged.

## 4. Account identity

`~/.claude.json` → `oauthAccount` with keys including `accountUuid`, `emailAddress`, `organizationUuid`, `organizationName`, `displayName`. Use `oauthAccount.accountUuid` as the grouping key and `emailAddress` as the label. This is not secret, but tokens are stored elsewhere and must never be read.

## 5. Hook output fields (Plan 2)

From the observed `hook_response` and the hooks docs:
- PostToolUse context: `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"…"}}`
- Stop block: `{"decision":"block","reason":"…"}`. Input includes `stop_hook_active`, which must be respected to avoid loops.
- Hook input includes `session_id` and `cwd`.

Re-check against the docs when building Plan 2.

## Plan deltas

- **Plan 1, runner (Task 4):** confirmed. "Done" closes stdin explicitly, because the process would otherwise wait forever. Follow-ups use `--resume`.
- **Plan 1, parser (Task 3):** `parseEvent` also maps `rate_limit_event` → `{kind:'rateLimit', fiveHour?: {utilization, resetsAt}, sevenDay?: {...}}` and keeps `permissionDenials` from `result`. Recorded as a ruling.
- **Plan 2, team mode:** mid-turn injection works, so a teammate gets local's message within one tool call. No turn-boundary queueing is needed.
- **Plan 3 / spec §10:** `rate_limit_event` exposes **real utilization** of the 5-hour and 7-day windows per account. The burn meter can show true "% of window used" from the most recent event of any agent on that account, instead of only a user-configured budget. Update the spec's honesty rule when Plan 3 starts.
- **Noise:** a remote `claude` loads that host user's hooks, plugins and CLAUDE.md (a SessionStart hook fired here). This is acceptable; it is their environment. ladvin's appended system prompt must still win, which is checked in Task 11.

## First real run (kata54, Ubuntu 22.04 x64, 2026-10-23)

Real Claude Code ran with `--plugin-dir`, and the agentd binary was compiled locally (`LADVIN_AGENTD_BINARY_DIR`).

- **add-host:** `claude` was only on the login-shell PATH (`~/.local/bin`). The probe found it and stored the full login PATH in `agentd.json`. `~/.ladvin` is mode 700. The clock offset was -2 ms.
- **observer task (`t_8caebb0c`):** reported OS release, uptime and the top 5 processes by memory in about 15 s. The agent called `ladvin_report` itself (status `success`, no `reportMissing`), so the presets now allow `mcp__ladvin`. The report arrived wrapped in `<ladvin-remote-content>`. The coordinator used the Sonnet model.
- **worker task (`t_e07408bf`):** wrote `disk.txt`, attached it, and reported. `ladvin_fetch` saved identical bytes to `.ladvin/inbox/t_e07408bf/disk.txt` on Windows. The coordinator used the Haiku model.
- **tmux:** sessions `ladvin-agentd` and `ladvin-<task>` exist on the host. The view closes 10 minutes after the task ends.
- **Surprises:** none blocking. ladvin's appended system prompt held, even though the host user has their own Claude setup.

## First real team run (kata54, 2026-10-23)

Setup: the coordinator was real Claude Code (Sonnet, `-p`, `--plugin-dir`), with one `observer` teammate "sysmon" on kata54. Before the run, add-host upgraded the host's running agentd from 0.1.0 to 0.2.0 in place.

- **Flow:** the teammate posted its plan, two `uptime` reports about 7.7 s apart, an answer to a question sent mid-run (disk usage), and final notes at `ladvin_team_end`. All of them arrived.
- **Latency:** from the teammate's `team_send` to the local inbox took about 2 s (poll interval 1 s plus ssh). Question sent → answer in the inbox took about 5.6 s, including the model's turn.
- **Clock:** the measured offset was -11 ms, so normalisation works.
- **Finding (timezone):** the teammate wrote times on its own clock in the host's timezone (UTC, `06:41:49`). The inbox stamps are local time (UTC+7, `13:41:51`). Clock skew is handled, but the coordinator still has to adjust for the timezone by hand. Next step: tell teammates the coordinator's UTC offset, or ask them to timestamp in UTC, and render the inbox with the offset.
