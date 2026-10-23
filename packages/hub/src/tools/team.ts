import { existsSync, statSync } from "node:fs";
import { basename, posix } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_WALL_MS, type Owner, PRESET_RANK, Preset, type TaskInfo, TeamTaskStatus } from "@ladvin/protocol";
import { z } from "zod";
import type { ConnectionPool } from "../connection";
import { loadHosts } from "../state";
import { syncTasks, type TeamPoller } from "../team/poller";
import { applyOp, renderTasks, type Team, type TeamMember, type TeamStore } from "../team/store";
import { renderInbox } from "../team/time";
import { guarded, ok, ToolError } from "./delegate";

const DEFAULT_MAX_SHARE_BYTES = 200 * 1024 * 1024;
const MAX_WAIT_SECONDS = 300;
const TERMINAL = new Set(["done", "failed", "cancelled"]);

export type TeamCtx = {
  owner: Owner;
  pool: ConnectionPool;
  store: TeamStore;
  poller: TeamPoller;
  budgetGuard?: (alias: string) => Promise<string | null>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function registerTeamTools(server: McpServer, ctx: TeamCtx): void {
  const { owner, pool, store, poller } = ctx;

  const active = (): Team => {
    const t = store.active();
    if (!t) throw new ToolError("No active team in this project. Start one with ladvin_team_start.");
    return t;
  };

  const recipients = (team: Team, to: string): TeamMember[] => {
    if (to === "all") return team.members;
    const hit = team.members.filter((m) => m.role === to || m.taskId === to);
    if (!hit.length) throw new ToolError(`No teammate "${to}". Members: ${team.members.map((m) => m.role).join(", ")} (or "all").`);
    return hit;
  };

  const memberState = (m: TeamMember) => pool.get(m.host).call<TaskInfo>("task.get", { taskId: m.taskId });

  server.registerTool(
    "ladvin_team_start",
    {
      description:
        "Start a team: remote Claude Code teammates on SSH hosts that work on one goal with you, exchanging messages and files while running. One active team per project.",
      inputSchema: {
        goal: z.string().describe("The shared goal, with enough context for a teammate to start"),
        members: z
          .array(
            z.object({
              host: z.string(),
              role: z.string().describe("Short unique role name, e.g. db-watcher"),
              cwd: z.string().optional(),
              preset: Preset.optional().describe("default observer"),
            }),
          )
          .min(1),
      },
    },
    guarded(async (a) => {
      const cur = store.active();
      if (cur) throw new ToolError(`A team is already active in this project (${cur.teamId}). End it with ladvin_team_end first.`);
      const roles = a.members.map((m) => m.role);
      if (new Set(roles).size !== roles.length) throw new ToolError("Member roles must be unique.");
      const hosts = loadHosts();
      for (const m of a.members) {
        const h = hosts.find((x) => x.alias === m.host);
        if (!h) throw new ToolError(`Unknown host "${m.host}". Register it first with /ladvin:add-host ${m.host}.`);
        const preset = m.preset ?? "observer";
        if (PRESET_RANK[preset] > PRESET_RANK[h.maxPreset]) throw new ToolError(`Preset ${preset} exceeds host max ${h.maxPreset} for ${h.alias}.`);
      }
      for (const host of new Set(a.members.map((m) => m.host))) {
        const refusal = await ctx.budgetGuard?.(host);
        if (refusal) throw new ToolError(refusal);
      }
      // Reserve the team id first so members can be told which team they join.
      const team = store.create(a.goal, []);
      const members: TeamMember[] = [];
      try {
        for (const m of a.members) {
          const preset = m.preset ?? "observer";
          const conn = pool.get(m.host);
          const { taskId, cwd } = await conn.call<{ taskId: string; cwd: string }>("team.join", {
            owner,
            teamId: team.teamId,
            role: m.role,
            goal: a.goal,
            cwd: m.cwd,
            preset,
          });
          members.push({ taskId, host: m.host, role: m.role, preset, cwd });
          store.save({ ...team, members });
          const prompt = `Team goal: ${a.goal}\nYour role: ${m.role}\nTeammates: ${a.members.map((x) => `${x.role}@${x.host}`).join(", ")} and the coordinator (local).\nStart by reading the shared task list (team_tasks list) and tell the coordinator your plan with team_send.`;
          await conn.call("task.start", { taskId, prompt, limits: { wallMs: DEFAULT_WALL_MS * 4 } });
        }
      } catch (e) {
        await Promise.allSettled(members.map((m) => pool.get(m.host).call("team.stop", { taskId: m.taskId })));
        store.end(team.teamId);
        throw e;
      }
      poller.start();
      const table = members.map((m) => `${m.role}  ${m.host}  ${m.taskId}  ${m.preset}`).join("\n");
      return ok(
        `Started ${team.teamId}.\nrole  host  task  preset\n${table}\nTeammates report with team_send; read them with ladvin_team_inbox (new messages also appear after your tool calls).`,
      );
    }),
  );

  server.registerTool(
    "ladvin_team_send",
    {
      description: "Message one teammate (by role or task id) or all. Optionally attach local files (they land in the teammate's .ladvin/shared/).",
      inputSchema: { to: z.string(), text: z.string(), files: z.array(z.string()).optional() },
    },
    guarded(async (a) => {
      const team = active();
      const targets = recipients(team, a.to);
      const cap = Number(process.env.LADVIN_MAX_SHARE_BYTES) || DEFAULT_MAX_SHARE_BYTES;
      for (const f of a.files ?? []) {
        if (!existsSync(f)) throw new ToolError(`Local file not found: ${f}`);
        if (statSync(f).size > cap) throw new ToolError(`${f} is larger than the share limit (${cap} bytes).`);
      }
      const results = await Promise.allSettled(
        targets.map(async (m) => {
          const names: string[] = [];
          for (const f of a.files ?? []) {
            const rel = posix.join(".ladvin", "shared", basename(f));
            await pool.transport(m.host).upload(f, posix.join(m.cwd.replace(/\\/g, "/"), rel));
            names.push(rel);
          }
          const text = names.length ? `${a.text}\n\nFiles for you (relative to your working directory):\n${names.map((n) => `- ${n}`).join("\n")}` : a.text;
          await pool.get(m.host).call("team.send", { taskId: m.taskId, text, from: "local" });
        }),
      );
      const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${targets[i]!.role}: ${r.reason instanceof Error ? r.reason.message : r.reason}`] : []));
      if (failed.length === targets.length) throw new ToolError(`Not delivered:\n${failed.join("\n")}`);
      if (failed.length < targets.length) store.appendSent(team.teamId, { at: new Date().toISOString(), to: a.to, text: a.text });
      return ok(`Sent to ${targets.map((m) => m.role).join(", ")}.${failed.length ? `\nNot delivered:\n${failed.join("\n")}` : ""}`);
    }),
  );

  server.registerTool(
    "ladvin_team_inbox",
    {
      description: "Read new messages from teammates (marks them read). wait_seconds blocks until something arrives (use at sync points).",
      inputSchema: { wait_seconds: z.number().min(0).max(MAX_WAIT_SECONDS).optional() },
    },
    guarded(async (a) => {
      const team = store.latest();
      if (!team) throw new ToolError("No team in this project yet.");
      const end = Date.now() + (a.wait_seconds ?? 0) * 1000;
      if (!poller.running() && team.status === "active") poller.start();
      await poller.pollOnce();
      while (!store.unread(team.teamId).length && Date.now() < end) {
        await sleep(250);
        await poller.pollOnce();
      }
      const unread = store.takeUnread(team.teamId);
      if (!unread.length) return ok("No new messages.");
      return ok(renderInbox(unread));
    }),
  );

  server.registerTool(
    "ladvin_team_tasks",
    {
      description: "The team's shared task list (yours is canonical; teammates see a synced copy).",
      inputSchema: {
        op: z.enum(["list", "add", "update"]),
        title: z.string().optional(),
        id: z.string().optional(),
        status: TeamTaskStatus.optional(),
        owner: z.string().optional(),
        note: z.string().optional(),
      },
    },
    guarded(async (a) => {
      const team = active();
      if (a.op === "list") return ok(renderTasks(team.tasks, team.teamId));
      if (a.op === "add" && !a.title) throw new ToolError("add needs a title.");
      if (a.op === "update" && !a.id) throw new ToolError("update needs an id.");
      const op =
        a.op === "add"
          ? { op: "add" as const, title: a.title!, ...(a.owner ? { owner: a.owner } : {}) }
          : { op: "update" as const, id: a.id!, ...(a.status ? { status: a.status } : {}), ...(a.owner ? { owner: a.owner } : {}), ...(a.note ? { note: a.note } : {}) };
      const tasks = applyOp(team.tasks, op, "local");
      store.save({ ...team, tasks });
      await syncTasks(pool, team, tasks);
      return ok(renderTasks(tasks, team.teamId));
    }),
  );

  server.registerTool(
    "ladvin_team_end",
    {
      description: "End the team: ask teammates to send final notes, wait briefly, stop them, and return the last messages.",
      inputSchema: { summary: z.string().optional() },
    },
    guarded(async (a) => {
      const team = active();
      const wrap = `Wrap up now: send your final notes with team_send, then stop.${a.summary ? `\nCoordinator's summary: ${a.summary}` : ""}`;
      await Promise.allSettled(team.members.map((m) => pool.get(m.host).call("team.send", { taskId: m.taskId, text: wrap, from: "local" })));
      // Wait until every member has answered the wrap-up (a new inbox entry from it) or is gone.
      const waitMs = Number(process.env.LADVIN_TEAM_END_WAIT_MS) || 60_000;
      const end = Date.now() + waitMs;
      const sentBy = (taskId: string) => store.all(team.teamId).filter((e) => e.taskId === taskId).length;
      const before = new Map(team.members.map((m) => [m.taskId, sentBy(m.taskId)]));
      while (Date.now() < end) {
        await poller.pollOnce();
        const pending = team.members.filter((m) => sentBy(m.taskId) <= before.get(m.taskId)!);
        if (!pending.length) break;
        const states = await Promise.allSettled(pending.map(memberState));
        if (states.every((s) => s.status === "rejected" || TERMINAL.has(s.value.state))) break;
        await sleep(250);
      }
      await Promise.allSettled(team.members.map((m) => pool.get(m.host).call("team.stop", { taskId: m.taskId })));
      await poller.pollOnce();
      poller.stop();
      store.end(team.teamId);
      const unread = store.takeUnread(team.teamId);
      return ok(`Ended ${team.teamId}.${unread.length ? `\nFinal messages:\n${renderInbox(unread)}` : "\nNo final messages."}`);
    }),
  );

  server.registerTool(
    "ladvin_team_resume",
    {
      description: "Reconnect to this project's team after a new session: collect messages sent while you were away and wake stopped teammates.",
      inputSchema: {},
    },
    guarded(async () => {
      const team = store.latest();
      if (!team) throw new ToolError("No team in this project.");
      if (team.status === "ended" && Date.now() - Date.parse(team.endedAt ?? team.createdAt) > 24 * 3600_000)
        throw new ToolError(`${team.teamId} ended more than 24 h ago; start a new team.`);
      if (team.status === "ended") store.save({ ...team, status: "active", endedAt: undefined });
      poller.start();
      await poller.pollOnce();
      const lines: string[] = [];
      for (const m of team.members) {
        try {
          const t = await memberState(m);
          if (TERMINAL.has(t.state) && t.failReason?.startsWith("stopped:")) {
            await pool.get(m.host).call("team.send", { taskId: m.taskId, text: "The coordinator is back; continue.", from: "local" });
            lines.push(`${m.role}@${m.host}: resumed`);
          } else lines.push(`${m.role}@${m.host}: ${t.state}${t.failReason ? ` (${t.failReason})` : ""}`);
        } catch (e) {
          lines.push(`${m.role}@${m.host}: unreachable (${e instanceof Error ? e.message : e})`);
        }
      }
      return ok(`Resumed ${team.teamId}.\n${lines.join("\n")}\n${store.unread(team.teamId).length} unread message(s); read them with ladvin_team_inbox.`);
    }),
  );
}
