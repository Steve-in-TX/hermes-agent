// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import {
  NativeSocketRegistry,
  base64ToBytes,
  bytesToBase64,
  createCapacitorHttpDriver,
  planNativeSocket,
  type HermesHttpPlugin,
  type HermesSocketPlugin,
  type NativeSocketEvent,
  type NativeSocketEventName,
} from "./capacitor";

describe("base64 helpers", () => {
  it("round-trips bytes, including a chunk boundary", () => {
    const bytes = new Uint8Array(0x8000 + 17);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

describe("createCapacitorHttpDriver", () => {
  it("hands the request to the plugin and rebuilds a real Response", async () => {
    const plugin: HermesHttpPlugin = {
      request: vi.fn(async (req) => ({
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json", "x-echo-method": req.method },
        bodyBase64: bytesToBase64(new TextEncoder().encode('{"sessions":[]}')),
      })),
    };
    const driver = createCapacitorHttpDriver(plugin);

    const res = await driver.fetch("https://gw.example:9119/api/sessions", {
      method: "get",
      headers: { Authorization: "Bearer tok" },
      credentials: "omit",
    });

    expect(plugin.request).toHaveBeenCalledWith({
      url: "https://gw.example:9119/api/sessions",
      method: "GET",
      headers: { authorization: "Bearer tok" },
      body: undefined,
      bodyBase64: undefined,
    });
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.headers.get("x-echo-method")).toBe("GET");
    await expect(res.json()).resolves.toEqual({ sessions: [] });
  });

  it("sends JSON bodies as text and sets the content type from the body when absent", async () => {
    const plugin: HermesHttpPlugin = {
      request: vi.fn(async () => ({ status: 204, headers: {}, bodyBase64: "" })),
    };
    const driver = createCapacitorHttpDriver(plugin);
    const res = await driver.fetch("https://gw/api/x", {
      method: "POST",
      body: new URLSearchParams({ a: "1" }),
    });
    const call = (plugin.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.body).toBe("a=1");
    expect(call.headers["content-type"]).toMatch(/x-www-form-urlencoded/);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("surfaces a 401 as a normal non-ok Response (no throw)", async () => {
    const plugin: HermesHttpPlugin = {
      request: vi.fn(async () => ({
        status: 401,
        headers: { "content-type": "application/json" },
        bodyBase64: bytesToBase64(new TextEncoder().encode('{"error":"unauthenticated"}')),
      })),
    };
    const res = await createCapacitorHttpDriver(plugin).fetch("https://gw/api/auth/me");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthenticated" });
  });
});

describe("planNativeSocket", () => {
  it("moves the /api/ws ticket into the gateway subprotocols", () => {
    expect(planNativeSocket("wss://gw.example:9119/hermes/api/ws?ticket=abc")).toEqual({
      url: "wss://gw.example:9119/hermes/api/ws",
      protocols: ["hermes-gateway-v1", "hermes-gateway-ticket.abc"],
    });
  });

  it("leaves other endpoints on the query form (only gateway_ws echoes a subprotocol)", () => {
    const url = "wss://gw.example:9119/api/events?channel=c&ticket=abc";
    expect(planNativeSocket(url)).toEqual({ url });
  });

  it("leaves /api/ws alone without a ticket", () => {
    const url = "ws://10.0.0.5:9119/api/ws?token=legacy";
    expect(planNativeSocket(url)).toEqual({ url });
  });
});

function fakeSocketPlugin() {
  const listeners = new Map<NativeSocketEventName, (e: NativeSocketEvent) => void>();
  let nextId = 0;
  const plugin: HermesSocketPlugin = {
    connect: vi.fn(async () => ({ id: `ws${++nextId}` })),
    send: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    addListener: vi.fn(async (name, cb) => {
      listeners.set(name, cb);
      return { remove: async () => {} };
    }),
  };
  const emit = (name: NativeSocketEventName, event: NativeSocketEvent) => listeners.get(name)?.(event);
  return { plugin, emit };
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

describe("NativeSocketRegistry", () => {
  it("routes open/message/close to the right socket by id", async () => {
    const { plugin, emit } = fakeSocketPlugin();
    const registry = new NativeSocketRegistry(plugin);
    const ws = registry.open("wss://gw/api/ws?ticket=t1");
    const opened = vi.fn();
    const messages: string[] = [];
    const closed = vi.fn();
    ws.addEventListener("open", opened);
    ws.addEventListener("message", (e) => messages.push((e as MessageEvent).data as string));
    ws.addEventListener("close", (e) => closed((e as CloseEvent).code));
    await flush();

    expect(plugin.connect).toHaveBeenCalledWith({
      url: "wss://gw/api/ws",
      protocols: ["hermes-gateway-v1", "hermes-gateway-ticket.t1"],
    });
    expect(ws.readyState).toBe(0);

    emit("open", { id: "ws1", protocol: "hermes-gateway-v1" });
    expect(ws.readyState).toBe(1);
    expect(ws.protocol).toBe("hermes-gateway-v1");
    expect(opened).toHaveBeenCalledTimes(1);

    emit("message", { id: "ws1", data: '{"jsonrpc":"2.0"}' });
    emit("message", { id: "ws-other", data: "not mine" });
    expect(messages).toEqual(['{"jsonrpc":"2.0"}']);

    ws.send("hello");
    expect(plugin.send).toHaveBeenCalledWith({ id: "ws1", data: "hello" });

    emit("close", { id: "ws1", code: 1000, reason: "bye", wasClean: true });
    expect(ws.readyState).toBe(3);
    expect(closed).toHaveBeenCalledWith(1000);
  });

  it("replays events that arrive before connect() resolves", async () => {
    const { plugin, emit } = fakeSocketPlugin();
    const registry = new NativeSocketRegistry(plugin);
    const ws = registry.open("wss://gw/api/events?ticket=t");
    const onopen = vi.fn();
    ws.onopen = onopen;
    // Native side emitted before the JS promise settled.
    emit("open", { id: "ws1" });
    expect(ws.readyState).toBe(0);
    await flush();
    expect(ws.readyState).toBe(1);
    expect(onopen).toHaveBeenCalledTimes(1);
  });

  it("closes natively once the id is known when close() raced connect()", async () => {
    const { plugin } = fakeSocketPlugin();
    const registry = new NativeSocketRegistry(plugin);
    const ws = registry.open("wss://gw/api/ws");
    ws.close(1000, "early");
    expect(ws.readyState).toBe(2);
    await flush();
    expect(plugin.close).toHaveBeenCalledWith({ id: "ws1", code: 1000, reason: "early" });
  });

  it("reports a rejected connect() as error + unclean close", async () => {
    const { plugin } = fakeSocketPlugin();
    (plugin.connect as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("refused"));
    const registry = new NativeSocketRegistry(plugin);
    const ws = registry.open("wss://gw/api/ws");
    const onerror = vi.fn();
    const onclose = vi.fn();
    ws.addEventListener("error", onerror);
    ws.addEventListener("close", (e) => onclose((e as CloseEvent).code));
    await flush();
    expect(onerror).toHaveBeenCalledTimes(1);
    expect(onclose).toHaveBeenCalledWith(1006);
    expect(ws.readyState).toBe(3);
  });

  it("delivers binary frames as ArrayBuffer when asked", async () => {
    const { plugin, emit } = fakeSocketPlugin();
    const registry = new NativeSocketRegistry(plugin);
    const ws = registry.open("wss://gw/api/pty?ticket=t");
    ws.binaryType = "arraybuffer";
    await flush();
    emit("open", { id: "ws1" });
    const received: ArrayBuffer[] = [];
    ws.onmessage = (e) => received.push(e.data as ArrayBuffer);
    emit("message", { id: "ws1", dataBase64: bytesToBase64(new Uint8Array([1, 2, 3])) });
    expect(new Uint8Array(received[0])).toEqual(new Uint8Array([1, 2, 3]));
  });
});
