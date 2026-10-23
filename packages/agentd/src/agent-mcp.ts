import { connect } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LineCodec, RpcPeer } from "@ladvin/protocol";
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

  await server.connect(new StdioServerTransport());
}
