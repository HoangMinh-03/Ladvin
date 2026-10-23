import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHub } from "./hub";
import { machineId } from "./state";
import { sshTransport } from "./transport";

const owner = { machineId: machineId(), projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd() };
const hub = createHub({ owner, transportFor: sshTransport });
await hub.server.connect(new StdioServerTransport());
const shutdown = () => {
  hub.close();
  process.exit(0);
};
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
