import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BurnGetResult } from "@ladvin/protocol";
import { collectBurn, overBudget, renderBurn } from "../src/burn/aggregate";
import { saveBudget } from "../src/burn/budget";
import { createHub, type Hub } from "../src/hub";
import { type HostConfig, saveHost } from "../src/state";
import { localTransport } from "../src/transport";

const ROOT = join(import.meta.dir, "..", "..", "..");
let home: string;
let userHome: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ladvin-hubburn-"));
  userHome = mkdtempSync(join(tmpdir(), "ladvin-hubburnuser-"));
  process.env.LADVIN_HOME = home;
});
afterEach(() => {
  delete process.env.LADVIN_HOME;
  for (const d of [home, userHome])
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
});

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const host = (alias: string): HostConfig => ({ alias, os: "linux", arch: "x64", maxPreset: "worker", agentdVersion: "0.3.3", addedAt: "t" });
const result = (o: Partial<BurnGetResult> = {}): BurnGetResult => ({
  account: { accountUuid: "acc-1", email: "dev@example.com" },
  rateLimit: null,
  usage: { last5h: { input: 10, output: 5, cacheRead: 1000, cacheWrite: 20 }, last7d: { input: 10, output: 5, cacheRead: 1000, cacheWrite: 20 }, billablePerMin15: 2 },
  agents: [{ taskId: "t_1", state: "running", kind: "delegate", usage: ZERO }],
  ...o,
});
const fakePool = (byAlias: Record<string, BurnGetResult | Error>) =>
  ({
    get: (alias: string) => ({
      call: async () => {
        const r = byAlias[alias];
        if (r instanceof Error) throw r;
        return r;
      },
    }),
  }) as any;

// windows that have not reset yet (epoch seconds)
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

test("hosts on one account become one row; the newest observed window wins", async () => {
  const rows = await collectBurn({
    pool: fakePool({
      a: result({ rateLimit: { fiveHour: { utilization: 0.3, resetsAt: FUTURE }, observedAt: minutesAgo(30) } }),
      b: result({ rateLimit: { fiveHour: { utilization: 0.42, resetsAt: FUTURE }, sevenDay: { utilization: 0.05, resetsAt: FUTURE }, observedAt: minutesAgo(2) } }),
    }),
    hosts: [host("a"), host("b")],
    local: { userHome },
  });
  const acc = rows.find((r) => r.key === "acc-1")!;
  expect(acc.hosts.sort()).toEqual(["a", "b"]);
  expect(acc.fiveHour?.utilization).toBe(0.42);
  expect(acc.agentsRunning).toBe(2);
  expect(acc.last5h.output).toBe(10);
});

test("unknown account, unreachable host, and the local machine", async () => {
  writeFileSync(join(userHome, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "acc-local", emailAddress: "me@local" } }));
  const rows = await collectBurn({
    pool: fakePool({ x: result({ account: null }), dead: new Error("host dead unreachable") }),
    hosts: [host("x"), host("dead")],
    local: { userHome },
  });
  expect(rows.find((r) => r.key === "host:x")!.label).toContain("account unknown");
  expect(rows.some((r) => r.unreachable.includes("dead"))).toBe(true);
  expect(rows.find((r) => r.key === "acc-local")!.includesLocal).toBe(true);
});

test("render shows observed utilization with its age, '—' when unknown, cache reads apart", async () => {
  const rows = await collectBurn({
    pool: fakePool({ a: result({ rateLimit: { fiveHour: { utilization: 0.42, resetsAt: FUTURE }, observedAt: minutesAgo(3) } }), x: result({ account: null }) }),
    hosts: [host("a"), host("x")],
    local: { userHome },
  });
  const out = renderBurn(rows);
  expect(out).toContain("5h 42%");
  expect(out).toContain("seen 3 min ago");
  expect(out).toContain("5h —");
  expect(out).toContain("cache read");
});

test("budgets: utilization and billable tokens", async () => {
  const [row] = (
    await collectBurn({
      pool: fakePool({ a: result({ rateLimit: { fiveHour: { utilization: 0.42, resetsAt: FUTURE }, observedAt: minutesAgo(1) } }) }),
      hosts: [host("a")],
      local: { userHome },
    })
  ).filter((r) => r.key === "acc-1");
  expect(overBudget(row!, { fiveHourPct: 40 })).toEqual(["5h 42% ≥ 40%"]);
  expect(overBudget(row!, { fiveHourTokens: 10 })).toEqual(["5h tokens 35 ≥ 10"]);
  expect(overBudget(row!, { fiveHourPct: 50, sevenDayTokens: 100 })).toEqual([]);
});

test("delegate is refused while the host's account is over budget", async () => {
  const MAIN = join(ROOT, "packages", "agentd", "src", "main.ts");
  const remote = mkdtempSync(join(tmpdir(), "ladvin-hubburnremote-"));
  process.env.LADVIN_USER_HOME = userHome;
  saveHost(host("box"));
  saveBudget("*", { fiveHourTokens: 0 });
  const h: Hub = createHub({
    owner: { machineId: "m", projectDir: userHome },
    transportFor: () => localTransport({ agentdCmd: [process.execPath, MAIN], userHome: remote, env: { LADVIN_USER_HOME: remote } }),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "t", version: "0" });
  await Promise.all([h.server.connect(a), c.connect(b)]);
  try {
    const r: any = await c.callTool({ name: "ladvin_delegate", arguments: { host: "box", task: "x" } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("budget");
    expect(r.content[0].text).toContain("ladvin_budget");
    const burn: any = await c.callTool({ name: "ladvin_burn", arguments: {} });
    expect(burn.content[0].text).toContain("box");
  } finally {
    await h.pool.get("box").call("shutdown", { force: true }).catch(() => {});
    h.close();
    delete process.env.LADVIN_USER_HOME;
    await new Promise((r) => setTimeout(r, 300));
    rmSync(remote, { recursive: true, force: true });
  }
}, 40000);

test("statusline prints the busiest account from a fresh cache, nothing when stale", () => {
  spawnSync(process.execPath, ["run", "build:hub"], { cwd: ROOT });
  const run = () =>
    spawnSync("node", [join(ROOT, "dist", "ladvin-statusline.js")], { input: "{}", env: { ...process.env, LADVIN_HOME: home }, encoding: "utf8" }).stdout;
  expect(run()).toBe("");
  const row = { key: "acc-1", label: "dev@example.com", hosts: ["a"], includesLocal: false, fiveHour: { utilization: 0.23, resetsAt: FUTURE, observedAt: minutesAgo(1) }, sevenDay: { utilization: 0.04, resetsAt: FUTURE, observedAt: minutesAgo(1) }, last5h: ZERO, last7d: ZERO, billablePerMin15: 0, agentsRunning: 2, unreachable: [], over: [] };
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "burn-cache.json"), JSON.stringify({ at: new Date().toISOString(), rows: [row] }));
  expect(run()).toContain("5h 23% · 7d 4% · 2 running");
  writeFileSync(join(home, "burn-cache.json"), JSON.stringify({ at: minutesAgo(30), rows: [row] }));
  expect(run()).toBe("");
}, 60000);

// ---- review fixes ----
test("an observed window that has already reset counts as unobserved (no permanent lockout)", async () => {
  const past = Math.floor(Date.now() / 1000) - 60;
  const [row] = (
    await collectBurn({
      pool: fakePool({ a: result({ rateLimit: { fiveHour: { utilization: 0.95, resetsAt: past }, observedAt: minutesAgo(400) } }) }),
      hosts: [host("a")],
      local: { userHome },
    })
  ).filter((r) => r.key === "acc-1");
  expect(row!.fiveHour).toBeUndefined();
  expect(overBudget(row!, { fiveHourPct: 90 })).toEqual([]);
  expect(renderBurn([row!])).toContain("5h —");
});

test("budget changes apply immediately, even with a fresh cached snapshot", async () => {
  const { makeBudgetGuard } = await import("../src/tools/burn");
  saveHost(host("a"));
  process.env.LADVIN_USER_HOME = userHome;
  try {
    const pool = fakePool({ a: result() }); // billable 5h = 35
    const guard = makeBudgetGuard(pool);
    expect(await guard("a")).toBeNull(); // caches rows
    saveBudget("acc-1", { fiveHourTokens: 10 });
    expect(await guard("a")).toContain("over its ladvin budget");
    saveBudget("acc-1", null);
    expect(await guard("a")).toBeNull();
  } finally {
    delete process.env.LADVIN_USER_HOME;
  }
});

test("a host that never answers cannot stall collection past the deadline", async () => {
  const pool = { get: () => ({ call: () => new Promise(() => {}) }) } as any;
  const t0 = Date.now();
  const rows = await collectBurn({ pool, hosts: [host("hang")], local: { userHome }, deadlineMs: 300 });
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(rows.some((r) => r.unreachable.includes("hang"))).toBe(true);
});
