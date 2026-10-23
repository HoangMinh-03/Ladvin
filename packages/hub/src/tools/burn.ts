import { homedir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type AccountRow, applyBudgets, type BurnPool, collectBurn, readBurnCache, renderBurn, writeBurnCache } from "../burn/aggregate";
import { saveBudget } from "../burn/budget";
import { loadHosts } from "../state";
import { guarded, ok, ToolError } from "./delegate";

export const userHome = () => process.env.LADVIN_USER_HOME || homedir();

export async function refreshBurn(pool: BurnPool): Promise<AccountRow[]> {
  const rows = await collectBurn({ pool, hosts: loadHosts(), local: { userHome: userHome() } });
  writeBurnCache(rows);
  return rows;
}

// Refuses new work on a host whose account is over budget (spec §10). Uses a snapshot at most 60 s old.
export function makeBudgetGuard(pool: BurnPool): (alias: string) => Promise<string | null> {
  return async (alias) => {
    const cached = readBurnCache(60_000);
    const rows = applyBudgets(cached?.length ? cached : await refreshBurn(pool));
    const row = rows.find((r) => r.hosts.includes(alias));
    if (!row?.over.length) return null;
    return `${row.label} is over its ladvin budget (${row.over.join(", ")}). Wait for the window to reset, or raise it with ladvin_budget({account: "${row.key}", …}) or clear it with ladvin_budget({account: "${row.key}", clear: true}).`;
  };
}

export function registerBurnTools(server: McpServer, ctx: { pool: BurnPool }): void {
  server.registerTool(
    "ladvin_burn",
    {
      description: "Fleet burn meter: per Claude account, window utilization (when observed), token usage, running ladvin agents, budgets.",
      inputSchema: {},
    },
    guarded(async () => ok(renderBurn(await refreshBurn(ctx.pool)))),
  );

  server.registerTool(
    "ladvin_budget",
    {
      description: "Set or clear a budget for an account (key from ladvin_burn: account id, host:<alias>, or * for all). While over budget, new ladvin work on it is refused.",
      inputSchema: {
        account: z.string(),
        five_hour_pct: z.number().min(0).max(100).optional(),
        seven_day_pct: z.number().min(0).max(100).optional(),
        five_hour_tokens: z.number().min(0).optional(),
        seven_day_tokens: z.number().min(0).optional(),
        clear: z.boolean().optional(),
      },
    },
    guarded(async (a) => {
      if (a.clear) {
        saveBudget(a.account, null);
        return ok(`Cleared the budget for ${a.account}.`);
      }
      const b = {
        ...(a.five_hour_pct !== undefined ? { fiveHourPct: a.five_hour_pct } : {}),
        ...(a.seven_day_pct !== undefined ? { sevenDayPct: a.seven_day_pct } : {}),
        ...(a.five_hour_tokens !== undefined ? { fiveHourTokens: a.five_hour_tokens } : {}),
        ...(a.seven_day_tokens !== undefined ? { sevenDayTokens: a.seven_day_tokens } : {}),
      };
      if (!Object.keys(b).length) throw new ToolError("Give at least one limit, or clear: true.");
      saveBudget(a.account, b);
      return ok(`Budget for ${a.account}: ${JSON.stringify(b)}`);
    }),
  );
}
