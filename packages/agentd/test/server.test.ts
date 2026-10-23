import { afterEach, beforeEach, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineCodec, RpcPeer, type Report, type TaskInfo } from "@ladvin/protocol";
import { socketPath } from "../src/paths";
import { Runner } from "../src/runner";
import { startServer } from "../src/server";
import { TaskStore } from "../src/store";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const FAKE = join(import.meta.dir, "fake-claude.ts");
const owner = { machineId: "m", projectDir: "/p" };
let home: string;
let runner: Runner;
let server: { close(): Promise<void> } | undefined;
const sockets: Socket[] = [];
const children: ChildProcess[] = [];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ladvin-server-"));
  process.env.LADVIN_HOME = home;
  const store = new TaskStore();
  runner = new Runner({
    store,
    hostName: "box",
    claudeBin: process.execPath,
    claudeBinArgs: [FAKE],
    agentMcpCommand: (id) => ({ command: process.execPath, args: [MAIN, "agent-mcp", id] }),
  });
  server = await startServer({ store, runner, version: "0.1.0" });
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const c of children.splice(0)) c.kill();
  await runner.stopAll();
  await server?.close();
  server = undefined;
  delete process.env.FAKE_CLAUDE_SCRIPT;
  delete process.env.LADVIN_HOME;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

function peerOver(write: (l: string) => void, onData: (fn: (chunk: string) => void) => void): RpcPeer {
  const peer = new RpcPeer(write);
  const codec = new LineCodec();
  onData((chunk) => codec.push(chunk).forEach((m) => peer.receive(m)));
  return peer;
}

async function client(): Promise<RpcPeer> {
  const s = connect(socketPath());
  sockets.push(s);
  await new Promise((r, j) => s.once("connect", r).once("error", j));
  s.setEncoding("utf8");
  return peerOver((l) => s.write(l), (fn) => s.on("data", fn));
}

async function until<T>(fn: () => Promise<T | undefined>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("hello returns protocol major and version", async () => {
  const c = await client();
  expect(await c.request("hello", { protocolMajor: 1, client: owner })).toMatchObject({ protocolMajor: 1, agentdVersion: "0.1.0" });
});

test("delegate round trip: agent attaches an artifact and reports via its MCP tools", async () => {
  process.env.FAKE_CLAUDE_SCRIPT = JSON.stringify([
    { writeFile: { path: "out.txt", content: "hello" } },
    { callTool: { name: "ladvin_attach_artifact", args: { path: "out.txt", note: "greeting" } } },
    { callTool: { name: "ladvin_report", args: { summary: "did it", status: "success" } } },
    { result: "bye" },
  ]);
  const c = await client();
  const { taskId } = await c.request<{ taskId: string }>("task.prepare", { owner, preset: "worker" });
  await c.request("task.start", { taskId, prompt: "go", limits: { wallMs: 60000 } });
  await until(async () => ((await c.request<TaskInfo>("task.get", { taskId })).state === "done" ? true : undefined));
  const r = await c.request<Report>("task.report", { taskId });
  expect(r.summary).toBe("did it");
  expect(r.reportMissing).toBe(false);
  expect(r.artifacts).toEqual([{ path: "out.txt", size: 5, note: "greeting" }]);
}, 20000);

test("two clients can talk to the server at once", async () => {
  const [a, b] = [await client(), await client()];
  await a.request("task.prepare", { owner, preset: "worker" });
  const [la, lb] = await Promise.all([a.request<TaskInfo[]>("task.list", {}), b.request<TaskInfo[]>("task.list", {})]);
  expect(la.length).toBe(1);
  expect(lb.length).toBe(1);
});

test("invalid params are rejected with -32602", async () => {
  const c = await client();
  expect(await c.request("task.prepare", { owner, preset: "root" }).catch((e) => e)).toMatchObject({ code: -32602 });
});

test("starting a task twice is refused", async () => {
  process.env.FAKE_CLAUDE_SCRIPT = JSON.stringify([{ sleepMs: 3000 }]);
  const c = await client();
  const { taskId } = await c.request<{ taskId: string }>("task.prepare", { owner, preset: "worker" });
  await c.request("task.start", { taskId, prompt: "go", limits: { wallMs: 60000 } });
  expect(await c.request("task.start", { taskId, prompt: "go", limits: { wallMs: 60000 } }).catch((e) => e)).toMatchObject({ code: -32010 });
});

test("cancelAll cancels every running task", async () => {
  process.env.FAKE_CLAUDE_SCRIPT = JSON.stringify([{ sleepMs: 5000 }]);
  const c = await client();
  for (let i = 0; i < 2; i++) {
    const { taskId } = await c.request<{ taskId: string }>("task.prepare", { owner, preset: "worker" });
    await c.request("task.start", { taskId, prompt: "go", limits: { wallMs: 60000 } });
  }
  expect(await c.request("task.cancelAll", {})).toEqual({ cancelled: 2 });
  const list = await c.request<TaskInfo[]>("task.list", {});
  expect(list.map((t) => t.state)).toEqual(["cancelled", "cancelled"]);
});

test("bridge autostarts a server when none is running", async () => {
  await server!.close();
  server = undefined;
  const p = spawn(process.execPath, [MAIN, "bridge"], { env: { ...process.env, LADVIN_HOME: home } });
  children.push(p);
  p.stdout!.setEncoding("utf8");
  const peer = peerOver((l) => p.stdin!.write(l), (fn) => p.stdout!.on("data", fn));
  const hello = await peer.request<{ agentdVersion: string }>("hello", { protocolMajor: 1, client: owner }, 10000);
  expect(hello.agentdVersion).toBe("0.3.1");
  // stop the autostarted server through a fresh client
  const c = await client();
  await c.request("shutdown", {}).catch(() => {});
}, 20000);

test("agent.attach only accepts files inside the task's working directory", async () => {
  const c = await client();
  const { taskId, cwd } = await c.request<{ taskId: string; cwd: string }>("task.prepare", { owner, preset: "worker" });
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(cwd, "sub"), { recursive: true });
  writeFileSync(join(cwd, "sub", "ok.txt"), "ok");
  writeFileSync(join(home, "secret.txt"), "secret");
  expect(await c.request("agent.attach", { taskId, path: "sub/../sub/ok.txt" }).catch((e) => e)).toEqual({});
  for (const bad of [join(home, "secret.txt"), "../../../secret.txt", "~/secret.txt"])
    expect(await c.request("agent.attach", { taskId, path: bad }).catch((e) => e)).toMatchObject({ code: -32602 });
  const t = await c.request<TaskInfo>("task.get", { taskId });
  expect(t).toBeDefined();
});
