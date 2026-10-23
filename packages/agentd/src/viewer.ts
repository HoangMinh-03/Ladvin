import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseEvent } from "./claude";
import { taskDir } from "./paths";
import { TaskStore } from "./store";

export function renderEvent(line: string): string | null {
  const ev = parseEvent(line);
  if (!ev) return null;
  switch (ev.kind) {
    case "init":
      return `● session ${ev.sessionId}`;
    case "assistant": {
      const parts: string[] = [];
      if (ev.text) parts.push(`▸ assistant: ${ev.text}`);
      for (const t of ev.toolUses) parts.push(`⚙ tool: ${t}`);
      return parts.length ? parts.join("\n") : null;
    }
    case "result":
      return `${ev.isError ? "✘ error" : "✔ done"} (in ${ev.usage.input} / out ${ev.usage.output} tokens)`;
    default:
      return null;
  }
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);

// Follows stream.jsonl, printing human-readable lines. Runs inside the task's tmux session and returns
// (ending that session) `lingerMs` after the task reaches a terminal state.
export async function view(
  taskId: string,
  o: { pollMs?: number; lingerMs?: number; write?: (s: string) => void } = {},
): Promise<void> {
  const { pollMs = 500, lingerMs = 10 * 60_000 } = o;
  const write = o.write ?? ((s: string) => void process.stdout.write(s));
  const file = join(taskDir(taskId), "stream.jsonl");
  const store = new TaskStore();
  let pos = 0;
  let buf = "";
  write(`ladvin agent ${taskId} — Ctrl-b d to detach\n\n`);
  for (;;) {
    const terminal = TERMINAL.has(store.get(taskId)?.state ?? "");
    if (existsSync(file)) {
      const size = statSync(file).size;
      if (size > pos) {
        const fd = openSync(file, "r");
        const chunk = Buffer.alloc(size - pos);
        try {
          readSync(fd, chunk, 0, chunk.length, pos);
        } finally {
          closeSync(fd);
        }
        pos = size;
        buf += chunk.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const out = renderEvent(buf.slice(0, i));
          buf = buf.slice(i + 1);
          if (out) write(out + "\n");
        }
      }
    }
    if (terminal) {
      write(`\n— task finished; this view closes in ${Math.round(lingerMs / 1000)}s —\n`);
      await new Promise((r) => setTimeout(r, lingerMs));
      return;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
