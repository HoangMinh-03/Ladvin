import { wrapRemote } from "../untrusted";
import type { InboxEntry } from "./store";

// clockOffsetMs = remote clock − hub clock (HostConnection.connect).
export function toLocal(remoteIso: string, offsetMs: number): Date {
  return new Date(Date.parse(remoteIso) - offsetMs);
}

export function toRemote(local: Date, offsetMs: number): Date {
  return new Date(local.getTime() + offsetMs);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function fmt(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function renderInbox(entries: InboxEntry[]): string {
  return entries.map((e) => wrapRemote(e.host, e.taskId, `[${fmt(new Date(e.at))}] ${e.role}@${e.host}: ${e.text}`)).join("\n");
}
