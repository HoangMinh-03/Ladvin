import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  billable,
  type BurnGetResult,
  type RateWindow,
  readAccount,
  type ScanState,
  scanTranscripts,
  type Usage,
  windowSums,
  ZERO_USAGE,
} from "@ladvin/protocol";
import { type HostConfig, ladvinHome } from "../state";
import { type Budget, budgetFor } from "./budget";

type ObservedWindow = RateWindow & { observedAt: string };

export type AccountRow = {
  key: string;
  label: string;
  hosts: string[];
  includesLocal: boolean;
  fiveHour?: ObservedWindow;
  sevenDay?: ObservedWindow;
  last5h: Usage;
  last7d: Usage;
  billablePerMin15: number;
  agentsRunning: number;
  unreachable: string[];
  over: string[];
};

export type BurnPool = { get(alias: string): { call<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> } };

const add = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

function readJson<T>(f: string): T | undefined {
  try {
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(f: string, v: unknown): void {
  mkdirSync(ladvinHome(), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v));
  renameSync(tmp, f);
}

// The local machine's own usage (the Claude session this hub runs under, plus anything else on this machine).
function localBurn(userHome: string): BurnGetResult {
  const f = join(ladvinHome(), "local-usage-scan.json");
  const now = Date.now();
  const scan = scanTranscripts(join(userHome, ".claude", "projects"), readJson<ScanState>(f) ?? { files: {}, seen: [], events: [] }, now);
  writeJson(f, scan);
  return { account: readAccount(userHome), rateLimit: null, usage: windowSums(scan.events, now), agents: [] };
}

const newer = (a: ObservedWindow | undefined, b: ObservedWindow | undefined) =>
  !a ? b : !b ? a : Date.parse(b.observedAt) > Date.parse(a.observedAt) ? b : a;

export async function collectBurn(o: { pool: BurnPool; hosts: HostConfig[]; local: { userHome: string } }): Promise<AccountRow[]> {
  const results = await Promise.allSettled(o.hosts.map((h) => o.pool.get(h.alias).call<BurnGetResult>("burn.get", {}, 10_000)));
  const rows = new Map<string, AccountRow>();
  const rowFor = (key: string, label: string): AccountRow => {
    let r = rows.get(key);
    if (!r)
      rows.set(
        key,
        (r = { key, label, hosts: [], includesLocal: false, last5h: { ...ZERO_USAGE }, last7d: { ...ZERO_USAGE }, billablePerMin15: 0, agentsRunning: 0, unreachable: [], over: [] }),
      );
    return r;
  };
  const merge = (r: AccountRow, b: BurnGetResult) => {
    r.last5h = add(r.last5h, b.usage.last5h);
    r.last7d = add(r.last7d, b.usage.last7d);
    r.billablePerMin15 += b.usage.billablePerMin15;
    r.agentsRunning += b.agents.filter((a) => a.state === "running" || a.state === "idle").length;
    if (b.rateLimit) {
      const at = b.rateLimit.observedAt;
      r.fiveHour = newer(r.fiveHour, b.rateLimit.fiveHour && { ...b.rateLimit.fiveHour, observedAt: at });
      r.sevenDay = newer(r.sevenDay, b.rateLimit.sevenDay && { ...b.rateLimit.sevenDay, observedAt: at });
    }
  };
  const unreachable: string[] = [];
  results.forEach((res, i) => {
    const alias = o.hosts[i]!.alias;
    if (res.status === "rejected") return void unreachable.push(alias);
    const b = res.value;
    const r = b.account
      ? rowFor(b.account.accountUuid, b.account.email ?? b.account.name ?? b.account.accountUuid)
      : rowFor(`host:${alias}`, `${alias} (account unknown)`);
    r.hosts.push(alias);
    merge(r, b);
  });
  const local = localBurn(o.local.userHome);
  const lr = local.account
    ? rowFor(local.account.accountUuid, local.account.email ?? local.account.name ?? local.account.accountUuid)
    : rowFor("local", "this machine (account unknown)");
  lr.includesLocal = true;
  merge(lr, local);
  if (unreachable.length) {
    const r = rowFor("unreachable", "unreachable hosts");
    r.unreachable = unreachable;
  }
  for (const r of rows.values()) {
    const b = budgetFor(r.key);
    r.over = b ? overBudget(r, b) : [];
  }
  return [...rows.values()];
}

const pct = (u: number) => `${Math.round(u * 100)}%`;

export function overBudget(row: AccountRow, b: Budget): string[] {
  const out: string[] = [];
  if (b.fiveHourPct !== undefined && row.fiveHour && row.fiveHour.utilization * 100 >= b.fiveHourPct)
    out.push(`5h ${pct(row.fiveHour.utilization)} ≥ ${b.fiveHourPct}%`);
  if (b.sevenDayPct !== undefined && row.sevenDay && row.sevenDay.utilization * 100 >= b.sevenDayPct)
    out.push(`7d ${pct(row.sevenDay.utilization)} ≥ ${b.sevenDayPct}%`);
  if (b.fiveHourTokens !== undefined && billable(row.last5h) >= b.fiveHourTokens) out.push(`5h tokens ${billable(row.last5h)} ≥ ${b.fiveHourTokens}`);
  if (b.sevenDayTokens !== undefined && billable(row.last7d) >= b.sevenDayTokens) out.push(`7d tokens ${billable(row.last7d)} ≥ ${b.sevenDayTokens}`);
  return out;
}

const n = (x: number) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : String(Math.round(x)));

function ago(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function windowText(name: string, w?: ObservedWindow): string {
  if (!w) return `${name} —`;
  const reset = new Date(w.resetsAt * 1000);
  return `${name} ${pct(w.utilization)} (resets ${reset.toLocaleString()}, seen ${ago(w.observedAt)})`;
}

export function renderBurn(rows: AccountRow[]): string {
  const out: string[] = [];
  for (const r of rows) {
    if (r.key === "unreachable") {
      out.push(`⚠ unreachable: ${r.unreachable.join(", ")}`);
      continue;
    }
    const where = [...r.hosts, ...(r.includesLocal ? ["this machine"] : [])].join(", ");
    out.push(`${r.label} — ${where}`);
    out.push(`  ${windowText("5h", r.fiveHour)} · ${windowText("7d", r.sevenDay)}`);
    out.push(
      `  tokens 5h ${n(billable(r.last5h))} billable (cache read ${n(r.last5h.cacheRead)}) · 7d ${n(billable(r.last7d))} (cache read ${n(r.last7d.cacheRead)}) · now ${n(r.billablePerMin15)}/min`,
    );
    out.push(`  ladvin agents running: ${r.agentsRunning}${r.over.length ? `  ⚠ over budget: ${r.over.join(", ")}` : ""}`);
  }
  out.push("", "Utilization is what Claude last reported to a ladvin agent on that account; '—' means not observed yet.");
  return out.join("\n");
}

export const burnCacheFile = () => join(ladvinHome(), "burn-cache.json");

export function writeBurnCache(rows: AccountRow[]): void {
  writeJson(burnCacheFile(), { at: new Date().toISOString(), rows });
}

export function readBurnCache(maxAgeMs: number): AccountRow[] | undefined {
  const c = readJson<{ at: string; rows: AccountRow[] }>(burnCacheFile());
  if (!c || Date.now() - Date.parse(c.at) > maxAgeMs) return undefined;
  return c.rows;
}
