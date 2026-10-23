import { z } from "zod";

export const PROTOCOL_MAJOR = 1;

export const Preset = z.enum(["observer", "worker", "yolo"]);
export type Preset = z.infer<typeof Preset>;
export const PRESET_RANK: Record<Preset, number> = { observer: 0, worker: 1, yolo: 2 };

export const TaskState = z.enum(["queued", "running", "done", "failed", "cancelled"]);
export type TaskState = z.infer<typeof TaskState>;

export const Owner = z.object({ machineId: z.string().min(1), projectDir: z.string().min(1) });
export type Owner = z.infer<typeof Owner>;

export const Usage = z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() });
export type Usage = z.infer<typeof Usage>;
export const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const Artifact = z.object({ path: z.string(), size: z.number(), note: z.string().optional() });
export type Artifact = z.infer<typeof Artifact>;

export const Limits = z.object({ wallMs: z.number().positive(), maxTokens: z.number().positive().optional() });
export type Limits = z.infer<typeof Limits>;
export const DEFAULT_WALL_MS = 2 * 60 * 60 * 1000;

export const ReportStatus = z.enum(["success", "partial", "failed"]);
export type ReportStatus = z.infer<typeof ReportStatus>;

export const Report = z.object({
  taskId: z.string(),
  host: z.string(),
  status: ReportStatus,
  summary: z.string(),
  details: z.string().optional(),
  artifacts: z.array(Artifact),
  usage: Usage,
  startedAt: z.string(),
  endedAt: z.string(),
  reportMissing: z.boolean(),
  permissionDenials: z.array(z.string()).optional(),
});
export type Report = z.infer<typeof Report>;

export const TaskInfo = z.object({
  taskId: z.string(),
  owner: Owner,
  state: TaskState,
  preset: Preset,
  cwd: z.string(),
  prompt: z.string(),
  limits: Limits.optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  usage: Usage,
  lastActivity: z.string().optional(),
  failReason: z.string().optional(),
  sessionId: z.string().optional(),
  runs: z.number(),
});
export type TaskInfo = z.infer<typeof TaskInfo>;

// ---- method params / results ----

export const HelloParams = z.object({ protocolMajor: z.number(), client: Owner });
export type HelloResult = { protocolMajor: number; agentdVersion: string; now: string };
export type PingResult = { now: string };

export const TaskPrepareParams = z.object({ owner: Owner, cwd: z.string().optional(), preset: Preset });
export type TaskPrepareResult = { taskId: string; cwd: string };

export const TaskStartParams = z.object({ taskId: z.string(), prompt: z.string().min(1), limits: Limits });
export const TaskListParams = z.object({ owner: Owner.optional() });
export const TaskIdParams = z.object({ taskId: z.string() });
export const TaskFollowupParams = z.object({ taskId: z.string(), text: z.string().min(1) });
export type CancelAllResult = { cancelled: number };

export const AgentReportParams = z.object({
  taskId: z.string(),
  summary: z.string(),
  status: ReportStatus,
  details: z.string().optional(),
});
export const AgentAttachParams = z.object({ taskId: z.string(), path: z.string(), note: z.string().optional() });

export const METHODS = {
  hello: "hello",
  ping: "ping",
  prepare: "task.prepare",
  start: "task.start",
  list: "task.list",
  get: "task.get",
  report: "task.report",
  cancel: "task.cancel",
  followup: "task.followup",
  cancelAll: "task.cancelAll",
  agentReport: "agent.report",
  agentAttach: "agent.attach",
} as const;
