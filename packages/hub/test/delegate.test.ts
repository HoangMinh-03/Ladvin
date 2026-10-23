import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Owner } from "@ladvin/protocol";
import { createHub, type Hub } from "../src/hub";
import { saveHost } from "../src/state";
import { localTransport } from "../src/transport";

const MAIN = join(import.meta.dir, "..", "..", "agentd", "src", "main.ts");
const FAKE = join(import.meta.dir, "..", "..", "agentd", "test", "fake-claude.ts");
let localHome: string;
let remoteHome: string;
let project: string;
const hubs: { hub: Hub; client: Client }[] = [];

function writeAgentdConfig(): void {
  mkdirSync(join(remoteHome, ".ladvin"), { recursive: true });
  writeFileSync(join(remoteHome, ".ladvin", "agentd.json"), JSON.stringify({ claudeBin: process.execPath, claudeArgs: [FAKE] }));
}

function script(steps: unknown[]): Record<string, string> {
  return { FAKE_CLAUDE_SCRIPT: JSON.stringify(steps) };
}

let env: Record<string, string> = {};

async function hub(owner: Owner = { machineId: "m1", projectDir: project }): Promise<Client> {
  const h = createHub({
    owner,
    transportFor: () => localTransport({ agentdCmd: [process.execPath, MAIN], userHome: remoteHome, env }),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([h.server.connect(a), client.connect(b)]);
  hubs.push({ hub: h, client });
  return client;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const r: any = await c.callTool({ name, arguments: args });
  return { text: r.content.map((x: any) => x.text).join("\n"), isError: !!r.isError };
}

async function until(fn: () => Promise<boolean>, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const taskIdOf = (text: string) => text.match(/t_[0-9a-f]{8}/)![0];
const isDone = async (c: Client, id: string) => /\bdone\b/.test((await call(c, "ladvin_status", { task_id: id })).text);

beforeEach(() => {
  localHome = mkdtempSync(join(tmpdir(), "ladvin-local-"));
  remoteHome = mkdtempSync(join(tmpdir(), "ladvin-rhome-"));
  project = mkdtempSync(join(tmpdir(), "ladvin-proj-"));
  process.env.LADVIN_HOME = localHome;
  saveHost({ alias: "local1", os: "linux", arch: "x64", maxPreset: "worker", agentdVersion: "0.1.0", addedAt: "t" });
  writeAgentdConfig();
});

afterEach(async () => {
  const c = hubs[0]?.client;
  if (c) await call(c, "ladvin_stop_all").catch(() => {});
  for (const { hub: h } of hubs) {
    await h.pool.get("local1").call("shutdown", { force: true }).catch(() => {});
    h.pool.closeAll();
  }
  hubs.length = 0;
  env = {};
  delete process.env.LADVIN_HOME;
  await new Promise((r) => setTimeout(r, 300));
  for (const d of [localHome, remoteHome, project]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

test("delegate → done → wrapped report → fetch artifact", async () => {
  env = script([
    { writeFile: { path: "out.txt", content: "artifact-bytes" } },
    { callTool: { name: "ladvin_attach_artifact", args: { path: "out.txt" } } },
    { callTool: { name: "ladvin_report", args: { summary: "all good", status: "success" } } },
    { result: "bye" },
  ]);
  const c = await hub();
  const started = await call(c, "ladvin_delegate", { host: "local1", task: "do the thing" });
  expect(started.isError).toBe(false);
  const id = taskIdOf(started.text);
  await until(() => isDone(c, id));
  const rep = await call(c, "ladvin_report", { task_id: id });
  expect(rep.text).toContain('<ladvin-remote-content host="local1"');
  expect(rep.text).toContain("all good");
  const f = await call(c, "ladvin_fetch", { task_id: id, artifact: "out.txt" });
  expect(f.isError).toBe(false);
  expect(readFileSync(join(project, ".ladvin", "inbox", id, "out.txt"), "utf8")).toBe("artifact-bytes");
}, 40000);

test("input files are uploaded into the agent's .ladvin/inbox before it starts", async () => {
  env = script([
    {
      ifExists: ".ladvin/inbox/input.txt",
      then: [{ callTool: { name: "ladvin_report", args: { summary: "saw input", status: "success" } } }],
      else: [{ callTool: { name: "ladvin_report", args: { summary: "no input", status: "failed" } } }],
    },
    { result: "x" },
  ]);
  const input = join(project, "input.txt");
  writeFileSync(input, "data");
  const c = await hub();
  const id = taskIdOf((await call(c, "ladvin_delegate", { host: "local1", task: "use input", files: [input] })).text);
  await until(() => isDone(c, id));
  expect((await call(c, "ladvin_report", { task_id: id })).text).toContain("saw input");
}, 40000);

test("preset above the host maximum is refused", async () => {
  const c = await hub();
  const r = await call(c, "ladvin_delegate", { host: "local1", task: "x", preset: "yolo" });
  expect(r.isError).toBe(true);
  expect(r.text).toContain("exceeds host max");
});

test("unknown host is refused with a hint", async () => {
  const c = await hub();
  const r = await call(c, "ladvin_delegate", { host: "nope", task: "x" });
  expect(r.isError).toBe(true);
  expect(r.text).toContain("add-host");
});

test("a new hub in the same project sees a task started by a previous session", async () => {
  env = script([{ sleepMs: 1500 }, { callTool: { name: "ladvin_report", args: { summary: "survived", status: "success" } } }, { result: "x" }]);
  const c1 = await hub();
  const id = taskIdOf((await call(c1, "ladvin_delegate", { host: "local1", task: "slow" })).text);
  hubs[0]!.hub.pool.closeAll();
  const c2 = await hub();
  expect((await call(c2, "ladvin_status")).text).toContain(id);
  await until(() => isDone(c2, id));
  expect((await call(c2, "ladvin_report", { task_id: id })).text).toContain("survived");
}, 40000);

test("another project can see but not manage a task", async () => {
  env = script([{ sleepMs: 5000 }]);
  const c1 = await hub();
  const id = taskIdOf((await call(c1, "ladvin_delegate", { host: "local1", task: "x" })).text);
  const c2 = await hub({ machineId: "m1", projectDir: "/other" });
  expect((await call(c2, "ladvin_status", { host: "local1" })).text).toContain(`owned by ${project}`);
  const cancel = await call(c2, "ladvin_cancel", { task_id: id });
  expect(cancel.isError).toBe(true);
  expect(cancel.text).toContain(`belongs to ${project}`);
}, 40000);

test("stop_all cancels running tasks", async () => {
  env = script([{ sleepMs: 10000 }]);
  const c = await hub();
  const id = taskIdOf((await call(c, "ladvin_delegate", { host: "local1", task: "x" })).text);
  const r = await call(c, "ladvin_stop_all");
  expect(r.text).toContain("1");
  expect((await call(c, "ladvin_status", { task_id: id })).text).toContain("cancelled");
}, 40000);

test("hosts lists reachability and remove_host refuses while agents run", async () => {
  env = script([{ sleepMs: 10000 }]);
  const c = await hub();
  await call(c, "ladvin_delegate", { host: "local1", task: "x" });
  const hosts = await call(c, "ladvin_hosts");
  expect(hosts.text).toContain("local1");
  expect(hosts.text).toContain("reachable");
  expect(hosts.text).toContain("1 running");
  const rm = await call(c, "ladvin_remove_host", { alias: "local1" });
  expect(rm.isError).toBe(true);
  expect(rm.text).toContain("force");
  expect((await call(c, "ladvin_remove_host", { alias: "local1", force: true })).isError).toBe(false);
  expect((await call(c, "ladvin_hosts")).text).not.toContain("local1");
}, 40000);
