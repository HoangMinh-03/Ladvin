import { spawn } from "node:child_process";

// Live view of a remote agent (spec §13): its tmux session ladvin-<task>, opened in the user's terminal.

export function sshAttachArgv(alias: string, taskId: string): string[] {
  const cfg = process.env.LADVIN_SSH_CONFIG ? ["-F", process.env.LADVIN_SSH_CONFIG] : [];
  return ["ssh", ...cfg, "-t", alias, `tmux attach -t ladvin-${taskId}`];
}

export type AttachPlan = { kind: "spawn"; command: string; args: string[] } | { kind: "print"; command: string };

const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const shellJoin = (argv: string[]) => argv.map(shq).join(" ");
const appleString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function attachPlan(env: Record<string, string | undefined>, platform: NodeJS.Platform, argv: string[]): AttachPlan {
  const forced = env.LADVIN_TERMINAL;
  const pick = forced ?? (env.WEZTERM_PANE ? "wezterm" : env.TMUX ? "tmux" : platform === "darwin" ? "terminal" : "print");
  switch (pick) {
    case "wezterm":
      return { kind: "spawn", command: "wezterm", args: ["cli", "split-pane", "--", ...argv] };
    case "tmux":
      return { kind: "spawn", command: "tmux", args: ["split-window", shellJoin(argv)] };
    case "terminal":
      return {
        kind: "spawn",
        command: "osascript",
        args: ["-e", `tell application "Terminal" to do script ${appleString(shellJoin(argv))}`, "-e", 'tell application "Terminal" to activate'],
      };
    default:
      return { kind: "print", command: shellJoin(argv) };
  }
}

export function runAttach(plan: Extract<AttachPlan, { kind: "spawn" }>): void {
  spawn(plan.command, plan.args, { detached: true, stdio: "ignore", windowsHide: false }).unref();
}
