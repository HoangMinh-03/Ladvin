import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BurnGetResult, LineCodec, RpcPeer } from "@ladvin/protocol";
import { BurnState } from "../src/burn";
import { socketPath } from "../src/paths";
import { Runner } from "../src/runner";
import { startServer } from "../src/server";
import { TaskStore } from "../src/store";

const FAKE = join(import.meta.dir, "fake-claude.ts");
let home: string;
let userHome: string;
let store: TaskStore;
let burn: BurnState;
let runner: Runner;
const sockets: Socket[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ladvin-burn-"));
  userHome = mkdtempSync(join(tmpdir(), "ladvin-burnuser-"));
  process.env.LADVIN_HOME = home;
  store = new TaskStore();
  burn = new BurnState({ userHome });
  runner = new Runner({
    store,
    hostName: "box",
    claudeBin: process.execPath,
    claudeBinArgs: [FAKE],
    agentMcpCommand: () => ({ command: process.execPath, args: ["-e", "0"] }),
    onRateLimit: (ev) => burn.recordRateLimit(ev, new Date()),
  });
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await runner.stopAll();
  delete process.env.FAKE_CLAUDE_SCRIPT;
  delete process.env.LADVIN_HOME;
  for (const d of [home, userHome])
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
});

async function until(fn: () => boolean, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("observed rate limits from agents are recorded with their time", async () => {
  process.env.FAKE_CLAUDE_SCRIPT = JSON.stringify([
    { emit: { type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1 }, seven_day: { utilization: 0.05, resetsAt: 2 } } } } },
    { result: "x" },
  ]);
  const t = store.create({ owner: { machineId: "m", projectDir: "/p" }, preset: "worker", cwd: home, prompt: "", limits: { wallMs: 60000 } });
  runner.start(t.taskId, "go");
  await until(() => store.get(t.taskId)!.state === "done");
  const snap = burn.snapshot(store, Date.now());
  expect(snap.rateLimit?.fiveHour).toEqual({ utilization: 0.42, resetsAt: 1 });
  expect(snap.rateLimit?.sevenDay?.utilization).toBe(0.05);
  expect(Date.now() - Date.parse(snap.rateLimit!.observedAt)).toBeLessThan(10_000);
  expect(snap.agents.map((a) => a.taskId)).toEqual([t.taskId]);
  // survives a restart (new BurnState on the same home)
  expect(new BurnState({ userHome }).snapshot(store, Date.now()).rateLimit?.fiveHour?.utilization).toBe(0.42);
});

test("host usage comes from the host's transcripts; account from .claude.json", () => {
  mkdirSync(join(userHome, ".claude", "projects", "x"), { recursive: true });
  const ts = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(
    join(userHome, ".claude", "projects", "x", "s.jsonl"),
    JSON.stringify({ type: "assistant", timestamp: ts, message: { id: "m1", usage: { input_tokens: 1, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) + "\n",
  );
  writeFileSync(join(userHome, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "acc-1", emailAddress: "a@b.c" } }));
  const snap = burn.snapshot(store, Date.now());
  expect(snap.usage.last5h.output).toBe(7);
  expect(snap.account).toEqual({ accountUuid: "acc-1", email: "a@b.c" });
  expect(snap.rateLimit).toBeNull();
});

test("burn.get and hello's binary hash over the socket", async () => {
  const server = await startServer({ store, runner, version: "t", burn });
  try {
    const s = connect(socketPath());
    sockets.push(s);
    await new Promise((r, j) => s.once("connect", r).once("error", j));
    s.setEncoding("utf8");
    const peer = new RpcPeer((l) => s.write(l));
    const codec = new LineCodec();
    s.on("data", (c: string) => codec.push(c).forEach((m) => peer.receive(m)));
    const hello = await peer.request<any>("hello", { protocolMajor: 1, client: { machineId: "m", projectDir: "/p" } });
    expect(hello.binarySha256).toMatch(/^[0-9a-f]{64}$/);
    const b = await peer.request<BurnGetResult>("burn.get", {});
    expect(b).toMatchObject({ account: null, rateLimit: null, agents: [] });
    expect(b.usage.last7d.input).toBe(0);
  } finally {
    await server.close();
  }
}, 20000);
