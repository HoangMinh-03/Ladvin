import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Artifact, type Owner, type Report, type TaskInfo, ZERO_USAGE } from "@ladvin/protocol";
import { ladvinHome, taskDir } from "./paths";

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export type TaskInit = Omit<TaskInfo, "taskId" | "state" | "usage" | "runs">;

// One directory per task under <home>/agents/<id>: meta.json, report.json, stream.jsonl, artifacts.json, reports/<n>.json
export class TaskStore {
  create(init: TaskInit): TaskInfo {
    const taskId = `t_${randomBytes(4).toString("hex")}`;
    const info: TaskInfo = { ...init, taskId, state: "queued", usage: { ...ZERO_USAGE }, runs: 0 };
    mkdirSync(taskDir(taskId), { recursive: true });
    writeJson(join(taskDir(taskId), "meta.json"), info);
    return info;
  }

  get(taskId: string): TaskInfo | undefined {
    if (!/^t_[0-9a-f]{8}$/.test(taskId)) return undefined;
    return readJson<TaskInfo>(join(taskDir(taskId), "meta.json"));
  }

  list(owner?: Owner): TaskInfo[] {
    const dir = join(ladvinHome(), "agents");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((id) => this.get(id))
      .filter((t): t is TaskInfo => !!t)
      .filter((t) => !owner || (t.owner.machineId === owner.machineId && t.owner.projectDir === owner.projectDir));
  }

  update(taskId: string, patch: Partial<TaskInfo>): TaskInfo {
    const cur = this.get(taskId);
    if (!cur) throw new Error(`unknown task ${taskId}`);
    const next = { ...cur, ...patch, taskId };
    writeJson(join(taskDir(taskId), "meta.json"), next);
    return next;
  }

  setReport(taskId: string, r: Report): void {
    writeJson(join(taskDir(taskId), "report.json"), r);
  }

  getReport(taskId: string): Report | undefined {
    return readJson<Report>(join(taskDir(taskId), "report.json"));
  }

  // Moves the current report to reports/<n>.json before a follow-up run replaces it.
  archiveReport(taskId: string, run: number): void {
    const cur = join(taskDir(taskId), "report.json");
    if (!existsSync(cur)) return;
    mkdirSync(join(taskDir(taskId), "reports"), { recursive: true });
    renameSync(cur, join(taskDir(taskId), "reports", `${run}.json`));
  }

  appendStream(taskId: string, line: string): void {
    appendFileSync(join(taskDir(taskId), "stream.jsonl"), line.endsWith("\n") ? line : line + "\n");
  }

  addArtifact(taskId: string, a: Artifact): void {
    const list = this.artifacts(taskId).filter((x) => x.path !== a.path);
    writeJson(join(taskDir(taskId), "artifacts.json"), [...list, a]);
  }

  artifacts(taskId: string): Artifact[] {
    return readJson<Artifact[]>(join(taskDir(taskId), "artifacts.json")) ?? [];
  }
}
