import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Preset } from "@ladvin/protocol";
import type { ConnectInfo } from "../connection";
import { type HostConfig, ladvinHome, saveHost } from "../state";
import type { Transport } from "../transport";

export const AGENTD_VERSION = "0.2.0";
export const RELEASE_REPO = "OWNER/ladvin"; // set once the GitHub repo exists

type Os = HostConfig["os"];
type Arch = HostConfig["arch"];

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function parseUname(out: string): { os: Os; arch: Arch } | null {
  const [sys, machine] = out.trim().split(/\s+/);
  const os = sys === "Linux" ? "linux" : sys === "Darwin" ? "darwin" : null;
  const arch = machine === "x86_64" || machine === "amd64" ? "x64" : machine === "aarch64" || machine === "arm64" ? "arm64" : null;
  return os && arch ? { os, arch } : null;
}

// ssh hands the command to the user's login shell, which may be fish or csh: always run POSIX sh explicitly.
export const posix = (script: string) => `sh -c ${shq(script)}`;

// One probe: the login shell's view (often adds ~/.local/bin, nvm…), the plain ssh view, and well-known install dirs.
const PROBE = [
  `L=$("\${SHELL:-/bin/sh}" -lc 'echo "path=$PATH"; echo "claude=$(command -v claude)"; echo "tmux=$(command -v tmux)"' 2>/dev/null </dev/null)`,
  `printf '%s\\n' "$L" | grep -E '^(path|claude|tmux)='`,
  `for c in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" "$HOME/.npm-global/bin/claude" "$HOME"/.nvm/versions/node/*/bin/claude /usr/local/bin/claude /opt/homebrew/bin/claude /usr/bin/tmux /usr/local/bin/tmux /opt/homebrew/bin/tmux; do [ -x "$c" ] && echo "cand=$c"; done`,
  `echo "plainpath=$PATH"; echo "plainclaude=$(command -v claude)"; echo "plaintmux=$(command -v tmux)"`,
].join("\n");

type Probe = { claude?: string; tmux?: string; path: string };

function parseProbe(out: string, claudeOverride?: string): Probe {
  const one = (k: string) => out.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() || undefined;
  const cands = [...out.matchAll(/^cand=(.+)$/gm)].map((m) => m[1]!.trim());
  const cand = (name: string) => cands.filter((c) => c.endsWith(`/${name}`)).sort().reverse()[0]; // newest nvm version sorts last
  const claude = claudeOverride ?? one("claude") ?? one("plainclaude") ?? cand("claude");
  const tmux = one("tmux") ?? one("plaintmux") ?? cand("tmux");
  const dir = (p?: string) => (p ? p.slice(0, p.lastIndexOf("/")) : undefined);
  // claude's own dir first: an npm/nvm install needs the `node` that sits next to it.
  const parts = [dir(claude), dir(tmux), ...(one("path") ?? "").split(":"), ...(one("plainpath") ?? "").split(":")];
  const path = [...new Set(parts.filter((p): p is string => !!p))].join(":");
  return { claude, tmux, path };
}

export async function downloadBinary(
  os: Os,
  arch: Arch,
  version: string,
  o: { fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const name = `ladvin-agentd-${os}-${arch}`;
  const devDir = process.env.LADVIN_AGENTD_BINARY_DIR;
  if (devDir) {
    const p = join(devDir, name);
    if (!existsSync(p)) throw new Error(`${p} not found (LADVIN_AGENTD_BINARY_DIR)`);
    return p;
  }
  const dir = join(ladvinHome(), "cache", version);
  const dest = join(dir, name);
  if (existsSync(dest)) return dest;
  const f = o.fetchImpl ?? fetch;
  const base = `https://github.com/${RELEASE_REPO}/releases/download/v${version}`;
  const get = async (url: string) => {
    const r = await f(url);
    if (!r.ok) throw new Error(`download failed: ${url} → HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  };
  const sums = (await get(`${base}/SHA256SUMS`)).toString("utf8");
  const expected = sums.split("\n").map((l) => l.trim().split(/\s+/)).find(([, n]) => n === name)?.[0];
  if (!expected) throw new Error(`${name} not listed in SHA256SUMS of v${version}`);
  const bin = await get(`${base}/${name}`);
  if (createHash("sha256").update(bin).digest("hex") !== expected) throw new Error(`checksum mismatch for ${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(dest, bin, { mode: 0o755 });
  return dest;
}

export type AddHostOptions = {
  maxPreset?: Preset;
  transport: Transport;
  connection: { connect(): Promise<ConnectInfo>; call<T>(m: string, p: unknown): Promise<T>; close?(): void };
  fetchBinary?: (os: Os, arch: Arch, version: string) => Promise<string>;
  skipLoginCheck?: boolean;
  claudePath?: string; // explicit claude location on the host, skips discovery
};

export async function addHost(alias: string, o: AddHostOptions): Promise<{ lines: string[]; host?: HostConfig }> {
  const lines: string[] = [];
  const t = o.transport;

  const un = await t.exec("uname -sm");
  if (un.code !== 0) return { lines: [`cannot reach ${alias} over ssh: ${un.stderr.trim() || `exit ${un.code}`}`] };
  const plat = parseUname(un.stdout);
  if (!plat) return { lines: [`unsupported OS/arch: ${un.stdout.trim()} (ladvin supports Linux and macOS, x64/arm64)`] };
  lines.push(`✓ ${alias}: ${plat.os}/${plat.arch}`);

  const tools = parseProbe((await t.exec(posix(PROBE))).stdout, o.claudePath);
  if (!tools.claude)
    lines.push(`claude not found on ${alias}. Install it there and run "claude" once to log in, or pass its full path as claude_path.`);
  if (!tools.tmux) lines.push(`tmux not found on ${alias}. Install it (e.g. apt install tmux / brew install tmux).`);
  if (!tools.claude || !tools.tmux) return { lines };
  lines.push(`✓ claude: ${tools.claude}`, `✓ tmux: ${tools.tmux}`);
  const withPath = (cmd: string) => posix(`PATH=${shq(tools.path)}; export PATH; ${cmd}`);

  if (!o.skipLoginCheck) {
    const probe = await t.exec(withPath(`exec ${shq(tools.claude)} -p --model haiku 'reply ok' </dev/null`), 120_000);
    if (probe.code !== 0)
      return {
        lines: [...lines, `claude on ${alias} is not logged in or cannot run (${(probe.stderr || probe.stdout).trim().slice(0, 200)}). Run "claude" on ${alias} once to log in.`],
      };
    lines.push("✓ claude is logged in");
  }

  const local = await (o.fetchBinary ?? downloadBinary)(plat.os, plat.arch, AGENTD_VERSION);
  const mk = await t.exec(posix("mkdir -p ~/.ladvin/bin && chmod 700 ~/.ladvin"));
  if (mk.code !== 0) return { lines: [...lines, `cannot create ~/.ladvin on ${alias}: ${mk.stderr.trim()}`] };
  // Upload beside the live binary and rename: overwriting a running executable fails with "text file busy".
  await t.upload(local, "~/.ladvin/bin/ladvin-agentd.new");
  const cfg = JSON.stringify({ claudeBin: tools.claude, tmuxBin: tools.tmux, path: tools.path });
  const inst = await t.exec(
    posix(
      `chmod +x ~/.ladvin/bin/ladvin-agentd.new && mv -f ~/.ladvin/bin/ladvin-agentd.new ~/.ladvin/bin/ladvin-agentd && printf '%s' ${shq(cfg)} > ~/.ladvin/agentd.json`,
    ),
  );
  if (inst.code !== 0) return { lines: [...lines, `installing agentd on ${alias} failed: ${inst.stderr.trim()}`] };
  lines.push(`✓ installed ladvin-agentd ${AGENTD_VERSION}`);

  let info = await o.connection.connect();
  if (info.agentdVersion !== AGENTD_VERSION) {
    // An older daemon is still serving; restart it unless agents are running.
    try {
      await o.connection.call("shutdown", {});
      await new Promise((r) => setTimeout(r, 500));
      info = await o.connection.connect();
    } catch (e) {
      lines.push(`⚠ agentd ${info.agentdVersion} is still running agents; it will be replaced when you stop them (${e instanceof Error ? e.message : e}).`);
    }
  }
  lines.push(`✓ connected (agentd ${info.agentdVersion}, clock offset ${Math.round(info.clockOffsetMs)} ms)`);

  const maxPreset = o.maxPreset ?? "worker";
  if (maxPreset === "yolo") lines.push(`⚠ yolo: agents on ${alias} skip ALL permission checks.`);
  const host: HostConfig = { alias, ...plat, maxPreset, agentdVersion: info.agentdVersion, addedAt: new Date().toISOString() };
  saveHost(host);
  lines.push(`✓ ${alias} added (max preset ${maxPreset})`);
  return { lines, host };
}
