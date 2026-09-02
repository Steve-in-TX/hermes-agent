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

import { gatewayKey } from "@hermes/shared";

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
/** Non-secret registry of gateways the phone has used (names, last use). */
export const GATEWAYS_STORAGE_KEY = "hermes.mobile.gateways";

export interface KnownGateway {
  origin: string;
  basePath: string;
  name?: string;
  lastUsedAt: number;
  /** A stored session exists (signed in). */
  signedIn: boolean;
  userId?: string;
  provider?: string;
}

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

// ── gateway registry (names + last use; tokens live in the native store) ──

interface GatewayRecord {
  origin: string;
  basePath: string;
  name?: string;
  lastUsedAt: number;
}

function readRegistry(storage: StorageLike | null = defaultStorage()): Record<string, GatewayRecord> {
  try {
    const raw = storage?.getItem(GATEWAYS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, GatewayRecord> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const rec = value as Partial<GatewayRecord>;
      if (typeof rec?.origin !== "string") continue;
      out[key] = {
        origin: rec.origin,
        basePath: typeof rec.basePath === "string" ? rec.basePath : "",
        name: typeof rec.name === "string" ? rec.name : undefined,
        lastUsedAt: typeof rec.lastUsedAt === "number" ? rec.lastUsedAt : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeRegistry(registry: Record<string, GatewayRecord>, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(GATEWAYS_STORAGE_KEY, JSON.stringify(registry));
  } catch {
    /* ignore */
  }
}

/** Record a gateway as used now (optionally naming it). */
export function rememberGateway(origin: string, basePath: string, name?: string, storage: StorageLike | null = defaultStorage()): void {
  const registry = readRegistry(storage);
  const key = gatewayKey(origin, basePath);
  const prev = registry[key];
  registry[key] = { origin, basePath, name: name ?? prev?.name, lastUsedAt: Date.now() };
  writeRegistry(registry, storage);
}

export function forgetGatewayRecord(origin: string, basePath: string, storage: StorageLike | null = defaultStorage()): void {
  const registry = readRegistry(storage);
  delete registry[gatewayKey(origin, basePath)];
  writeRegistry(registry, storage);
}

/** Registry ∪ native sessions, most recently used first. */
export async function listGateways(storage: StorageLike | null = defaultStorage()): Promise<KnownGateway[]> {
  const registry = readRegistry(storage);
  const bridge = getNativeAuthBridge();
  const sessions = bridge.available ? await bridge.listSessions().catch(() => []) : [loadSavedSession(storage)].filter((s): s is NativeSession => !!s);
  const byKey = new Map<string, KnownGateway>();
  for (const [key, rec] of Object.entries(registry)) {
    byKey.set(key, { origin: rec.origin, basePath: rec.basePath, name: rec.name, lastUsedAt: rec.lastUsedAt, signedIn: false });
  }
  for (const s of sessions) {
    const key = gatewayKey(s.origin, s.basePath);
    const prev = byKey.get(key);
    byKey.set(key, {
      origin: s.origin,
      basePath: s.basePath,
      name: prev?.name,
      lastUsedAt: prev?.lastUsedAt ?? 0,
      signedIn: true,
      userId: s.userId || undefined,
      provider: s.provider || undefined,
    });
  }
  return [...byKey.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

/** Make another signed-in gateway active. Resolves false when it has no session. */
export async function switchGateway(origin: string, basePath: string): Promise<boolean> {
  const bridge = getNativeAuthBridge();
  const session = bridge.available ? await bridge.switchSession(origin, basePath) : null;
  if (!session) return false;
  rememberGateway(origin, basePath);
  applySession(session);
  return true;
}

/** Drop a gateway's stored session and registry entry; disconnect if it was active. */
export async function forgetGateway(origin: string, basePath: string): Promise<void> {
  const bridge = getNativeAuthBridge();
  const wasActive = current !== null && gatewayKey(current.origin, current.basePath) === gatewayKey(origin, basePath);
  if (bridge.available) await bridge.removeSession(origin, basePath).catch(() => {});
  forgetGatewayRecord(origin, basePath);
  if (wasActive) {
    clearSavedSession();
    applySession(null);
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
export async function signIn(opts: NativeLoginOptions & { name?: string }): Promise<ConnectionInfo> {
  const session = await getNativeAuthBridge().login(opts);
  rememberGateway(session.origin, session.basePath, opts.name);
  applySession(session);
  return current as ConnectionInfo;
}

/** Manual path: a pasted access token, kept in the native store when present. */
export async function connectWithToken(session: NativeSession, name?: string): Promise<ConnectionInfo> {
  const bridge = getNativeAuthBridge();
  const stored = bridge.available ? await bridge.setSession(session) : session;
  if (!bridge.available) saveSession(stored);
  rememberGateway(stored.origin, stored.basePath, name);
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
