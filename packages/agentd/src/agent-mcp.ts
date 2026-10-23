import { connect } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LineCodec, RpcPeer, type TaskInfo, type TeamTask } from "@ladvin/protocol";
import { z } from "zod";
import { socketPath } from "./paths";

async function agentdPeer(): Promise<RpcPeer> {
  const s = connect(socketPath());
  await new Promise((r, j) => s.once("connect", r).once("error", j));
  s.setEncoding("utf8");
  const peer = new RpcPeer((l) => s.write(l));
  const codec = new LineCodec();
  s.on("data", (c: string) => codec.push(c).forEach((m) => peer.receive(m)));
  s.on("close", () => peer.close("agentd connection closed"));
  return peer;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

// MCP server that the remote claude process runs as its "ladvin" tool provider.
export async function runAgentMcp(taskId: string): Promise<void> {
  const peer = await agentdPeer();
  const server = new McpServer({ name: "ladvin", version: "0.1.0" });
  const task = await peer.request<TaskInfo>("task.get", { taskId });
  if (task.kind === "team") registerTeamTools(server, peer, taskId);
  else registerDelegateTools(server, peer, taskId);
  await server.connect(new StdioServerTransport());
}

const failed = (e: unknown) => ({ ...text(`Failed: ${e instanceof Error ? e.message : e}`), isError: true });

function registerTeamTools(server: McpServer, peer: RpcPeer, taskId: string): void {
  server.registerTool(
    "team_send",
    {
      description: "Send a message to the coordinating agent. This is the only way the coordinator sees anything from you.",
      inputSchema: { text: z.string().describe("Your message; include times for observations") },
    },
    async (args) => {
      try {
        await peer.request("agent.teamSend", { taskId, text: args.text });
        return text("Sent.");
      } catch (e) {
        return failed(e);
      }
    },
  );

  server.registerTool(
    "team_tasks",
    {
      description: "Shared task list of the team. op=list reads it; add/update are applied by the coordinator within a few seconds.",
      inputSchema: {
        op: z.enum(["list", "add", "update"]),
        title: z.string().optional(),
        id: z.string().optional(),
        status: z.enum(["todo", "doing", "done"]).optional(),
        owner: z.string().optional(),
        note: z.string().optional(),
      },
    },
    async (a) => {
      try {
        if (a.op === "list") {
          const tasks = await peer.request<TeamTask[]>("agent.tasksList", { taskId });
          return text(tasks.length ? tasks.map((t) => `${t.id} [${t.status}] ${t.title}${t.owner ? ` (${t.owner})` : ""}${t.note ? ` — ${t.note}` : ""}`).join("\n") : "The task list is empty.");
        }
        const op =
          a.op === "add"
            ? { op: "add", title: a.title ?? "", ...(a.owner ? { owner: a.owner } : {}) }
            : { op: "update", id: a.id ?? "", ...(a.status ? { status: a.status } : {}), ...(a.owner ? { owner: a.owner } : {}), ...(a.note ? { note: a.note } : {}) };
        await peer.request("agent.tasksOp", { taskId, op });
        return text("Queued; the shared list updates within a few seconds.");
      } catch (e) {
        return failed(e);
      }
    },
  );

  server.registerTool(
    "share_file",
    {
      description: "Send a file from your working directory to the coordinator (it lands in their project).",
      inputSchema: { path: z.string(), note: z.string().optional() },
    },
    async (args) => {
      try {
        await peer.request("agent.share", { taskId, ...args });
        return text(`Shared ${args.path}.`);
      } catch (e) {
        return failed(e);
      }
    },
  );
}

function registerDelegateTools(server: McpServer, peer: RpcPeer, taskId: string): void {

  server.registerTool(
    "ladvin_report",
    {
      description: "Submit your final report to the coordinating agent. Call exactly once, when the task is finished.",
      inputSchema: {
        summary: z.string().describe("Concise result summary"),
        status: z.enum(["success", "partial", "failed"]),
        details: z.string().optional().describe("Longer details, findings, commands run"),
      },
    },
    async (args) => {
      await peer.request("agent.report", { taskId, ...args });
      return text("Report delivered. You can stop now.");
    },
  );

  server.registerTool(
    "ladvin_attach_artifact",
    {
      description: "Attach a file (relative to your working directory, or absolute) so the coordinator can fetch it.",
      inputSchema: { path: z.string(), note: z.string().optional() },
    },
    async (args) => {
      try {
        await peer.request("agent.attach", { taskId, ...args });
        return text(`Attached ${args.path}.`);
      } catch (e) {
        return { ...text(`Could not attach: ${e instanceof Error ? e.message : e}`), isError: true };
      }
    },
  );
}
