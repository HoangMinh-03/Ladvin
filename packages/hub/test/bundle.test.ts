import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BUNDLE = join(import.meta.dir, "..", "..", "..", "dist", "ladvin-mcp.js");

test("the committed node bundle starts and exposes exactly the ladvin tools", async () => {
  const home = mkdtempSync(join(tmpdir(), "ladvin-bundle-"));
  const client = new Client({ name: "bundle-test", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [BUNDLE], env: { ...process.env, LADVIN_HOME: home } as any }));
  const { tools } = await client.listTools();
  await client.close();
  rmSync(home, { recursive: true, force: true });
  expect(tools.map((t) => t.name).sort()).toEqual([
    "ladvin_add_host",
    "ladvin_attach",
    "ladvin_budget",
    "ladvin_burn",
    "ladvin_cancel",
    "ladvin_delegate",
    "ladvin_fetch",
    "ladvin_followup",
    "ladvin_hosts",
    "ladvin_remove_host",
    "ladvin_report",
    "ladvin_status",
    "ladvin_stop_all",
    "ladvin_team_end",
    "ladvin_team_inbox",
    "ladvin_team_resume",
    "ladvin_team_send",
    "ladvin_team_start",
    "ladvin_team_tasks",
  ].sort());
}, 30000);
