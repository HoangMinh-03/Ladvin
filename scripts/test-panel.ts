// Runs the panel mod's tests (tests/*.test.tsx) with `claude plugin test`, which runs every test file under
// the folder it is given, so the mod's own files are copied to a temp folder without the package tests.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ladvin-panel-test-"));
try {
  for (const p of [".claude-plugin", "hooks", "types", "tests"]) cpSync(p, join(dir, p), { recursive: true });
  const r = spawnSync("claude", ["plugin", "test", dir], { stdio: "inherit", shell: process.platform === "win32" });
  process.exitCode = r.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
