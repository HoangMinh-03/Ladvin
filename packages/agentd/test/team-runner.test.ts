import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskDir } from "../src/paths";
import { Runner } from "../src/runner";
import { TaskStore } from "../src/store";

const FAKE = join(import.meta.dir, "fake-claude.ts");
let home: string;
let store: TaskStore;
let runner: Runner;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ladvin-team-runner-"));
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
  delete process.env.LADVIN_HOME;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

const script = (s: unknown[]) => (process.env.FAKE_CLAUDE_SCRIPT = JSON.stringify(s));
const state = (id: string) => store.get(id)!.state;
const stream = (id: string) => readFileSync(join(taskDir(id), "stream.jsonl"), "utf8");
async function until(fn: () => boolean, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function member(role = "db-watcher"): string {
  const cwd = join(home, "work");
  mkdirSync(cwd, { recursive: true });
  return store.create({
    owner: { machineId: "m", projectDir: "/p" },
    preset: "observer",
    cwd,
    prompt: "",
    limits: { wallMs: 60_000 },
    kind: "team",
    team: { teamId: "team_1", role },
  }).taskId;
}

const RESPONDER = [{ say: "hi" }, { result: "turn1" }, { respond: [{ say: "got $INPUT" }, { result: "r" }] }];

test("a team member goes idle after a turn instead of finishing", async () => {
  script(RESPONDER);
  const id = member();
  runner.start(id, "Team goal: g");
  await until(() => state(id) === "idle");
  await new Promise((r) => setTimeout(r, 200));
  expect(state(id)).toBe("idle");
  expect(store.get(id)!.usage.input).toBe(10);
});

test("the team system prompt names the member's role", async () => {
  script(RESPONDER);
  const id = member("db-watcher");
  runner.start(id, "Team goal: g");
  await until(() => state(id) === "idle");
  const init = JSON.parse(stream(id).split("\n")[0]!);
  const sp = init.argv[init.argv.indexOf("--append-system-prompt") + 1];
  expect(sp).toContain("db-watcher");
  expect(sp).toContain("team_send");
});

test("inject delivers a message into the live session", async () => {
  script(RESPONDER);
  const id = member();
  runner.start(id, "Team goal: g");
  await until(() => state(id) === "idle");
  await runner.inject(id, "[ladvin message from local @ 10:00:00.000]: ping");
  await until(() => stream(id).includes("got [ladvin message from local @ 10:00:00.000]: ping")).catch((e) => {
    console.error(stream(id));
    throw e;
  });
  await until(() => state(id) === "idle");
});

test("stop ends a member gracefully with a reason", async () => {
  script(RESPONDER);
  const id = member();
  runner.start(id, "Team goal: g");
  await until(() => state(id) === "idle");
  runner.stop(id, "team ended");
  await until(() => state(id) === "done" && runner.running().length === 0);
  expect(store.get(id)!.failReason).toBe("team ended");
});

test("a message to an idle-stopped member resumes its session", async () => {
  script(RESPONDER);
  process.env.FAKE_CLAUDE_SCRIPT_RESUME = JSON.stringify([{ say: "got $INPUT" }, { result: "r" }, { respond: [{ say: "got $INPUT" }, { result: "r" }] }]);
  const id = member();
  runner.start(id, "Team goal: g");
  await until(() => state(id) === "idle");
  const session = store.get(id)!.sessionId;
  runner.stop(id, "stopped: idle timeout (resumable)");
  await until(() => state(id) === "done");
  await runner.inject(id, "wake");
  await until(() => stream(id).includes("got wake"));
  const inits = stream(id).trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.subtype === "init");
  expect(inits.at(-1).argv).toContain("--resume");
  expect(inits.at(-1).argv).toContain(session);
  delete process.env.FAKE_CLAUDE_SCRIPT_RESUME;
});

test("sweepIdle stops only idle members of teams without recent hub contact", async () => {
  script(RESPONDER);
  const idle = member();
  runner.start(idle, "Team goal: g");
  await until(() => state(idle) === "idle");
  const now = Date.now();
  expect(runner.sweepIdle(now, () => now, 1000)).toEqual([]);
  expect(runner.sweepIdle(now, () => now - 2000, 1000)).toEqual([idle]);
  await until(() => state(idle) === "done");
  expect(store.get(idle)!.failReason).toBe("stopped: idle timeout (resumable)");

  script([{ sleepMs: 3000 }]);
  const busy = member("busy");
  runner.start(busy, "Team goal: g");
  await until(() => state(busy) === "running");
  expect(runner.sweepIdle(Date.now(), () => 0, 1)).toEqual([]);
});
