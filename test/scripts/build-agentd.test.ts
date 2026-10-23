import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

test("build-agentd writes the binary and a matching SHA256SUMS line", () => {
  const out = mkdtempSync(join(tmpdir(), "ladvin-build-"));
  try {
    const r = spawnSync(process.execPath, ["scripts/build-agentd.ts", "--targets", "linux-x64", "--out", out], { cwd: ROOT, encoding: "utf8" });
    expect(r.status).toBe(0);
    const bin = readFileSync(join(out, "ladvin-agentd-linux-x64"));
    const sums = readFileSync(join(out, "SHA256SUMS"), "utf8").trim().split("\n");
    expect(sums).toEqual([`${createHash("sha256").update(bin).digest("hex")}  ladvin-agentd-linux-x64`]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 120000);
