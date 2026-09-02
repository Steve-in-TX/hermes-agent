/**
 * Message model for the structured (non-terminal) gateway chat.
 *
 * Deliberately small: text, reasoning, and tool-call parts on user / assistant
 * / system messages. Everything a phone renders for M3 fits here; the desktop's
 * richer `chat-messages` library can replace it later without changing the
 * page, because only `reducer.ts` and `hydrate.ts` build these values.
 */
import type {
  ApprovalRequest,
  ClarifyRequest,
  SecretRequest,
  SudoRequest,
} from "@hermes/shared";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ReasoningPart {
  type: "reasoning";
  text: string;
}

export interface ToolPart {
  type: "tool";
  toolId: string;
  name: string;
  /** Gateway's ≤80-char preview of the args (`tool.start.context`). */
  context: string;
  args?: unknown;
  status: "running" | "complete";
  result?: unknown;
  /** Best-effort text of the result for display. */
  resultText?: string;
  isError?: boolean;
  durationS?: number;
}

export type MessagePart = TextPart | ReasoningPart | ToolPart;

export type MessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  parts: MessagePart[];
  /** Unix seconds. */
  timestamp?: number;
  /** Still streaming. */
  pending?: boolean;
  /** Mid-turn bubble sealed by `message.interim`; more content follows in a new bubble. */
  interim?: boolean;
  status?: "complete" | "interrupted" | "error";
  error?: string;
  rowId?: number;
}

/** One `session.history` / `session.resume` record (display projection). */
export interface HistoryRecord {
  role: string;
  text?: string;
  timestamp?: number;
  row_id?: number;
  display_kind?: string;
  reasoning?: string;
  /** Tool rows only. */
  name?: string;
  context?: string;
  args?: unknown;
}

export interface SessionChatState {
  sessionId: string;
  storedSessionId: string | null;
  title: string | null;
  model: string | null;
  approvalMode: string | null;
  messages: ChatMessage[];
  /** A turn is in flight (optimistic from submit, confirmed by message.start). */
  busy: boolean;
  /** Id of the assistant message currently receiving stream content. */
  streamId: string | null;
  /** Transient "thinking…" line from `thinking.delta`. */
  thinking: string | null;
  /** Transient status line (`tool.generating`, `tool.progress`, `status.update`). */
  statusLine: string | null;
  lastError: string | null;
  approval: ApprovalRequest | null;
  clarify: ClarifyRequest | null;
  sudo: SudoRequest | null;
  secret: SecretRequest | null;
  /** The gateway reaped this runtime session; it must be resumed by stored id. */
  reclaimed: boolean;
  /** Monotonic id source for locally created messages. */
  nextId: number;
}

export function createSessionChatState(
  sessionId: string,
  init: Partial<Omit<SessionChatState, "sessionId">> = {},
): SessionChatState {
  return {
    sessionId,
    storedSessionId: null,
    title: null,
    model: null,
    approvalMode: null,
    messages: [],
    busy: false,
    streamId: null,
    thinking: null,
    statusLine: null,
    lastError: null,
    approval: null,
    clarify: null,
    sudo: null,
    secret: null,
    reclaimed: false,
    nextId: 1,
    ...init,
  };
}

export function messageText(message: ChatMessage): string {
  return message.parts
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("");
}
