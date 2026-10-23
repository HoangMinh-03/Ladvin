// Newline-delimited JSON-RPC 2.0, symmetric: either side can request, notify and handle.

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export const ERR_CLOSED = -32000;
export const ERR_TIMEOUT = -32001;
export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;
export const ERR_INTERNAL = -32603;

export class LineCodec {
  private buf = "";
  constructor(private onError: (line: string) => void = () => {}) {}

  push(chunk: string): unknown[] {
    this.buf += chunk;
    const out: unknown[] = [];
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        this.onError(line);
      }
    }
    return out;
  }
}

type Handler = (params: unknown, ctx: { peer: RpcPeer }) => Promise<unknown>;
type Pending = { resolve: (v: any) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> };

export class RpcPeer {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Handler>();
  private notifyHandlers = new Map<string, (params: unknown) => void>();
  private closed: string | null = null;

  constructor(private write: (line: string) => void) {}

  handle(method: string, fn: Handler): void {
    this.handlers.set(method, fn);
  }

  onNotify(method: string, fn: (params: unknown) => void): void {
    this.notifyHandlers.set(method, fn);
  }

  request<T>(method: string, params?: unknown, timeoutMs = 30000): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError(ERR_CLOSED, this.closed));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(ERR_TIMEOUT, `${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  receive(msg: any): void {
    if (!msg || typeof msg !== "object") return;
    if (typeof msg.method === "string") {
      if (msg.id === undefined) this.notifyHandlers.get(msg.method)?.(msg.params);
      else void this.dispatch(msg.id, msg.method, msg.params);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
    else p.resolve(msg.result);
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = reason;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RpcError(ERR_CLOSED, reason));
    }
    this.pending.clear();
  }

  private async dispatch(id: unknown, method: string, params: unknown): Promise<void> {
    const h = this.handlers.get(method);
    if (!h) {
      this.send({ jsonrpc: "2.0", id, error: { code: ERR_METHOD_NOT_FOUND, message: `method not found: ${method}` } });
      return;
    }
    try {
      const result = await h(params, { peer: this });
      this.send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (e) {
      const err = e instanceof RpcError ? e : new RpcError(ERR_INTERNAL, e instanceof Error ? e.message : String(e));
      this.send({ jsonrpc: "2.0", id, error: { code: err.code, message: err.message, data: err.data } });
    }
  }

  private send(msg: unknown): void {
    if (this.closed) return;
    try {
      this.write(JSON.stringify(msg) + "\n");
    } catch (e) {
      this.close(`write failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}
