import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OutMsg, Owner } from "@ladvin/protocol";
import { ladvinHome } from "./paths";
import type { TaskStore } from "./store";

type NewMsg = OutMsg extends infer M ? (M extends OutMsg ? Omit<M, "id" | "sentAt"> : never) : never;

// Remote → local team traffic. Entries stay until the hub acks them, so nothing is lost while it is away.
// agentd is a single process with synchronous file I/O, so ack can compact the file safely.
export class Outbox {
  constructor(private store: TaskStore) {}

  private file = () => join(ladvinHome(), "outbox.jsonl");

  private all(): OutMsg[] {
    if (!existsSync(this.file())) return [];
    return readFileSync(this.file(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as OutMsg);
  }

  append(m: NewMsg): OutMsg {
    const msg = { ...m, id: `m_${randomBytes(6).toString("hex")}`, sentAt: new Date().toISOString() } as OutMsg;
    appendFileSync(this.file(), JSON.stringify(msg) + "\n");
    return msg;
  }

  pull(owner: Owner): OutMsg[] {
    return this.all().filter((m) => {
      const t = this.store.get(m.taskId);
      return !!t && t.owner.machineId === owner.machineId && t.owner.projectDir === owner.projectDir;
    });
  }

  ack(ids: string[]): void {
    const drop = new Set(ids);
    const keep = this.all().filter((m) => !drop.has(m.id));
    const tmp = `${this.file()}.${process.pid}.tmp`;
    writeFileSync(tmp, keep.map((m) => JSON.stringify(m) + "\n").join(""));
    renameSync(tmp, this.file());
  }
}
