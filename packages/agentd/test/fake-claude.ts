// Scripted stand-in for `claude -p --input-format stream-json --output-format stream-json`.
// Script: env FAKE_CLAUDE_SCRIPT, else ~/.fake-claude-script.json (first run) / FAKE_CLAUDE_SCRIPT_RESUME (runs with --resume): JSON array of steps.
//   {emit: object}                         print one JSON line (session_id added)
//   {say: string}                          emit an assistant text event
//   {result: string, isError?: boolean}    emit a result event with fixed usage
//   {sleepMs: number}
//   {waitInput: true}                      wait for one stdin line
//   {writeFile: {path, content}}           relative to cwd
//   {ifExists: path, then: Step[], else?: Step[]}
//   {callTool: {name, args}}               call a tool on the "ladvin" MCP server from --mcp-config
//   {exit: number}
// After the script: stays alive until stdin closes, then exits 0 (like real claude).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
// One-shot mode (`claude -p "prompt"`, used by add-host as a login probe): answer and exit.
if (!argv.includes("--input-format")) {
  console.log("ok");
  process.exit(0);
}
const resume = argv.includes("--resume") ? argv[argv.indexOf("--resume") + 1] : undefined;
const sessionId = resume ?? `fake-${process.pid}`;
const scriptFile = join(homedir(), ".fake-claude-script.json");
const raw =
  (resume && process.env.FAKE_CLAUDE_SCRIPT_RESUME) ||
  process.env.FAKE_CLAUDE_SCRIPT ||
  (existsSync(scriptFile) ? readFileSync(scriptFile, "utf8") : undefined);
const script: any[] = raw ? JSON.parse(raw) : [{ say: "working" }, { result: "default done" }];

const out = (o: object) => process.stdout.write(JSON.stringify({ ...o, session_id: sessionId }) + "\n");
const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };

const lines: string[] = [];
let waiter: ((l: string | null) => void) | null = null;
let stdinClosed = false;
const rl = createInterface({ input: process.stdin });
rl.on("line", (l) => (waiter ? (waiter(l), (waiter = null)) : lines.push(l)));
rl.on("close", () => {
  stdinClosed = true;
  waiter?.(null);
});
const nextLine = () =>
  new Promise<string | null>((r) => (lines.length ? r(lines.shift()!) : stdinClosed ? r(null) : (waiter = r)));

let client: Client | null = null;
async function mcp(): Promise<Client> {
  if (client) return client;
  const cfgPath = argv[argv.indexOf("--mcp-config") + 1];
  const srv = JSON.parse(readFileSync(cfgPath, "utf8")).mcpServers.ladvin;
  client = new Client({ name: "fake-claude", version: "0" });
  await client.connect(new StdioClientTransport({ command: srv.command, args: srv.args, env: { ...process.env, ...srv.env } as any }));
  return client;
}

async function run(steps: any[]): Promise<void> {
  for (const s of steps) {
    if (s.emit) out(s.emit);
    else if (s.say !== undefined) out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: s.say }] } });
    else if (s.result !== undefined)
      out({ type: "result", subtype: "success", is_error: !!s.isError, result: s.result, usage: USAGE, permission_denials: [] });
    else if (s.sleepMs) await new Promise((r) => setTimeout(r, s.sleepMs));
    else if (s.waitInput) await nextLine();
    else if (s.writeFile) writeFileSync(s.writeFile.path, s.writeFile.content);
    else if (s.ifExists !== undefined) await run(existsSync(s.ifExists) ? s.then : (s.else ?? []));
    else if (s.callTool) await (await mcp()).callTool({ name: s.callTool.name, arguments: s.callTool.args });
    else if (s.exit !== undefined) process.exit(s.exit);
  }
}

out({ type: "system", subtype: "init", cwd: process.cwd(), argv });
await run(script);
await client?.close();
while ((await nextLine()) !== null) {}
process.exit(0);
