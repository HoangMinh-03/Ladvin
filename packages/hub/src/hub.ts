import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Owner } from "@ladvin/protocol";
import { ConnectionPool } from "./connection";
import { TeamPoller } from "./team/poller";
import { TeamStore } from "./team/store";
import { registerAttachTools } from "./tools/attach";
import { makeBudgetGuard, registerBurnTools } from "./tools/burn";
import { registerDelegateTools } from "./tools/delegate";
import { registerSnapshotTool } from "./tools/snapshot";
import { registerHostTools } from "./tools/hosts";
import { registerTeamTools } from "./tools/team";
import type { Transport } from "./transport";

export const HUB_VERSION = "0.3.2";

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
  registerSnapshotTool(server, { owner: o.owner, pool, store });
  // A team left active by a previous session keeps receiving messages (hooks read them from disk).
  if (store.active()) poller.start();
  return {
    server,
    pool,
    poller,
    close() {
      poller.stop();
      pool.closeAll();
    },
  };
}
