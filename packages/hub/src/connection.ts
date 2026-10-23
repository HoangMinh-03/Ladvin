import type { ChildProcess } from "node:child_process";
import { type HelloResult, LineCodec, type Owner, PROTOCOL_MAJOR, type PingResult, RpcPeer } from "@ladvin/protocol";
import type { Transport } from "./transport";

export type ConnectInfo = { agentdVersion: string; clockOffsetMs: number; binarySha256?: string };

// One live bridge (ssh … ladvin-agentd bridge) per host, reconnected lazily.
export class HostConnection {
  private peer: RpcPeer | null = null;
  private child: ChildProcess | null = null;
  private stderrTail = "";
  private connecting: Promise<ConnectInfo> | null = null;
  info: ConnectInfo | null = null;

  constructor(
    readonly alias: string,
    private transport: Transport,
    private owner: Owner,
  ) {}

  connect(): Promise<ConnectInfo> {
    return (this.connecting ??= this.doConnect().finally(() => (this.connecting = null)));
  }

  private async doConnect(): Promise<ConnectInfo> {
    this.close();
    const child = this.transport.spawnBridge();
    this.child = child;
    this.stderrTail = "";
    const peer = new RpcPeer((l) => child.stdin!.write(l));
    this.peer = peer;
    const codec = new LineCodec();
    child.stdout!.setEncoding("utf8").on("data", (c: string) => codec.push(c).forEach((m) => peer.receive(m)));
    child.stderr!.setEncoding("utf8").on("data", (c: string) => (this.stderrTail = (this.stderrTail + c).slice(-2000)));
    child.stdin!.on("error", () => {});
    const gone = () => peer.close(`host ${this.alias} unreachable: ${this.stderrTail.trim() || "connection closed"}`);
    child.on("exit", gone);
    child.on("error", gone);

    const hello = await peer.request<HelloResult>("hello", { protocolMajor: PROTOCOL_MAJOR, client: this.owner }, 30_000);
    const offsets: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const { now } = await peer.request<PingResult>("ping", {}, 10_000);
      const t1 = Date.now();
      offsets.push(Date.parse(now) - (t0 + t1) / 2);
    }
    offsets.sort((a, b) => a - b);
    this.info = { agentdVersion: hello.agentdVersion, clockOffsetMs: offsets[1]!, binarySha256: hello.binarySha256 };
    return this.info;
  }

  private alive(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  async call<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (!this.alive() || !this.peer) await this.connect();
    return this.peer!.request<T>(method, params, timeoutMs);
  }

  close(): void {
    this.peer?.close("connection closed");
    this.child?.stdin?.end();
    this.child?.kill();
    this.peer = null;
    this.child = null;
  }
}

export class ConnectionPool {
  private conns = new Map<string, HostConnection>();
  constructor(
    private owner: Owner,
    private transportFor: (alias: string) => Transport,
  ) {}

  get(alias: string): HostConnection {
    let c = this.conns.get(alias);
    if (!c) this.conns.set(alias, (c = new HostConnection(alias, this.transportFor(alias), this.owner)));
    return c;
  }

  transport(alias: string): Transport {
    return this.transportFor(alias);
  }

  closeAll(): void {
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
  }
}
