import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ladvinHome } from "../state";

// Per account (accountUuid, "host:<alias>", or "*" for every account). Utilization in %, tokens are billable tokens.
export type Budget = { fiveHourPct?: number; sevenDayPct?: number; fiveHourTokens?: number; sevenDayTokens?: number };

const file = () => join(ladvinHome(), "budget.json");

export function loadBudgets(): Record<string, Budget> {
  try {
    return existsSync(file()) ? (JSON.parse(readFileSync(file(), "utf8")) as Record<string, Budget>) : {};
  } catch {
    return {};
  }
}

export function saveBudget(key: string, b: Budget | null): void {
  const all = loadBudgets();
  if (b) all[key] = b;
  else delete all[key];
  mkdirSync(ladvinHome(), { recursive: true });
  writeFileSync(file(), JSON.stringify(all, null, 2));
}

export function budgetFor(key: string): Budget | undefined {
  const all = loadBudgets();
  return all[key] ?? all["*"];
}
