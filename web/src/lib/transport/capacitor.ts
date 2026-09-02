/**
 * Native transport for the Android app: an ``HttpDriver`` and a
 * ``SocketFactory`` backed by the Kotlin ``HermesHttp`` / ``HermesSocket``
 * Capacitor plugins (OkHttp). Only ever imported by ``installNativeTransport``
 * inside the mobile build; the browser dashboard never loads this module.
 *
 * Why native rather than the WebView: the gateway's CORS middleware never
 * sets ``allow_credentials``, its auth gate 401s the preflight, and its WS
 * Origin guard refuses ``https://localhost`` on a specific-address bind. A
 * native client sends no ``Origin`` and is not subject to CORS at all.
 * Verified in ``apps/mobile/spikes/m0``.
 */
import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

import type { HttpDriver } from "./http-driver";
import type { SocketFactory } from "./socket";

// ── Plugin contracts (mirror the Kotlin side) ─────────────────────────

export interface NativeHttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** UTF-8 text body (JSON, form-encoded). */
  body?: string;
  /** Binary body, base64 (blobs, multipart). */
  bodyBase64?: string;
}

export interface NativeHttpResponse {
  status: number;
  statusText?: string;
  headers: Record<string, string>;
  bodyBase64?: string;
}

export interface HermesHttpPlugin {
  request(req: NativeHttpRequest): Promise<NativeHttpResponse>;
}

export type NativeSocketEventName = "open" | "message" | "close" | "error";

export interface NativeSocketEvent {
  id: string;
  /** Text frame. */
  data?: string;
  /** Binary frame, base64. */
  dataBase64?: string;
  code?: number;
  reason?: string;
  wasClean?: boolean;
  protocol?: string;
  message?: string;
}

export interface HermesSocketPlugin {
  connect(opts: { url: string; protocols?: string[] }): Promise<{ id: string }>;
  send(opts: { id: string; data?: string; dataBase64?: string }): Promise<void>;
  close(opts: { id: string; code?: number; reason?: string }): Promise<void>;
  addListener(
    eventName: NativeSocketEventName,
    listener: (event: NativeSocketEvent) => void,
  ): Promise<PluginListenerHandle>;
}

// ── base64 helpers (no Buffer in the WebView) ─────────────────────────

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array<ArrayBufferLike>): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ── HTTP ───────────────────────────────────────────────────────────────

export interface EncodedBody {
  body?: string;
  bodyBase64?: string;
  contentType?: string;
}

/**
 * Serialise a ``fetch`` body for the native side. Strings and
 * ``URLSearchParams`` travel as text; everything else (``Blob``,
 * ``ArrayBuffer``, typed arrays, ``FormData``) is serialised by the platform
 * itself via ``new Response(body)`` so multipart boundaries and blob types
 * come out exactly as ``fetch`` would send them.
 */
export async function encodeRequestBody(body: BodyInit | null | undefined): Promise<EncodedBody> {
  if (body === null || body === undefined) return {};
  if (typeof body === "string") return { body };
  if (body instanceof URLSearchParams) {
    return {
      body: body.toString(),
      contentType: "application/x-www-form-urlencoded;charset=UTF-8",
    };
  }
  const wrapped = new Response(body);
  const bytes = new Uint8Array(await wrapped.arrayBuffer());
  return {
    bodyBase64: bytesToBase64(bytes),
    contentType: wrapped.headers.get("content-type") ?? undefined,
  };
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** Statuses for which ``new Response(body)`` must receive ``null``. */
const NULL_BODY_STATUS = new Set([204, 205, 304]);

export function createCapacitorHttpDriver(
  plugin: HermesHttpPlugin = registerPlugin<HermesHttpPlugin>("HermesHttp"),
): HttpDriver {
  return {
    async fetch(url, init) {
      if (!/^https?:\/\//i.test(url)) {
        // Same-origin path with no remote target set: nothing to dial. Fail
        // like a network error so callers' catch paths run (never crash).
        throw new TypeError(`Hermes app: no gateway connected (cannot fetch ${url})`);
      }
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = new Headers(init?.headers);
      const encoded = await encodeRequestBody(init?.body ?? null);
      if (encoded.contentType && !headers.has("content-type")) {
        headers.set("content-type", encoded.contentType);
      }
      const res = await plugin.request({
        url,
        method,
        headers: headersToRecord(headers),
        body: encoded.body,
        bodyBase64: encoded.bodyBase64,
      });
      const bytes =
        res.bodyBase64 && !NULL_BODY_STATUS.has(res.status)
          ? base64ToBytes(res.bodyBase64)
          : null;
      return new Response(bytes, {
        status: res.status,
        statusText: res.statusText ?? "",
        headers: res.headers,
      });
    },
  };
}

// ── WebSocket ──────────────────────────────────────────────────────────

const GATEWAY_WS_PROTOCOL = "hermes-gateway-v1";
const GATEWAY_WS_TICKET_PREFIX = "hermes-gateway-ticket.";

/**
 * Decide how a dashboard WS URL is dialled natively. For ``/api/ws`` the
 * single-use ``?ticket=`` moves into the subprotocol list the gateway accepts
 * (``_gateway_ws_ticket_from_subprotocol``), keeping the credential out of
 * URLs and proxy logs. Other endpoints keep the query form: only
 * ``gateway_ws`` echoes a selected subprotocol back.
 */
export function planNativeSocket(url: string): { url: string; protocols?: string[] } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url };
  }
  if (!parsed.pathname.endsWith("/api/ws")) return { url };
  const ticket = parsed.searchParams.get("ticket");
  if (!ticket) return { url };
  parsed.searchParams.delete("ticket");
  return {
    url: parsed.toString(),
    protocols: [GATEWAY_WS_PROTOCOL, `${GATEWAY_WS_TICKET_PREFIX}${ticket}`],
  };
}

type Handler<E extends Event> = ((this: WebSocket, ev: E) => unknown) | null;

function makeCloseEvent(init: { code: number; reason: string; wasClean: boolean }): CloseEvent {
  if (typeof CloseEvent === "function") {
    return new CloseEvent("close", init);
  }
  return Object.assign(new Event("close"), init) as unknown as CloseEvent;
}

/**
 * The subset of the ``WebSocket`` surface the dashboard uses, driven by
 * ``HermesSocket`` events. Handed out as ``WebSocket`` through the factory.
 */
export class NativeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readonly url: string;
  readyState = 0;
  binaryType: BinaryType = "blob";
  protocol = "";
  extensions = "";
  bufferedAmount = 0;
  onopen: Handler<Event> = null;
  onmessage: Handler<MessageEvent> = null;
  onclose: Handler<CloseEvent> = null;
  onerror: Handler<Event> = null;

  /** Native socket id once ``connect`` resolves. */
  id: string | null = null;
  private pendingClose: { code: number; reason: string } | null = null;
  private readonly plugin: HermesSocketPlugin;

  constructor(url: string, plugin: HermesSocketPlugin) {
    super();
    this.url = url;
    this.plugin = plugin;
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== this.OPEN || !this.id) {
      throw new DOMException("WebSocket is not open", "InvalidStateError");
    }
    const id = this.id;
    if (typeof data === "string") {
      void this.plugin.send({ id, data });
      return;
    }
    if (data instanceof Blob) {
      void data.arrayBuffer().then((buf) =>
        this.plugin.send({ id, dataBase64: bytesToBase64(new Uint8Array(buf)) }),
      );
      return;
    }
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    void this.plugin.send({ id, dataBase64: bytesToBase64(bytes) });
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === this.CLOSING || this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSING;
    if (this.id) {
      void this.plugin.close({ id: this.id, code, reason });
    } else {
      this.pendingClose = { code, reason };
    }
  }

  /** @internal called by the registry once the native id is known. */
  attach(id: string): void {
    this.id = id;
    if (this.pendingClose) {
      void this.plugin.close({ id, ...this.pendingClose });
      this.pendingClose = null;
    }
  }

  /** @internal called by the registry for every native event. */
  deliver(name: NativeSocketEventName, event: NativeSocketEvent): void {
    switch (name) {
      case "open": {
        if (this.readyState !== this.CONNECTING) return;
        this.readyState = this.OPEN;
        this.protocol = event.protocol ?? "";
        const ev = new Event("open");
        this.onopen?.call(this as unknown as WebSocket, ev);
        this.dispatchEvent(ev);
        return;
      }
      case "message": {
        if (this.readyState !== this.OPEN) return;
        let data: string | ArrayBuffer | Blob = event.data ?? "";
        if (event.dataBase64 !== undefined) {
          const bytes = base64ToBytes(event.dataBase64);
          data = this.binaryType === "arraybuffer" ? bytes.buffer : new Blob([bytes]);
        }
        const ev = new MessageEvent("message", { data });
        this.onmessage?.call(this as unknown as WebSocket, ev);
        this.dispatchEvent(ev);
        return;
      }
      case "error": {
        const ev = new Event("error");
        this.onerror?.call(this as unknown as WebSocket, ev);
        this.dispatchEvent(ev);
        return;
      }
      case "close": {
        if (this.readyState === this.CLOSED) return;
        this.readyState = this.CLOSED;
        const ev = makeCloseEvent({
          code: event.code ?? 1006,
          reason: event.reason ?? "",
          wasClean: event.wasClean ?? false,
        });
        this.onclose?.call(this as unknown as WebSocket, ev);
        this.dispatchEvent(ev);
        return;
      }
    }
  }
}

/**
 * Routes ``HermesSocket`` plugin events (one listener per event name for the
 * whole app) to the ``NativeWebSocket`` instances by id. Events that arrive
 * before ``connect`` has resolved are parked and replayed on attach.
 */
export class NativeSocketRegistry {
  private readonly sockets = new Map<string, NativeWebSocket>();
  private readonly early = new Map<string, Array<[NativeSocketEventName, NativeSocketEvent]>>();
  private listenersInstalled = false;
  private readonly plugin: HermesSocketPlugin;

  constructor(plugin: HermesSocketPlugin) {
    this.plugin = plugin;
  }

  private installListeners(): void {
    if (this.listenersInstalled) return;
    this.listenersInstalled = true;
    for (const name of ["open", "message", "close", "error"] as const) {
      void this.plugin.addListener(name, (event) => this.route(name, event));
    }
  }

  route(name: NativeSocketEventName, event: NativeSocketEvent): void {
    const socket = this.sockets.get(event.id);
    if (!socket) {
      const queue = this.early.get(event.id) ?? [];
      queue.push([name, event]);
      this.early.set(event.id, queue);
      return;
    }
    socket.deliver(name, event);
    if (name === "close") this.sockets.delete(event.id);
  }

  open(url: string): NativeWebSocket {
    this.installListeners();
    const socket = new NativeWebSocket(url, this.plugin);
    const plan = planNativeSocket(url);
    this.plugin
      .connect(plan)
      .then(({ id }) => {
        this.sockets.set(id, socket);
        socket.attach(id);
        const queued = this.early.get(id);
        if (queued) {
          this.early.delete(id);
          for (const [name, event] of queued) this.route(name, event);
        }
      })
      .catch((err: unknown) => {
        socket.deliver("error", { id: "", message: String(err) });
        socket.deliver("close", { id: "", code: 1006, reason: String(err), wasClean: false });
      });
    return socket;
  }
}

export function createCapacitorSocketFactory(
  plugin: HermesSocketPlugin = registerPlugin<HermesSocketPlugin>("HermesSocket"),
): SocketFactory {
  const registry = new NativeSocketRegistry(plugin);
  return (url) => registry.open(url) as unknown as WebSocket;
}
