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
