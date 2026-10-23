import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addHost, downloadBinary } from "../src/setup/add-host";
import { loadHosts } from "../src/state";
import { scpArgs, type Transport } from "../src/transport";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ladvin-add-"));
  process.env.LADVIN_HOME = home;
});
afterEach(() => {
  delete process.env.LADVIN_HOME;
  rmSync(home, { recursive: true, force: true });
});

// exec answers: first matching [substring, result] wins.
function fakeTransport(table: [string, { code?: number; stdout?: string; stderr?: string }][]) {
  const execs: string[] = [];
  const uploads: [string, string][] = [];
  const t: Transport = {
    spawnBridge: () => {
      throw new Error("not used");
    },
    exec: async (cmd) => {
      execs.push(cmd);
      const hit = table.find(([k]) => cmd.includes(k));
      return { code: hit?.[1].code ?? 0, stdout: hit?.[1].stdout ?? "", stderr: hit?.[1].stderr ?? "" };
    },
    upload: async (l, r) => void uploads.push([l, r]),
    download: async () => {},
  };
  return { t, execs, uploads };
}

const connection = { connect: async () => ({ agentdVersion: "0.1.0", clockOffsetMs: 0 }), call: async () => ({}) } as any;
const fetchBinary = async () => "/cache/ladvin-agentd-linux-x64";

const LOGIN_OK = "claude=/home/u/.local/bin/claude\ntmux=/usr/bin/tmux\n";

test("unsupported OS is refused", async () => {
  const { t } = fakeTransport([["uname", { stdout: "MINGW64_NT-10.0 x86_64\n" }]]);
  const r = await addHost("win", { transport: t, connection, fetchBinary });
  expect(r.host).toBeUndefined();
  expect(r.lines.join("\n")).toContain("unsupported OS/arch: MINGW64_NT-10.0 x86_64");
});

test("unreachable host reports the ssh error", async () => {
  const { t } = fakeTransport([["uname", { code: 255, stderr: "ssh: Could not resolve hostname nope" }]]);
  const r = await addHost("nope", { transport: t, connection, fetchBinary });
  expect(r.lines.join("\n")).toContain("Could not resolve hostname nope");
});

test("claude found only on the login-shell PATH is resolved and stored", async () => {
  const { t, execs, uploads } = fakeTransport([
    ["uname", { stdout: "Linux x86_64\n" }],
    ["-lc", { stdout: LOGIN_OK }],
    ["command -v", { stdout: "claude=\ntmux=/usr/bin/tmux\n" }],
  ]);
  const r = await addHost("box", { transport: t, connection, fetchBinary });
  expect(r.host).toMatchObject({ alias: "box", os: "linux", arch: "x64", maxPreset: "worker", agentdVersion: "0.1.0" });
  expect(execs.some((c) => c.includes("agentd.json") && c.includes("/home/u/.local/bin/claude"))).toBe(true);
  expect(uploads).toEqual([["/cache/ladvin-agentd-linux-x64", "~/.ladvin/bin/ladvin-agentd.new"]]);
  expect(loadHosts().map((h) => h.alias)).toEqual(["box"]);
});

test("missing claude gives the exact fix", async () => {
  const { t } = fakeTransport([
    ["uname", { stdout: "Darwin arm64\n" }],
    ["command -v", { stdout: "claude=\ntmux=/opt/homebrew/bin/tmux\n" }],
  ]);
  const r = await addHost("mac", { transport: t, connection, fetchBinary });
  expect(r.host).toBeUndefined();
  expect(r.lines).toContain('claude not found on mac. Install it there, then run "claude" once to log in.');
});

test("missing tmux gives the exact fix", async () => {
  const { t } = fakeTransport([
    ["uname", { stdout: "Linux aarch64\n" }],
    ["command -v", { stdout: "claude=/usr/bin/claude\ntmux=\n" }],
  ]);
  const r = await addHost("pi", { transport: t, connection, fetchBinary });
  expect(r.lines).toContain("tmux not found on pi. Install it (e.g. apt install tmux / brew install tmux).");
});

test("claude not logged in is reported", async () => {
  const { t } = fakeTransport([
    ["uname", { stdout: "Linux x86_64\n" }],
    ["command -v", { stdout: LOGIN_OK }],
    ["reply ok", { code: 1, stderr: "Invalid API key · Please run /login" }],
  ]);
  const r = await addHost("box", { transport: t, connection, fetchBinary });
  expect(r.host).toBeUndefined();
  expect(r.lines.join("\n")).toContain("not logged in");
});

test("yolo max preset prints a loud warning", async () => {
  const { t } = fakeTransport([["uname", { stdout: "Linux x86_64\n" }], ["command -v", { stdout: LOGIN_OK }]]);
  const r = await addHost("box", { transport: t, connection, fetchBinary, maxPreset: "yolo" });
  expect(r.lines).toContain("⚠ yolo: agents on box skip ALL permission checks.");
});

test("downloaded binary is verified against SHA256SUMS", async () => {
  const bin = Buffer.from("binary");
  const good = createHash("sha256").update(bin).digest("hex");
  const fetchImpl = (sum: string) =>
    (async (url: string) =>
      url.endsWith("SHA256SUMS")
        ? new Response(`${sum}  ladvin-agentd-linux-x64\n`)
        : new Response(bin)) as unknown as typeof fetch;
  const p = await downloadBinary("linux", "x64", "0.1.0", { fetchImpl: fetchImpl(good) });
  expect(p.endsWith("ladvin-agentd-linux-x64")).toBe(true);
  rmSync(join(home, "cache"), { recursive: true, force: true });
  await expect(downloadBinary("linux", "x64", "0.1.0", { fetchImpl: fetchImpl("0".repeat(64)) })).rejects.toThrow(
    "checksum mismatch for ladvin-agentd-linux-x64",
  );
});

test("LADVIN_AGENTD_BINARY_DIR short-circuits the download", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ladvin-bins-"));
  writeFileSync(join(dir, "ladvin-agentd-darwin-arm64"), "x");
  process.env.LADVIN_AGENTD_BINARY_DIR = dir;
  try {
    expect(await downloadBinary("darwin", "arm64", "0.1.0")).toBe(join(dir, "ladvin-agentd-darwin-arm64"));
  } finally {
    delete process.env.LADVIN_AGENTD_BINARY_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scp args never pass a Windows drive path and keep remote paths home-relative", () => {
  const up = scpArgs("h", "upload", "D:\\my dir\\a b.txt", "~/x/a b.txt");
  expect(up.cwd).toBe("D:\\my dir");
  expect(up.args).toEqual(["./a b.txt", "h:'x/a b.txt'"]);
  expect(up.args.some((a) => a.includes("'~"))).toBe(false);
  const down = scpArgs("h", "download", "/home/me/p/out.log", "/srv/app/out.log");
  expect(down).toEqual({ cwd: "/home/me/p", args: ["h:'/srv/app/out.log'", "./out.log"] });
});
