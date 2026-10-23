import { type ChildProcess, spawn } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { ladvinHome } from "./state";

export type ExecResult = { code: number; stdout: string; stderr: string };

export interface Transport {
  spawnBridge(): ChildProcess;
  exec(cmd: string, timeoutMs?: number): Promise<ExecResult>;
  upload(localPath: string, remotePath: string): Promise<void>;
  download(remotePath: string, localPath: string): Promise<void>;
}

export const REMOTE_AGENTD = ".ladvin/bin/ladvin-agentd";

function run(command: string, args: string[], opts: { cwd?: string; shell?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((r) => {
    const p = spawn(command, args, { cwd: opts.cwd, shell: opts.shell, env: opts.env ?? process.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    p.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    p.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    const timer = opts.timeoutMs ? setTimeout(() => p.kill(), opts.timeoutMs) : undefined;
    p.on("error", (e) => r({ code: 127, stdout, stderr: stderr + e.message }));
    p.on("close", (code) => {
      clearTimeout(timer);
      r({ code: code ?? 1, stdout, stderr });
    });
  });
}

// Remote paths are given home-relative to scp because `~` is not expanded inside quotes.
function homeRelative(remotePath: string): string {
  return remotePath.startsWith("~/") ? remotePath.slice(2) : remotePath;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// Never hand scp a local absolute path: on Windows `D:\x` parses as host `D`.
export function scpArgs(alias: string, dir: "upload" | "download", localPath: string, remotePath: string): { cwd: string; args: string[] } {
  const isWin = /^[A-Za-z]:[\\/]/.test(localPath) || localPath.includes("\\");
  const dirOf = isWin ? localPath.slice(0, Math.max(localPath.lastIndexOf("\\"), localPath.lastIndexOf("/"))) : dirname(localPath);
  const name = isWin ? localPath.slice(dirOf.length + 1) : basename(localPath);
  const local = `./${name}`;
  const remote = `${alias}:${shq(homeRelative(remotePath))}`;
  return { cwd: dirOf, args: dir === "upload" ? [local, remote] : [remote, local] };
}

export function sshBase(): string[] {
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30"];
  if (process.env.LADVIN_SSH_CONFIG) args.unshift("-F", process.env.LADVIN_SSH_CONFIG);
  if (process.platform !== "win32") {
    mkdirSync(ladvinHome(), { recursive: true });
    args.push("-o", "ControlMaster=auto", "-o", `ControlPath=${join(ladvinHome(), "cm-%C")}`, "-o", "ControlPersist=10m");
  }
  return args;
}

export function sshTransport(alias: string): Transport {
  return {
    spawnBridge: () => spawn("ssh", [...sshBase(), "-T", alias, `${REMOTE_AGENTD} bridge`], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }),
    exec: (cmd, timeoutMs = 60_000) => run("ssh", [...sshBase(), "-n", alias, cmd], { timeoutMs }),
    upload: async (localPath, remotePath) => {
      // scp does not create directories.
      const rel = homeRelative(remotePath);
      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      if (dir) {
        const mk = await run("ssh", [...sshBase(), "-n", alias, `mkdir -p ${shq(dir)}`]);
        if (mk.code !== 0) throw new Error(`upload to ${alias} failed: ${mk.stderr.trim()}`);
      }
      const { cwd, args } = scpArgs(alias, "upload", resolve(localPath), remotePath);
      const r = await run("scp", [...sshBase(), "-q", ...args], { cwd });
      if (r.code !== 0) throw new Error(`upload to ${alias} failed: ${r.stderr.trim()}`);
    },
    download: async (remotePath, localPath) => {
      mkdirSync(dirname(resolve(localPath)), { recursive: true });
      const { cwd, args } = scpArgs(alias, "download", resolve(localPath), remotePath);
      const r = await run("scp", [...sshBase(), "-q", ...args], { cwd });
      if (r.code !== 0) throw new Error(`download from ${alias} failed: ${r.stderr.trim()}`);
    },
  };
}

// Test/dev transport: the "remote" is a child process on this machine whose user home is `userHome`
// (so its LADVIN_HOME is <userHome>/.ladvin, like a real host).
export function localTransport(o: { agentdCmd: string[]; userHome: string; env?: Record<string, string> }): Transport {
  const env = { ...process.env, ...o.env, LADVIN_HOME: join(o.userHome, ".ladvin") };
  const remote = (p: string) => (isAbsolute(p) ? p : join(o.userHome, homeRelative(p)));
  return {
    spawnBridge: () => spawn(o.agentdCmd[0]!, [...o.agentdCmd.slice(1), "bridge"], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }),
    exec: (cmd, timeoutMs) => run(cmd, [], { shell: true, env, timeoutMs }),
    upload: async (localPath, remotePath) => {
      const dst = remote(remotePath);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(localPath, dst);
    },
    download: async (remotePath, localPath) => {
      mkdirSync(dirname(resolve(localPath)), { recursive: true });
      copyFileSync(remote(remotePath), localPath);
    },
  };
}
