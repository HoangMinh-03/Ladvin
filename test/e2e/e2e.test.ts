// End-to-end over real SSH against a disposable Docker host (Linux x64) with a fake `claude`.
// Skips when Docker is not available. Run: bun run test:e2e
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHub, type Hub } from "../../packages/hub/src/hub";
import { machineId } from "../../packages/hub/src/state";
import { sshTransport } from "../../packages/hub/src/transport";

const ROOT = join(import.meta.dir, "..", "..");
const IMAGE = "ladvin-e2e-host";
const ALIAS = "ladvin-e2e";
const sh = (cmd: string, args: string[], opts: { cwd?: string } = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd: opts.cwd, windowsHide: true });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stderr}${r.stdout}`);
  return r.stdout.trim();
};
const dockerOk = spawnSync("docker", ["info"], { encoding: "utf8" }).status === 0;

let work: string;
let container = "";
let hub: Hub;
let client: Client;
let project: string;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  return { text: r.content.map((x: any) => x.text).join("\n"), isError: !!r.isError };
};
const ssh = (cmd: string) => sh("ssh", ["-F", process.env.LADVIN_SSH_CONFIG!, ALIAS, cmd]);

beforeAll(async () => {
  if (!dockerOk) return;
  work = mkdtempSync(join(tmpdir(), "ladvin-e2e-"));
  const ctx = join(work, "ctx");
  const bins = join(work, "bins");
  mkdirSync(ctx, { recursive: true });
  mkdirSync(bins, { recursive: true });
  const bun = process.execPath;
  sh(bun, ["build", "--compile", "--target=bun-linux-x64", "packages/agentd/src/main.ts", "--outfile", join(bins, "ladvin-agentd-linux-x64")], { cwd: ROOT });
  sh(bun, ["build", "--compile", "--target=bun-linux-x64", "packages/agentd/test/fake-claude.ts", "--outfile", join(ctx, "claude")], { cwd: ROOT });
  const key = join(work, "id_ed25519");
  sh("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  copyFileSync(`${key}.pub`, join(ctx, "authorized_keys"));
  copyFileSync(join(import.meta.dir, "Dockerfile"), join(ctx, "Dockerfile"));
  sh("docker", ["build", "-q", "-t", IMAGE, ctx]);
  container = sh("docker", ["run", "-d", "--rm", "-p", "127.0.0.1::22", IMAGE]);
  const port = sh("docker", ["port", container, "22"]).split("\n")[0]!.split(":").pop()!;
  const fwd = (p: string) => p.replace(/\\/g, "/");
  const cfg = join(work, "ssh_config");
  writeFileSync(
    cfg,
    [
      `Host ${ALIAS}`,
      `  HostName 127.0.0.1`,
      `  Port ${port}`,
      `  User dev`,
      `  IdentityFile ${fwd(key)}`,
      `  IdentitiesOnly yes`,
      `  StrictHostKeyChecking no`,
      `  UserKnownHostsFile ${fwd(join(work, "known_hosts"))}`,
      `  LogLevel ERROR`,
      "",
    ].join("\n"),
  );
  process.env.LADVIN_SSH_CONFIG = cfg;
  process.env.LADVIN_AGENTD_BINARY_DIR = bins;
  process.env.LADVIN_HOME = join(work, "local-ladvin");
  // wait for sshd
  for (let i = 0; i < 50; i++) {
    if (spawnSync("ssh", ["-F", cfg, ALIAS, "true"]).status === 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  project = join(work, "project");
  mkdirSync(project);
  hub = createHub({ owner: { machineId: machineId(), projectDir: project }, transportFor: sshTransport });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "e2e", version: "0" });
  await Promise.all([hub.server.connect(a), client.connect(b)]);
}, 600_000);

afterAll(() => {
  if (!dockerOk) return;
  hub?.pool.closeAll();
  if (container) spawnSync("docker", ["rm", "-f", container]);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
});

test.skipIf(!dockerOk)("add-host, delegate with input, report, fetch, tmux views — over real ssh", async () => {
  const add = await call("ladvin_add_host", { alias: ALIAS });
  if (add.isError) console.error(add.text);
  expect(add.isError).toBe(false);
  expect(add.text).toContain("/home/dev/.local/bin/claude");

  ssh(
    `cat > ~/.fake-claude-script.json <<'EOF'\n${JSON.stringify([
      { ifExists: ".ladvin/inbox/input.txt", then: [{ writeFile: { path: "out.txt", content: "from-remote" } }] },
      { callTool: { name: "ladvin_attach_artifact", args: { path: "out.txt" } } },
      { callTool: { name: "ladvin_report", args: { summary: "remote ok", status: "success" } } },
      { result: "bye" },
    ])}\nEOF`,
  );
  const input = join(project, "input.txt");
  writeFileSync(input, "hello");
  const started = await call("ladvin_delegate", { host: ALIAS, task: "e2e", files: [input] });
  if (started.isError) console.error(started.text);
  expect(started.isError).toBe(false);
  const id = started.text.match(/t_[0-9a-f]{8}/)![0];

  for (let i = 0; i < 100; i++) {
    if (/\bdone\b/.test((await call("ladvin_status", { task_id: id })).text)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const rep = await call("ladvin_report", { task_id: id });
  expect(rep.text).toContain("remote ok");
  const f = await call("ladvin_fetch", { task_id: id, artifact: "out.txt" });
  expect(f.isError).toBe(false);
  expect(readFileSync(join(project, ".ladvin", "inbox", id, "out.txt"), "utf8")).toBe("from-remote");

  const sessions = ssh("tmux ls -F '#{session_name}'");
  expect(sessions).toContain("ladvin-agentd");
  expect(sessions).toContain(`ladvin-${id}`);
  expect((await call("ladvin_hosts")).text).toContain("reachable");
}, 300_000);

test.skipIf(!dockerOk)("team over real ssh: plan, round trip, shared file both ways, end", async () => {
  ssh(
    `cat > ~/.fake-claude-script.json <<'EOF'\n${JSON.stringify([
      { callTool: { name: "team_send", args: { text: "plan: watch the box" } } },
      { result: "x" },
      {
        respond: [
          { writeFile: { path: "obs.log", content: "obs" } },
          { callTool: { name: "share_file", args: { path: "obs.log" } } },
          { ifExists: ".ladvin/shared/probe.txt", then: [{ callTool: { name: "team_send", args: { text: "ack $INPUT (got probe)" } } }] },
        ],
      },
    ])}\nEOF`,
  );
  const started = await call("ladvin_team_start", { goal: "e2e team", members: [{ host: ALIAS, role: "watcher" }] });
  if (started.isError) console.error(started.text);
  expect(started.isError).toBe(false);
  const teamId = started.text.match(/team_[0-9a-f]{8}/)![0];
  let inbox = "";
  const waitFor = async (needle: string) => {
    for (let i = 0; i < 20 && !inbox.includes(needle); i++) inbox += (await call("ladvin_team_inbox", { wait_seconds: 3 })).text;
    expect(inbox).toContain(needle);
  };
  await waitFor("plan: watch the box");
  const probe = join(project, "probe.txt");
  writeFileSync(probe, "probe");
  expect((await call("ladvin_team_send", { to: "watcher", text: "step 1", files: [probe] })).isError).toBe(false);
  await waitFor("(got probe)");
  await waitFor("shared file obs.log");
  expect(readFileSync(join(project, ".ladvin", "shared", teamId, "obs.log"), "utf8")).toBe("obs");
  expect((await call("ladvin_team_end", {})).isError).toBe(false);
  ssh("rm -f ~/.fake-claude-script.json");
}, 300_000);

test.skipIf(!dockerOk)("burn meter, idempotent upgrade, attach command — over real ssh", async () => {
  const burn = await call("ladvin_burn");
  expect(burn.isError).toBe(false);
  expect(burn.text).toContain(`${ALIAS} (account unknown)`);

  const again = await call("ladvin_add_host", { alias: ALIAS });
  expect(again.isError).toBe(false);
  expect(again.text).toContain("already up to date");

  ssh(`cat > ~/.fake-claude-script.json <<'EOF'\n${JSON.stringify([{ sleepMs: 20000 }, { result: "x" }])}\nEOF`);
  const id = (await call("ladvin_delegate", { host: ALIAS, task: "sleepy" })).text.match(/t_[0-9a-f]{8}/)![0];
  process.env.LADVIN_TERMINAL = "print";
  try {
    let att = "";
    for (let i = 0; i < 20 && !att.includes("tmux attach"); i++) {
      att = (await call("ladvin_attach", { task_id: id })).text;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(att).toContain(`tmux attach -t ladvin-${id}`);
  } finally {
    delete process.env.LADVIN_TERMINAL;
    await call("ladvin_stop_all");
    ssh("rm -f ~/.fake-claude-script.json");
  }
}, 300_000);
