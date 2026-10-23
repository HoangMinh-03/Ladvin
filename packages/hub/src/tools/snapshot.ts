import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Owner, TaskInfo, TeamTask } from "@ladvin/protocol";
import { liveWindow, readBurnCache } from "../burn/aggregate";
import { loadHosts } from "../state";
import type { TeamStore } from "../team/store";
import { guarded, ok, taskLocator } from "./delegate";

// Compact JSON state for the ladvin panel mod (a UI, not the conversation). Reads local state and this
// project's tasks only; never marks team messages read and never refreshes the burn meter.
export type Snapshot = {
  at: string;
  hosts: { alias: string; account?: string; reachable: boolean }[];
  tasks: {
    taskId: string;
    host: string;
    state: TaskInfo["state"];
    kind: "delegate" | "team";
    preset: TaskInfo["preset"];
    role?: string;
    elapsedMs?: number;
    tokensIn: number;
    tokensOut: number;
    lastActivity?: string;
    failReason?: string;
  }[];
  team: null | {
    teamId: string;
    goal: string;
    members: { role: string; host: string; taskId: string }[];
    tasks: TeamTask[];
    unread: number;
    recent: { at: string; role: string; host: string; text: string }[];
  };
  burn: { label: string; hosts: string[]; fiveHourPct?: number; sevenDayPct?: number; running: number; over: string[] }[];
};

type SnapshotPool = Parameters<typeof taskLocator>[0]["pool"];

export function registerSnapshotTool(server: McpServer, ctx: { owner: Owner; pool: SnapshotPool; store: TeamStore }): void {
  const loc = taskLocator(ctx);
  server.registerTool(
    "ladvin_snapshot",
    {
      description: "Machine-readable ladvin state for the ladvin panel UI. Not needed in conversation; use ladvin_status, ladvin_team_inbox or ladvin_burn instead.",
      inputSchema: {},
    },
    guarded(async () => {
      const now = Date.now();
      const burnRows = (readBurnCache(10 * 60_000) ?? []).filter((r) => r.key !== "unreachable");
      const tasksByHost = new Map<string, TaskInfo[]>();
      for (const { host, task } of await loc.projectTasks()) tasksByHost.set(host, [...(tasksByHost.get(host) ?? []), task]);
      const hosts = loadHosts().map((h) => {
        const account = burnRows.find((r) => r.hosts.includes(h.alias))?.label;
        const reachable = !!ctx.pool.get(h.alias).info;
        return { alias: h.alias, ...(account ? { account } : {}), reachable };
      });
      const tasks: Snapshot["tasks"] = [];
      for (const [host, list] of tasksByHost)
        for (const t of list)
          tasks.push({
            taskId: t.taskId,
            host,
            state: t.state,
            kind: t.kind ?? "delegate",
            preset: t.preset,
            ...(t.team ? { role: t.team.role } : {}),
            ...(t.startedAt ? { elapsedMs: (t.endedAt ? Date.parse(t.endedAt) : now) - Date.parse(t.startedAt) } : {}),
            tokensIn: t.usage.input,
            tokensOut: t.usage.output,
            ...(t.lastActivity ? { lastActivity: t.lastActivity } : {}),
            ...(t.failReason ? { failReason: t.failReason } : {}),
          });
      const active = ctx.store.active();
      const team: Snapshot["team"] = active
        ? {
            teamId: active.teamId,
            goal: active.goal,
            members: active.members.map((m) => ({ role: m.role, host: m.host, taskId: m.taskId })),
            tasks: active.tasks,
            unread: ctx.store.unread(active.teamId).length,
            recent: ctx.store
              .all(active.teamId)
              .slice(-8)
              .map((e) => ({ at: e.at, role: e.role, host: e.host, text: e.text })),
          }
        : null;
      const pct = (w?: { utilization: number; resetsAt: number }) => {
        const l = liveWindow(w);
        return l ? Math.round(l.utilization * 100) : undefined;
      };
      const burn = burnRows.map((r) => {
        const five = pct(r.fiveHour);
        const seven = pct(r.sevenDay);
        return {
          label: r.label,
          hosts: r.hosts,
          ...(five !== undefined ? { fiveHourPct: five } : {}),
          ...(seven !== undefined ? { sevenDayPct: seven } : {}),
          running: r.agentsRunning,
          over: r.over,
        };
      });
      const snap: Snapshot = { at: new Date(now).toISOString(), hosts, tasks, team, burn };
      return ok(JSON.stringify(snap));
    }),
  );
}
