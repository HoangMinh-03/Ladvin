import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { saveHost } from "../src/state";
import { TeamStore } from "../src/team/store";
import { addToIndex } from "../src/tools/delegate";
import { registerSnapshotTool, type Snapshot } from "../src/tools/snapshot";

let home: string;
let project: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ladvin-snap-"));
  project = mkdtempSync(join(tmpdir(), "ladvin-snapproj-"));
  process.env.LADVIN_HOME = home;
});
afterEach(() => {
  delete process.env.LADVIN_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

async function snapshot(pool: any): Promise<Snapshot> {
  const server = new McpServer({ name: "t", version: "0" });
  const owner = { machineId: "m", projectDir: project };
  registerSnapshotTool(server, { owner, pool, store: new TeamStore(project) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), c.connect(b)]);
  const r: any = await c.callTool({ name: "ladvin_snapshot", arguments: {} });
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0].text);
}

test("snapshot: hosts with accounts, this project's tasks, team without marking read, cached burn", async () => {
  saveHost({ alias: "box", os: "linux", arch: "x64", maxPreset: "worker", agentdVersion: "0.3.3", addedAt: "t" });
  saveHost({ alias: "dead", os: "linux", arch: "x64", maxPreset: "worker", agentdVersion: "0.3.3", addedAt: "t" });
  addToIndex(project, { taskId: "t_00000001", host: "box" });
  addToIndex(project, { taskId: "t_00000002", host: "dead" });
  writeFileSync(
    join(home, "burn-cache.json"),
    JSON.stringify({
      at: new Date().toISOString(),
      rows: [{ key: "acc", label: "dev@example.com", hosts: ["box"], includesLocal: false, fiveHour: { utilization: 0.4, resetsAt: Math.floor(Date.now() / 1000) + 600, observedAt: new Date().toISOString() }, last5h: ZERO, last7d: ZERO, billablePerMin15: 0, agentsRunning: 1, unreachable: [], over: [] }],
    }),
  );
  const store = new TeamStore(project);
  const team = store.create("find the bottleneck", [{ taskId: "t_00000003", host: "box", role: "db-watch", preset: "observer", cwd: "/w" }]);
  store.appendInbox(team.teamId, { id: "m_1", at: new Date().toISOString(), role: "db-watch", host: "box", taskId: "t_00000003", text: "pool exhausted" });

  const pool = {
    get: (alias: string) => ({
      info: alias === "box" ? { agentdVersion: "0.3.3", clockOffsetMs: 0 } : null,
      call: async (m: string) => {
        if (alias === "dead") throw new Error("unreachable");
        if (m === "task.list")
          return [
            { taskId: "t_00000001", state: "running", kind: "delegate", preset: "worker", startedAt: new Date(Date.now() - 5000).toISOString(), usage: { ...ZERO, input: 3, output: 4 }, lastActivity: "Bash(ls)" },
            { taskId: "t_00000003", state: "idle", kind: "team", team: { teamId: team.teamId, role: "db-watch" }, preset: "observer", usage: ZERO },
          ];
        return {};
      },
    }),
  } as any;

  const s = await snapshot(pool);
  expect(s.hosts).toEqual([
    { alias: "box", account: "dev@example.com", reachable: true },
    { alias: "dead", reachable: false },
  ]);
  expect(s.tasks.map((t) => [t.taskId, t.state, t.host])).toEqual([
    ["t_00000001", "running", "box"],
    ["t_00000003", "idle", "box"],
  ]);
  expect(s.tasks[0]!.elapsedMs).toBeGreaterThan(4000);
  expect(s.tasks[1]!.role).toBe("db-watch");
  expect(s.team).toMatchObject({ teamId: team.teamId, goal: "find the bottleneck", unread: 1 });
  expect(s.team!.recent[0]).toMatchObject({ role: "db-watch", text: "pool exhausted" });
  expect(store.unread(team.teamId)).toHaveLength(1); // the panel must not consume messages
  expect(s.burn[0]).toMatchObject({ label: "dev@example.com", fiveHourPct: 40, running: 1, over: [] });
});

test("snapshot with nothing set up is empty, not an error", async () => {
  const s = await snapshot({ get: () => ({ info: null, call: async () => [] }) } as any);
  expect(s).toMatchObject({ hosts: [], tasks: [], team: null, burn: [] });
});

test("team members appear as agents even though delegate never indexed them; chat merges both directions", async () => {
  saveHost({ alias: "box", os: "linux", arch: "x64", maxPreset: "worker", agentdVersion: "0.3.3", addedAt: "t" });
  const store = new TeamStore(project);
  const team = store.create("Interactive chat with the user about this server", [{ taskId: "t_00000009", host: "box", role: "kata", preset: "observer", cwd: "/w" }]);
  store.appendInbox(team.teamId, { id: "m_1", at: "2026-10-23T09:00:01.000Z", role: "kata", host: "box", taskId: "t_00000009", text: "hello" });
  store.appendSent(team.teamId, { at: "2026-10-23T09:00:05.000Z", to: "kata", text: "how much RAM?" });
  const pool = {
    get: () => ({
      info: { agentdVersion: "0.3.3", clockOffsetMs: 0 },
      call: async (m: string) => (m === "task.get" ? { taskId: "t_00000009", state: "idle", kind: "team", team: { teamId: team.teamId, role: "kata" }, preset: "observer", usage: ZERO } : []),
    }),
  } as any;
  const s = await snapshot(pool);
  expect(s.tasks).toMatchObject([{ taskId: "t_00000009", state: "idle", role: "kata", host: "box" }]);
  expect(s.team!.chat).toEqual([
    { at: "2026-10-23T09:00:01.000Z", from: "kata", text: "hello" },
    { at: "2026-10-23T09:00:05.000Z", from: "you", text: "how much RAM?" },
  ]);
});
