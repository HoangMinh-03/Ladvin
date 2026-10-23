// Claude Code usage from its own transcripts (~/.claude/projects/**/*.jsonl), shared by agentd (per host)
// and the hub (local machine). Incremental: remembers byte offsets and message ids already counted.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Usage, ZERO_USAGE } from "./messages";

export type UsageEvent = { ts: number; id: string; usage: Usage };
export type ScanState = { files: Record<string, number>; seen: string[]; events: UsageEvent[] };

const WEEK_MS = 7 * 86400_000;

export const billable = (u: Usage): number => u.input + u.output + u.cacheWrite;

function jsonlFiles(dir: string, out: string[] = []): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) jsonlFiles(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function mapUsage(u: any): Usage {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    cacheWrite: u?.cache_creation_input_tokens ?? 0,
  };
}

export function scanTranscripts(root: string, state: ScanState, now: number): ScanState {
  const seen = new Set(state.seen);
  const events = [...state.events];
  const files: Record<string, number> = {};
  for (const f of jsonlFiles(root)) {
    let size: number;
    try {
      size = statSync(f).size;
    } catch {
      continue;
    }
    let offset = state.files[f] ?? 0;
    if (size < offset) offset = 0; // truncated or replaced: ids already seen keep it from double counting
    if (size > offset) {
      const buf = Buffer.alloc(size - offset);
      try {
        const fd = openSync(f, "r");
        try {
          readSync(fd, buf, 0, buf.length, offset);
        } finally {
          closeSync(fd);
        }
      } catch {
        files[f] = offset;
        continue;
      }
      const end = buf.lastIndexOf(0x0a); // only complete lines; a partial tail is read next time
      if (end >= 0) {
        for (const l of buf.subarray(0, end).toString("utf8").split("\n")) {
          if (!l.includes('"usage"')) continue;
          let o: any;
          try {
            o = JSON.parse(l);
          } catch {
            continue;
          }
          const id = o?.message?.id;
          if (o?.type !== "assistant" || !o.message?.usage || !id || seen.has(id)) continue;
          const ts = Date.parse(o.timestamp);
          if (!Number.isFinite(ts) || ts < now - WEEK_MS) continue;
          seen.add(id);
          events.push({ ts, id, usage: mapUsage(o.message.usage) });
        }
        offset += end + 1;
      }
    }
    files[f] = offset;
  }
  const kept = events.filter((e) => e.ts >= now - WEEK_MS);
  const keptIds = new Set(kept.map((e) => e.id));
  return { files, seen: [...seen].filter((id) => keptIds.has(id)), events: kept };
}

const add = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

export function windowSums(events: UsageEvent[], now: number): { last5h: Usage; last7d: Usage; billablePerMin15: number } {
  let last5h = { ...ZERO_USAGE };
  let last7d = { ...ZERO_USAGE };
  let last15 = 0;
  for (const e of events) {
    const age = now - e.ts;
    if (age < 0 || age > WEEK_MS) continue;
    last7d = add(last7d, e.usage);
    if (age <= 5 * 3600_000) last5h = add(last5h, e.usage);
    if (age <= 15 * 60_000) last15 += billable(e.usage);
  }
  return { last5h, last7d, billablePerMin15: last15 / 15 };
}

// Identity only. ~/.claude.json also holds other settings; nothing else is read or returned.
export function readAccount(home: string): { accountUuid: string; email?: string; name?: string } | null {
  const f = join(home, ".claude.json");
  if (!existsSync(f)) return null;
  try {
    const a = JSON.parse(readFileSync(f, "utf8"))?.oauthAccount;
    if (!a?.accountUuid) return null;
    return {
      accountUuid: String(a.accountUuid),
      ...(a.emailAddress ? { email: String(a.emailAddress) } : {}),
      ...(a.displayName ? { name: String(a.displayName) } : {}),
    };
  } catch {
    return null;
  }
}
