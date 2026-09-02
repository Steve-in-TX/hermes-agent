/**
 * The Android app's notion of "which gateway am I signed in to".
 *
 * Owns the active session, applies it to ``backend-target`` (bearer +
 * refresh hook), refreshes proactively before expiry, and drops it when the
 * gateway says the session is gone.
 *
 * Storage: tokens live in the native ``HermesAuth`` plugin's encrypted store
 * (Keystore-backed). JS holds the access token in memory only. When no
 * native bridge is installed (browser dev builds), the connection falls
 * back to ``localStorage`` so the flow can still be exercised.
 */
import { useSyncExternalStore } from "react";

import { REAUTH_EVENT, setBackendTarget, type ReauthDetail } from "@/lib/backend-target";
import {
  NativeAuthError,
  getNativeAuthBridge,
  refreshDelayMs,
  type NativeLoginOptions,
  type NativeSession,
} from "@/lib/native-auth";

/** What the UI sees. No token. */
export interface ConnectionInfo {
  origin: string;
  basePath: string;
  userId?: string;
  provider?: string;
  expiresAt?: number;
}

export const CONNECTION_STORAGE_KEY = "hermes.mobile.connection";

type StorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

let current: ConnectionInfo | null = null;
let accessToken: string | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshInFlight: Promise<boolean> | null = null;
const listeners = new Set<() => void>();
/** Windows that already have the reauth listener (bootstrap is idempotent). */
const wiredTargets = new WeakSet<object>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ── browser fallback storage (no native bridge) ─────────────────────

export function loadSavedSession(storage: StorageLike | null = defaultStorage()): NativeSession | null {
  try {
    const raw = storage?.getItem(CONNECTION_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.origin !== "string" || typeof rec.accessToken !== "string" || !rec.origin || !rec.accessToken) {
      return null;
    }
    return {
      origin: rec.origin,
      basePath: typeof rec.basePath === "string" ? rec.basePath : "",
      accessToken: rec.accessToken,
      expiresAt: typeof rec.expiresAt === "number" ? rec.expiresAt : 0,
      userId: typeof rec.userId === "string" ? rec.userId : "",
      provider: typeof rec.provider === "string" ? rec.provider : "",
    };
  } catch {
    return null;
  }
}

export function saveSession(session: NativeSession, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* storage unavailable — the in-memory session still works this run */
  }
}

export function clearSavedSession(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(CONNECTION_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

// ── session lifecycle ───────────────────────────────────────────────

function clearRefreshTimer(): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function scheduleRefresh(expiresAt: number): void {
  clearRefreshTimer();
  const delay = refreshDelayMs(expiresAt);
  if (delay === null || !getNativeAuthBridge().available) return;
  // setTimeout overflows past ~24.8 days; a session that long is refreshed
  // on the next launch instead.
  if (delay > 0x7fffffff) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshSession();
  }, delay);
}

/** Make ``session`` (or nothing) the active backend target and notify subscribers. */
export function applySession(session: NativeSession | null): void {
  clearRefreshTimer();
  if (!session) {
    current = null;
    accessToken = null;
    setBackendTarget(null);
    emit();
    return;
  }
  current = {
    origin: session.origin,
    basePath: session.basePath,
    userId: session.userId || undefined,
    provider: session.provider || undefined,
    expiresAt: session.expiresAt || undefined,
  };
  accessToken = session.accessToken;
  setBackendTarget({
    origin: session.origin,
    basePath: session.basePath,
    bearer: () => accessToken,
    refresh: refreshSession,
  });
  scheduleRefresh(session.expiresAt);
  emit();
}

/**
 * Rotate the session through the native bridge. Single-flighted: parallel
 * 401s share one refresh. Resolves ``true`` when a new access token is in
 * place. ``session_expired`` wipes the connection (the gateway's terminal
 * answer); ``unavailable`` keeps it — a transient IDP outage must not log
 * the user out.
 */
export function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  const bridge = getNativeAuthBridge();
  if (!bridge.available || !current) return Promise.resolve(false);
  refreshInFlight = (async () => {
    try {
      const session = await bridge.refresh();
      applySession(session);
      return true;
    } catch (err) {
      if (err instanceof NativeAuthError && err.code === "session_expired") {
        applySession(null);
        clearSavedSession();
      }
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/** RFC 8252 sign-in through the system browser (native bridge required). */
export async function signIn(opts: NativeLoginOptions): Promise<ConnectionInfo> {
  const session = await getNativeAuthBridge().login(opts);
  applySession(session);
  return current as ConnectionInfo;
}

/** Manual path: a pasted access token, kept in the native store when present. */
export async function connectWithToken(session: NativeSession): Promise<ConnectionInfo> {
  const bridge = getNativeAuthBridge();
  const stored = bridge.available ? await bridge.setSession(session) : session;
  if (!bridge.available) saveSession(stored);
  applySession(stored);
  return current as ConnectionInfo;
}

export async function disconnect(): Promise<void> {
  clearSavedSession();
  applySession(null);
  try {
    await getNativeAuthBridge().logout();
  } catch {
    /* best effort — the in-memory session is already gone */
  }
}

export function getCurrentConnection(): ConnectionInfo | null {
  return current;
}

/** Test/diagnostic access to the in-memory access token. */
export function getAccessToken(): string | null {
  return accessToken;
}

/**
 * Boot-time wiring for the mobile shell: restore the stored session and
 * react to the API layer reporting the credential is no longer usable
 * (``fetchJSON`` already tried one refresh before announcing that).
 */
export async function bootstrapMobileConnection(
  target: Pick<Window, "addEventListener"> | null = typeof window === "undefined" ? null : window,
): Promise<ConnectionInfo | null> {
  const bridge = getNativeAuthBridge();
  const session = bridge.available ? await bridge.getSession() : loadSavedSession();
  applySession(session);
  if (!target || wiredTargets.has(target)) return current;
  wiredTargets.add(target);
  target.addEventListener(REAUTH_EVENT, (event) => {
    const reason = (event as CustomEvent<ReauthDetail>).detail?.reason;
    if (reason === "logout") {
      void disconnect();
      return;
    }
    // "unauthorized" after a failed retry: the access token is dead. Try one
    // more refresh (covers a race with the proactive timer); if the session
    // is really gone the bridge already wiped it and refreshSession clears us.
    void refreshSession().then((ok) => {
      if (!ok && !getNativeAuthBridge().available) void disconnect();
    });
  });
  return current;
}

export function useMobileConnection(): ConnectionInfo | null {
  return useSyncExternalStore(subscribe, getCurrentConnection, getCurrentConnection);
}
