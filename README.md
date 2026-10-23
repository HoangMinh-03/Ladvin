# ladvin: lazy dev plugin

ladvin lets the Claude Code session on your machine **delegate work to Claude Code agents on your SSH servers**. Status, reports and files come back to your local session. Everything runs over your existing SSH: no open ports, no relay.

> Status: early (v0.1). Delegate and team modes work. The burn meter and terminal attach are next.

## Requirements

- **Local:** Claude Code, OpenSSH (`ssh`, `scp`), Node.js ≥ 20. Windows, macOS and Linux all work.
- **Each host:** Linux or macOS (x64/arm64), key-based SSH (an alias in `~/.ssh/config`), `tmux`, and `claude` installed and logged in.

## Install

```
/plugin marketplace add <owner>/ladvin
/plugin install ladvin@ladvin
```

## Use

```
/ladvin:add-host my-server          # checks claude/tmux, installs the small ladvin-agentd daemon
```

Then just ask, for example: *"delegate to my-server: find why the nightly job is slow, attach the relevant logs"*. Claude uses `ladvin_delegate`, checks `ladvin_status`, reads `ladvin_report`, and pulls files with `ladvin_fetch` into `.ladvin/inbox/`.

- `/ladvin:hosts` shows host health and running agents.
- `/ladvin:stop-all` cancels every running agent on every host (kill switch).
- Presets: `observer` (read-only commands), `worker` (default) and `yolo` (no permission checks). Each host has a maximum, chosen at add-host.

**Team mode.** Ask, for example: *"start a team with an observer on my-server; I'll run the load test here and you correlate with what the server sees"*. Claude uses `ladvin_team_start`, exchanges messages with `ladvin_team_send` and `ladvin_team_inbox`, shares a task list and files, and wraps up with `ladvin_team_end`.

To watch an agent live, run `ssh -t my-server tmux attach -t ladvin-<task_id>`.

## Design

See [docs/superpowers/specs/2026-10-23-ladvin-design.md](docs/superpowers/specs/2026-10-23-ladvin-design.md).

## License

MIT
