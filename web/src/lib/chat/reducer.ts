/**
 * Pure reducer: one gateway event in, a new `SessionChatState` out.
 *
 * Event shapes are the ones the gateway actually emits (captured live against
 * `hermes serve` in the M3 rig; see `tui_gateway/server.py`):
 *   message.start (no payload) → message.delta {text} → [message.interim
 *   {text, already_streamed}] → tool.start {tool_id,name,context,args} →
 *   tool.complete {tool_id,name,args,duration_s,result} → message.complete
 *   {text, usage, status, error?}
 * plus thinking.delta / reasoning.delta / reasoning.available, status.update
 * {kind,text}, error {message}, session.info {model,title,running,…}, the four
 * input requests and their expiries, and session.reclaimed.
 *
 * Invariants kept from the desktop implementation:
 * - a delta after `message.interim` opens a NEW assistant bubble;
 * - a tool part closes the open text run (text after a tool starts a new run);
 * - `message.complete` with no streamed text adopts `payload.text`; when text
 *   was streamed the streamed text wins (the payload is the same text);
 * - the turn ending clears every pending input request.
 */
import { parseInputRequest } from "@hermes/shared";

import type {
  ChatMessage,
  MessagePart,
  SessionChatState,
  TextPart,
  ToolPart,
} from "./types";
import { messageText } from "./types";

type Payload = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function payloadOf(raw: unknown): Payload {
  return typeof raw === "object" && raw !== null ? (raw as Payload) : {};
}

function nowSeconds(): number {
  return Date.now() / 1000;
}

/** Render a tool result for display without pretending to know every tool. */
export function resultToText(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    const rec = result as Payload;
    const output = str(rec.output);
    const error = str(rec.error);
    if (output || error) {
      return [output, error ? `error: ${error}` : ""].filter(Boolean).join("\n");
    }
    if (typeof rec.user_response === "string") return rec.user_response;
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  return String(result);
}

function resultIsError(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const rec = result as Payload;
  if (rec.error) return true;
  return typeof rec.exit_code === "number" && rec.exit_code !== 0;
}

/** Returns [state, message] with an assistant message open for streaming. */
function ensureStreamMessage(state: SessionChatState): [SessionChatState, ChatMessage] {
  if (state.streamId) {
    const existing = state.messages.find((m) => m.id === state.streamId);
    if (existing) return [state, existing];
  }
  const id = `${state.sessionId}-a${state.nextId}`;
  const message: ChatMessage = {
    id,
    role: "assistant",
    parts: [],
    timestamp: nowSeconds(),
    pending: true,
  };
  return [
    { ...state, messages: [...state.messages, message], streamId: id, nextId: state.nextId + 1 },
    message,
  ];
}

function replaceMessage(state: SessionChatState, next: ChatMessage): SessionChatState {
  return { ...state, messages: state.messages.map((m) => (m.id === next.id ? next : m)) };
}

function appendText(message: ChatMessage, text: string, type: "text" | "reasoning"): ChatMessage {
  const parts = [...message.parts];
  const last = parts[parts.length - 1];
  if (last && last.type === type) {
    parts[parts.length - 1] = { ...last, text: last.text + text };
  } else {
    parts.push({ type, text } as MessagePart);
  }
  return { ...message, parts };
}

function findToolPart(
  state: SessionChatState,
  toolId: string,
): { message: ChatMessage; index: number } | null {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const message = state.messages[i];
    const index = message.parts.findIndex((p) => p.type === "tool" && p.toolId === toolId);
    if (index >= 0) return { message, index };
  }
  return null;
}

function clearInputRequests(state: SessionChatState): SessionChatState {
  if (!state.approval && !state.clarify && !state.sudo && !state.secret) return state;
  return { ...state, approval: null, clarify: null, sudo: null, secret: null };
}

/** Seal whatever is still streaming (turn over, interrupted, or reconnected). */
function settlePending(
  state: SessionChatState,
  status: ChatMessage["status"],
  error?: string,
): SessionChatState {
  const messages = state.messages.map((m) =>
    m.pending ? { ...m, pending: false, status, ...(error ? { error } : {}) } : m,
  );
  return { ...state, messages, streamId: null, busy: false, thinking: null, statusLine: null };
}

export function applyGatewayEvent(
  state: SessionChatState,
  type: string,
  rawPayload: unknown,
): SessionChatState {
  const payload = payloadOf(rawPayload);

  switch (type) {
    case "message.start":
      return {
        ...state,
        busy: true,
        streamId: null,
        thinking: null,
        statusLine: null,
        lastError: null,
      };

    case "message.delta": {
      const text = str(payload.text);
      if (!text) return state;
      const [next, message] = ensureStreamMessage(state);
      return { ...replaceMessage(next, appendText(message, text, "text")), busy: true, thinking: null };
    }

    case "reasoning.delta": {
      const text = str(payload.text);
      if (!text) return state;
      const [next, message] = ensureStreamMessage(state);
      return replaceMessage(next, appendText(message, text, "reasoning"));
    }

    case "thinking.delta":
      return { ...state, thinking: str(payload.text) || null };

    case "message.interim": {
      const text = str(payload.text);
      let next = state;
      let message: ChatMessage | undefined = state.streamId
        ? state.messages.find((m) => m.id === state.streamId)
        : undefined;
      if (!message) {
        if (!text) return state;
        [next, message] = ensureStreamMessage(state);
      }
      if (payload.already_streamed !== true && text && !messageText(message)) {
        message = appendText(message, text, "text");
      }
      next = replaceMessage(next, { ...message, pending: false, interim: true });
      // The next delta opens a fresh bubble.
      return { ...next, streamId: null };
    }

    case "tool.generating":
      return { ...state, statusLine: payload.name ? `Preparing ${str(payload.name)}…` : null };

    case "tool.progress":
      return { ...state, statusLine: str(payload.preview) || state.statusLine };

    case "tool.start": {
      const toolId = str(payload.tool_id);
      const name = str(payload.name);
      if (!toolId || !name) return state;
      if (findToolPart(state, toolId)) return state;
      const [next, message] = ensureStreamMessage(state);
      const part: ToolPart = {
        type: "tool",
        toolId,
        name,
        context: str(payload.context),
        args: payload.args,
        status: "running",
      };
      return {
        ...replaceMessage(next, { ...message, parts: [...message.parts, part] }),
        busy: true,
        statusLine: null,
        thinking: null,
      };
    }

    case "tool.complete": {
      const toolId = str(payload.tool_id);
      const result = payload.result;
      const complete: Partial<ToolPart> = {
        status: "complete",
        result,
        resultText: str(payload.result_text) || resultToText(result),
        isError: resultIsError(result),
        ...(typeof payload.duration_s === "number" ? { durationS: payload.duration_s } : {}),
      };
      const found = toolId ? findToolPart(state, toolId) : null;
      if (found) {
        const parts = [...found.message.parts];
        parts[found.index] = { ...(parts[found.index] as ToolPart), ...complete };
        return { ...replaceMessage(state, { ...found.message, parts }), statusLine: null };
      }
      // Completion for a start we never saw (reconnect): record it anyway.
      const name = str(payload.name);
      if (!name) return state;
      const [next, message] = ensureStreamMessage(state);
      const args = payloadOf(payload.args);
      const part: ToolPart = {
        type: "tool",
        toolId: toolId || `${name}-${next.nextId}`,
        name,
        context: str(args.command),
        args: payload.args,
        status: "complete",
        ...complete,
      };
      return { ...replaceMessage(next, { ...message, parts: [...message.parts, part] }), statusLine: null };
    }

    case "message.complete": {
      const status = (str(payload.status) || "complete") as ChatMessage["status"];
      const text = str(payload.text);
      const error = str(payload.error) || (status === "error" ? "The turn failed." : "");
      let next = state;
      let message: ChatMessage | undefined = state.streamId
        ? state.messages.find((m) => m.id === state.streamId)
        : undefined;
      if (!message && text) {
        [next, message] = ensureStreamMessage(state);
      }
      if (message && text && !messageText(message)) {
        message = appendText(message, text, "text");
      }
      if (message) {
        next = replaceMessage(next, message);
      }
      next = settlePending(next, status, error || undefined);
      return clearInputRequests({ ...next, lastError: error || null });
    }

    case "status.update": {
      const text = str(payload.text);
      if (str(payload.kind) === "lifecycle" && text) {
        const id = `${state.sessionId}-s${state.nextId}`;
        return {
          ...state,
          nextId: state.nextId + 1,
          messages: [...state.messages, { id, role: "system", parts: [{ type: "text", text }], timestamp: nowSeconds() }],
        };
      }
      return { ...state, statusLine: text || null };
    }

    case "error":
      return { ...state, lastError: str(payload.message) || "Unknown gateway error" };

    case "session.info": {
      let next: SessionChatState = {
        ...state,
        model: str(payload.model) || state.model,
        approvalMode: str(payload.approval_mode) || state.approvalMode,
        storedSessionId: str(payload.stored_session_id) || state.storedSessionId,
      };
      if ("title" in payload) next = { ...next, title: str(payload.title) || null };
      if (payload.running === false && (state.busy || state.streamId)) {
        next = settlePending(next, "complete");
      } else if (payload.running === true) {
        next = { ...next, busy: true };
      }
      return next;
    }

    case "session.title":
      return "title" in payload ? { ...state, title: str(payload.title) || null } : state;

    case "session.reclaimed":
      return clearInputRequests({ ...settlePending(state, "interrupted"), reclaimed: true });

    default: {
      const request = parseInputRequest(type, payload, state.sessionId);
      if (!request) return state;
      switch (request.kind) {
        case "approval":
          return { ...state, approval: request, thinking: null, statusLine: null };
        case "clarify":
          return { ...state, clarify: request, thinking: null, statusLine: null };
        case "sudo":
          return { ...state, sudo: request };
        case "secret":
          return { ...state, secret: request };
        case "expire":
          if (state[request.of]?.requestId !== request.requestId) return state;
          return { ...state, [request.of]: null };
      }
    }
  }
  return state;
}

/** Optimistic user message + busy flag at submit time. */
export function appendUserMessage(state: SessionChatState, text: string): SessionChatState {
  const id = `${state.sessionId}-u${state.nextId}`;
  const message: ChatMessage = {
    id,
    role: "user",
    parts: [{ type: "text", text } satisfies TextPart],
    timestamp: nowSeconds(),
  };
  return {
    ...state,
    nextId: state.nextId + 1,
    messages: [...state.messages, message],
    busy: true,
    lastError: null,
    reclaimed: false,
  };
}

/** A local system line (slash-command output, notices). */
export function appendSystemMessage(state: SessionChatState, text: string): SessionChatState {
  const id = `${state.sessionId}-s${state.nextId}`;
  return {
    ...state,
    nextId: state.nextId + 1,
    messages: [...state.messages, { id, role: "system", parts: [{ type: "text", text }], timestamp: nowSeconds() }],
  };
}

/** Local Stop: seal the stream now; the backend confirms via session.info. */
export function markInterrupted(state: SessionChatState): SessionChatState {
  return clearInputRequests(settlePending(state, "interrupted"));
}
