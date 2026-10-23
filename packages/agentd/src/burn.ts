import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BurnGetResult, readAccount, type RateWindow, type ScanState, scanTranscripts, windowSums } from "@ladvin/protocol";
import { ladvinHome } from "./paths";
import type { TaskStore } from "./store";

const WEEK_MS = 7 * 86400_000;

function readJson<T>(f: string): T | undefined {
  try {
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(f: string, v: unknown): void {
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v));
  renameSync(tmp, f);
}

// What this host's Claude account is burning: the latest window utilization any ladvin agent saw
// (rate_limit_event, docs/spikes.md) plus token usage from all of the user's transcripts on this host.
export class BurnState {
  constructor(private o: { userHome: string }) {}

  private rateFile = () => join(ladvinHome(), "ratelimit.json");
  private scanFile = () => join(ladvinHome(), "usage-scan.json");

  recordRateLimit(ev: { fiveHour?: RateWindow; sevenDay?: RateWindow }, at: Date): void {
    if (!ev.fiveHour && !ev.sevenDay) return;
    const prev = readJson<BurnGetResult["rateLimit"]>(this.rateFile());
    writeJson(this.rateFile(), {
      fiveHour: ev.fiveHour ?? prev?.fiveHour,
      sevenDay: ev.sevenDay ?? prev?.sevenDay,
      observedAt: at.toISOString(),
    });
  }

  snapshot(store: TaskStore, now: number): BurnGetResult {
    const prev = readJson<ScanState>(this.scanFile()) ?? { files: {}, seen: [], events: [] };
    const scan = scanTranscripts(join(this.o.userHome, ".claude", "projects"), prev, now);
    writeJson(this.scanFile(), scan);
    return {
      account: readAccount(this.o.userHome),
      rateLimit: readJson<BurnGetResult["rateLimit"]>(this.rateFile()) ?? null,
      usage: windowSums(scan.events, now),
      agents: store
        .list()
        .filter((t) => !t.endedAt || now - Date.parse(t.endedAt) < WEEK_MS)
        .map((t) => ({ taskId: t.taskId, state: t.state, kind: t.kind ?? "delegate", usage: t.usage })),
    };
  }
}
