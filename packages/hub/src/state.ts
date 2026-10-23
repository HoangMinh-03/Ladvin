import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Preset } from "@ladvin/protocol";

export type HostConfig = {
  alias: string;
  os: "linux" | "darwin";
  arch: "x64" | "arm64";
  maxPreset: Preset;
  agentdVersion: string;
  addedAt: string;
};

export function ladvinHome(): string {
  return process.env.LADVIN_HOME || join(homedir(), ".ladvin");
}

const hostsFile = () => join(ladvinHome(), "hosts.json");

export function loadHosts(): HostConfig[] {
  return existsSync(hostsFile()) ? (JSON.parse(readFileSync(hostsFile(), "utf8")) as HostConfig[]) : [];
}

function writeHosts(hosts: HostConfig[]): void {
  mkdirSync(ladvinHome(), { recursive: true });
  writeFileSync(hostsFile(), JSON.stringify(hosts, null, 2));
}

export function saveHost(h: HostConfig): void {
  writeHosts([...loadHosts().filter((x) => x.alias !== h.alias), h]);
}

export function removeHost(alias: string): void {
  writeHosts(loadHosts().filter((x) => x.alias !== alias));
}

export function machineId(): string {
  const f = join(ladvinHome(), "machine-id");
  if (existsSync(f)) return readFileSync(f, "utf8").trim();
  mkdirSync(ladvinHome(), { recursive: true });
  const id = randomUUID();
  writeFileSync(f, id);
  return id;
}

export function projectStateDir(projectDir: string): string {
  const h = createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
  const dir = join(ladvinHome(), "state", h);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureGitignore(projectDir: string): void {
  const f = join(projectDir, ".gitignore");
  if (!existsSync(f)) return;
  const cur = readFileSync(f, "utf8");
  if (cur.split(/\r?\n/).some((l) => l.trim() === ".ladvin/" || l.trim() === ".ladvin")) return;
  appendFileSync(f, (cur.endsWith("\n") || cur === "" ? "" : "\n") + ".ladvin/\n");
}
