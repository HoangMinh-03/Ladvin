// packages/hub/src/team/store.ts
import { randomBytes } from "node:crypto";
import { appendFileSync as appendFileSync2, existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";

// packages/hub/src/state.ts
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function ladvinHome() {
  return process.env.LADVIN_HOME || join(homedir(), ".ladvin");
}
function projectStateDir(projectDir) {
  const h = createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
  const dir = join(ladvinHome(), "state", h);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// packages/hub/src/untrusted.ts
function wrapRemote(host, agent, body) {
  const safe = body.replace(/<\/?ladvin-remote-content/gi, (m) => m.replace("<", "&lt;"));
  const attr = (s) => s.replace(/[^\w.@:-]/g, "_");
  return `<ladvin-remote-content host="${attr(host)}" agent="${attr(agent)}">
${safe}
</ladvin-remote-content>`;
}

// packages/hub/src/team/store.ts
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync2(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

class TeamStore {
  root;
  constructor(projectDir) {
    this.root = projectStateDir(projectDir);
  }
  dir(teamId) {
    return join2(this.root, "teams", teamId);
  }
  activeFile = () => join2(this.root, "active-team");
  get(teamId) {
    const f = join2(this.dir(teamId), "team.json");
    return existsSync2(f) ? JSON.parse(readFileSync2(f, "utf8")) : undefined;
  }
  active() {
    if (!existsSync2(this.activeFile()))
      return;
    const t = this.get(readFileSync2(this.activeFile(), "utf8").trim());
    return t?.status === "active" ? t : undefined;
  }
  latest() {
    if (!existsSync2(this.activeFile()))
      return;
    return this.get(readFileSync2(this.activeFile(), "utf8").trim());
  }
  create(goal, members) {
    const cur = this.active();
    if (cur)
      throw new Error(`a team is already active in this project (${cur.teamId})`);
    const team = {
      teamId: `team_${randomBytes(4).toString("hex")}`,
      goal,
      members,
      tasks: [],
      status: "active",
      createdAt: new Date().toISOString()
    };
    mkdirSync2(this.dir(team.teamId), { recursive: true });
    this.save(team);
    writeFileSync2(this.activeFile(), team.teamId);
    return team;
  }
  save(team) {
    mkdirSync2(this.dir(team.teamId), { recursive: true });
    writeJson(join2(this.dir(team.teamId), "team.json"), team);
  }
  end(teamId) {
    const t = this.get(teamId);
    if (t)
      this.save({ ...t, status: "ended", endedAt: new Date().toISOString() });
  }
  all(teamId) {
    const f = join2(this.dir(teamId), "inbox.jsonl");
    if (!existsSync2(f))
      return [];
    return readFileSync2(f, "utf8").split(`
`).filter(Boolean).map((l) => JSON.parse(l));
  }
  has(teamId, id) {
    return this.all(teamId).some((e) => e.id === id);
  }
  appendInbox(teamId, e) {
    if (this.has(teamId, e.id))
      return false;
    mkdirSync2(this.dir(teamId), { recursive: true });
    appendFileSync2(join2(this.dir(teamId), "inbox.jsonl"), JSON.stringify(e) + `
`);
    return true;
  }
  cursor(teamId) {
    const f = join2(this.dir(teamId), "read-cursor");
    return existsSync2(f) ? Number(readFileSync2(f, "utf8")) || 0 : 0;
  }
  unread(teamId) {
    return this.all(teamId).slice(this.cursor(teamId));
  }
  markReadTo(teamId, n) {
    const next = Math.max(this.cursor(teamId), n);
    mkdirSync2(this.dir(teamId), { recursive: true });
    writeJson(join2(this.dir(teamId), "read-cursor"), next);
  }
  markRead(teamId) {
    this.markReadTo(teamId, this.all(teamId).length);
  }
  takeUnread(teamId) {
    const start = this.cursor(teamId);
    const entries = this.all(teamId).slice(start);
    if (entries.length)
      this.markReadTo(teamId, start + entries.length);
    return entries;
  }
  lockFile() {
    return join2(this.root, "poller.lock");
  }
}

// packages/hub/src/team/time.ts
var pad = (n, w = 2) => String(n).padStart(w, "0");
function fmt(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
function fmtUtc(d) {
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}Z`;
}
function renderInbox(entries) {
  return entries.map((e) => {
    const d = new Date(e.at);
    return wrapRemote(e.host, e.taskId, `[${fmt(d)} / ${fmtUtc(d)}] ${e.role}@${e.host}: ${e.text}`);
  }).join(`
`);
}

// packages/hub/src/hook.ts
function runHook(event, input, env) {
  try {
    const projectDir = env.CLAUDE_PROJECT_DIR || input.cwd;
    if (!projectDir)
      return "";
    const store = new TeamStore(projectDir);
    const team = store.active();
    if (!team)
      return "";
    const unread = store.takeUnread(team.teamId);
    if (!unread.length)
      return "";
    const body = renderInbox(unread);
    if (event === "post")
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `ladvin team: ${unread.length} new message(s)
${body}` }
      });
    return JSON.stringify({
      decision: "block",
      reason: `ladvin team: ${unread.length} unread message(s) from teammates — read and respond before stopping:
${body}`
    });
  } catch {
    return "";
  }
}

// packages/hub/src/hook-main.ts
var raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => raw += c);
process.stdin.on("end", () => {
  let input = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch {}
  const event = process.argv[2] === "stop" ? "stop" : "post";
  const out = runHook(event, input, process.env);
  if (out)
    process.stdout.write(out);
  process.exit(0);
});
