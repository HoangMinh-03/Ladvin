import { z } from "zod";

export const PROTOCOL_MAJOR = 1;

export const Preset = z.enum(["observer", "worker", "yolo"]);
export type Preset = z.infer<typeof Preset>;
export const PRESET_RANK: Record<Preset, number> = { observer: 0, worker: 1, yolo: 2 };

// "idle": a team member that is alive and waiting for its next message.
export const TaskState = z.enum(["queued", "running", "idle", "done", "failed", "cancelled"]);
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

export const TaskKind = z.enum(["delegate", "team"]);
export type TaskKind = z.infer<typeof TaskKind>;
export const TeamInfo = z.object({ teamId: z.string(), role: z.string().min(1) });

export const TeamTaskStatus = z.enum(["todo", "doing", "done"]);
export const TeamTask = z.object({
  id: z.string(),
  title: z.string(),
  status: TeamTaskStatus,
  owner: z.string().optional(),
  note: z.string().optional(),
});
export type TeamTask = z.infer<typeof TeamTask>;
export const TeamTaskOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), title: z.string().min(1), owner: z.string().optional() }),
  z.object({
    op: z.literal("update"),
    id: z.string(),
    status: TeamTaskStatus.optional(),
    owner: z.string().optional(),
    note: z.string().optional(),
  }),
]);
export type TeamTaskOp = z.infer<typeof TeamTaskOp>;

// Remote → local traffic, queued in the agentd outbox until the hub acks it.
const OutBase = { id: z.string(), teamId: z.string(), taskId: z.string(), role: z.string(), sentAt: z.string() };
export const OutMsg = z.discriminatedUnion("kind", [
  z.object({ ...OutBase, kind: z.literal("message"), text: z.string() }),
  z.object({
    ...OutBase,
    kind: z.literal("file"),
    name: z.string(),
    path: z.string(),
    size: z.number(),
    sha256: z.string(),
    note: z.string().optional(),
    // absolute path of the copy agentd took at share time; this, not `path`, is what the hub downloads
    staged: z.string().optional(),
  }),
  z.object({ ...OutBase, kind: z.literal("tasksOp"), op: TeamTaskOp }),
]);
export type OutMsg = z.infer<typeof OutMsg>;

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
  kind: TaskKind.optional(),
  team: TeamInfo.optional(),
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

export const TeamJoinParams = z.object({
  owner: Owner,
  teamId: z.string().min(1),
  role: z.string().min(1),
  goal: z.string().min(1),
  cwd: z.string().optional(),
  preset: Preset,
});
export const TeamSendParams = z.object({ taskId: z.string(), text: z.string().min(1), from: z.string().min(1) });
export const TeamPullParams = z.object({ owner: Owner });
export type TeamPullResult = { messages: OutMsg[] };
export const TeamAckParams = z.object({ ids: z.array(z.string()) });
export const TeamSyncTasksParams = z.object({ teamId: z.string(), tasks: z.array(TeamTask) });
export const TeamStopParams = z.object({ taskId: z.string() });
export const AgentTeamSendParams = z.object({ taskId: z.string(), text: z.string().min(1) });
export const AgentShareParams = z.object({ taskId: z.string(), path: z.string(), note: z.string().optional() });
export const AgentTasksOpParams = z.object({ taskId: z.string(), op: TeamTaskOp });
export const AgentTasksListParams = z.object({ taskId: z.string() });

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
  teamJoin: "team.join",
  teamSend: "team.send",
  teamPull: "team.pull",
  teamAck: "team.ack",
  teamSyncTasks: "team.syncTasks",
  teamStop: "team.stop",
  agentTeamSend: "agent.teamSend",
  agentShare: "agent.share",
  agentTasksOp: "agent.tasksOp",
  agentTasksList: "agent.tasksList",
} as const;
