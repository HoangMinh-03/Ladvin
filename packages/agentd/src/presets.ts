import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Preset } from "@ladvin/protocol";
import { ladvinHome } from "./paths";

// Read-only / observation commands an `observer` agent may run through Bash.
export const OBSERVER_ALLOWLIST: string[] = [
  "top -b", "ps", "iostat", "vmstat", "free", "df", "du", "ss", "netstat", "uptime",
  "cat", "tail", "head", "grep", "ls", "journalctl",
  "docker stats", "docker logs", "docker ps", "psql -c", "mysql -e",
];

function observerAllowlist(): string[] {
  const file = join(ladvinHome(), "observer-allowlist.txt");
  if (!existsSync(file)) return OBSERVER_ALLOWLIST;
  return readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

export function presetArgs(p: Preset): string[] {
  switch (p) {
    case "observer":
      return [
        "--permission-mode", "default",
        "--allowedTools", ["Read", "Grep", "Glob", ...observerAllowlist().map((c) => `Bash(${c}:*)`)].join(","),
      ];
    case "worker":
      return ["--permission-mode", "acceptEdits", "--allowedTools", "Bash,Read,Grep,Glob,Edit,Write"];
    case "yolo":
      return ["--permission-mode", "bypassPermissions"];
  }
}
