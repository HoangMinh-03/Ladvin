// Entry for dist/ladvin-statusline.js: one line for Claude Code's statusLine, from the hub's burn cache.
// Prints nothing when there is no fresh data, so it never shows stale numbers.
import { type AccountRow, readBurnCache } from "./burn/aggregate";

export function statusLine(rows: AccountRow[] | undefined): string {
  const real = rows?.filter((r) => r.key !== "unreachable");
  if (!real?.length) return "";
  const r = [...real].sort((a, b) => b.agentsRunning - a.agentsRunning)[0]!;
  const p = (w?: { utilization: number }) => (w ? `${Math.round(w.utilization * 100)}%` : "—");
  return `ladvin ⚡ ${r.label} 5h ${p(r.fiveHour)} · 7d ${p(r.sevenDay)} · ${r.agentsRunning} running${r.over.length ? " · ⚠ over budget" : ""}`;
}

process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  const line = statusLine(readBurnCache(10 * 60_000));
  if (line) process.stdout.write(line);
  process.exit(0);
});
