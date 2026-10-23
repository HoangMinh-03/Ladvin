import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHub, type Hub } from "../src/hub";
import { saveHost } from "../src/state";
import { localTransport } from "../src/transport";

const MAIN = join(import.meta.dir, "..", "..", "agentd", "src", "main.ts");
const FAKE = join(import.meta.dir, "..", "..", "agentd", "test", "fake-claude.ts");
let localHome: string;
let remoteHome: string;
let project: string;
let env: Record<string, string> = {};
const hubs: Hub[] = [];

async function hub(): Promise<Client> {
  const h = createHub({
    owner: { machineId: "m1", projectDir: project },
    transportFor: () => localTransport({ agentdCmd: [process.execPath, MAIN], userHome: remoteHome, env }),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([h.server.connect(a), client.connect(b)]);
  hubs.push(h);
  return client;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r: any = await c.callTool({ name, arguments: args });
  return { text: r.content.map((x: any) => x.text).join("\n") as string, isError: !!r.isError };
}

async function until(fn: () => Promise<boolean> | boolean, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
}

// collects inbox text across calls until it contains `needle`
async function inboxUntil(c: Client, needle: string): Promise<string> {
  let acc = "";
  await until(async () => {
    acc += (await call(c, "ladvin_team_inbox", { wait_seconds: 2 })).text + "\n";
    return acc.includes(needle);
  }, 20000);
  return acc;
}

const send = (text: string) => ({ callTool: { name: "team_send", args: { text } } });
const script = (steps: unknown[]) => (env = { FAKE_CLAUDE_SCRIPT: JSON.stringify(steps), LADVIN_TEAM_END_WAIT_MS: "5000" });
const teamIdOf = (text: string) => text.match(/team_[0-9a-f]{8}/)![0];

beforeEach(() => {
  localHome = mkdtempSync(join(tmpdir(), "ladvin-tl-"));
  remoteHome = mkdtempSync(join(tmpdir(), "ladvin-tr-"));
  project = mkdtempSync(join(tmpdir(), "ladvin-tp-"));
  process.env.LADVIN_HOME = localHome;
  process.env.LADVIN_TEAM_END_WAIT_MS = "5000";
  saveHost({ alias: "box", os: "linux", arch: "x64", maxPreset: "worker", agentdVersion: "0.1.0", addedAt: "t" });
  mkdirSync(join(remoteHome, ".ladvin"), { recursive: true });
  writeFileSync(join(remoteHome, ".ladvin", "agentd.json"), JSON.stringify({ claudeBin: process.execPath, claudeArgs: [FAKE] }));
});

afterEach(async () => {
  for (const h of hubs) {
    await h.pool.get("box").call("shutdown", { force: true }).catch(() => {});
    h.close();
  }
  hubs.length = 0;
  env = {};
  delete process.env.LADVIN_HOME;
  delete process.env.LADVIN_TEAM_END_WAIT_MS;
  await new Promise((r) => setTimeout(r, 300));
  for (const d of [localHome, remoteHome, project])
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
});

const member = { host: "box", role: "watcher" };

test("teammate's first message reaches the local inbox, timestamped and wrapped", async () => {
  script([send("plan: watch iostat"), { result: "x" }]);
  const c = await hub();
  const started = await call(c, "ladvin_team_start", { goal: "find the bottleneck", members: [member] });
  expect(started.isError).toBe(false);
  expect(started.text).toMatch(/team_[0-9a-f]{8}/);
  const inbox = await inboxUntil(c, "plan: watch iostat");
  expect(inbox).toMatch(/\[\d\d:\d\d:\d\d\.\d{3}\] watcher@box: plan: watch iostat/);
  expect(inbox).toContain('<ladvin-remote-content host="box"');
}, 40000);

test("local → teammate → local round trip", async () => {
  script([send("ready"), { result: "x" }, { respond: [send("ack $INPUT")] }]);
  const c = await hub();
  await call(c, "ladvin_team_start", { goal: "g", members: [member] });
  await inboxUntil(c, "ready");
  expect((await call(c, "ladvin_team_send", { to: "watcher", text: "load step 1 at 500 rps" })).isError).toBe(false);
  const inbox = await inboxUntil(c, "500 rps");
  expect(inbox).toContain("ack [ladvin message from local @");
}, 40000);

test("unknown recipient lists the roles", async () => {
  script([{ result: "x" }]);
  const c = await hub();
  await call(c, "ladvin_team_start", { goal: "g", members: [member] });
  const r = await call(c, "ladvin_team_send", { to: "nobody", text: "x" });
  expect(r.isError).toBe(true);
  expect(r.text).toContain("watcher");
}, 40000);

test("teammate shares a file; it lands in the project with a manifest", async () => {
  script([{ writeFile: { path: "out.log", content: "iostat says hi" } }, { callTool: { name: "share_file", args: { path: "out.log" } } }, { result: "x" }]);
  const c = await hub();
  const teamId = teamIdOf((await call(c, "ladvin_team_start", { goal: "g", members: [member] })).text);
  await inboxUntil(c, "shared file out.log");
  expect(readFileSync(join(project, ".ladvin", "shared", teamId, "out.log"), "utf8")).toBe("iostat says hi");
  expect(existsSync(join(project, ".ladvin", "shared", teamId, "manifest.jsonl"))).toBe(true);
}, 40000);

test("local sends a file; the teammate finds it in .ladvin/shared", async () => {
  script([{ result: "x" }, { respond: [{ ifExists: ".ladvin/shared/load.js", then: [send("saw file")], else: [send("no file")] }] }]);
  const f = join(project, "load.js");
  writeFileSync(f, "k6 script");
  const c = await hub();
  await call(c, "ladvin_team_start", { goal: "g", members: [member] });
  await until(async () => (await call(c, "ladvin_status", {})).text.length > 0);
  await call(c, "ladvin_team_send", { to: "all", text: "here is the load script", files: [f] });
  await inboxUntil(c, "saw file");
}, 40000);

test("shared task list syncs both ways", async () => {
  script([{ result: "x" }, { respond: [{ callTool: { name: "team_tasks", args: { op: "add", title: "remote task" } } }] }]);
  const c = await hub();
  const teamId = teamIdOf((await call(c, "ladvin_team_start", { goal: "g", members: [member] })).text);
  await call(c, "ladvin_team_tasks", { op: "add", title: "local task", owner: "watcher" });
  const mirror = join(remoteHome, ".ladvin", "teams", teamId, "tasks.json");
  await until(() => existsSync(mirror) && readFileSync(mirror, "utf8").includes("local task"), 5000);
  await call(c, "ladvin_team_send", { to: "watcher", text: "add yours" });
  await until(async () => (await call(c, "ladvin_team_tasks", { op: "list" })).text.includes("remote task"), 10000);
  expect((await call(c, "ladvin_team_tasks", { op: "list" })).text).toContain("k1 [todo] local task (watcher)");
}, 40000);

test("one active team at a time; end stops members, returns final notes and frees the slot", async () => {
  script([{ result: "x" }, { respond: [send("final: done watching")] }]);
  const c = await hub();
  await call(c, "ladvin_team_start", { goal: "g", members: [member] });
  const again = await call(c, "ladvin_team_start", { goal: "g2", members: [member] });
  expect(again.isError).toBe(true);
  expect(again.text).toContain("already active");
  const ended = await call(c, "ladvin_team_end", {});
  expect(ended.isError).toBe(false);
  expect(ended.text).toContain("final: done watching");
  await until(async () => /team ended/.test((await call(c, "ladvin_status", { host: "box" })).text));
  expect((await call(c, "ladvin_team_start", { goal: "g3", members: [member] })).isError).toBe(false);
}, 60000);

test("messages sent while the hub is away arrive after resume", async () => {
  script([{ result: "x" }, { respond: [{ sleepMs: 1500 }, send("while you were away")] }]);
  const c1 = await hub();
  await call(c1, "ladvin_team_start", { goal: "g", members: [member] });
  await call(c1, "ladvin_team_send", { to: "watcher", text: "keep watching" });
  hubs[0]!.close(); // session ends before the teammate answers
  await new Promise((r) => setTimeout(r, 2500));
  const c2 = await hub();
  const resumed = await call(c2, "ladvin_team_resume", {});
  expect(resumed.isError).toBe(false);
  await inboxUntil(c2, "while you were away");
}, 60000);
