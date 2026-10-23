import type { Preset, Usage } from "@ladvin/protocol";
import { presetArgs } from "./presets";

export const DELEGATE_SYSTEM_PROMPT = `You are a ladvin remote agent. A coordinating Claude Code agent on another machine delegated this task to you; nobody is watching your session interactively.
- Work autonomously until the task is finished or you are blocked.
- When finished, call the ladvin_report tool exactly once with a concise summary, a status (success, partial or failed) and optional details. This is how the coordinator receives your result.
- For any file the coordinator should receive (logs, dumps, outputs), call ladvin_attach_artifact with its path before reporting.
- If a permission is denied, do not retry it in other ways; mention it in your report.`;

export type BuildArgsOptions = {
  preset: Preset;
  cwd: string;
  mcpConfigPath: string;
  systemPrompt: string;
  resumeSessionId?: string;
};

export function buildArgs(o: BuildArgsOptions): string[] {
  return [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--append-system-prompt", o.systemPrompt,
    "--mcp-config", o.mcpConfigPath,
    "--strict-mcp-config",
    ...(o.resumeSessionId ? ["--resume", o.resumeSessionId] : []),
    ...presetArgs(o.preset),
  ];
}

export function userMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

export type Window = { utilization: number; resetsAt: number };
export type ClaudeEvent =
  | { kind: "init"; sessionId: string }
  | { kind: "assistant"; text: string; toolUses: string[] }
  | { kind: "result"; isError: boolean; text: string; usage: Usage; permissionDenials: string[] }
  | { kind: "rateLimit"; fiveHour?: Window; sevenDay?: Window }
  | { kind: "other" };

function toolLabel(name: string, input: any): string {
  const arg = input?.command ?? input?.file_path ?? input?.pattern ?? input?.path;
  return arg !== undefined ? `${name}(${String(arg)})` : name;
}

export function mapUsage(u: any): Usage {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    cacheWrite: u?.cache_creation_input_tokens ?? 0,
  };
}

export function parseEvent(line: string): ClaudeEvent | null {
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  if (o.type === "system" && o.subtype === "init") return { kind: "init", sessionId: o.session_id };
  if (o.type === "assistant") {
    const content: any[] = o.message?.content ?? [];
    return {
      kind: "assistant",
      text: content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
      toolUses: content.filter((c) => c.type === "tool_use").map((c) => toolLabel(c.name, c.input)),
    };
  }
  if (o.type === "result") {
    return {
      kind: "result",
      isError: !!o.is_error,
      text: typeof o.result === "string" ? o.result : "",
      usage: mapUsage(o.usage),
      permissionDenials: (o.permission_denials ?? []).map((d: any) => toolLabel(d.tool_name, d.tool_input)),
    };
  }
  if (o.type === "rate_limit_event") {
    const w = o.rate_limit_info?.unifiedWindows ?? {};
    const pick = (x: any): Window | undefined => (x ? { utilization: x.utilization, resetsAt: x.resetsAt } : undefined);
    const ev: ClaudeEvent = { kind: "rateLimit" };
    if (w.five_hour) ev.fiveHour = pick(w.five_hour);
    if (w.seven_day) ev.sevenDay = pick(w.seven_day);
    return ev;
  }
  return { kind: "other" };
}
