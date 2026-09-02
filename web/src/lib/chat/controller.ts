/**
 * Owns the gateway socket for the structured chat: connect, reconnect with
 * backoff, session create/resume, prompt submit/interrupt, the four
 * input-request responses, and routing of every event into the store.
 *
 * Protocol facts this relies on (verified live against `hermes serve`):
 * - A session's events reach the socket that created, resumed, or last
 *   submitted to it, so every reconnect re-issues `session.resume` for the
 *   active session — that also cancels the gateway's orphan-reap timer.
 * - `prompt.submit` answers `{status:"streaming"}` immediately; the turn ends
 *   with `message.complete` (and `session.info.running=false`).
 * - `approval.request` needs an `approval.received` ack and, after any
 *   respond or resume, an `approval.pending` replay so nothing is lost.
 * - `JsonRpcGatewayClient` already replays seq'd events via
 *   `session.events.since` after a reconnect; the history reload on resume
 *   makes the transcript authoritative regardless.
 */
import type { ApprovalChoice, ConnectionState, GatewayEvent } from "@hermes/shared";

import { messagesFromHistory } from "./hydrate";
import { appendUserMessage, applyGatewayEvent, markInterrupted } from "./reducer";
import { getSessionState, getShell, hasSession, setSessionState, updateSession, updateShell } from "./store";
import { createSessionChatState, messageText, type HistoryRecord, type SessionChatState } from "./types";

/** What the controller needs from `web/src/lib/gatewayClient.ts` (`connect()` resolves auth itself). */
export interface ChatGatewayClient {
  readonly connectionState: ConnectionState;
  connect(): Promise<void>;
  close(): void;
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  onEvent(handler: (event: GatewayEvent) => void): () => void;
  onState(handler: (state: ConnectionState) => void): () => void;
}

type Client = ChatGatewayClient;

export interface ChatControllerOptions {
  createClient: () => Client;
  /** `source` sent on session.create (gates toolsets server-side). */
  source?: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Test hooks. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
}

interface SessionRef {
  session_id: string;
  stored_session_id?: string;
  resumed?: string;
  messages?: HistoryRecord[];
  running?: boolean;
  info?: Record<string, unknown>;
  inflight?: { assistant?: string; user?: string } | null;
  pending_approval?: unknown;
  pending_clarify?: unknown;
}

const DEFAULT_COLS = 60;

export class ChatController {
  private client: Client | null = null;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private unsubscribes: Array<() => void> = [];
  private readonly opts: Required<Omit<ChatControllerOptions, "createClient">> & Pick<ChatControllerOptions, "createClient">;

  constructor(options: ChatControllerOptions) {
    this.opts = {
      source: "android",
      reconnectBaseMs: 1000,
      reconnectMaxMs: 30_000,
      // Wrapped, not referenced: calling a bare `setTimeout` as a method of
      // this options object is an "Illegal invocation" in a real browser
      // (the WebView), even though test fakes tolerate it.
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id),
      ...options,
    };
  }

  get activeSessionId(): string | null {
    return getShell().activeSessionId;
  }

  /** Open the socket (idempotent). Resolves once `gateway.ready` has been seen. */
  async connect(): Promise<void> {
    if (this.disposed) return;
    if (this.client && (this.client.connectionState === "open" || this.client.connectionState === "connecting")) {
      return;
    }
    this.teardownClient();
    const client = this.opts.createClient();
    this.client = client;
    this.unsubscribes.push(
      client.onState((state) => {
        updateShell({ connection: state });
        if (state === "closed" || state === "error") this.scheduleReconnect();
      }),
      client.onEvent((event) => this.handleEvent(event)),
    );
    try {
      await client.connect();
    } catch (err) {
      updateShell({ error: err instanceof Error ? err.message : String(err) });
      this.scheduleReconnect();
      return;
    }
    this.attempt = 0;
    updateShell({ reconnectAttempt: 0, error: null });
    const active = this.activeSessionId;
    if (active) {
      // After a drop the runtime id is detached and `session.resume` by that
      // id answers 4007; the STORED id reattaches the live runtime (same id,
      // running flag, pending approval, in-flight text) — verified against
      // the gateway in the M3 rig.
      const stored = getSessionState(active).storedSessionId ?? active;
      await this.resumeSession(stored).catch((err: unknown) => {
        updateShell({ error: err instanceof Error ? err.message : String(err) });
      });
    }
  }

  private teardownClient(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
    this.client?.close();
    this.client = null;
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    this.attempt += 1;
    const delay = Math.min(this.opts.reconnectMaxMs, this.opts.reconnectBaseMs * 2 ** (this.attempt - 1));
    updateShell({ reconnectAttempt: this.attempt });
    this.reconnectTimer = this.opts.setTimer(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  /** Foreground/network came back: reconnect now instead of waiting out the backoff. */
  reconnectNow(): void {
    if (this.reconnectTimer !== null) {
      this.opts.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    void this.connect();
  }

  /**
   * Drop the socket as if the network died (diagnostics / live tests). The
   * normal close handling reconnects with backoff and re-resumes the session.
   */
  simulateDisconnect(): void {
    this.client?.close();
    updateShell({ connection: "closed" });
    this.scheduleReconnect();
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) this.opts.clearTimer(this.reconnectTimer);
    this.teardownClient();
  }

  private request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.client) return Promise.reject(new Error("gateway not connected"));
    return this.client.request<T>(method, params);
  }

  // ── events ──────────────────────────────────────────────────────

  private handleEvent(event: GatewayEvent): void {
    const sid = event.session_id;
    if (!sid) return;
    if (!hasSession(sid) && event.type !== "session.info") return;
    updateSession(sid, (state) => applyGatewayEvent(state, event.type, event.payload));
    if (event.type === "approval.request") {
      const requestId = (event.payload as { request_id?: string } | undefined)?.request_id;
      if (requestId) {
        void this.request("approval.received", { session_id: sid, request_id: requestId }).catch(() => {});
      }
    }
  }

  // ── sessions ────────────────────────────────────────────────────

  private applySessionRef(ref: SessionRef, previous?: SessionChatState): SessionChatState {
    const sid = ref.session_id;
    const { messages, nextId } = messagesFromHistory(sid, ref.messages ?? []);
    const info = ref.info ?? {};
    let state = createSessionChatState(sid, {
      ...(previous ? { title: previous.title, model: previous.model } : {}),
      storedSessionId: ref.stored_session_id ?? ref.resumed ?? previous?.storedSessionId ?? null,
      model: typeof info.model === "string" ? info.model : (previous?.model ?? null),
      approvalMode: typeof info.approval_mode === "string" ? info.approval_mode : null,
      title: typeof info.title === "string" && info.title ? info.title : (previous?.title ?? null),
      messages,
      nextId,
      busy: ref.running === true,
    });
    // Seed the still-streaming assistant text, unless history already holds
    // it (the gateway persists interim text before the tool runs, so a
    // reconnect mid-tool would otherwise show the same bubble twice).
    const inflight = ref.inflight?.assistant?.trim();
    const last = state.messages.at(-1);
    const lastText = last?.role === "assistant" ? messageText(last).trim() : "";
    if (inflight && inflight !== lastText) {
      state = applyGatewayEvent(state, "message.delta", { text: ref.inflight!.assistant! });
    }
    for (const [type, pending] of [
      ["approval.request", ref.pending_approval],
      ["clarify.request", ref.pending_clarify],
    ] as const) {
      if (pending && typeof pending === "object") {
        state = applyGatewayEvent(state, type, pending);
      }
    }
    return state;
  }

  /** Start a fresh session and make it active. */
  async createSession(): Promise<string> {
    const ref = await this.request<SessionRef>("session.create", {
      source: this.opts.source,
      close_on_disconnect: false,
      cols: DEFAULT_COLS,
    });
    setSessionState(ref.session_id, this.applySessionRef(ref));
    updateShell({ activeSessionId: ref.session_id });
    return ref.session_id;
  }

  /**
   * Resume by runtime id, stored id, or title; makes it active. Used for
   * picking a session and after every reconnect.
   */
  async resumeSession(id: string): Promise<string> {
    const ref = await this.request<SessionRef>("session.resume", { session_id: id, cols: DEFAULT_COLS });
    const previous = hasSession(ref.session_id) ? getSessionState(ref.session_id) : undefined;
    setSessionState(ref.session_id, this.applySessionRef(ref, previous));
    updateShell({ activeSessionId: ref.session_id });
    await this.replayPendingApproval(ref.session_id);
    return ref.session_id;
  }

  async listSessions(limit = 30): Promise<
    Array<{ id: string; title?: string; preview?: string; started_at?: number; message_count?: number; source?: string }>
  > {
    const res = await this.request<{ sessions?: unknown[] }>("session.list", { limit });
    return (res.sessions ?? []).filter((s): s is { id: string } => typeof (s as { id?: unknown })?.id === "string");
  }

  private async replayPendingApproval(sid: string): Promise<void> {
    try {
      const res = await this.request<{ approvals?: unknown[] }>("approval.pending", { session_id: sid });
      const first = res.approvals?.[0];
      updateSession(sid, (state) => {
        if (!first || typeof first !== "object") return state.approval ? { ...state, approval: null } : state;
        return applyGatewayEvent(state, "approval.request", first);
      });
    } catch {
      /* older gateway or session gone — nothing to replay */
    }
  }

  // ── turn ────────────────────────────────────────────────────────

  /** Submit a prompt to the active session (creating one on first use). */
  async submit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    let sid = this.activeSessionId;
    if (!sid || getSessionState(sid).reclaimed) {
      const stored = sid ? getSessionState(sid).storedSessionId : null;
      sid = stored ? await this.resumeSession(stored) : await this.createSession();
    }
    updateSession(sid, (state) => appendUserMessage(state, trimmed));
    try {
      await this.request("prompt.submit", { session_id: sid, text: trimmed });
    } catch (err) {
      updateSession(sid, (state) => ({
        ...markInterrupted(state),
        lastError: err instanceof Error ? err.message : String(err),
      }));
      throw err;
    }
  }

  async interrupt(): Promise<void> {
    const sid = this.activeSessionId;
    if (!sid) return;
    updateSession(sid, markInterrupted);
    await this.request("session.interrupt", { session_id: sid }).catch(() => {});
  }

  // ── input requests ──────────────────────────────────────────────

  async respondApproval(sid: string, requestId: string, choice: ApprovalChoice): Promise<void> {
    updateSession(sid, (state) =>
      state.approval?.requestId === requestId ? { ...state, approval: null } : state,
    );
    await this.request("approval.respond", { session_id: sid, request_id: requestId, choice });
    await this.replayPendingApproval(sid);
  }

  /** Single clarify: a bare answer (or JSON array for multi-select); "" skips. */
  async respondClarify(sid: string, requestId: string, answer: string): Promise<void> {
    updateSession(sid, (state) =>
      state.clarify?.requestId === requestId ? { ...state, clarify: null } : state,
    );
    await this.request("clarify.respond", { request_id: requestId, answer });
  }

  /** Batch clarify: one lock per question, sequential — the last lock resolves the tool. */
  async respondClarifyBatch(sid: string, requestId: string, answers: Array<{ qid: string; answer: string }>): Promise<void> {
    updateSession(sid, (state) =>
      state.clarify?.requestId === requestId ? { ...state, clarify: null } : state,
    );
    for (const { qid, answer } of answers) {
      await this.request("clarify.respond", { request_id: requestId, question_id: qid, answer });
    }
  }

  /** Empty password = refusal; the backend runs nothing. */
  async respondSudo(sid: string, requestId: string, password: string): Promise<void> {
    updateSession(sid, (state) => (state.sudo?.requestId === requestId ? { ...state, sudo: null } : state));
    await this.request("sudo.respond", { request_id: requestId, password }).catch(swallowMissingPrompt);
  }

  async respondSecret(sid: string, requestId: string, value: string): Promise<void> {
    updateSession(sid, (state) => (state.secret?.requestId === requestId ? { ...state, secret: null } : state));
    await this.request("secret.respond", { request_id: requestId, value }).catch(swallowMissingPrompt);
  }
}

/** A prompt that already expired or was answered elsewhere is not an error for the user. */
function swallowMissingPrompt(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (/no pending/i.test(message)) return;
  throw err;
}
