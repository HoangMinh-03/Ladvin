import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskDir } from "../src/paths";
import { TaskStore } from "../src/store";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ladvin-store-"));
  process.env.LADVIN_HOME = home;
});
afterEach(() => {
  delete process.env.LADVIN_HOME;
  rmSync(home, { recursive: true, force: true });
});

const base = (projectDir: string) => ({
  owner: { machineId: "m", projectDir },
  preset: "worker" as const,
  cwd: "/w",
  prompt: "",
});

test("create then get round-trips with queued state and zero usage", () => {
  const s = new TaskStore();
  const t = s.create(base("/a"));
  expect(t.taskId).toMatch(/^t_[0-9a-f]{8}$/);
  expect(s.get(t.taskId)).toMatchObject({ state: "queued", runs: 0, usage: { input: 0 } });
});

test("list(owner) excludes tasks of another project", () => {
  const s = new TaskStore();
  const a = s.create(base("/a"));
  s.create(base("/b"));
  expect(s.list({ machineId: "m", projectDir: "/a" }).map((t) => t.taskId)).toEqual([a.taskId]);
  expect(s.list().length).toBe(2);
});

test("update persists across store instances", () => {
  const t = new TaskStore().create(base("/a"));
  new TaskStore().update(t.taskId, { state: "running", sessionId: "s1" });
  expect(new TaskStore().get(t.taskId)).toMatchObject({ state: "running", sessionId: "s1" });
});

test("appendStream writes one line per call", () => {
  const s = new TaskStore();
  const t = s.create(base("/a"));
  s.appendStream(t.taskId, '{"a":1}');
  s.appendStream(t.taskId, '{"b":2}');
  const lines = readFileSync(join(taskDir(t.taskId), "stream.jsonl"), "utf8").trim().split("\n");
  expect(lines.length).toBe(2);
});

test("artifacts accumulate and report round-trips", () => {
  const s = new TaskStore();
  const t = s.create(base("/a"));
  s.addArtifact(t.taskId, { path: "a.txt", size: 1 });
  s.addArtifact(t.taskId, { path: "b.txt", size: 2, note: "n" });
  expect(s.artifacts(t.taskId).map((a) => a.path)).toEqual(["a.txt", "b.txt"]);
  expect(s.getReport(t.taskId)).toBeUndefined();
});
