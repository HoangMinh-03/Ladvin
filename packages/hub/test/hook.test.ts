import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/hook";
import { projectStateDir } from "../src/state";
import { TeamStore } from "../src/team/store";

const ROOT = join(import.meta.dir, "..", "..", "..");
let home: string;
let project: string;
let store: TeamStore;
let teamId: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ladvin-hook-"));
  project = mkdtempSync(join(tmpdir(), "ladvin-hookproj-"));
  process.env.LADVIN_HOME = home;
  store = new TeamStore(project);
  teamId = store.create("g", [{ taskId: "t_00000001", host: "h", role: "db", preset: "observer", cwd: "/w" }]).teamId;
  for (const [id, text] of [["m_1", "load 7.9 at 14:03"], ["m_2", "pool exhausted"]])
    store.appendInbox(teamId, { id, at: new Date().toISOString(), role: "db", host: "h", taskId: "t_00000001", text });
});
afterEach(() => {
  delete process.env.LADVIN_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const env = () => ({ CLAUDE_PROJECT_DIR: project });

test("PostToolUse surfaces unread teammate messages once", () => {
  const out = JSON.parse(runHook("post", {}, env()));
  expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  expect(out.hookSpecificOutput.additionalContext).toContain("ladvin team: 2 new message(s)");
  expect(out.hookSpecificOutput.additionalContext).toContain("pool exhausted");
  expect(store.unread(teamId)).toEqual([]);
  expect(runHook("post", {}, env())).toBe("");
});

test("Stop blocks only while something is unread, so it cannot loop", () => {
  const out = JSON.parse(runHook("stop", { cwd: project }, env()));
  expect(out.decision).toBe("block");
  expect(out.reason).toContain("load 7.9 at 14:03");
  expect(runHook("stop", { cwd: project, stop_hook_active: true }, env())).toBe("");
});

test("project is found from the hook input cwd when CLAUDE_PROJECT_DIR is unset", () => {
  expect(JSON.parse(runHook("stop", { cwd: project }, {})).decision).toBe("block");
});

test("no active team → silent", () => {
  store.end(teamId);
  expect(runHook("post", {}, env())).toBe("");
  expect(runHook("stop", {}, env())).toBe("");
});

test("corrupt state → silent, never throws", () => {
  writeFileSync(join(projectStateDir(project), "teams", teamId, "team.json"), "{nope");
  expect(runHook("post", {}, env())).toBe("");
});

test("bundled hook script prints the block decision", () => {
  const build = spawnSync(process.execPath, ["run", "build:hub"], { cwd: ROOT, encoding: "utf8" });
  expect(build.status).toBe(0);
  const r = spawnSync("node", [join(ROOT, "dist", "ladvin-hook.js"), "stop"], {
    input: JSON.stringify({ cwd: project }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, LADVIN_HOME: home },
    encoding: "utf8",
  });
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout).decision).toBe("block");
}, 60000);
