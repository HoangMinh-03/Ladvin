import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { configPath, ladvinHome, logPath, socketPath } from "./paths";

export type AgentdConfig = { claudeBin?: string; claudeArgs?: string[]; tmuxBin?: string };

export function loadConfig(): AgentdConfig {
  const p = configPath();
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as AgentdConfig) : {};
}

// How to re-invoke this program: compiled binary, or `bun <script>` in development.
export function selfCommand(): { command: string; args: string[] } {
  const script = process.argv[1];
  return script && /\.(ts|js)$/.test(script) && existsSync(script)
    ? { command: process.execPath, args: [script] }
    : { command: process.execPath, args: [] };
}

function tryConnect(): Promise<Socket | null> {
  return new Promise((r) => {
    const s = connect(socketPath());
    s.once("connect", () => r(s));
    s.once("error", () => r(null));
  });
}

function startServe(): void {
  mkdirSync(ladvinHome(), { recursive: true });
  const self = selfCommand();
  const cfg = loadConfig();
  if (cfg.tmuxBin) {
    const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const cmd = [self.command, ...self.args, "serve"].map(quote).join(" ");
    spawn(cfg.tmuxBin, ["new-session", "-d", "-s", "ladvin-agentd", `${cmd} 2>>${quote(logPath())}`], {
      stdio: "ignore",
      env: process.env,
    }).unref();
    return;
  }
  const log = openSync(logPath(), "a");
  spawn(self.command, [...self.args, "serve"], { detached: true, stdio: ["ignore", log, log], env: process.env }).unref();
}

// Pipes this process's stdio to the agentd socket, starting agentd if needed.
export async function runBridge(): Promise<void> {
  let sock = await tryConnect();
  if (!sock) {
    startServe();
    const end = Date.now() + 5000;
    while (!sock && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 100));
      sock = await tryConnect();
    }
  }
  if (!sock) {
    process.stderr.write(`ladvin-agentd: could not start or reach the daemon; see ${logPath()}\n`);
    process.exit(2);
  }
  const s = sock;
  process.stdin.pipe(s);
  s.pipe(process.stdout);
  process.stdin.on("end", () => s.end());
  await new Promise<void>((r) => s.on("close", () => r()));
  process.exit(0);
}
