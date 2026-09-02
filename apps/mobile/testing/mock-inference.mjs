#!/usr/bin/env node
/**
 * Minimal OpenAI-compatible mock inference server for driving a real
 * `hermes serve` without an LLM — the M3 chat/approval rig for the mobile
 * client. Modelled on apps/desktop/e2e/mock-server.ts but scripted by
 * keyword in the LAST USER MESSAGE so a phone can trigger each scenario by
 * typing it, and stateless across requests (the turn phase is derived from
 * how many tool results follow that user message).
 *
 *   node apps/mobile/testing/mock-inference.mjs [port]      (default 9977)
 *
 * Scenarios (type the keyword anywhere in the prompt):
 *   M3_TOOL      text + terminal(echo …) → "The tool said …"
 *   M3_APPROVAL  terminal(rm -rf <tmp dir>) → the approval guard parks the turn
 *                behind approval.request when approvals.mode is manual
 *   M3_CLARIFY   clarify(question, choices) → clarify.request
 *   M3_SLOW      a long reply streamed slowly (follow-scroll / streaming UI)
 *   anything else → "You said: <prompt>" streamed word by word
 */
import http from "node:http";

const PORT = Number(process.argv[2] ?? process.env.MOCK_PORT ?? 9977);
const MODEL = "mock-model";
const APPROVAL_DIR = "/tmp/hermes-m3-approval-test";

function sse(delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: "mock-completion",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function toolCalls(calls) {
  return calls.map((tc, idx) => ({
    index: idx,
    id: `call_m3_${Date.now()}_${idx}`,
    type: "function",
    function: { name: tc.name, arguments: JSON.stringify(tc.args) },
  }));
}

/** Decide what this completion returns from the conversation so far. */
function script(messages) {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  const user = lastUserIdx >= 0 ? messages[lastUserIdx] : null;
  const text =
    typeof user?.content === "string"
      ? user.content
      : Array.isArray(user?.content)
        ? user.content.map((p) => (typeof p?.text === "string" ? p.text : "")).join(" ")
        : "";
  // Turn phase: how many tool results the agent has appended since the prompt.
  const phase = messages.slice(lastUserIdx + 1).filter((m) => m?.role === "tool").length;

  if (text.includes("M3_APPROVAL")) {
    return phase === 0
      ? {
          text: "I will remove the scratch directory now.",
          tools: [{ name: "terminal", args: { command: `rm -rf ${APPROVAL_DIR}` } }],
        }
      : { text: "The scratch directory is gone." };
  }
  if (text.includes("M3_CLARIFY")) {
    return phase === 0
      ? {
          tools: [{ name: "clarify", args: { question: "Proceed with the plan?", choices: ["Yes", "No"] } }],
        }
      : { text: "Thanks — proceeding as you answered." };
  }
  if (text.includes("M3_TOOL")) {
    return phase === 0
      ? { text: "Let me check.", tools: [{ name: "terminal", args: { command: "echo hello-from-tool" } }] }
      : { text: "The tool said hello-from-tool." };
  }
  if (text.includes("M3_SLOW")) {
    return {
      text: Array.from({ length: 60 }, (_, i) => `token${i + 1}`).join(" "),
      delayMs: 80,
    };
  }
  return { text: `You said: ${text.trim() || "(nothing)"}` };
}

function streamTurn(res, turn) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const finish = turn.tools?.length ? "tool_calls" : "stop";
  const words = turn.text ? turn.text.split(" ") : [];
  let i = 0;
  const step = () => {
    if (i < words.length) {
      res.write(sse({ content: (i === 0 ? "" : " ") + words[i] }));
      i++;
      setTimeout(step, turn.delayMs ?? 15);
      return;
    }
    res.write(sse(turn.tools?.length ? { tool_calls: toolCalls(turn.tools) } : {}, finish));
    res.write("data: [DONE]\n\n");
    res.end();
  };
  res.write(sse({ role: "assistant" }));
  step();
}

function jsonTurn(res, turn) {
  const message = { role: "assistant", content: turn.text ?? null };
  if (turn.tools?.length) message.tool_calls = toolCalls(turn.tools);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: "mock-completion",
      object: "chat.completion",
      created: 0,
      model: MODEL,
      choices: [{ index: 0, message, finish_reason: turn.tools?.length ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
  );
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "mock" }] }));
    return;
  }
  if (req.method === "POST" && req.url?.startsWith("/v1/chat/completions")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* defaults */
      }
      const turn = script(parsed.messages ?? []);
      process.stderr.write(`[mock] ${parsed.stream ? "stream" : "json"} → ${JSON.stringify(turn).slice(0, 120)}\n`);
      if (parsed.stream) streamTurn(res, turn);
      else jsonTurn(res, turn);
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(`[mock] listening on http://127.0.0.1:${PORT}\n`);
});
