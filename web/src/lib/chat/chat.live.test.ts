/**
 * Live end-to-end check of the structured chat against the M3 rig
 * (apps/mobile/testing/rig.sh: real `hermes serve`, mock model, manual
 * approvals). Runs the same ChatController + GatewayClient the app uses,
 * from Node — which, like the native transport, has no CORS.
 *
 *   HERMES_LIVE_GATEWAY=http://127.0.0.1:9137 \
 *   HERMES_LIVE_TOKEN="$(apps/mobile/scripts/mint-token.sh http://127.0.0.1:9137 spike m0-spike-password)" \
 *     npx vitest run src/lib/chat/chat.live.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { normalizeGatewayUrl, setBackendTarget } from "../backend-target";
import { GatewayClient } from "../gatewayClient";
import { ChatController } from "./controller";
import { getSessionState, getShell, resetChatStore } from "./store";
import type { SessionChatState, ToolPart } from "./types";

const GATEWAY = process.env.HERMES_LIVE_GATEWAY ?? "";
const TOKEN = process.env.HERMES_LIVE_TOKEN ?? "";

async function until(predicate: () => boolean, label: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const active = (): SessionChatState => getSessionState(getShell().activeSessionId);
const tools = (s: SessionChatState): ToolPart[] =>
  s.messages.flatMap((m) => m.parts.filter((p): p is ToolPart => p.type === "tool"));

describe.skipIf(!GATEWAY || !TOKEN)("structured chat against a live gateway", () => {
  let ctl: ChatController;

  beforeAll(async () => {
    resetChatStore();
    const { origin, basePath } = normalizeGatewayUrl(GATEWAY);
    setBackendTarget({ origin, basePath, bearer: () => TOKEN });
    ctl = new ChatController({ createClient: () => new GatewayClient(), source: "android" });
    await ctl.connect();
    await until(() => getShell().connection === "open", "socket open", 15_000);
  }, 30_000);

  afterAll(() => {
    ctl?.dispose();
    setBackendTarget(null);
  });

  it("streams a plain reply into one assistant bubble", async () => {
    await ctl.submit("hello from the live test");
    await until(() => !active().busy && active().messages.length >= 2, "turn to finish", 90_000);
    const s = active();
    const assistant = s.messages.filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0].parts.find((p) => p.type === "text")).toMatchObject({ text: "You said: hello from the live test" });
    expect(s.model).toBe("mock-model");
  }, 120_000);

  it("runs a tool turn end to end", async () => {
    await ctl.submit("please M3_TOOL");
    await until(() => !active().busy && tools(active()).some((t) => t.status === "complete"), "tool to complete", 90_000);
    const tool = tools(active()).at(-1)!;
    expect(tool).toMatchObject({ name: "terminal", status: "complete", resultText: "hello-from-tool", isError: false });
  }, 120_000);

  it("parks an approval, resolves it from the client, and the agent proceeds", async () => {
    await ctl.submit("now M3_APPROVAL");
    await until(() => active().approval !== null, "approval.request", 90_000);
    const approval = active().approval!;
    expect(approval.choices).toEqual(["once", "session", "always", "deny"]);
    expect(approval.command).toContain("rm -rf /tmp/hermes-m3-approval-test");
    await ctl.respondApproval(active().sessionId, approval.requestId, "once");
    await until(() => !active().busy, "turn to finish after approval", 90_000);
    const tool = tools(active()).at(-1)!;
    expect(tool.status).toBe("complete");
    expect(String((tool.result as { approval?: string })?.approval ?? "")).toMatch(/approved/i);
    expect(active().approval).toBeNull();
  }, 120_000);

  it("replays a pending approval after the socket dies mid-approval", async () => {
    await ctl.submit("again M3_APPROVAL");
    await until(() => active().approval !== null, "approval.request", 90_000);
    const requestId = active().approval!.requestId;

    ctl.simulateDisconnect();
    expect(getShell().connection).toBe("closed");
    await until(() => getShell().connection === "open" && getShell().reconnectAttempt === 0, "reconnect", 30_000);
    await until(() => active().approval?.requestId === requestId, "approval replayed via approval.pending", 30_000);

    await ctl.respondApproval(active().sessionId, requestId, "deny");
    await until(() => !active().busy, "turn to finish after deny", 90_000);
    const tool = tools(active()).at(-1)!;
    expect(tool.status).toBe("complete");
    expect(String((tool.result as { approval?: string; error?: string })?.approval ?? (tool.result as { error?: string })?.error ?? "")).toMatch(/den|reject/i);
  }, 180_000);

  it("answers a clarify question", async () => {
    await ctl.submit("now M3_CLARIFY");
    await until(() => active().clarify !== null, "clarify.request", 90_000);
    const clarify = active().clarify!;
    expect(clarify.choices).toEqual(["Yes (Recommended)", "No"]);
    await ctl.respondClarify(active().sessionId, clarify.requestId, "Yes");
    await until(() => !active().busy, "turn to finish after clarify", 90_000);
    const last = active().messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.parts.find((p) => p.type === "text")).toMatchObject({ text: expect.stringContaining("proceeding") });
  }, 120_000);

  it("resumes the same session by stored id with the transcript intact", async () => {
    const before = active();
    const stored = before.storedSessionId!;
    expect(stored).toBeTruthy();
    const count = before.messages.length;
    const sid = await ctl.resumeSession(stored);
    const after = getSessionState(sid);
    expect(after.messages.length).toBeGreaterThanOrEqual(count - 1);
    expect(after.messages[0].role).toBe("user");
  }, 60_000);
});
