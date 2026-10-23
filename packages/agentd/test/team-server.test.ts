import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineCodec, type OutMsg, RpcPeer, type TeamTask } from "@ladvin/protocol";
import { socketPath, taskDir } from "../src/paths";
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

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ladvin-team-server-"));
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
  await runner.stopAll();
  await server?.close();
  delete process.env.FAKE_CLAUDE_SCRIPT;
  delete process.env.LADVIN_MAX_SHARE_BYTES;
  delete process.env.LADVIN_HOME;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

async function client(): Promise<RpcPeer> {
  const s = connect(socketPath());
  sockets.push(s);
  await new Promise((r, j) => s.once("connect", r).once("error", j));
  s.setEncoding("utf8");
  const peer = new RpcPeer((l) => s.write(l));
  const codec = new LineCodec();
  s.on("data", (c: string) => codec.push(c).forEach((m) => peer.receive(m)));
  return peer;
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

async function teammate(c: RpcPeer, steps: unknown[], role = "watcher"): Promise<{ taskId: string; cwd: string }> {
  process.env.FAKE_CLAUDE_SCRIPT = JSON.stringify(steps);
  const j = await c.request<{ taskId: string; cwd: string }>("team.join", { owner, teamId: "team_1", role, goal: "g", preset: "observer" });
  await c.request("task.start", { taskId: j.taskId, prompt: "Team goal: g", limits: { wallMs: 60000 } });
  return j;
}

const pullUntil = (c: RpcPeer, pred: (m: OutMsg[]) => boolean) =>
  until(async () => {
    const { messages } = await c.request<{ messages: OutMsg[] }>("team.pull", { owner });
    return pred(messages) ? messages : undefined;
  });

const send = (text: string) => ({ callTool: { name: "team_send", args: { text } } });

test("teammate messages are queued until acked", async () => {
  const c = await client();
  await teammate(c, [send("hello"), { result: "x" }]);
  const msgs = await pullUntil(c, (m) => m.length > 0);
  expect(msgs).toHaveLength(1);
  expect(msgs[0]).toMatchObject({ kind: "message", text: "hello", role: "watcher", teamId: "team_1" });
  expect((await c.request<{ messages: OutMsg[] }>("team.pull", { owner })).messages).toHaveLength(1); // not acked yet
  await c.request("team.ack", { ids: [msgs[0]!.id] });
  expect((await c.request<{ messages: OutMsg[] }>("team.pull", { owner })).messages).toHaveLength(0);
}, 20000);

test("team.send reaches the live teammate as a framed message", async () => {
  const c = await client();
  const { taskId } = await teammate(c, [{ result: "ready" }, { respond: [send("echo $INPUT")] }]);
  await until(async () => ((await c.request<any>("task.get", { taskId })).state === "idle" ? true : undefined));
  await c.request("team.send", { taskId, text: "ping", from: "local" });
  const msgs = await pullUntil(c, (m) => m.some((x) => x.kind === "message" && x.text.includes("ping")));
  expect((msgs.find((x) => x.kind === "message") as any).text).toMatch(/^echo \[ladvin message from local @ \d\d:\d\d:\d\d\.\d{3}Z\]: ping$/);
}, 20000);

test("share_file queues a file entry with cwd-relative path and sha256", async () => {
  const c = await client();
  await teammate(c, [
    { writeFile: { path: "a.txt", content: "abc" } },
    { callTool: { name: "share_file", args: { path: "a.txt", note: "n" } } },
    { result: "x" },
  ]);
  const msgs = await pullUntil(c, (m) => m.length > 0);
  expect(msgs[0]).toMatchObject({ kind: "file", name: "a.txt", path: "a.txt", size: 3, note: "n", sha256: createHash("sha256").update("abc").digest("hex") });
}, 20000);

test("share_file refuses files outside the cwd and files over the cap", async () => {
  process.env.LADVIN_MAX_SHARE_BYTES = "4";
  writeFileSync(join(home, "outside.txt"), "x");
  const c = await client();
  const { taskId } = await teammate(c, [
    { writeFile: { path: "big.txt", content: "0123456789" } },
    { callTool: { name: "share_file", args: { path: "big.txt" } } },
    { callTool: { name: "share_file", args: { path: join(home, "outside.txt") } } },
    { result: "x" },
  ]);
  await until(async () => ((await c.request<any>("task.get", { taskId })).state === "idle" ? true : undefined));
  const seen = readFileSync(join(taskDir(taskId), "stream.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "tool_result_seen");
  expect(seen.map((e) => e.isError)).toEqual([true, true]);
  expect(seen[0].text).toContain("limit");
  expect((await c.request<{ messages: OutMsg[] }>("team.pull", { owner })).messages).toHaveLength(0);
}, 20000);

test("task-list ops are queued; the synced mirror is what teammates list", async () => {
  const c = await client();
  const { taskId } = await teammate(c, [
    { callTool: { name: "team_tasks", args: { op: "add", title: "watch iostat" } } },
    { result: "x" },
    { respond: [{ callTool: { name: "team_tasks", args: { op: "list" } } }] },
  ]);
  const msgs = await pullUntil(c, (m) => m.length > 0);
  expect(msgs[0]).toMatchObject({ kind: "tasksOp", op: { op: "add", title: "watch iostat" } });
  const tasks: TeamTask[] = [{ id: "k1", title: "watch iostat", status: "doing", owner: "watcher" }];
  await c.request("team.syncTasks", { teamId: "team_1", tasks });
  await c.request("team.send", { taskId, text: "list please", from: "local" });
  const listed = await until(async () => {
    const lines = readFileSync(join(taskDir(taskId), "stream.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    return lines.find((e) => e.type === "tool_result_seen" && e.name === "team_tasks" && e.text.includes("k1"));
  });
  expect(listed.text).toContain("watch iostat");
}, 20000);

test("another owner pulls nothing", async () => {
  const c = await client();
  await teammate(c, [send("secret"), { result: "x" }]);
  await pullUntil(c, (m) => m.length > 0);
  const other = await c.request<{ messages: OutMsg[] }>("team.pull", { owner: { machineId: "m", projectDir: "/other" } });
  expect(other.messages).toHaveLength(0);
}, 20000);

test("team.stop ends the member", async () => {
  const c = await client();
  const { taskId } = await teammate(c, [{ result: "x" }]);
  await until(async () => ((await c.request<any>("task.get", { taskId })).state === "idle" ? true : undefined));
  await c.request("team.stop", { taskId });
  const t = await until(async () => {
    const t = await c.request<any>("task.get", { taskId });
    return t.state === "done" ? t : undefined;
  });
  expect(t.failReason).toBe("team ended");
}, 20000);

test("a shared file is staged at share time; later changes to the original do not leak", async () => {
  const c = await client();
  const { cwd } = await teammate(c, [
    { writeFile: { path: "out.txt", content: "original" } },
    { callTool: { name: "share_file", args: { path: "out.txt" } } },
    { writeFile: { path: "out.txt", content: "swapped-later" } },
    { result: "x" },
  ]);
  const msgs = await pullUntil(c, (m) => m.length > 0);
  const f = msgs[0] as any;
  expect(f.staged).toBeDefined();
  expect(readFileSync(f.staged, "utf8")).toBe("original");
  expect(readFileSync(join(cwd, "out.txt"), "utf8")).toBe("swapped-later");
}, 20000);

test("acked entries are compacted out of the outbox file", async () => {
  const c = await client();
  await teammate(c, [send("one"), send("two"), { result: "x" }]);
  const msgs = await pullUntil(c, (m) => m.length === 2);
  await c.request("team.ack", { ids: [msgs[0]!.id] });
  const raw = readFileSync(join(home, "outbox.jsonl"), "utf8");
  expect(raw).not.toContain(msgs[0]!.id);
  expect(raw).toContain(msgs[1]!.id);
}, 20000);

test("incoming messages are stamped in UTC", async () => {
  const c = await client();
  const { taskId } = await teammate(c, [{ result: "ready" }, { respond: [send("echo $INPUT")] }]);
  await until(async () => ((await c.request<any>("task.get", { taskId })).state === "idle" ? true : undefined));
  await c.request("team.send", { taskId, text: "t", from: "local" });
  const msgs = await pullUntil(c, (m) => m.some((x) => x.kind === "message" && x.text.includes("echo")));
  expect((msgs.find((x) => x.kind === "message") as any).text).toMatch(/@ \d\d:\d\d:\d\d\.\d{3}Z\]: t$/);
}, 20000);
