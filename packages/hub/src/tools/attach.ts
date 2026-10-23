import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Owner } from "@ladvin/protocol";
import { z } from "zod";
import { type AttachPlan, attachPlan, runAttach, sshAttachArgv } from "../attach";
import type { ConnectionPool } from "../connection";
import { guarded, ok, taskLocator, ToolError } from "./delegate";

export type AttachCtx = {
  owner: Owner;
  pool: ConnectionPool;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  spawn?: (plan: Extract<AttachPlan, { kind: "spawn" }>) => void;
};

export function registerAttachTools(server: McpServer, ctx: AttachCtx): void {
  const loc = taskLocator(ctx);
  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;
  const open = ctx.spawn ?? runAttach;

  const attachOne = async (host: string, taskId: string): Promise<string> => {
    const probe = await ctx.pool.transport(host).exec(`tmux has-session -t ladvin-${taskId} 2>/dev/null`);
    if (probe.code !== 0)
      return `The live view for ${taskId} has closed (it closes 10 minutes after the task ends). Read the result with ladvin_report.`;
    const plan = attachPlan(env, platform, sshAttachArgv(host, taskId));
    if (plan.kind === "print") return `Run this in a terminal to watch ${taskId}:\n${plan.command}`;
    open(plan);
    return `Opened a ${plan.command} view of ${taskId} on ${host} (Ctrl-b d detaches).`;
  };

  server.registerTool(
    "ladvin_attach",
    {
      description:
        "Open a live view of a remote agent in your terminal (WezTerm pane, tmux split, or Terminal.app; otherwise prints the ssh command). task_id may be 'all' for every running agent of this project.",
      inputSchema: { task_id: z.string() },
    },
    guarded(async (a) => {
      if (a.task_id !== "all") {
        const { host } = await loc.owned(a.task_id);
        return ok(await attachOne(host, a.task_id));
      }
      const live = (await loc.projectTasks()).filter(({ task }) => task.state === "running" || task.state === "idle");
      if (!live.length) throw new ToolError("No running agents in this project.");
      const lines: string[] = [];
      for (const { host, task } of live) lines.push(await attachOne(host, task.taskId));
      return ok(lines.join("\n"));
    }),
  );
}
