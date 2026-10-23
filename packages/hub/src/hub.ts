import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Owner } from "@ladvin/protocol";
import { ConnectionPool } from "./connection";
import { TeamPoller } from "./team/poller";
import { TeamStore } from "./team/store";
import { loadHosts } from "./state";
import { registerAttachTools } from "./tools/attach";
import { makeBudgetGuard, refreshBurn, registerBurnTools } from "./tools/burn";
import { registerDelegateTools } from "./tools/delegate";
import { registerHostTools } from "./tools/hosts";
import { registerTeamTools } from "./tools/team";
import type { Transport } from "./transport";

export const HUB_VERSION = "0.3.0";

export type Hub = { server: McpServer; pool: ConnectionPool; poller: TeamPoller; close(): void };

export function createHub(o: { owner: Owner; transportFor: (alias: string) => Transport }): Hub {
  const server = new McpServer({ name: "ladvin", version: HUB_VERSION });
  const pool = new ConnectionPool(o.owner, o.transportFor);
  const store = new TeamStore(o.owner.projectDir);
  const poller = new TeamPoller({ store, pool, owner: o.owner, projectDir: o.owner.projectDir });
  const budgetGuard = makeBudgetGuard(pool);
  registerDelegateTools(server, { owner: o.owner, pool, budgetGuard });
  registerHostTools(server, { pool });
  registerTeamTools(server, { owner: o.owner, pool, store, poller, budgetGuard });
  registerBurnTools(server, { pool });
  registerAttachTools(server, { owner: o.owner, pool });
  // Keeps the statusline cache fresh while hosts are registered.
  const burnTimer = setInterval(() => {
    if (loadHosts().length) void refreshBurn(pool).catch(() => {});
  }, 60_000);
  burnTimer.unref?.();
  // A team left active by a previous session keeps receiving messages (hooks read them from disk).
  if (store.active()) poller.start();
  return {
    server,
    pool,
    poller,
    close() {
      clearInterval(burnTimer);
      poller.stop();
      pool.closeAll();
    },
  };
}
