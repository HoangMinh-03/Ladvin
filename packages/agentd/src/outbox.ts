import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OutMsg, Owner } from "@ladvin/protocol";
import { ladvinHome } from "./paths";
import type { TaskStore } from "./store";

type NewMsg = OutMsg extends infer M ? (M extends OutMsg ? Omit<M, "id" | "sentAt"> : never) : never;

// Remote → local team traffic. Entries stay until the hub acks them, so nothing is lost while it is away.
export class Outbox {
  constructor(private store: TaskStore) {}

  private file = () => join(ladvinHome(), "outbox.jsonl");
  private ackedFile = () => join(ladvinHome(), "outbox-acked.json");

  private acked(): Set<string> {
    return new Set(existsSync(this.ackedFile()) ? (JSON.parse(readFileSync(this.ackedFile(), "utf8")) as string[]) : []);
  }

  append(m: NewMsg): OutMsg {
    const msg = { ...m, id: `m_${randomBytes(6).toString("hex")}`, sentAt: new Date().toISOString() } as OutMsg;
    appendFileSync(this.file(), JSON.stringify(msg) + "\n");
    return msg;
  }

  pull(owner: Owner): OutMsg[] {
    if (!existsSync(this.file())) return [];
    const acked = this.acked();
    return readFileSync(this.file(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as OutMsg)
      .filter((m) => !acked.has(m.id))
      .filter((m) => {
        const t = this.store.get(m.taskId);
        return !!t && t.owner.machineId === owner.machineId && t.owner.projectDir === owner.projectDir;
      });
  }

  ack(ids: string[]): void {
    const acked = this.acked();
    for (const id of ids) acked.add(id);
    const tmp = `${this.ackedFile()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify([...acked]));
    renameSync(tmp, this.ackedFile());
  }
}
