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

const connection = { connect: async () => ({ agentdVersion: "0.3.1", clockOffsetMs: 0 }), call: async () => ({}) } as any;
const fetchBinary = async () => "/cache/ladvin-agentd-linux-x64";

// Output of the single host probe (PROBE in add-host.ts): login-shell view, install-dir candidates, plain view.
const probe = (o: { path?: string; claude?: string; tmux?: string; cands?: string[]; plainclaude?: string; plaintmux?: string }) =>
  [
    `path=${o.path ?? ""}`,
    `claude=${o.claude ?? ""}`,
    `tmux=${o.tmux ?? ""}`,
    ...(o.cands ?? []).map((c) => `cand=${c}`),
    "plainpath=/usr/bin:/bin",
    `plainclaude=${o.plainclaude ?? ""}`,
    `plaintmux=${o.plaintmux ?? ""}`,
  ].join("\n") + "\n";
const LOGIN_OK = probe({ path: "/home/u/.local/bin:/usr/bin", claude: "/home/u/.local/bin/claude", tmux: "/usr/bin/tmux" });

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
    ["command -v", { stdout: LOGIN_OK }],
  ]);
  const r = await addHost("box", { transport: t, connection, fetchBinary });
  expect(r.host).toMatchObject({ alias: "box", os: "linux", arch: "x64", maxPreset: "worker", agentdVersion: "0.3.1" });
  const install = execs.find((c) => c.includes("agentd.json"))!;
  expect(install).toContain("/home/u/.local/bin/claude");
  expect(install).toContain("/home/u/.local/bin:/usr/bin");
  // the login probe runs claude with the captured PATH, not the bare ssh PATH
  expect(execs.find((c) => c.includes("reply ok"))).toContain("PATH=");
  expect(uploads).toEqual([["/cache/ladvin-agentd-linux-x64", "~/.ladvin/bin/ladvin-agentd.new"]]);
  expect(loadHosts().map((h) => h.alias)).toEqual(["box"]);
});

test("missing claude gives the exact fix", async () => {
  const { t } = fakeTransport([
    ["uname", { stdout: "Darwin arm64\n" }],
    ["command -v", { stdout: probe({ tmux: "/opt/homebrew/bin/tmux" }) }],
  ]);
  const r = await addHost("mac", { transport: t, connection, fetchBinary });
  expect(r.host).toBeUndefined();
  expect(r.lines).toContain('claude not found on mac. Install it there and run "claude" once to log in, or pass its full path as claude_path.');
});

test("missing tmux gives the exact fix", async () => {
  const { t } = fakeTransport([
    ["uname", { stdout: "Linux aarch64\n" }],
    ["command -v", { stdout: probe({ claude: "/usr/bin/claude" }) }],
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
  expect(down).toEqual({ cwd: "/home/me/p", args: ["h:/srv/app/out.log", "./out.log"] });
});

test("an nvm-installed claude missed by the login shell is found in a well-known location", async () => {
  const nvm = "/home/u/.nvm/versions/node/v22.1.0/bin/claude";
  const { t, execs } = fakeTransport([
    ["uname", { stdout: "Linux x86_64\n" }],
    ["command -v", { stdout: probe({ path: "/usr/bin", tmux: "/usr/bin/tmux", cands: [nvm] }) }],
  ]);
  const r = await addHost("box", { transport: t, connection, fetchBinary });
  expect(r.host).toBeDefined();
  const install = execs.find((c) => c.includes("agentd.json"))!;
  expect(install).toContain(nvm);
  expect(install).toContain("/home/u/.nvm/versions/node/v22.1.0/bin:"); // node lives next to claude
});

test("an explicit claude path overrides discovery", async () => {
  const { t, execs } = fakeTransport([
    ["uname", { stdout: "Linux x86_64\n" }],
    ["command -v", { stdout: probe({ tmux: "/usr/bin/tmux" }) }],
  ]);
  const r = await addHost("box", { transport: t, connection, fetchBinary, claudePath: "/opt/claude/bin/claude" });
  expect(r.host).toBeDefined();
  expect(execs.find((c) => c.includes("agentd.json"))).toContain("/opt/claude/bin/claude");
});

test("probe and install commands are wrapped in sh -c so non-POSIX login shells (fish, csh) work", async () => {
  const { t, execs } = fakeTransport([["uname", { stdout: "Linux x86_64\n" }], ["command -v", { stdout: LOGIN_OK }]]);
  await addHost("box", { transport: t, connection, fetchBinary });
  for (const c of execs.filter((c) => c.includes("command -v") || c.includes("agentd.json") || c.includes("reply ok"))) expect(c.startsWith("sh -c ")).toBe(true);
});

test("ssh never waits long on a dead host", async () => {
  const { sshBase } = await import("../src/transport");
  expect(sshBase().join(" ")).toContain("ConnectTimeout=10");
});

// ---- upgrade by binary hash ----
function binary(content: string): { path: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "ladvin-bin-"));
  const path = join(dir, "ladvin-agentd-linux-x64");
  writeFileSync(path, content);
  return { path, sha: createHash("sha256").update(content).digest("hex") };
}

function seqConnection(shas: string[], shutdown: () => Promise<unknown>) {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    connection: {
      connect: async () => ({ agentdVersion: "0.3.1", clockOffsetMs: 0, binarySha256: shas[Math.min(i++, shas.length - 1)] }),
      call: async (m: string) => {
        calls.push(m);
        return m === "shutdown" ? shutdown() : {};
      },
    } as any,
  };
}

test("identical binary: no upload, no restart", async () => {
  const bin = binary("v3");
  const { t, uploads } = fakeTransport([
    ["uname", { stdout: "Linux x86_64\n" }],
    ["command -v", { stdout: LOGIN_OK }],
    ["sha256sum", { stdout: `${bin.sha}  /home/u/.ladvin/bin/ladvin-agentd\n` }],
  ]);
  const { connection, calls } = seqConnection([bin.sha], async () => ({}));
  const r = await addHost("box", { transport: t, connection, fetchBinary: async () => bin.path });
  expect(uploads).toEqual([]);
  expect(calls).not.toContain("shutdown");
  expect(r.lines).toContain("✓ ladvin-agentd already up to date");
  expect(r.host).toBeDefined();
});

test("new binary while agents run: uploaded, restart deferred with a warning", async () => {
  const bin = binary("v3");
  const { t, uploads } = fakeTransport([
    ["uname", { stdout: "Linux x86_64\n" }],
    ["command -v", { stdout: LOGIN_OK }],
    ["sha256sum", { stdout: `${"0".repeat(64)}  x\n` }],
  ]);
  const { connection } = seqConnection(["old"], async () => {
    throw new Error("2 agents running; pass force to stop them");
  });
  const r = await addHost("box", { transport: t, connection, fetchBinary: async () => bin.path });
  expect(uploads).toHaveLength(1);
  expect(r.lines.join("\n")).toContain("keeps running the old binary until its 2 agent(s) finish");
  expect(r.host).toBeDefined();
});

test("new binary while idle: daemon restarted on it", async () => {
  const bin = binary("v3");
  const { t } = fakeTransport([
    ["uname", { stdout: "Linux x86_64\n" }],
    ["command -v", { stdout: LOGIN_OK }],
    ["sha256sum", { stdout: "" }],
  ]);
  const { connection, calls } = seqConnection(["old", bin.sha], async () => ({}));
  const r = await addHost("box", { transport: t, connection, fetchBinary: async () => bin.path });
  expect(calls).toContain("shutdown");
  expect(r.lines).toContain("✓ restarted agentd on the new binary");
});

test("plain remote paths are passed unquoted (SFTP-mode scp takes quotes literally)", () => {
  expect(scpArgs("h", "upload", "/tmp/ladvin-agentd-linux-x64", "~/.ladvin/bin/ladvin-agentd.new").args).toEqual([
    "./ladvin-agentd-linux-x64",
    "h:.ladvin/bin/ladvin-agentd.new",
  ]);
  expect(scpArgs("h", "download", "/home/me/p/out.log", "/srv/app/out.log").args[0]).toBe("h:/srv/app/out.log");
});
