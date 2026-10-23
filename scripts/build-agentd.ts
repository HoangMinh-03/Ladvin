// Builds ladvin-agentd for every supported remote platform plus SHA256SUMS (used by CI releases and by
// developers with LADVIN_AGENTD_BINARY_DIR).  bun scripts/build-agentd.ts [--targets linux-x64,...] [--out dist-bin]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ALL = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
// x64 uses the baseline (no AVX2) runtime so older servers do not die with "Illegal instruction".
const BUN_TARGET: Record<string, string> = { "linux-x64": "bun-linux-x64-baseline", "darwin-x64": "bun-darwin-x64-baseline" };
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const targets = arg("--targets")?.split(",") ?? ALL;
const out = arg("--out") ?? "dist-bin";
mkdirSync(out, { recursive: true });

const sums: string[] = [];
for (const t of targets) {
  if (!ALL.includes(t)) throw new Error(`unknown target ${t}; use ${ALL.join(", ")}`);
  const name = `ladvin-agentd-${t}`;
  const file = join(out, name);
  const r = spawnSync(process.execPath, ["build", "--compile", `--target=${BUN_TARGET[t] ?? `bun-${t}`}`, "packages/agentd/src/main.ts", "--outfile", file], {
    stdio: "inherit",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
  sums.push(`${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${name}`);
}
writeFileSync(join(out, "SHA256SUMS"), sums.join("\n") + "\n");
console.log(`built ${targets.length} target(s) into ${out}`);
