import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskInfo } from "@ladvin/protocol";
import { taskDir } from "../src/paths";
import { Runner } from "../src/runner";
import { TaskStore } from "../src/store";
import { renderEvent, view } from "../src/viewer";

const FAKE = join(import.meta.dir, "fake-claude.ts");
let home: string;
let store: TaskStore;
let runner: Runner;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ladvin-runner-"));
  process.env.LADVIN_HOME = home;
  store = new TaskStore();
  runner = new Runner({
    store,
    hostName: "box",
    claudeBin: process.execPath,
    claudeBinArgs: [FAKE],
    agentMcpCommand: () => ({ command: process.execPath, args: ["-e", "0"] }),
  });
});
afterEach(async () => {
  await runner.stopAll();
  delete process.env.FAKE_CLAUDE_SCRIPT;
  delete process.env.FAKE_CLAUDE_SCRIPT_RESUME;
  delete process.env.LADVIN_HOME;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

function newTask(limits = { wallMs: 60_000 } as TaskInfo["limits"]): string {
  const cwd = join(home, "work");
  mkdirSync(cwd, { recursive: true });
  const t = store.create({ owner: { machineId: "m", projectDir: "/p" }, preset: "worker", cwd, prompt: "", limits });
  return t.taskId;
}

async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const script = (s: unknown[]) => (process.env.FAKE_CLAUDE_SCRIPT = JSON.stringify(s));
const state = (id: string) => store.get(id)!.state;

test("agent report marks task done with success report and session id", async () => {
  script([{ say: "working" }, { waitInput: true }]);
  const id = newTask();
  runner.start(id, "do it");
  await until(() => !!store.get(id)?.sessionId);
  runner.onAgentReport(id, { summary: "ok", status: "success" });
  await until(() => state(id) === "done");
  expect(store.getReport(id)).toMatchObject({ status: "success", summary: "ok", reportMissing: false, host: "box" });
  expect(store.get(id)!.sessionId).toMatch(/^fake-/);
});

test("result without agent report → partial, final words, reportMissing", async () => {
  script([{ say: "final words" }, { result: "final words" }]);
  const id = newTask();
  runner.start(id, "do it");
  await until(() => state(id) === "done");
  expect(store.getReport(id)).toMatchObject({ status: "partial", summary: "final words", reportMissing: true });
  await until(() => store.getReport(id)!.usage.input === 10);
});

test("exit before result → failed with exit code", async () => {
  script([{ say: "oops" }, { exit: 3 }]);
  const id = newTask();
  runner.start(id, "do it");
  await until(() => state(id) === "failed");
  expect(store.get(id)!.failReason).toContain("code 3");
});

test("wall limit kills the agent", async () => {
  script([{ sleepMs: 5000 }, { result: "late" }]);
  const id = newTask({ wallMs: 200 });
  const t0 = Date.now();
  runner.start(id, "do it");
  await until(() => state(id) === "failed", 2000);
  expect(Date.now() - t0).toBeLessThan(1500);
  expect(store.get(id)!.failReason).toBe("limit: wall");
});

test("token limit kills the agent", async () => {
  script([{ result: "turn" }, { waitInput: true }]);
  // fake result usage: input 10 + output 5 + cacheWrite 20 = 35 > 30
  const id = newTask({ wallMs: 60_000, maxTokens: 30 });
  runner.start(id, "do it");
  await until(() => store.get(id)!.failReason === "limit: tokens" || state(id) === "done");
  expect(store.get(id)!.failReason).toBe("limit: tokens");
});

test("follow-up resumes the session and archives the previous report", async () => {
  script([{ result: "first" }]);
  process.env.FAKE_CLAUDE_SCRIPT_RESUME = JSON.stringify([{ result: "second" }]);
  const id = newTask();
  runner.start(id, "do it");
  await until(() => state(id) === "done");
  const session = store.get(id)!.sessionId!;
  await until(() => runner.running().length === 0);
  runner.followup(id, "more");
  await until(() => store.get(id)!.runs === 2 && state(id) === "done" && store.getReport(id)?.summary === "second");
  expect(existsSync(join(taskDir(id), "reports", "1.json"))).toBe(true);
  const init = readFileSync(join(taskDir(id), "stream.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.subtype === "init")
    .pop();
  expect(init.argv).toContain("--resume");
  expect(init.argv[init.argv.indexOf("--resume") + 1]).toBe(session);
});

test("cancel stops a running agent", async () => {
  script([{ sleepMs: 5000 }]);
  const id = newTask();
  runner.start(id, "do it");
  await until(() => state(id) === "running");
  runner.cancel(id);
  await until(() => state(id) === "cancelled");
  expect(runner.running()).toEqual([]);
});

test("renderEvent formats assistant text and tools", () => {
  expect(
    renderEvent('{"type":"assistant","message":{"content":[{"type":"text","text":"Hi"},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}'),
  ).toBe("▸ assistant: Hi\n⚙ tool: Bash(ls)");
  expect(renderEvent('{"type":"system","subtype":"hook_started"}')).toBeNull();
});

test("a claude binary that cannot be spawned fails the task instead of crashing", async () => {
  const r = new Runner({ store, hostName: "box", claudeBin: join(home, "no-such-claude"), agentMcpCommand: () => ({ command: "x", args: [] }) });
  const id = newTask();
  r.start(id, "do it");
  await until(() => state(id) === "failed");
  expect(store.get(id)!.failReason).toContain("cannot start claude");
  expect(r.running()).toEqual([]);
});

test("token limit triggers mid-turn from assistant usage, without waiting for result", async () => {
  const msg = (id: string) => ({ emit: { type: "assistant", message: { id, content: [{ type: "text", text: "." }], usage: { input_tokens: 20, output_tokens: 20 } } } });
  // the same message id streamed twice must be counted once: 40 ≤ 50, then m2 → 80 > 50
  script([msg("m1"), msg("m1"), { sleepMs: 300 }, msg("m2"), { waitInput: true }]);
  const id = newTask({ wallMs: 60_000, maxTokens: 50 });
  runner.start(id, "do it");
  await until(() => state(id) === "failed");
  expect(store.get(id)!.failReason).toBe("limit: tokens");
});

test("two rapid follow-ups: one runs, the other is rejected, and nothing crashes", async () => {
  script([{ result: "first" }]);
  process.env.FAKE_CLAUDE_SCRIPT_RESUME = JSON.stringify([{ result: "again" }]);
  const id = newTask();
  runner.start(id, "do it");
  await until(() => state(id) === "done");
  const results = await Promise.allSettled([runner.followup(id, "a"), runner.followup(id, "b")]);
  expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  await until(() => store.get(id)!.runs === 2 && state(id) === "done");
});

test("runner passes its configured env (e.g. the login PATH) to claude", async () => {
  const r = new Runner({
    store,
    hostName: "box",
    claudeBin: process.execPath,
    claudeBinArgs: [FAKE],
    env: { LADVIN_TEST_MARK: "login-path" },
    agentMcpCommand: () => ({ command: "x", args: [] }),
  });
  script([{ result: "x" }]);
  const id = newTask();
  r.start(id, "do it");
  await until(() => state(id) === "done");
  await r.stopAll();
  expect(readFileSync(join(taskDir(id), "stream.jsonl"), "utf8")).toContain('"envMark":"login-path"');
});

test("viewer exits after the task reaches a terminal state", async () => {
  const id = newTask();
  store.appendStream(id, '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}');
  store.update(id, { state: "done" });
  const lines: string[] = [];
  await view(id, { pollMs: 10, lingerMs: 0, write: (s) => lines.push(s) });
  expect(lines.join("")).toContain("▸ assistant: hi");
  expect(lines.join("")).toContain("finished");
});
