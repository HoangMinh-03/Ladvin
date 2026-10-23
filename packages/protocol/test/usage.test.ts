import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAccount, type ScanState, scanTranscripts, windowSums } from "../src/usage";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ladvin-usage-"));
  mkdirSync(join(root, "projects", "a", "sub"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const line = (id: string, ts: number, u = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 20, cache_read_input_tokens: 100 }) =>
  JSON.stringify({ type: "assistant", timestamp: new Date(ts).toISOString(), message: { id, usage: u } }) + "\n";
const fresh = (): ScanState => ({ files: {}, seen: [], events: [] });
const projects = () => join(root, "projects");

test("streamed chunks sharing a message id are counted once; subdirectories are scanned", () => {
  writeFileSync(join(projects(), "a", "s1.jsonl"), line("m1", NOW - 1000) + line("m1", NOW - 900) + JSON.stringify({ type: "user" }) + "\n");
  writeFileSync(join(projects(), "a", "sub", "s2.jsonl"), line("m2", NOW - 800));
  const s = scanTranscripts(projects(), fresh(), NOW);
  expect(s.events.map((e) => e.id).sort()).toEqual(["m1", "m2"]);
});

test("a partial last line is left for the next scan and then counted exactly once", () => {
  const f = join(projects(), "a", "s1.jsonl");
  const full = line("m3", NOW - 500);
  writeFileSync(f, line("m1", NOW - 1000) + full.slice(0, 20));
  let s = scanTranscripts(projects(), fresh(), NOW);
  expect(s.events.map((e) => e.id)).toEqual(["m1"]);
  appendFileSync(f, full.slice(20));
  s = scanTranscripts(projects(), s, NOW);
  s = scanTranscripts(projects(), s, NOW);
  expect(s.events.map((e) => e.id)).toEqual(["m1", "m3"]);
});

test("a truncated file is re-read without double counting; a deleted file is forgotten", () => {
  const f = join(projects(), "a", "s1.jsonl");
  writeFileSync(f, line("m1", NOW - 1000) + line("m2", NOW - 900));
  let s = scanTranscripts(projects(), fresh(), NOW);
  writeFileSync(f, line("m1", NOW - 1000));
  s = scanTranscripts(projects(), s, NOW);
  expect(s.events).toHaveLength(2);
  rmSync(f);
  s = scanTranscripts(projects(), s, NOW);
  expect(Object.keys(s.files)).toHaveLength(0);
});

test("events older than 7 days are dropped", () => {
  writeFileSync(join(projects(), "a", "s1.jsonl"), line("old", NOW - 8 * 86400_000) + line("new", NOW - 1000));
  expect(scanTranscripts(projects(), fresh(), NOW).events.map((e) => e.id)).toEqual(["new"]);
});

test("windowSums splits 5h and 7d and computes the 15-minute billable rate", () => {
  writeFileSync(join(projects(), "a", "s1.jsonl"), line("a", NOW - 3600_000) + line("b", NOW - 6 * 3600_000) + line("c", NOW - 60_000));
  const w = windowSums(scanTranscripts(projects(), fresh(), NOW).events, NOW);
  expect(w.last5h).toEqual({ input: 20, output: 10, cacheWrite: 40, cacheRead: 200 });
  expect(w.last7d.input).toBe(30);
  expect(w.billablePerMin15).toBeCloseTo(35 / 15);
});

test("readAccount returns only identity fields, never credentials", () => {
  writeFileSync(
    join(root, ".claude.json"),
    JSON.stringify({ primaryApiKey: "sk-secret", oauthAccount: { accountUuid: "u-1", emailAddress: "a@b.c", displayName: "A", billingType: "x" } }),
  );
  expect(readAccount(root)).toEqual({ accountUuid: "u-1", email: "a@b.c", name: "A" });
  expect(readAccount(join(root, "nope"))).toBeNull();
});

test("files untouched for more than 7 days are skipped without reading or remembering them", () => {
  const { utimesSync } = require("node:fs");
  const f = join(projects(), "a", "old.jsonl");
  writeFileSync(f, line("fresh-looking", NOW - 1000));
  const old = (NOW - 8 * 86400_000) / 1000;
  utimesSync(f, old, old);
  const s = scanTranscripts(projects(), fresh(), NOW);
  expect(s.events).toHaveLength(0);
  expect(Object.keys(s.files)).toHaveLength(0);
});
