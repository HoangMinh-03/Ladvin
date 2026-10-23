// What ladvin's `ladvin_snapshot` tool returns (packages/hub/src/tools/snapshot.ts).
export type Snapshot = {
  at: string;
  hosts: { alias: string; account?: string; reachable: boolean }[];
  tasks: {
    taskId: string;
    host: string;
    state: 'queued' | 'running' | 'idle' | 'done' | 'failed' | 'cancelled';
    kind: 'delegate' | 'team';
    preset: 'observer' | 'worker' | 'yolo';
    role?: string;
    elapsedMs?: number;
    tokensIn: number;
    tokensOut: number;
    lastActivity?: string;
    failReason?: string;
  }[];
  team: null | {
    teamId: string;
    goal: string;
    members: { role: string; host: string; taskId: string }[];
    tasks: { id: string; title: string; status: 'todo' | 'doing' | 'done'; owner?: string; note?: string }[];
    unread: number;
    recent: { at: string; role: string; host: string; text: string }[];
    // both directions, oldest first; `from` is a member role or "you" (ladvin ≥ 0.3.3)
    chat?: { at: string; from: string; text: string }[];
  };
  burn: { label: string; hosts: string[]; fiveHourPct?: number; sevenDayPct?: number; running: number; over: string[] }[];
};

declare module 'claude-code' {
  interface PluginState {
    'ladvin': {
      snap: Shaped<Snapshot | null>;
      problem: string | null;
      isBandHidden: boolean;
      sshHosts: string[];
    };
  }
}
