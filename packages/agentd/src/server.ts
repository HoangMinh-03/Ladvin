import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
} from "@ladvin/protocol";
import type { z } from "zod";
import { socketPath, taskDir } from "./paths";
import type { Runner } from "./runner";
import type { TaskStore } from "./store";

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
}): Promise<{ close(): Promise<void> }> {
  const { store, runner } = o;
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
      let dir: string;
      if (cwd) {
        dir = resolve(expandHome(cwd));
        if (!isAbsolute(dir) || !existsSync(dir) || !statSync(dir).isDirectory())
          throw new RpcError(ERR_INVALID_PARAMS, `cwd does not exist on this host: ${cwd}`);
      } else dir = "";
      const t = store.create({ owner, preset, cwd: dir, prompt: "" });
      if (!cwd) {
        dir = join(taskDir(t.taskId), "work");
        mkdirSync(dir, { recursive: true });
        store.update(t.taskId, { cwd: dir });
      }
      return { taskId: t.taskId, cwd: dir };
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
        runner.followup(taskId, text);
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
      const abs = resolve(t.cwd, expandHome(rel));
      if (!existsSync(abs) || !statSync(abs).isFile()) throw new RpcError(ERR_INVALID_PARAMS, `no such file: ${rel}`);
      store.addArtifact(taskId, { path: rel, size: statSync(abs).size, ...(note ? { note } : {}) });
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
  return { close };
}
