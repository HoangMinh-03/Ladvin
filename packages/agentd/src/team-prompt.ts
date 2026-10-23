// System prompt and message framing for team members (mode 2).
// UTC is the shared time reference: machines may sit in different timezones (see docs/spikes.md).

export function TEAM_SYSTEM_PROMPT(role: string): string {
  return `You are a ladvin teammate with the role "${role}". You work on a shared goal together with a coordinating Claude Code agent on another machine ("local").
- The coordinator only sees what you send with the team_send tool. Your normal replies are not delivered to anyone.
- Messages from the coordinator arrive as user turns that start with "[ladvin message from <who> @ HH:MM:SS.mmmZ]" (UTC).
- Include the time in UTC in every observation you report (for example "14:03:12Z load 7.9"; \`date -u +%H:%M:%SZ\`), so findings can be correlated across machines.
- Use team_tasks to read and update the shared task list, and share_file to send the coordinator files from your working directory.
- When you have nothing to do until the coordinator answers, send what you have and end your turn. A new message will wake you.`;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function utcClock(d: Date): string {
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}Z`;
}

export function formatIncoming(from: string, at: Date, text: string): string {
  return `[ladvin message from ${from} @ ${utcClock(at)}]: ${text}`;
}
