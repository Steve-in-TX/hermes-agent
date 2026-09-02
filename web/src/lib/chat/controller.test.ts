// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionState, GatewayEvent } from "@hermes/shared";

import type { NativeShellBridge, ShellEvents } from "../native-shell";
import { ChatController, type ChatGatewayClient } from "./controller";
import { getSessionState, getShell, resetChatStore } from "./store";

function fakeShell() {
  const handlers = new Map<keyof ShellEvents, Set<(p: never) => void>>();
  const shell: NativeShellBridge = {
    available: true,
    requestNotificationPermission: vi.fn(async () => true),
    startForeground: vi.fn(async () => {}),
    stopForeground: vi.fn(async () => {}),
    notifyApproval: vi.fn(async () => {}),
    notifyTurnComplete: vi.fn(async () => {}),
    cancelApprovalNotification: vi.fn(async () => {}),
    startDictation: vi.fn(async () => null),
    on: vi.fn((event, handler) => {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler as (p: never) => void);
      return () => set!.delete(handler as (p: never) => void);
    }),
  };
  const emit = <K extends keyof ShellEvents>(event: K, payload: ShellEvents[K]) =>
    handlers.get(event)?.forEach((h) => (h as (p: ShellEvents[K]) => void)(payload));
  return { shell, emit };
}

/** A scripted stand-in for JsonRpcGatewayClient. */
function fakeClient() {
  let state: ConnectionState = "idle";
  const stateHandlers = new Set<(s: ConnectionState) => void>();
  const eventHandlers = new Set<(e: GatewayEvent) => void>();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const responders: Record<string, (params: Record<string, unknown>) => unknown> = {
    "session.create": () => ({ session_id: "rt1", stored_session_id: "st1", messages: [], info: { model: "mock-model" } }),
    "session.resume": (p) => ({
      session_id: "rt1",
      resumed: String(p.session_id),
      messages: [
        { role: "user", text: "earlier" },
        { role: "assistant", text: "reply" },
      ],
      running: false,
      info: { model: "mock-model", title: "Old chat" },
    }),
    "prompt.submit": () => ({ status: "streaming" }),
    "approval.pending": () => ({ approvals: [] }),
    "approval.respond": () => ({ resolved: 1 }),
    "approval.received": () => ({ acknowledged: true }),
    "clarify.respond": () => ({ status: "ok" }),
    "session.interrupt": () => ({ status: "interrupted" }),
  };
  const client = {
    get connectionState() {
      return state;
    },
    connect: vi.fn(async () => {
      state = "open";
      stateHandlers.forEach((h) => h(state));
    }),
    close: vi.fn(() => {
      state = "closed";
    }),
    request: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      const r = responders[method];
      if (!r) throw new Error(`unexpected ${method}`);
      return r(params);
    }),
    onState: vi.fn((h: (s: ConnectionState) => void) => {
      stateHandlers.add(h);
      h(state);
      return () => stateHandlers.delete(h);
    }),
    onEvent: vi.fn((h: (e: GatewayEvent) => void) => {
      eventHandlers.add(h);
      return () => eventHandlers.delete(h);
    }),
  };
  return {
    client: client as unknown as ChatGatewayClient & typeof client,
    calls,
    responders,
    emit: (type: string, session_id: string, payload?: unknown) => eventHandlers.forEach((h) => h({ type, session_id, payload } as GatewayEvent)),
    drop: () => {
      state = "closed";
      stateHandlers.forEach((h) => h(state));
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetChatStore();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ChatController", () => {
  it("creates a session lazily on first submit and appends the user message", async () => {
    const fake = fakeClient();
    const ctl = new ChatController({ createClient: () => fake.client, source: "android" });
    await ctl.connect();
    expect(getShell().connection).toBe("open");

    await ctl.submit("  hello  ");
    expect(fake.calls.map((c) => c.method)).toEqual(["session.create", "prompt.submit"]);
    expect(fake.calls[0].params).toMatchObject({ source: "android", close_on_disconnect: false });
    expect(fake.calls[1].params).toEqual({ session_id: "rt1", text: "hello" });
    const s = getSessionState("rt1");
    expect(s.busy).toBe(true);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].role).toBe("user");
    ctl.dispose();
  });

  it("routes events for known sessions and acks approvals", async () => {
    const fake = fakeClient();
    const ctl = new ChatController({ createClient: () => fake.client });
    await ctl.connect();
    await ctl.submit("go");
    fake.emit("message.start", "rt1");
    fake.emit("message.delta", "rt1", { text: "hi" });
    fake.emit("approval.request", "rt1", { request_id: "a1", command: "rm -rf x", choices: ["once", "deny"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(getSessionState("rt1").approval?.requestId).toBe("a1");
    expect(fake.calls.at(-1)).toEqual({ method: "approval.received", params: { session_id: "rt1", request_id: "a1" } });
    // Unknown sessions are ignored (another client's chat).
    fake.emit("message.delta", "other", { text: "x" });
    expect(getSessionState("other").messages).toHaveLength(0);

    await ctl.respondApproval("rt1", "a1", "once");
    expect(getSessionState("rt1").approval).toBeNull();
    expect(fake.calls.filter((c) => c.method === "approval.respond")[0].params).toEqual({ session_id: "rt1", request_id: "a1", choice: "once" });
    expect(fake.calls.filter((c) => c.method === "approval.pending")).toHaveLength(1);
    ctl.dispose();
  });

  it("resumes by stored id, hydrates history, and replays a pending approval", async () => {
    const fake = fakeClient();
    fake.responders["approval.pending"] = () => ({ approvals: [{ request_id: "p1", command: "sudo x", choices: ["once", "deny"] }] });
    const ctl = new ChatController({ createClient: () => fake.client });
    await ctl.connect();
    const sid = await ctl.resumeSession("st1");
    expect(sid).toBe("rt1");
    const s = getSessionState("rt1");
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.title).toBe("Old chat");
    expect(s.storedSessionId).toBe("st1");
    expect(s.approval?.requestId).toBe("p1");
    ctl.dispose();
  });

  it("does not duplicate in-flight text that history already holds", async () => {
    const fake = fakeClient();
    fake.responders["session.resume"] = () => ({
      session_id: "rt1",
      resumed: "st1",
      running: true,
      messages: [
        { role: "user", text: "again M3_APPROVAL" },
        { role: "assistant", text: "I will remove the scratch directory now." },
      ],
      inflight: { assistant: "I will remove the scratch directory now." },
      info: { model: "mock-model" },
    });
    const ctl = new ChatController({ createClient: () => fake.client });
    await ctl.connect();
    await ctl.resumeSession("st1");
    const s = getSessionState("rt1");
    expect(s.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(s.busy).toBe(true);
    ctl.dispose();
  });

  it("reconnects with backoff and re-resumes the active session", async () => {
    const fake = fakeClient();
    const ctl = new ChatController({ createClient: () => fake.client, reconnectBaseMs: 100 });
    await ctl.connect();
    await ctl.submit("first");
    fake.calls.length = 0;

    fake.drop();
    expect(getShell().connection).toBe("closed");
    expect(getShell().reconnectAttempt).toBe(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(fake.client.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.client.connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    // Reconnect resumes by STORED id: the runtime id is detached after a drop.
    expect(fake.calls[0]).toMatchObject({ method: "session.resume", params: { session_id: "st1" } });
    expect(getShell().reconnectAttempt).toBe(0);
    ctl.dispose();
  });

  it("interrupt seals the stream locally and tells the gateway", async () => {
    const fake = fakeClient();
    const ctl = new ChatController({ createClient: () => fake.client });
    await ctl.connect();
    await ctl.submit("run");
    fake.emit("message.start", "rt1");
    fake.emit("message.delta", "rt1", { text: "partial" });
    await ctl.interrupt();
    expect(getSessionState("rt1").busy).toBe(false);
    expect(fake.calls.at(-1)).toEqual({ method: "session.interrupt", params: { session_id: "rt1" } });
    ctl.dispose();
  });

  it("raises notifications only while hidden, and clears them on respond", async () => {
    const fake = fakeClient();
    const { shell } = fakeShell();
    let hidden = false;
    const ctl = new ChatController({ createClient: () => fake.client, shell, isHidden: () => hidden });
    await ctl.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(shell.startForeground).toHaveBeenCalledWith("gateway");
    // Started again once the permission prompt is answered.
    expect(shell.startForeground).toHaveBeenCalledTimes(2);
    expect(shell.requestNotificationPermission).toHaveBeenCalledTimes(1);
    await ctl.submit("go");

    fake.emit("approval.request", "rt1", { request_id: "a1", command: "rm -rf x", description: "recursive delete", choices: ["once", "deny"] });
    expect(shell.notifyApproval).not.toHaveBeenCalled();

    hidden = true;
    fake.emit("approval.request", "rt1", { request_id: "a2", command: "rm -rf y", description: "recursive delete", choices: ["once", "deny"] });
    expect(shell.notifyApproval).toHaveBeenCalledWith({ sessionId: "rt1", requestId: "a2", command: "rm -rf y", description: "recursive delete" });

    await ctl.respondApproval("rt1", "a2", "deny");
    expect(shell.cancelApprovalNotification).toHaveBeenCalledWith("a2");

    fake.emit("message.complete", "rt1", { text: "All   done.", status: "complete" });
    expect(shell.notifyTurnComplete).toHaveBeenCalledWith({ sessionId: "rt1", text: "All done.", title: "Hermes finished" });

    ctl.dispose();
    expect(shell.stopForeground).toHaveBeenCalledTimes(1);
  });

  it("answers a notification action and ignores anything but once/deny", async () => {
    const fake = fakeClient();
    const { shell, emit } = fakeShell();
    const ctl = new ChatController({ createClient: () => fake.client, shell, isHidden: () => true });
    await ctl.connect();
    await ctl.submit("go");
    fake.emit("approval.request", "rt1", { request_id: "a1", command: "rm -rf x", choices: ["once", "session", "always", "deny"] });

    emit("approvalAction", { sessionId: "rt1", requestId: "a1", choice: "always" as never });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.some((c) => c.method === "approval.respond")).toBe(false);

    emit("approvalAction", { sessionId: "rt1", requestId: "a1", choice: "deny" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.filter((c) => c.method === "approval.respond")[0].params).toEqual({ session_id: "rt1", request_id: "a1", choice: "deny" });
    expect(getSessionState("rt1").approval).toBeNull();
    ctl.dispose();
  });

  it("reconnects immediately when the network comes back", async () => {
    const fake = fakeClient();
    const { shell, emit } = fakeShell();
    const ctl = new ChatController({ createClient: () => fake.client, shell, reconnectBaseMs: 60_000 });
    await ctl.connect();
    fake.drop();
    expect(fake.client.connect).toHaveBeenCalledTimes(1);
    emit("networkAvailable", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.client.connect).toHaveBeenCalledTimes(2);
    ctl.dispose();
  });

  it("answers a batch clarify sequentially, one lock per question", async () => {
    const fake = fakeClient();
    const ctl = new ChatController({ createClient: () => fake.client });
    await ctl.connect();
    await ctl.submit("q");
    fake.emit("clarify.request", "rt1", { request_id: "b", questions: [{ qid: "q0", question: "A" }, { qid: "q1", question: "B" }] });
    await ctl.respondClarifyBatch("rt1", "b", [
      { qid: "q0", answer: "one" },
      { qid: "q1", answer: "" },
    ]);
    const locks = fake.calls.filter((c) => c.method === "clarify.respond").map((c) => c.params);
    expect(locks).toEqual([
      { request_id: "b", question_id: "q0", answer: "one" },
      { request_id: "b", question_id: "q1", answer: "" },
    ]);
    expect(getSessionState("rt1").clarify).toBeNull();
    ctl.dispose();
  });
});
