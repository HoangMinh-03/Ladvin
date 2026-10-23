import { expect, test } from "bun:test";
import { buildArgs, parseEvent, userMessage } from "../src/claude";
import { OBSERVER_ALLOWLIST } from "../src/presets";

const base = { cwd: "/w", mcpConfigPath: "/m.json", systemPrompt: "SP" };

test("observer preset: default permission mode and Bash allowlist, never bypass", () => {
  const a = buildArgs({ ...base, preset: "observer" });
  expect(a).toContain("-p");
  expect(a.join(" ")).toContain("--permission-mode default");
  expect(a.join(" ")).toContain("Bash(journalctl:*)");
  expect(a.join(" ")).not.toContain("bypassPermissions");
  expect(OBSERVER_ALLOWLIST).toContain("iostat");
});

test("worker preset uses acceptEdits", () => {
  expect(buildArgs({ ...base, preset: "worker" }).join(" ")).toContain("--permission-mode acceptEdits");
});

test("yolo preset bypasses permissions", () => {
  expect(buildArgs({ ...base, preset: "yolo" }).join(" ")).toContain("--permission-mode bypassPermissions");
});

test("stream-json flags, mcp config and resume", () => {
  const a = buildArgs({ ...base, preset: "worker" });
  const s = a.join(" ");
  expect(s).toContain("--input-format stream-json --output-format stream-json --verbose");
  expect(s).toContain("--mcp-config /m.json --strict-mcp-config");
  expect(a[a.indexOf("--append-system-prompt") + 1]).toBe("SP");
  expect(a).not.toContain("--resume");
  const r = buildArgs({ ...base, preset: "worker", resumeSessionId: "abc" });
  expect(r[r.indexOf("--resume") + 1]).toBe("abc");
});

test("userMessage is one stream-json line", () => {
  const l = userMessage("hi");
  expect(l.endsWith("\n")).toBe(true);
  expect(JSON.parse(l)).toEqual({ type: "user", message: { role: "user", content: "hi" } });
});

// Fixtures from docs/spikes.md
test("parseEvent maps init, assistant, result, rateLimit", () => {
  expect(parseEvent('{"type":"system","subtype":"init","session_id":"S"}')).toEqual({ kind: "init", sessionId: "S" });
  expect(
    parseEvent(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Hi"},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}',
    ),
  ).toEqual({ kind: "assistant", text: "Hi", toolUses: ["Bash(ls)"] });
  expect(
    parseEvent(
      '{"type":"result","subtype":"success","is_error":false,"result":"done","permission_denials":[{"tool_name":"Bash","tool_input":{"command":"rm x"}}],"usage":{"input_tokens":2,"cache_creation_input_tokens":5,"cache_read_input_tokens":7,"output_tokens":3}}',
    ),
  ).toEqual({
    kind: "result",
    isError: false,
    text: "done",
    usage: { input: 2, output: 3, cacheRead: 7, cacheWrite: 5 },
    permissionDenials: ["Bash(rm x)"],
  });
  expect(
    parseEvent(
      '{"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"five_hour":{"utilization":0.11,"resetsAt":1},"seven_day":{"utilization":0.02,"resetsAt":2}}}}',
    ),
  ).toEqual({ kind: "rateLimit", fiveHour: { utilization: 0.11, resetsAt: 1 }, sevenDay: { utilization: 0.02, resetsAt: 2 } });
  expect(parseEvent('{"type":"system","subtype":"hook_started"}')).toEqual({ kind: "other" });
  expect(parseEvent("not json")).toBeNull();
});

test("observer and worker may call ladvin's own MCP tools (report/attach)", () => {
  for (const preset of ["observer", "worker"] as const) {
    const a = buildArgs({ ...base, preset });
    const allowed = a[a.indexOf("--allowedTools") + 1]!.split(",");
    expect(allowed).toContain("mcp__ladvin");
  }
});

test("observer allowlist has no SQL clients that can write", () => {
  const s = buildArgs({ ...base, preset: "observer" }).join(" ");
  expect(s).not.toContain("psql");
  expect(s).not.toContain("mysql");
});

test("parseEvent keeps assistant message id and usage when present", () => {
  expect(
    parseEvent('{"type":"assistant","message":{"id":"m1","content":[],"usage":{"input_tokens":4,"output_tokens":6}}}'),
  ).toEqual({ kind: "assistant", text: "", toolUses: [], id: "m1", usage: { input: 4, output: 6, cacheRead: 0, cacheWrite: 0 } });
});
