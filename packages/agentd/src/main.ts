import { hostname } from "node:os";
import { PROTOCOL_MAJOR } from "@ladvin/protocol";
import { runAgentMcp } from "./agent-mcp";
import { loadConfig, runBridge, selfCommand } from "./bridge";
import { Runner } from "./runner";
import { startServer } from "./server";
import { TaskStore } from "./store";
import { Tmux } from "./tmux";
import { view } from "./viewer";

export const VERSION = "0.1.0";

async function serve(): Promise<void> {
  const cfg = loadConfig();
  const self = selfCommand();
  const store = new TaskStore();
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const runner = new Runner({
    store,
    hostName: hostname(),
    claudeBin: cfg.claudeBin ?? "claude",
    claudeBinArgs: cfg.claudeArgs,
    env: cfg.path ? { PATH: cfg.path } : undefined,
    agentMcpCommand: (id) => ({ command: self.command, args: [...self.args, "agent-mcp", id] }),
    viewCommand: (id) => [self.command, ...self.args, "view", id].map(quote).join(" "),
    tmux: new Tmux(cfg.tmuxBin),
  });
  // Runs that were live when a previous agentd died can no longer be driven.
  for (const t of store.list())
    if (t.state === "running") store.update(t.taskId, { state: "failed", failReason: "agentd restarted" });
  const srv = await startServer({ store, runner, version: VERSION, onShutdown: () => process.exit(0) });
  const stop = () => void srv.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "serve":
    await serve();
    break;
  case "bridge":
    await runBridge();
    break;
  case "agent-mcp":
    await runAgentMcp(arg!);
    break;
  case "view":
    await view(arg!);
    process.exit(0);
    break;
  case "version":
    console.log(`ladvin-agentd ${VERSION} protocol ${PROTOCOL_MAJOR}`);
    break;
  default:
    console.error("usage: ladvin-agentd serve | bridge | agent-mcp <taskId> | view <taskId> | version");
    process.exit(64);
}
