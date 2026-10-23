import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type AttachPlan, attachPlan, sshAttachArgv } from "../src/attach";
import { registerAttachTools } from "../src/tools/attach";
import { addToIndex } from "../src/tools/delegate";

const ARGV = ["ssh", "-t", "box", "tmux attach -t ladvin-t_00000001"];

test("ssh argv attaches to the task's tmux view", () => {
  expect(sshAttachArgv("box", "t_00000001")).toEqual(ARGV);
});

test("WezTerm splits a pane", () => {
  expect(attachPlan({ WEZTERM_PANE: "3" }, "win32", ARGV)).toEqual({ kind: "spawn", command: "wezterm", args: ["cli", "split-pane", "--", ...ARGV] });
});

test("tmux splits a window with one quoted command", () => {
  const p = attachPlan({ TMUX: "/tmp/tmux-1000/default,1,0" }, "linux", ARGV) as Extract<AttachPlan, { kind: "spawn" }>;
  expect(p.command).toBe("tmux");
  expect(p.args).toEqual(["split-window", "ssh -t box 'tmux attach -t ladvin-t_00000001'"]);
});

test("macOS opens Terminal.app with an escaped command", () => {
  const p = attachPlan({}, "darwin", ["ssh", "-t", "box", 'say "hi"']) as Extract<AttachPlan, { kind: "spawn" }>;
  expect(p.command).toBe("osascript");
  expect(p.args.join(" ")).toContain('do script "ssh -t box \'say \\"hi\\"\'"');
});

test("elsewhere the command is printed; LADVIN_TERMINAL overrides detection", () => {
  expect(attachPlan({}, "linux", ARGV).kind).toBe("print");
  expect(attachPlan({ WEZTERM_PANE: "3", LADVIN_TERMINAL: "print" }, "win32", ARGV)).toEqual({
    kind: "print",
    command: "ssh -t box 'tmux attach -t ladvin-t_00000001'",
  });
});

// ---- tool ----
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ladvin-attach-"));
  process.env.LADVIN_HOME = home;
});
afterEach(() => {
  delete process.env.LADVIN_HOME;
  rmSync(home, { recursive: true, force: true });
});

async function tool(o: { owner: string; hasSession: boolean }) {
  const owner = { machineId: "m", projectDir: "/proj" };
  addToIndex("/proj", { taskId: "t_00000001", host: "box" });
  const spawned: AttachPlan[] = [];
  const execs: string[] = [];
  const pool = {
    get: () => ({ call: async () => ({ taskId: "t_00000001", state: "running", owner: { machineId: "m", projectDir: o.owner } }) }),
    transport: () => ({ exec: async (cmd: string) => (execs.push(cmd), { code: o.hasSession ? 0 : 1, stdout: "", stderr: "" }) }),
  } as any;
  const server = new McpServer({ name: "t", version: "0" });
  registerAttachTools(server, { owner, pool, env: { WEZTERM_PANE: "1" }, platform: "win32", spawn: (p) => void spawned.push(p) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), c.connect(b)]);
  const r: any = await c.callTool({ name: "ladvin_attach", arguments: { task_id: "t_00000001" } });
  return { text: r.content[0].text as string, isError: !!r.isError, spawned, execs };
}

test("attach opens a pane for a live view", async () => {
  const r = await tool({ owner: "/proj", hasSession: true });
  expect(r.isError).toBe(false);
  expect(r.spawned).toHaveLength(1);
  expect(r.execs[0]).toContain("tmux has-session -t ladvin-t_00000001");
});

test("a closed view gives a clear message and opens nothing", async () => {
  const r = await tool({ owner: "/proj", hasSession: false });
  expect(r.text).toContain("has closed");
  expect(r.text).toContain("ladvin_report");
  expect(r.spawned).toHaveLength(0);
});

test("a task of another project is refused", async () => {
  const r = await tool({ owner: "/elsewhere", hasSession: true });
  expect(r.isError).toBe(true);
  expect(r.text).toContain("belongs to /elsewhere");
  expect(r.spawned).toHaveLength(0);
});
