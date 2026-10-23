import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export function ladvinHome(): string {
  return process.env.LADVIN_HOME || join(homedir(), ".ladvin");
}

export function taskDir(taskId: string): string {
  return join(ladvinHome(), "agents", taskId);
}

export function socketPath(): string {
  const home = ladvinHome();
  if (process.platform === "win32") {
    const h = createHash("sha256").update(home).digest("hex").slice(0, 12);
    return `\\\\.\\pipe\\ladvin-agentd-${h}`;
  }
  return join(home, "agentd.sock");
}

export function configPath(): string {
  return join(ladvinHome(), "agentd.json");
}

export function logPath(): string {
  return join(ladvinHome(), "agentd.log");
}
