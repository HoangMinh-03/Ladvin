import { spawnSync } from "node:child_process";

// Thin wrapper; every method is a no-op when tmux is not configured (tests, Windows dev).
export class Tmux {
  constructor(private bin?: string) {}

  openView(taskId: string, cmd: string): void {
    if (!this.bin) return;
    spawnSync(this.bin, ["new-session", "-d", "-s", `ladvin-${taskId}`, cmd], { stdio: "ignore" });
  }

  close(taskId: string): void {
    if (!this.bin) return;
    spawnSync(this.bin, ["kill-session", "-t", `ladvin-${taskId}`], { stdio: "ignore" });
  }
}
