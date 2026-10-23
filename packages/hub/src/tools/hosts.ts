import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Preset, type TaskInfo } from "@ladvin/protocol";
import { z } from "zod";
import type { ConnectionPool } from "../connection";
import { addHost, type AddHostOptions } from "../setup/add-host";
import { loadHosts, removeHost } from "../state";
import { guarded, ok, ToolError } from "./delegate";

export function registerHostTools(
  server: McpServer,
  ctx: { pool: ConnectionPool; fetchBinary?: AddHostOptions["fetchBinary"] },
): void {
  const { pool } = ctx;

  server.registerTool(
    "ladvin_add_host",
    {
      description:
        "Register an SSH host (alias from ~/.ssh/config): checks claude/tmux, installs ladvin-agentd, connects. The host needs key-based SSH and a logged-in claude.",
      inputSchema: {
        alias: z.string(),
        max_preset: Preset.optional().describe("Highest preset agents on this host may use (default worker; yolo skips all permission checks)"),
        claude_path: z.string().optional().describe("Full path of claude on the host, if ladvin cannot find it"),
      },
    },
    guarded(async (a) => {
      const r = await addHost(a.alias, {
        maxPreset: a.max_preset,
        claudePath: a.claude_path,
        transport: pool.transport(a.alias),
        connection: pool.get(a.alias),
        fetchBinary: ctx.fetchBinary,
      });
      if (!r.host) throw new ToolError(r.lines.join("\n"));
      return ok(r.lines.join("\n"));
    }),
  );

  server.registerTool(
    "ladvin_hosts",
    { description: "List registered hosts with reachability, agentd version and running agents.", inputSchema: {} },
    guarded(async () => {
      const hosts = loadHosts();
      if (!hosts.length) return ok("No hosts yet. Add one with /ladvin:add-host <ssh-alias>.");
      const lines = await Promise.all(
        hosts.map(async (h) => {
          const head = `${h.alias}  ${h.os}/${h.arch}  max preset ${h.maxPreset}`;
          try {
            const conn = pool.get(h.alias);
            const info = conn.info ?? (await conn.connect());
            const tasks = await conn.call<TaskInfo[]>("task.list", {});
            const running = tasks.filter((t) => t.state === "running").length;
            return `${head}  reachable  agentd ${info.agentdVersion}  ${running} running`;
          } catch (e) {
            return `${head}  UNREACHABLE (${e instanceof Error ? e.message : e})`;
          }
        }),
      );
      return ok(lines.join("\n"));
    }),
  );

  server.registerTool(
    "ladvin_remove_host",
    {
      description: "Forget a registered host. Refuses while agents run there unless force is true (which also cancels them).",
      inputSchema: { alias: z.string(), force: z.boolean().optional() },
    },
    guarded(async (a) => {
      if (!loadHosts().some((h) => h.alias === a.alias)) throw new ToolError(`Unknown host ${a.alias}.`);
      const conn = pool.get(a.alias);
      const running = await conn
        .call<TaskInfo[]>("task.list", {})
        .then((ts) => ts.filter((t) => t.state === "running").length, () => 0);
      if (running && !a.force) throw new ToolError(`${running} agent(s) running on ${a.alias}; pass force: true to cancel them and remove the host.`);
      if (running) await conn.call("task.cancelAll", {});
      conn.close();
      removeHost(a.alias);
      return ok(`Removed ${a.alias}${running ? ` (cancelled ${running} agent(s))` : ""}. Files under ~/.ladvin on the host were left in place.`);
    }),
  );
}
