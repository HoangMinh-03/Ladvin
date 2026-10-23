import { TeamStore } from "./team/store";
import { renderInbox } from "./team/time";

export type HookInput = { cwd?: string; stop_hook_active?: boolean };

// Claude Code hooks (spec §9): surface teammate messages to the local agent. Returns stdout ("" = say nothing).
// Never throws: a broken hook must not break the user's session.
export function runHook(event: "post" | "stop", input: HookInput, env: { CLAUDE_PROJECT_DIR?: string }): string {
  try {
    const projectDir = env.CLAUDE_PROJECT_DIR || input.cwd;
    if (!projectDir) return "";
    const store = new TeamStore(projectDir);
    const team = store.active();
    if (!team) return "";
    const unread = store.unread(team.teamId);
    if (!unread.length) return "";
    store.markRead(team.teamId, unread.length);
    const body = renderInbox(unread);
    if (event === "post")
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `ladvin team: ${unread.length} new message(s)\n${body}` },
      });
    return JSON.stringify({
      decision: "block",
      reason: `ladvin team: ${unread.length} unread message(s) from teammates — read and respond before stopping:\n${body}`,
    });
  } catch {
    return "";
  }
}
