import { appendFileSync, mkdirSync } from "node:fs";
import { basename, join, posix } from "node:path";
import type { OutMsg, Owner, TeamPullResult } from "@ladvin/protocol";
import type { ConnectInfo } from "../connection";
import { ensureGitignore } from "../state";
import type { Transport } from "../transport";
import { applyOp, describeOp, type Team, type TeamStore } from "./store";
import { toLocal } from "./time";

export type PoolLike = {
  get(alias: string): { info: ConnectInfo | null; call<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> };
  transport(alias: string): Pick<Transport, "download">;
};

// Pulls the agentd outboxes of the active team's hosts into the local inbox, then acks (at-least-once; the inbox dedupes).
export class TeamPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(
    private o: { store: TeamStore; pool: PoolLike; owner: Owner; projectDir: string; intervalMs?: number },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollOnce().catch(() => {}), this.o.intervalMs ?? 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  running(): boolean {
    return !!this.timer;
  }

  async pollOnce(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      const team = this.o.store.latest();
      if (!team) return 0;
      let added = 0;
      for (const host of [...new Set(team.members.map((m) => m.host))]) {
        try {
          added += await this.pollHost(team.teamId, host);
        } catch {
          // one unreachable host must not stop the others
        }
      }
      return added;
    } finally {
      this.busy = false;
    }
  }

  private async pollHost(teamId: string, host: string): Promise<number> {
    const conn = this.o.pool.get(host);
    const { messages } = await conn.call<TeamPullResult>("team.pull", { owner: this.o.owner });
    const offset = conn.info?.clockOffsetMs ?? 0;
    const done: string[] = [];
    let added = 0;
    for (const m of messages.filter((x) => x.teamId === teamId)) {
      if (!this.o.store.has(teamId, m.id)) {
        const text = await this.handle(teamId, host, m);
        if (this.o.store.appendInbox(teamId, { id: m.id, at: toLocal(m.sentAt, offset).toISOString(), role: m.role, host, taskId: m.taskId, text }))
          added++;
      }
      done.push(m.id);
    }
    if (done.length) await conn.call("team.ack", { ids: done });
    return added;
  }

  private async handle(teamId: string, host: string, m: OutMsg): Promise<string> {
    if (m.kind === "message") return m.text;
    const team = this.o.store.get(teamId) as Team;
    if (m.kind === "file") {
      const member = team.members.find((x) => x.taskId === m.taskId);
      const dir = join(this.o.projectDir, ".ladvin", "shared", teamId);
      mkdirSync(dir, { recursive: true });
      const local = join(dir, basename(m.name));
      await this.o.pool.transport(host).download(posix.join((member?.cwd ?? "").replace(/\\/g, "/"), m.path), local);
      appendFileSync(
        join(dir, "manifest.jsonl"),
        JSON.stringify({ name: m.name, from: `${m.role}@${host}`, size: m.size, sha256: m.sha256, note: m.note, time: new Date().toISOString() }) + "\n",
      );
      ensureGitignore(this.o.projectDir);
      return `shared file ${m.name} (${m.size} bytes) → ${local}${m.note ? ` — ${m.note}` : ""}`;
    }
    const tasks = applyOp(team.tasks, m.op, m.role);
    this.o.store.save({ ...team, tasks });
    await syncTasks(this.o.pool, team, tasks);
    return `task list: ${describeOp(m.op, tasks)}`;
  }
}

export async function syncTasks(pool: PoolLike, team: Team, tasks: Team["tasks"]): Promise<void> {
  await Promise.allSettled(
    [...new Set(team.members.map((m) => m.host))].map((h) => pool.get(h).call("team.syncTasks", { teamId: team.teamId, tasks })),
  );
}
