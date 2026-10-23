import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGitignore, loadHosts, machineId, projectStateDir, removeHost, saveHost } from "../src/state";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ladvin-hub-"));
  process.env.LADVIN_HOME = home;
});
afterEach(() => {
  delete process.env.LADVIN_HOME;
  rmSync(home, { recursive: true, force: true });
});

const host = { alias: "a", os: "linux" as const, arch: "x64" as const, maxPreset: "worker" as const, agentdVersion: "0.1.0", addedAt: "t" };

test("hosts save, replace and remove", () => {
  saveHost(host);
  saveHost({ ...host, maxPreset: "observer" });
  expect(loadHosts()).toEqual([{ ...host, maxPreset: "observer" }]);
  removeHost("a");
  expect(loadHosts()).toEqual([]);
});

test("machineId is stable", () => {
  expect(machineId()).toBe(machineId());
});

test("projectStateDir is per project and under home", () => {
  expect(projectStateDir("/a")).not.toBe(projectStateDir("/b"));
  expect(projectStateDir("/a").startsWith(join(home, "state"))).toBe(true);
});

test("ensureGitignore appends .ladvin/ once, only when .gitignore exists", () => {
  const proj = mkdtempSync(join(tmpdir(), "ladvin-proj-"));
  ensureGitignore(proj);
  expect(existsSync(join(proj, ".gitignore"))).toBe(false);
  writeFileSync(join(proj, ".gitignore"), "node_modules/");
  ensureGitignore(proj);
  ensureGitignore(proj);
  expect(readFileSync(join(proj, ".gitignore"), "utf8")).toBe("node_modules/\n.ladvin/\n");
  rmSync(proj, { recursive: true, force: true });
});
