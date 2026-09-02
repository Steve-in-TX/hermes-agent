import { describe, expect, it } from "vitest";

import { messagesFromHistory } from "./hydrate";
import { appendUserMessage, applyGatewayEvent, markInterrupted, resultToText } from "./reducer";
import { createSessionChatState, messageText, type SessionChatState, type ToolPart } from "./types";

// Event sequences below are the ones a real `hermes serve` emitted in the M3
// rig (apps/mobile/testing/rig.sh), trimmed to the fields the reducer reads.
function run(events: Array<[string, unknown?]>, start = createSessionChatState("s1")): SessionChatState {
  return events.reduce((state, [type, payload]) => applyGatewayEvent(state, type, payload), start);
}

const assistant = (state: SessionChatState) => state.messages.filter((m) => m.role === "assistant");

describe("plain streamed reply", () => {
  it("opens one assistant bubble, streams deltas, settles on complete", () => {
    let s = appendUserMessage(createSessionChatState("s1"), "hello there");
    expect(s.busy).toBe(true);
    s = run(
      [
        ["message.start"],
        ["thinking.delta", { text: "formulating..." }],
        ["message.delta", { text: "You" }],
        ["message.delta", { text: " said:" }],
        ["message.delta", { text: " hello there" }],
        ["reasoning.available", { text: "You said: hello there" }],
        ["message.complete", { text: "You said: hello there", status: "complete" }],
      ],
      s,
    );
    expect(s.busy).toBe(false);
    expect(s.streamId).toBeNull();
    expect(s.thinking).toBeNull();
    const a = assistant(s);
    expect(a).toHaveLength(1);
    expect(messageText(a[0])).toBe("You said: hello there");
    expect(a[0].pending).toBe(false);
    expect(a[0].status).toBe("complete");
  });

  it("adopts the final text when nothing was streamed", () => {
    const s = run([["message.start"], ["message.complete", { text: "Final only", status: "complete" }]]);
    expect(messageText(assistant(s)[0])).toBe("Final only");
  });

  it("marks an error turn and keeps the error visible", () => {
    const s = run([["message.start"], ["message.complete", { text: "", status: "error", error: "provider down" }]]);
    expect(s.lastError).toBe("provider down");
    expect(s.busy).toBe(false);
  });
});

describe("tool turn", () => {
  const TOOL_TURN: Array<[string, unknown?]> = [
    ["message.start"],
    ["message.delta", { text: "Let" }],
    ["message.delta", { text: " me check." }],
    ["tool.generating", { name: "terminal" }],
    ["message.interim", { text: "Let me check.", already_streamed: true }],
    ["tool.start", { tool_id: "call_1", name: "terminal", context: "echo hello-from-tool", args: { command: "echo hello-from-tool" } }],
    ["tool.complete", { tool_id: "call_1", name: "terminal", args: { command: "echo hello-from-tool" }, duration_s: 7.5, result: { output: "hello-from-tool", exit_code: 0, error: null } }],
    ["message.complete", { text: "The tool said hello-from-tool.", status: "complete" }],
  ];

  it("seals the interim bubble, attaches the tool to a new bubble, then the final text", () => {
    const s = run(TOOL_TURN);
    const a = assistant(s);
    expect(a).toHaveLength(2);
    expect(a[0].interim).toBe(true);
    expect(messageText(a[0])).toBe("Let me check.");
    const tool = a[1].parts.find((p): p is ToolPart => p.type === "tool");
    expect(tool).toMatchObject({ name: "terminal", status: "complete", resultText: "hello-from-tool", isError: false, durationS: 7.5 });
    expect(messageText(a[1])).toBe("The tool said hello-from-tool.");
    expect(s.busy).toBe(false);
    expect(s.statusLine).toBeNull();
  });

  it("shows tool.generating as a status line until the tool starts", () => {
    const s = run(TOOL_TURN.slice(0, 4));
    expect(s.statusLine).toBe("Preparing terminal…");
    expect(run(TOOL_TURN.slice(0, 6)).statusLine).toBeNull();
  });

  it("flags a failing tool result", () => {
    const s = run([
      ["message.start"],
      ["tool.start", { tool_id: "t", name: "terminal", context: "false" }],
      ["tool.complete", { tool_id: "t", name: "terminal", result: { output: "", exit_code: 1, error: "boom" } }],
    ]);
    const tool = assistant(s)[0].parts[0] as ToolPart;
    expect(tool.isError).toBe(true);
    expect(tool.resultText).toContain("boom");
  });

  it("records a tool.complete whose start was never seen (reconnect)", () => {
    const s = run([["tool.complete", { tool_id: "x", name: "read_file", result: "contents" }]]);
    expect((assistant(s)[0].parts[0] as ToolPart).status).toBe("complete");
  });
});

describe("input requests", () => {
  const APPROVAL = {
    command: "rm -rf /tmp/x",
    description: "delete in root path",
    allow_permanent: true,
    allow_session: true,
    request_id: "req-1",
    choices: ["once", "session", "always", "deny"],
  };

  it("parks an approval and clears it when the turn ends", () => {
    let s = run([["message.start"], ["tool.start", { tool_id: "t", name: "terminal", context: "rm -rf /tmp/x" }], ["approval.request", APPROVAL]]);
    expect(s.approval).toMatchObject({ requestId: "req-1", choices: ["once", "session", "always", "deny"] });
    s = run([["message.complete", { text: "gone", status: "complete" }]], s);
    expect(s.approval).toBeNull();
  });

  it("renders the gateway's narrowed choices verbatim", () => {
    const s = run([["approval.request", { ...APPROVAL, smart_denied: true, choices: ["once", "deny"] }]]);
    expect(s.approval?.choices).toEqual(["once", "deny"]);
    expect(s.approval?.smartDenied).toBe(true);
  });

  it("parks a clarify and drops it on a matching expiry only", () => {
    let s = run([["clarify.request", { question: "Proceed?", choices: ["Yes (Recommended)", "No"], request_id: "c1" }]]);
    expect(s.clarify).toMatchObject({ requestId: "c1", choices: ["Yes (Recommended)", "No"], multiSelect: false });
    s = run([["clarify.expire", { request_id: "other" }]], s);
    expect(s.clarify).not.toBeNull();
    s = run([["clarify.expire", { request_id: "c1" }]], s);
    expect(s.clarify).toBeNull();
  });

  it("parks sudo and secret requests", () => {
    const s = run([["sudo.request", { request_id: "su" }], ["secret.request", { request_id: "se", env_var: "API_KEY", prompt: "Paste it" }]]);
    expect(s.sudo?.requestId).toBe("su");
    expect(s.secret).toMatchObject({ requestId: "se", envVar: "API_KEY", prompt: "Paste it" });
  });
});

describe("session bookkeeping", () => {
  it("reads model/title/approval mode from session.info and settles on running=false", () => {
    let s = run([["message.start"], ["message.delta", { text: "partial" }]]);
    expect(s.busy).toBe(true);
    s = run([["session.info", { model: "mock-model", approval_mode: "manual", title: "First chat", running: false }]], s);
    expect(s).toMatchObject({ model: "mock-model", approvalMode: "manual", title: "First chat", busy: false });
    expect(assistant(s)[0].pending).toBe(false);
  });

  it("lifecycle status updates become system messages; other kinds are a status line", () => {
    const s = run([["status.update", { kind: "lifecycle", text: "Context file truncated" }], ["status.update", { kind: "status", text: "compacting" }]]);
    expect(s.messages.some((m) => m.role === "system" && messageText(m) === "Context file truncated")).toBe(true);
    expect(s.statusLine).toBe("compacting");
  });

  it("reclaimed sessions settle and remember it", () => {
    const s = run([["message.start"], ["message.delta", { text: "x" }], ["session.reclaimed", { reason: "ws_orphan_reap" }]]);
    expect(s.reclaimed).toBe(true);
    expect(s.busy).toBe(false);
  });

  it("local interrupt seals the stream and clears prompts", () => {
    const s = markInterrupted(run([["message.start"], ["message.delta", { text: "x" }], ["sudo.request", { request_id: "s" }]]));
    expect(s.busy).toBe(false);
    expect(s.sudo).toBeNull();
    expect(assistant(s)[0].status).toBe("interrupted");
  });
});

describe("history hydration", () => {
  it("folds tool rows into the preceding assistant bubble", () => {
    const { messages } = messagesFromHistory("s1", [
      { role: "user", text: "please M3_TOOL", timestamp: 1, row_id: 3 },
      { role: "assistant", text: "Let me check.", timestamp: 2, row_id: 4 },
      { role: "tool", name: "terminal", context: "echo hello-from-tool", args: { command: "echo hello-from-tool" } },
      { role: "assistant", text: "The tool said hello-from-tool.", timestamp: 3, row_id: 6 },
      { role: "user", text: "secret", display_kind: "hidden" },
    ]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(messages[1].parts.map((p) => p.type)).toEqual(["text", "tool"]);
    expect((messages[1].parts[1] as ToolPart).context).toBe("echo hello-from-tool");
    expect(messages[2].status).toBe("complete");
  });

  it("gives a leading tool row its own bubble", () => {
    const { messages } = messagesFromHistory("s1", [
      { role: "user", text: "now M3_CLARIFY" },
      { role: "tool", name: "clarify", context: "Proceed with the plan?" },
      { role: "assistant", text: "Thanks" },
    ]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(messages[1].parts[0].type).toBe("tool");
  });
});

describe("resultToText", () => {
  it.each([
    [{ output: "hi", exit_code: 0, error: null }, "hi"],
    [{ output: "", exit_code: 1, error: "boom" }, "error: boom"],
    [{ question: "q", user_response: "Yes" }, "Yes"],
    ["plain", "plain"],
    [null, ""],
  ])("%j → %j", (input, expected) => {
    expect(resultToText(input)).toBe(expected);
  });
});
