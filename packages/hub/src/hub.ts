import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Owner } from "@ladvin/protocol";
import { ConnectionPool } from "./connection";
import { registerDelegateTools } from "./tools/delegate";
import type { Transport } from "./transport";

export const HUB_VERSION = "0.1.0";

export type Hub = { server: McpServer; pool: ConnectionPool };

export function createHub(o: { owner: Owner; transportFor: (alias: string) => Transport }): Hub {
  const server = new McpServer({ name: "ladvin", version: HUB_VERSION });
  const pool = new ConnectionPool(o.owner, o.transportFor);
  registerDelegateTools(server, { owner: o.owner, pool });
  return { server, pool };
}
