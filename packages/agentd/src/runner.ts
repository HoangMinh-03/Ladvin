import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_WALL_MS, type Report, type ReportStatus, type Usage, ZERO_USAGE } from "@ladvin/protocol";
import { buildArgs, DELEGATE_SYSTEM_PROMPT, parseEvent, userMessage } from "./claude";
import { taskDir } from "./paths";
import { TEAM_SYSTEM_PROMPT } from "./team-prompt";
import type { TaskStore } from "./store";
import type { Tmux } from "./tmux";

export type RunnerOptions = {
  store: TaskStore;
  hostName: string;
  claudeBin: string;
  claudeBinArgs?: string[];
  agentMcpCommand: (taskId: string) => { command: string; args: string[] };
  viewCommand?: (taskId: string) => string;
  env?: Record<string, string>; // merged into claude's env (add-host stores the login-shell PATH here)
  tmux?: Tmux;
  now?: () => Date;
};

type Live = {
  proc: ChildProcess;
  startedAt: string;
  lastText: string;
  finished: boolean; // done/failed/cancelled already decided for this run
  denials: string[];
  timer: ReturnType<typeof setTimeout>;
  // Usage of the current turn from assistant events (deduped by message id), superseded by `result`.
  turnUsage: Usage;
  seenMessages: Set<string>;
};

const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});
const billable = (u: Usage) => u.input + u.output + u.cacheWrite;

export class Runner {
  private live = new Map<string, Live>();
  constructor(private o: RunnerOptions) {}

  private now(): string {
    return (this.o.now?.() ?? new Date()).toISOString();
  }

  running(): string[] {
    return [...this.live].filter(([, l]) => !l.finished).map(([id]) => id);
  }

  start(taskId: string, prompt: string): void {
    this.o.store.update(taskId, { prompt, startedAt: this.now(), runs: 1 });
    this.spawnRun(taskId, prompt);
    this.o.tmux?.openView(taskId, this.o.viewCommand?.(taskId) ?? "");
  }

  async followup(taskId: string, text: string): Promise<void> {
    if (!this.o.store.get(taskId)) throw new Error(`unknown task ${taskId}`);
    const prev = this.live.get(taskId);
    if (prev && !prev.finished) throw new Error(`task ${taskId} is still running`);
    // Previous run decided but its process is still exiting: resume once it is gone.
    if (prev) await new Promise((r) => prev.proc.once("exit", r));
    if (this.live.has(taskId)) throw new Error(`task ${taskId} is still running`);
    const t = this.o.store.get(taskId)!;
    if (!t.sessionId) throw new Error(`task ${taskId} has no session to resume`);
    this.o.store.archiveReport(taskId, t.runs);
    this.o.store.update(taskId, { runs: t.runs + 1, failReason: undefined, endedAt: undefined });
    this.spawnRun(taskId, text, t.sessionId);
  }

  cancel(taskId: string, reason = "cancelled"): void {
    const l = this.live.get(taskId);
    if (!l) return;
    this.finish(taskId, reason === "cancelled" ? { state: "cancelled" } : { state: "failed", failReason: reason });
    l.proc.kill();
  }

  // Cancels every live run and resolves once all claude processes have exited.
  async stopAll(reason = "cancelled"): Promise<void> {
    const exits = [...this.live.values()].map((l) => new Promise((r) => l.proc.once("exit", r)));
    for (const id of [...this.live.keys()]) this.cancel(id, reason);
    for (const l of this.live.values()) l.proc.kill();
    await Promise.all(exits);
  }

  // Team mode: deliver a message to a member. A live member gets it on stdin (folded into its current turn
  // if busy); a stopped member with a session is resumed with it.
  async inject(taskId: string, text: string): Promise<void> {
    const l = this.live.get(taskId);
    if (l && !l.finished) {
      l.proc.stdin!.write(userMessage(text));
      this.o.store.update(taskId, { state: "running" });
      return;
    }
    const t = this.o.store.get(taskId);
    if (!t) throw new Error(`unknown task ${taskId}`);
    // Only members that went away on their own (idle timeout, dead agentd) may be woken by a message.
    // A cancel (stop_all) or a hit limit must stick.
    const resumable = t.state === "idle" || t.failReason?.startsWith("stopped:") || t.failReason === "agentd restarted";
    if (!resumable) throw new Error(`task ${taskId} is ${t.state}${t.failReason ? ` (${t.failReason})` : ""} and cannot be resumed`);
    if (!t.sessionId) throw new Error(`task ${taskId} has no session to resume`);
    await this.followup(taskId, text);
  }

  // Graceful end of a live run: close stdin and let claude exit.
  stop(taskId: string, reason: string): void {
    if (!this.live.has(taskId)) return;
    this.finish(taskId, { state: "done", failReason: reason, report: { summary: reason, status: "success", reportMissing: false } });
  }

  // Stops idle team members whose coordinator has not been in touch for idleMs (spec §6.2).
  sweepIdle(now: number, lastHubContact: (teamId: string) => number, idleMs: number): string[] {
    const stopped: string[] = [];
    for (const id of this.running()) {
      const t = this.o.store.get(id);
      if (t?.kind !== "team" || t.state !== "idle" || !t.team) continue;
      if (now - lastHubContact(t.team.teamId) <= idleMs) continue;
      this.stop(id, "stopped: idle timeout (resumable)");
      stopped.push(id);
    }
    return stopped;
  }

  onAgentReport(taskId: string, r: { summary: string; status: ReportStatus; details?: string }): void {
    if (!this.live.has(taskId)) return;
    this.finish(taskId, { state: "done", report: { ...r, reportMissing: false } });
  }

  private spawnRun(taskId: string, text: string, resumeSessionId?: string): void {
    const t = this.o.store.get(taskId)!;
    const mcpConfigPath = join(taskDir(taskId), "mcp.json");
    const mcp = this.o.agentMcpCommand(taskId);
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({ mcpServers: { ladvin: { command: mcp.command, args: mcp.args, env: { LADVIN_HOME: process.env.LADVIN_HOME ?? "" } } } }),
    );
    const args = buildArgs({ preset: t.preset, cwd: t.cwd, mcpConfigPath, systemPrompt: t.kind === "team" && t.team ? TEAM_SYSTEM_PROMPT(t.team.role) : DELEGATE_SYSTEM_PROMPT, resumeSessionId });
    const proc = spawn(this.o.claudeBin, [...(this.o.claudeBinArgs ?? []), ...args], {
      cwd: t.cwd,
      env: { ...process.env, ...this.o.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const wallMs = t.limits?.wallMs ?? DEFAULT_WALL_MS;
    const live: Live = {
      proc,
      startedAt: this.now(),
      lastText: "",
      finished: false,
      denials: [],
      timer: setTimeout(() => this.cancel(taskId, "limit: wall"), wallMs),
      turnUsage: { ...ZERO_USAGE },
      seenMessages: new Set(),
    };
    // Spawn failures (moved claude binary, deleted cwd) emit "error" and may never emit "exit".
    proc.on("error", (e) => {
      if (!live.finished) this.finish(taskId, { state: "failed", failReason: `cannot start claude: ${e.message}` });
      if (this.live.get(taskId) === live) this.live.delete(taskId);
    });
    this.live.set(taskId, live);
    this.o.store.update(taskId, { state: "running" });

    let buf = "";
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) this.onLine(taskId, live, line);
      }
    });
    proc.stderr!.on("data", () => {});
    proc.stdin!.on("error", () => {});
    proc.on("exit", (code) => this.onExit(taskId, live, code));
    proc.stdin!.write(userMessage(text));
  }

  private onLine(taskId: string, live: Live, line: string): void {
    this.o.store.appendStream(taskId, line);
    const ev = parseEvent(line);
    if (!ev) return;
    if (ev.kind === "init") this.o.store.update(taskId, { sessionId: ev.sessionId });
    else if (ev.kind === "assistant") {
      if (ev.text) live.lastText = ev.text;
      const activity = ev.toolUses.at(-1) ?? ev.text.split("\n")[0];
      if (activity) this.o.store.update(taskId, { lastActivity: activity.slice(0, 200) });
      // A delegated task is often one long turn: enforce max tokens as usage streams in, not only at `result`.
      if (ev.usage && ev.id && !live.seenMessages.has(ev.id)) {
        live.seenMessages.add(ev.id);
        live.turnUsage = addUsage(live.turnUsage, ev.usage);
        const t = this.o.store.get(taskId)!;
        if (t.limits?.maxTokens && billable(addUsage(t.usage, live.turnUsage)) > t.limits.maxTokens) this.cancel(taskId, "limit: tokens");
      }
    } else if (ev.kind === "result") {
      live.turnUsage = { ...ZERO_USAGE };
      live.seenMessages.clear();
      const t = this.o.store.get(taskId)!;
      const usage = addUsage(t.usage, ev.usage);
      this.o.store.update(taskId, { usage });
      live.denials.push(...ev.permissionDenials);
      const report = this.o.store.getReport(taskId);
      if (report && live.finished) this.o.store.setReport(taskId, { ...report, usage, permissionDenials: live.denials });
      if (t.limits?.maxTokens && billable(usage) > t.limits.maxTokens) {
        this.cancel(taskId, "limit: tokens");
        return;
      }
      // A team member stays alive between turns, waiting for the next message.
      if (t.kind === "team") {
        if (!live.finished) this.o.store.update(taskId, { state: "idle" });
        return;
      }
      if (!live.finished) {
        this.finish(taskId, {
          state: ev.isError ? "failed" : "done",
          failReason: ev.isError ? "claude reported an error" : undefined,
          report: {
            summary: ev.text || live.lastText,
            status: ev.isError ? "failed" : "partial",
            reportMissing: true,
          },
        });
      }
    }
  }

  private finish(
    taskId: string,
    f: {
      state: "done" | "failed" | "cancelled";
      failReason?: string;
      report?: { summary: string; status: ReportStatus; details?: string; reportMissing: boolean };
    },
  ): void {
    const live = this.live.get(taskId);
    if (!live || live.finished) return;
    live.finished = true;
    clearTimeout(live.timer);
    const endedAt = this.now();
    const t = this.o.store.update(taskId, { state: f.state, failReason: f.failReason, endedAt });
    const r = f.report ?? {
      summary: f.failReason ?? f.state,
      status: "failed" as const,
      reportMissing: true,
    };
    const report: Report = {
      taskId,
      host: this.o.hostName,
      status: r.status,
      summary: r.summary,
      details: r.details,
      artifacts: this.o.store.artifacts(taskId),
      usage: t.usage ?? { ...ZERO_USAGE },
      startedAt: live.startedAt,
      endedAt,
      reportMissing: r.reportMissing,
      permissionDenials: live.denials,
    };
    this.o.store.setReport(taskId, report);
    live.proc.stdin?.end();
  }

  private onExit(taskId: string, live: Live, code: number | null): void {
    if (!live.finished) this.finish(taskId, { state: "failed", failReason: `claude exited with code ${code}` });
    this.live.delete(taskId);
  }
}
