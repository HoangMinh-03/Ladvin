import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutMsg } from "@ladvin/protocol";
import { TeamPoller } from "../src/team/poller";
import { applyOp, type InboxEntry, TeamStore } from "../src/team/store";
import { fmt, renderInbox, toLocal, toRemote } from "../src/team/time";

let home: string;
let project: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ladvin-teamstore-"));
  project = mkdtempSync(join(tmpdir(), "ladvin-teamproj-"));
  process.env.LADVIN_HOME = home;
});
afterEach(() => {
  delete process.env.LADVIN_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const member = { taskId: "t_00000001", host: "h", role: "db", preset: "observer" as const, cwd: "/w" };
const entry = (id: string, text = "x"): InboxEntry => ({ id, at: new Date().toISOString(), role: "db", host: "h", taskId: "t_00000001", text });

test("one active team per project", () => {
  const s = new TeamStore(project);
  const t = s.create("goal", [member]);
  expect(t.teamId).toMatch(/^team_[0-9a-f]{8}$/);
  expect(s.active()?.teamId).toBe(t.teamId);
  expect(() => s.create("again", [member])).toThrow(`a team is already active in this project (${t.teamId})`);
  s.end(t.teamId);
  expect(s.active()).toBeUndefined();
  expect(s.get(t.teamId)?.status).toBe("ended");
  expect(s.create("next", [member]).teamId).not.toBe(t.teamId);
});

test("inbox dedupes by id and tracks what was read", () => {
  const s = new TeamStore(project);
  const { teamId } = s.create("g", [member]);
  expect(s.appendInbox(teamId, entry("m_1", "a"))).toBe(true);
  expect(s.appendInbox(teamId, entry("m_1", "a"))).toBe(false);
  expect(s.unread(teamId).map((e) => e.text)).toEqual(["a"]);
  s.markRead(teamId);
  expect(s.unread(teamId)).toEqual([]);
  s.appendInbox(teamId, entry("m_2", "b"));
  expect(s.unread(teamId).map((e) => e.text)).toEqual(["b"]);
  expect(s.all(teamId)).toHaveLength(2);
});

test("clock normalisation", () => {
  expect(toLocal("2026-10-23T10:00:01.000Z", 1000).toISOString()).toBe("2026-10-23T10:00:00.000Z");
  expect(toRemote(new Date("2026-10-23T10:00:00.000Z"), 1000).toISOString()).toBe("2026-10-23T10:00:01.000Z");
  expect(fmt(new Date(2026, 9, 23, 9, 5, 7, 42))).toBe("09:05:07.042");
});

test("applyOp adds with k-ids and updates by id", () => {
  let tasks = applyOp([], { op: "add", title: "a" }, "local");
  tasks = applyOp(tasks, { op: "add", title: "b", owner: "db" }, "db");
  tasks = applyOp(tasks, { op: "update", id: "k1", status: "done", note: "ok" }, "db");
  tasks = applyOp(tasks, { op: "update", id: "k9", status: "done" }, "db");
  expect(tasks).toEqual([
    { id: "k1", title: "a", status: "done", note: "ok" },
    { id: "k2", title: "b", status: "todo", owner: "db" },
  ]);
});

test("renderInbox stamps and wraps each entry", () => {
  const out = renderInbox([entry("m_1", "load 7.9")]);
  expect(out).toContain('<ladvin-remote-content host="h" agent="t_00000001">');
  expect(out).toMatch(/\[\d\d:\d\d:\d\d\.\d{3}\] db@h: load 7\.9/);
});

test("pollOnce routes messages, files and task ops, then acks", async () => {
  const s = new TeamStore(project);
  const team = s.create("g", [member]);
  const base = { teamId: team.teamId, taskId: member.taskId, role: "db", sentAt: "2026-10-23T10:00:01.000Z" };
  const msgs: OutMsg[] = [
    { ...base, id: "m_a", kind: "message", text: "hello" },
    { ...base, id: "m_b", kind: "file", name: "x.log", path: "logs/x.log", size: 2, sha256: "s" },
    { ...base, id: "m_c", kind: "tasksOp", op: { op: "add", title: "watch" } },
  ];
  const calls: [string, any][] = [];
  const downloads: [string, string][] = [];
  const pool = {
    get: () => ({
      info: { clockOffsetMs: 1000, agentdVersion: "0.1.0" },
      call: async (m: string, p: any) => {
        calls.push([m, p]);
        return m === "team.pull" ? { messages: msgs } : {};
      },
    }),
    transport: () => ({
      download: async (remote: string, local: string) => {
        downloads.push([remote, local]);
        writeFileSync(local, "hi");
      },
    }),
  } as any;
  const poller = new TeamPoller({ store: s, pool, owner: { machineId: "m", projectDir: project }, projectDir: project });
  expect(await poller.pollOnce()).toBe(3);
  const inbox = s.unread(team.teamId);
  expect(inbox[0]).toMatchObject({ id: "m_a", text: "hello", at: "2026-10-23T10:00:00.000Z" });
  expect(inbox[1]!.text).toContain("shared file x.log (2 bytes)");
  expect(inbox[2]!.text).toContain("task list: added k1 watch");
  expect(downloads[0]![0]).toBe("/w/logs/x.log");
  const local = join(project, ".ladvin", "shared", team.teamId, "x.log");
  expect(downloads[0]![1]).toBe(local);
  expect(existsSync(local)).toBe(true);
  expect(readFileSync(join(project, ".ladvin", "shared", team.teamId, "manifest.jsonl"), "utf8")).toContain('"name":"x.log"');
  expect(s.get(team.teamId)!.tasks).toEqual([{ id: "k1", title: "watch", status: "todo" }]);
  expect(calls.find(([m]) => m === "team.syncTasks")?.[1]).toEqual({ teamId: team.teamId, tasks: [{ id: "k1", title: "watch", status: "todo" }] });
  expect(calls.find(([m]) => m === "team.ack")?.[1]).toEqual({ ids: ["m_a", "m_b", "m_c"] });
  // the same entries pulled again (ack lost) do not duplicate the inbox
  await poller.pollOnce();
  expect(s.all(team.teamId)).toHaveLength(3);
});
