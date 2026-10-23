import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Preset, TeamTask, TeamTaskOp } from "@ladvin/protocol";
import { projectStateDir } from "../state";

export type TeamMember = { taskId: string; host: string; role: string; preset: Preset; cwd: string };
export type Team = {
  teamId: string;
  goal: string;
  members: TeamMember[];
  tasks: TeamTask[];
  status: "active" | "ended";
  createdAt: string;
  endedAt?: string;
};
// `at` is hub time (ISO), already normalised from the sender's clock.
export type InboxEntry = { id: string; at: string; role: string; host: string; taskId: string; text: string };

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

// Local team state under ~/.ladvin/state/<project>/: teams/<id>/{team.json, inbox.jsonl, read-cursor} + active-team.
// Hooks read the same files, so nothing here may live only in memory.
export class TeamStore {
  private root: string;
  constructor(projectDir: string) {
    this.root = projectStateDir(projectDir);
  }

  private dir(teamId: string): string {
    return join(this.root, "teams", teamId);
  }
  private activeFile = () => join(this.root, "active-team");

  get(teamId: string): Team | undefined {
    const f = join(this.dir(teamId), "team.json");
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Team) : undefined;
  }

  active(): Team | undefined {
    if (!existsSync(this.activeFile())) return undefined;
    const t = this.get(readFileSync(this.activeFile(), "utf8").trim());
    return t?.status === "active" ? t : undefined;
  }

  // The active team, or else the most recently ended one (for resume).
  latest(): Team | undefined {
    if (!existsSync(this.activeFile())) return undefined;
    return this.get(readFileSync(this.activeFile(), "utf8").trim());
  }

  create(goal: string, members: TeamMember[]): Team {
    const cur = this.active();
    if (cur) throw new Error(`a team is already active in this project (${cur.teamId})`);
    const team: Team = {
      teamId: `team_${randomBytes(4).toString("hex")}`,
      goal,
      members,
      tasks: [],
      status: "active",
      createdAt: new Date().toISOString(),
    };
    mkdirSync(this.dir(team.teamId), { recursive: true });
    this.save(team);
    writeFileSync(this.activeFile(), team.teamId);
    return team;
  }

  save(team: Team): void {
    mkdirSync(this.dir(team.teamId), { recursive: true });
    writeJson(join(this.dir(team.teamId), "team.json"), team);
  }

  end(teamId: string): void {
    const t = this.get(teamId);
    if (t) this.save({ ...t, status: "ended", endedAt: new Date().toISOString() });
  }

  all(teamId: string): InboxEntry[] {
    const f = join(this.dir(teamId), "inbox.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as InboxEntry);
  }

  has(teamId: string, id: string): boolean {
    return this.all(teamId).some((e) => e.id === id);
  }

  appendInbox(teamId: string, e: InboxEntry): boolean {
    if (this.has(teamId, e.id)) return false;
    mkdirSync(this.dir(teamId), { recursive: true });
    appendFileSync(join(this.dir(teamId), "inbox.jsonl"), JSON.stringify(e) + "\n");
    return true;
  }

  private cursor(teamId: string): number {
    const f = join(this.dir(teamId), "read-cursor");
    return existsSync(f) ? Number(readFileSync(f, "utf8")) || 0 : 0;
  }

  unread(teamId: string): InboxEntry[] {
    return this.all(teamId).slice(this.cursor(teamId));
  }

  markRead(teamId: string, count?: number): void {
    const n = count === undefined ? this.all(teamId).length : this.cursor(teamId) + count;
    writeFileSync(join(this.dir(teamId), "read-cursor"), String(n));
  }
}

export function applyOp(tasks: TeamTask[], op: TeamTaskOp, _by: string): TeamTask[] {
  if (op.op === "add") {
    const n = tasks.reduce((m, t) => Math.max(m, Number(t.id.replace(/^k/, "")) || 0), 0) + 1;
    return [...tasks, { id: `k${n}`, title: op.title, status: "todo", ...(op.owner ? { owner: op.owner } : {}) }];
  }
  return tasks.map((t) =>
    t.id !== op.id
      ? t
      : { ...t, ...(op.status ? { status: op.status } : {}), ...(op.owner ? { owner: op.owner } : {}), ...(op.note ? { note: op.note } : {}) },
  );
}

export function describeOp(op: TeamTaskOp, tasks: TeamTask[]): string {
  if (op.op === "add") return `added ${tasks.at(-1)?.id ?? "?"} ${op.title}`;
  const parts = [op.status && `status ${op.status}`, op.owner && `owner ${op.owner}`, op.note && `note "${op.note}"`].filter(Boolean);
  return `updated ${op.id}: ${parts.join(", ")}`;
}

export function renderTasks(tasks: TeamTask[]): string {
  return tasks.length
    ? tasks.map((t) => `${t.id} [${t.status}] ${t.title}${t.owner ? ` (${t.owner})` : ""}${t.note ? ` — ${t.note}` : ""}`).join("\n")
    : "The task list is empty.";
}
