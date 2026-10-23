import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join, posix } from "node:path";
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

const LOCK_STALE_MS = 5000;

// A name that is valid on Windows, macOS and Linux and cannot escape the shared directory.
export function safeName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/, "")
    .replace(/^\.+/, "_");
  return cleaned || "file";
}

function uniquePath(dir: string, name: string): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let p = join(dir, name);
  for (let i = 1; existsSync(p); i++) p = join(dir, `${stem}-${i}${ext}`);
  return p;
}

// Pulls the agentd outboxes of the active team's hosts into the local inbox, then acks (at-least-once; the inbox dedupes).
// One poller per project directory holds a lock file; other sessions stand by and read the same on-disk inbox.
export class TeamPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<number> = Promise.resolve(0);
  private token = randomBytes(8).toString("hex");

  constructor(private o: { store: TeamStore; pool: PoolLike; owner: Owner; projectDir: string; intervalMs?: number }) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollOnce().catch(() => {}), this.o.intervalMs ?? 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.releaseLock();
  }

  running(): boolean {
    return !!this.timer;
  }

  // A call made while another poll is in flight waits for it and then polls again, so nothing in transit is missed.
  pollOnce(): Promise<number> {
    this.chain = this.chain.catch(() => 0).then(() => this.poll());
    return this.chain;
  }

  private tryLock(): boolean {
    const f = this.o.store.lockFile();
    try {
      const cur = JSON.parse(readFileSync(f, "utf8")) as { token: string; at: number };
      if (cur.token !== this.token && Date.now() - cur.at < LOCK_STALE_MS) return false;
    } catch {
      // no lock, or unreadable: take it
    }
    const tmp = `${f}.${this.token}.tmp`;
    writeFileSync(tmp, JSON.stringify({ token: this.token, pid: process.pid, at: Date.now() }));
    renameSync(tmp, f);
    return true;
  }

  private releaseLock(): void {
    const f = this.o.store.lockFile();
    try {
      if ((JSON.parse(readFileSync(f, "utf8")) as { token: string }).token === this.token) unlinkSync(f);
    } catch {}
  }

  private async poll(): Promise<number> {
    const team = this.o.store.latest();
    if (!team || !this.tryLock()) return 0;
    let added = 0;
    for (const host of [...new Set(team.members.map((m) => m.host))]) {
      try {
        added += await this.pollHost(team.teamId, host);
      } catch {
        // one unreachable host must not stop the others
      }
    }
    return added;
  }

  private async pollHost(teamId: string, host: string): Promise<number> {
    const conn = this.o.pool.get(host);
    const { messages } = await conn.call<TeamPullResult>("team.pull", { owner: this.o.owner });
    const offset = conn.info?.clockOffsetMs ?? 0;
    const done: string[] = [];
    let added = 0;
    for (const m of messages) {
      // Entries of other (ended) teams are dropped: acked without delivery.
      if (m.teamId === teamId && !this.o.store.has(teamId, m.id)) {
        let text: string;
        try {
          text = await this.handle(teamId, host, m);
        } catch (e) {
          // A failed entry is reported and acked; it must never block the messages behind it.
          const what = m.kind === "file" ? `could not fetch shared file ${m.name}` : `could not apply ${m.kind}`;
          text = `${what}: ${e instanceof Error ? e.message : e}`;
        }
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
      const local = uniquePath(dir, safeName(m.name));
      const remote = m.staged ?? posix.join((member?.cwd ?? "").replace(/\\/g, "/"), m.path);
      await this.o.pool.transport(host).download(remote, local);
      const got = createHash("sha256").update(readFileSync(local)).digest("hex");
      if (got !== m.sha256) {
        unlinkSync(local);
        throw new Error("checksum mismatch, file discarded");
      }
      appendFileSync(
        join(dir, "manifest.jsonl"),
        JSON.stringify({ name: m.name, file: local, from: `${m.role}@${host}`, size: m.size, sha256: m.sha256, note: m.note, time: new Date().toISOString() }) + "\n",
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
