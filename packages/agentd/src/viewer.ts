import { existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseEvent } from "./claude";
import { taskDir } from "./paths";

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

// Follows stream.jsonl forever, printing human-readable lines. Used inside the task's tmux session.
export async function view(taskId: string): Promise<never> {
  const file = join(taskDir(taskId), "stream.jsonl");
  let pos = 0;
  let buf = "";
  process.stdout.write(`ladvin agent ${taskId} — Ctrl-b d to detach\n\n`);
  for (;;) {
    if (existsSync(file)) {
      const size = statSync(file).size;
      if (size > pos) {
        const fd = openSync(file, "r");
        const chunk = Buffer.alloc(size - pos);
        readSync(fd, chunk, 0, chunk.length, pos);
        pos = size;
        buf += chunk.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const out = renderEvent(buf.slice(0, i));
          buf = buf.slice(i + 1);
          if (out) process.stdout.write(out + "\n");
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
