import { describe, expect, test } from "bun:test";
import { LineCodec, RpcError, RpcPeer } from "../src/rpc";

function pair(): [RpcPeer, RpcPeer] {
  let a!: RpcPeer;
  let b!: RpcPeer;
  a = new RpcPeer((line) => queueMicrotask(() => b.receive(JSON.parse(line))));
  b = new RpcPeer((line) => queueMicrotask(() => a.receive(JSON.parse(line))));
  return [a, b];
}

describe("LineCodec", () => {
  test("buffers partial lines across chunks", () => {
    const c = new LineCodec();
    expect(c.push('{"a":1}\n{"b"')).toEqual([{ a: 1 }]);
    expect(c.push(":2}\n")).toEqual([{ b: 2 }]);
  });

  test("reports malformed lines without throwing", () => {
    const errors: string[] = [];
    const c = new LineCodec((line) => errors.push(line));
    expect(c.push('nope\n{"ok":true}\n')).toEqual([{ ok: true }]);
    expect(errors).toEqual(["nope"]);
  });
});

describe("RpcPeer", () => {
  test("request resolves with handler result", async () => {
    const [a, b] = pair();
    b.handle("add", async (p: any) => p.a + p.b);
    expect(await a.request<number>("add", { a: 2, b: 3 })).toBe(5);
  });

  test("handler RpcError propagates code", async () => {
    const [a, b] = pair();
    b.handle("boom", async () => {
      throw new RpcError(42, "x");
    });
    await expect(a.request("boom")).rejects.toMatchObject({ code: 42, message: "x" });
  });

  test("unknown method rejects with -32601", async () => {
    const [a] = pair();
    await expect(a.request("nope")).rejects.toMatchObject({ code: -32601 });
  });

  test("close rejects pending requests with the reason", async () => {
    const a = new RpcPeer(() => {});
    const p = a.request("never");
    a.close("gone");
    await expect(p).rejects.toMatchObject({ code: -32000, message: "gone" });
  });

  test("request times out with -32001", async () => {
    const a = new RpcPeer(() => {});
    await expect(a.request("never", {}, 50)).rejects.toMatchObject({ code: -32001 });
  });

  test("notifications reach onNotify", async () => {
    const [a, b] = pair();
    const got = new Promise((r) => b.onNotify("evt", r));
    a.notify("evt", { n: 1 });
    expect(await got).toEqual({ n: 1 });
  });
});
