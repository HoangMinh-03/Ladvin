import { expect, test } from "bun:test";
import { PROTOCOL_MAJOR, Report, TaskPrepareParams } from "../src/messages";

test("protocol major is 1", () => {
  expect(PROTOCOL_MAJOR).toBe(1);
});

test("task.prepare rejects unknown preset", () => {
  const r = TaskPrepareParams.safeParse({ owner: { machineId: "m", projectDir: "/p" }, preset: "root" });
  expect(r.success).toBe(false);
});

test("Report round-trips a full sample", () => {
  const sample = {
    taskId: "t_0123abcd",
    host: "box",
    status: "partial",
    summary: "s",
    details: "d",
    artifacts: [{ path: "out.txt", size: 3, note: "n" }],
    usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    startedAt: "2026-10-23T00:00:00.000Z",
    endedAt: "2026-10-23T00:01:00.000Z",
    reportMissing: true,
    permissionDenials: ["Bash(rm -rf x)"],
  };
  expect(Report.parse(JSON.parse(JSON.stringify(sample)))).toEqual(sample);
});

import { OutMsg, TaskState, TeamJoinParams } from "../src/messages";

test("team.join requires a role", () => {
  const owner = { machineId: "m", projectDir: "/p" };
  expect(TeamJoinParams.safeParse({ owner, teamId: "team_1", role: "", goal: "g", preset: "observer" }).success).toBe(false);
  expect(TeamJoinParams.safeParse({ owner, teamId: "team_1", role: "db", goal: "g", preset: "observer" }).success).toBe(true);
});

test("OutMsg round-trips every kind", () => {
  const base = { id: "m_000000000001", teamId: "team_1", taskId: "t_00000001", role: "db", sentAt: "2026-10-23T00:00:00.000Z" };
  for (const m of [
    { ...base, kind: "message", text: "hi" },
    { ...base, kind: "file", name: "a.log", path: "a.log", size: 3, sha256: "ab", note: "n" },
    { ...base, kind: "tasksOp", op: { op: "add", title: "watch iostat" } },
    { ...base, kind: "tasksOp", op: { op: "update", id: "k1", status: "done" } },
  ])
    expect(OutMsg.parse(JSON.parse(JSON.stringify(m)))).toEqual(m as any);
});

test("idle is a task state", () => {
  expect(TaskState.parse("idle")).toBe("idle");
});
