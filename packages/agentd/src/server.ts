import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  AgentAttachParams,
  AgentReportParams,
  ERR_INVALID_PARAMS,
  HelloParams,
  LineCodec,
  PROTOCOL_MAJOR,
  RpcError,
  RpcPeer,
  TaskFollowupParams,
  TaskIdParams,
  TaskListParams,
  TaskPrepareParams,
  TaskStartParams,
  TeamAckParams,
  TeamJoinParams,
  TeamPullParams,
  TeamSendParams,
  TeamStopParams,
  TeamSyncTasksParams,
  AgentTeamSendParams,
  AgentShareParams,
  AgentTasksOpParams,
  AgentTasksListParams,
  type Owner,
  type Preset,
  type TaskInfo,
} from "@ladvin/protocol";
import type { z } from "zod";
import { Outbox } from "./outbox";
import { ladvinHome, socketPath, taskDir } from "./paths";
import type { Runner } from "./runner";
import type { TaskStore } from "./store";
import { formatIncoming } from "./team-prompt";

export const DEFAULT_MAX_SHARE_BYTES = 200 * 1024 * 1024;

// Only files inside the working directory (after resolving symlinks) may leave the host (spec §9).
function insideCwd(cwd: string, rel: string): { real: string; inside: string } {
  const abs = resolve(cwd, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new RpcError(ERR_INVALID_PARAMS, `no such file: ${rel}`);
  const real = realpathSync(abs);
  const inside = relative(realpathSync(cwd), real);
  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    throw new RpcError(ERR_INVALID_PARAMS, `only files inside the working directory can leave this host: ${rel}`);
  return { real, inside: inside.split(sep).join("/") };
}

export const ERR_UNKNOWN_TASK = -32004;
export const ERR_NOT_QUEUED = -32010;
export const ERR_NOT_FINISHED = -32011;
export const ERR_BAD_STATE = -32012;

function parse<T extends z.ZodTypeAny>(schema: T, params: unknown): z.infer<T> {
  const r = schema.safeParse(params ?? {});
  if (!r.success) throw new RpcError(ERR_INVALID_PARAMS, `invalid params: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return r.data;
}

function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

// Probe: is another live server already on this socket? If not, remove the stale socket file.
async function clearStaleSocket(path: string): Promise<void> {
  if (process.platform === "win32" || !existsSync(path)) return;
  const alive = await new Promise<boolean>((r) => {
    const s = connect(path);
    s.once("connect", () => (s.destroy(), r(true)));
    s.once("error", () => r(false));
  });
  if (alive) throw new Error(`ladvin-agentd already running on ${path}`);
  unlinkSync(path);
}

export async function startServer(o: {
  store: TaskStore;
  runner: Runner;
  version: string;
  onShutdown?: () => void;
}): Promise<{ close(): Promise<void>; lastHubContact: (teamId: string) => number }> {
  const { store, runner } = o;
  const outbox = new Outbox(store);
  // When the hub last pulled each team (spec §6.2 idle timeout). Starts "now" so a fresh agentd does not stop members at once.
  const startedAt = Date.now();
  const lastHubContact = new Map<string, number>();

  const prepare = (owner: Owner, cwd: string | undefined, preset: Preset, extra: Partial<TaskInfo>) => {
    let dir = "";
    if (cwd) {
      dir = resolve(homedir(), expandHome(cwd));
      if (!existsSync(dir) || !statSync(dir).isDirectory())
        throw new RpcError(ERR_INVALID_PARAMS, `cwd does not exist on this host: ${cwd}`);
    }
    const t = store.create({ owner, preset, cwd: dir, prompt: "", ...extra });
    if (!cwd) {
      dir = join(taskDir(t.taskId), "work");
      mkdirSync(dir, { recursive: true });
      store.update(t.taskId, { cwd: dir });
    }
    return { taskId: t.taskId, cwd: dir };
  };
  const path = socketPath();
  await clearStaleSocket(path);

  const task = (taskId: string) => {
    const t = store.get(taskId);
    if (!t) throw new RpcError(ERR_UNKNOWN_TASK, `unknown task ${taskId}`);
    return t;
  };

  const register = (peer: RpcPeer) => {
    peer.handle("hello", async (p) => {
      const { protocolMajor } = parse(HelloParams, p);
      if (protocolMajor !== PROTOCOL_MAJOR)
        throw new RpcError(ERR_INVALID_PARAMS, `protocol mismatch: client ${protocolMajor}, agentd ${PROTOCOL_MAJOR}`);
      return { protocolMajor: PROTOCOL_MAJOR, agentdVersion: o.version, now: new Date().toISOString() };
    });
    peer.handle("ping", async () => ({ now: new Date().toISOString() }));

    peer.handle("task.prepare", async (p) => {
      const { owner, cwd, preset } = parse(TaskPrepareParams, p);
      return prepare(owner, cwd, preset, {});
    });

    // ---- team mode (spec §9) ----
    peer.handle("team.join", async (p) => {
      const { owner, teamId, role, goal, cwd, preset } = parse(TeamJoinParams, p);
      return prepare(owner, cwd, preset, { kind: "team", team: { teamId, role }, prompt: goal });
    });

    peer.handle("team.send", async (p) => {
      const { taskId, text, from } = parse(TeamSendParams, p);
      if (task(taskId).kind !== "team") throw new RpcError(ERR_BAD_STATE, `task ${taskId} is not a team member`);
      try {
        await runner.inject(taskId, formatIncoming(from, new Date(), text));
      } catch (e) {
        throw new RpcError(ERR_BAD_STATE, e instanceof Error ? e.message : String(e));
      }
      return {};
    });

    peer.handle("team.pull", async (p) => {
      const { owner } = parse(TeamPullParams, p);
      const now = Date.now();
      for (const t of store.list(owner)) if (t.team) lastHubContact.set(t.team.teamId, now);
      return { messages: outbox.pull(owner) };
    });

    peer.handle("team.ack", async (p) => {
      outbox.ack(parse(TeamAckParams, p).ids);
      return {};
    });

    peer.handle("team.syncTasks", async (p) => {
      const { teamId, tasks } = parse(TeamSyncTasksParams, p);
      const dir = join(ladvinHome(), "teams", teamId.replace(/[^\w-]/g, "_"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "tasks.json"), JSON.stringify(tasks, null, 2));
      return {};
    });

    peer.handle("team.stop", async (p) => {
      const { taskId } = parse(TeamStopParams, p);
      task(taskId);
      runner.stop(taskId, "team ended");
      return {};
    });

    const member = (taskId: string) => {
      const t = task(taskId);
      if (t.kind !== "team" || !t.team) throw new RpcError(ERR_BAD_STATE, `task ${taskId} is not a team member`);
      return { t, team: t.team };
    };

    peer.handle("agent.teamSend", async (p) => {
      const { taskId, text } = parse(AgentTeamSendParams, p);
      const { team } = member(taskId);
      outbox.append({ kind: "message", teamId: team.teamId, taskId, role: team.role, text });
      return {};
    });

    peer.handle("agent.share", async (p) => {
      const { taskId, path: rel, note } = parse(AgentShareParams, p);
      const { t, team } = member(taskId);
      const { real, inside } = insideCwd(t.cwd, rel);
      const size = statSync(real).size;
      const cap = Number(process.env.LADVIN_MAX_SHARE_BYTES) || DEFAULT_MAX_SHARE_BYTES;
      if (size > cap) throw new RpcError(ERR_INVALID_PARAMS, `${rel} is ${size} bytes; the share limit is ${cap} bytes`);
      const sha256 = createHash("sha256").update(readFileSync(real)).digest("hex");
      outbox.append({ kind: "file", teamId: team.teamId, taskId, role: team.role, name: basename(real), path: inside, size, sha256, ...(note ? { note } : {}) });
      return {};
    });

    peer.handle("agent.tasksOp", async (p) => {
      const { taskId, op } = parse(AgentTasksOpParams, p);
      const { team } = member(taskId);
      outbox.append({ kind: "tasksOp", teamId: team.teamId, taskId, role: team.role, op });
      return {};
    });

    peer.handle("agent.tasksList", async (p) => {
      const { team } = member(parse(AgentTasksListParams, p).taskId);
      const f = join(ladvinHome(), "teams", team.teamId.replace(/[^\w-]/g, "_"), "tasks.json");
      return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
    });

    peer.handle("task.start", async (p) => {
      const { taskId, prompt, limits } = parse(TaskStartParams, p);
      if (task(taskId).state !== "queued") throw new RpcError(ERR_NOT_QUEUED, `task ${taskId} not queued`);
      store.update(taskId, { limits });
      runner.start(taskId, prompt);
      return {};
    });

    peer.handle("task.list", async (p) => store.list(parse(TaskListParams, p).owner));
    peer.handle("task.get", async (p) => task(parse(TaskIdParams, p).taskId));

    peer.handle("task.report", async (p) => {
      const { taskId } = parse(TaskIdParams, p);
      const t = task(taskId);
      const r = store.getReport(taskId);
      if (!r || t.state === "running" || t.state === "queued")
        throw new RpcError(ERR_NOT_FINISHED, `task ${taskId} is still ${t.state}`);
      return r;
    });

    peer.handle("task.cancel", async (p) => {
      const { taskId } = parse(TaskIdParams, p);
      const t = task(taskId);
      if (t.state === "queued") store.update(taskId, { state: "cancelled" });
      else runner.cancel(taskId);
      return {};
    });

    peer.handle("task.followup", async (p) => {
      const { taskId, text } = parse(TaskFollowupParams, p);
      task(taskId);
      try {
        await runner.followup(taskId, text);
      } catch (e) {
        throw new RpcError(ERR_BAD_STATE, e instanceof Error ? e.message : String(e));
      }
      return {};
    });

    peer.handle("task.cancelAll", async () => {
      const ids = runner.running();
      for (const id of ids) runner.cancel(id);
      return { cancelled: ids.length };
    });

    peer.handle("agent.report", async (p) => {
      const { taskId, ...r } = parse(AgentReportParams, p);
      task(taskId);
      runner.onAgentReport(taskId, r);
      return {};
    });

    peer.handle("agent.attach", async (p) => {
      const { taskId, path: rel, note } = parse(AgentAttachParams, p);
      const t = task(taskId);
      const { real, inside } = insideCwd(t.cwd, rel);
      store.addArtifact(taskId, { path: inside, size: statSync(real).size, ...(note ? { note } : {}) });
      return {};
    });

    peer.handle("shutdown", async (p: any) => {
      if (runner.running().length && !p?.force)
        throw new RpcError(ERR_BAD_STATE, `${runner.running().length} agents running; pass force to stop them`);
      setTimeout(() => void close().then(() => o.onShutdown?.()), 10);
      return {};
    });
  };

  const server: Server = createServer((sock) => {
    sock.setEncoding("utf8");
    const peer = new RpcPeer((l) => sock.write(l));
    const codec = new LineCodec();
    register(peer);
    sock.on("data", (chunk: string) => codec.push(chunk).forEach((m) => peer.receive(m)));
    sock.on("close", () => peer.close("client disconnected"));
    sock.on("error", () => {});
  });
  const conns = new Set<import("node:net").Socket>();
  server.on("connection", (s) => (conns.add(s), s.on("close", () => conns.delete(s))));

  await new Promise<void>((r, j) => server.once("error", j).listen(path, () => r()));

  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      await runner.stopAll("agentd stopped");
      for (const s of conns) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    })());
  return { close, lastHubContact: (teamId) => lastHubContact.get(teamId) ?? startedAt };
}
