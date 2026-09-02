/**
 * The Android app's notion of "which gateway am I signed in to".
 *
 * Owns the saved connection, applies it to ``backend-target`` on boot, and
 * drops it when the gateway rejects the credential (``REAUTH_EVENT``) so the
 * shell falls back to the connection screen.
 *
 * M1 storage note: the bearer is kept in ``localStorage`` because M1 pastes a
 * token by hand. M2 replaces this with the ``HermesTokenStore`` plugin
 * (EncryptedSharedPreferences / Keystore) and the RFC 8252 login; nothing
 * outside this module should know where the token lives.
 */
import { useSyncExternalStore } from "react";

import { REAUTH_EVENT, setBackendTarget } from "@/lib/backend-target";

export interface SavedConnection {
  origin: string;
  basePath: string;
  token: string;
  /** From ``/api/auth/me`` at connect time, for display only. */
  userId?: string;
  provider?: string;
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

let current: SavedConnection | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function loadSavedConnection(storage: StorageLike | null = defaultStorage()): SavedConnection | null {
  try {
    const raw = storage?.getItem(CONNECTION_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.origin !== "string" || typeof rec.token !== "string" || !rec.origin || !rec.token) {
      return null;
    }
    return {
      origin: rec.origin,
      basePath: typeof rec.basePath === "string" ? rec.basePath : "",
      token: rec.token,
      userId: typeof rec.userId === "string" ? rec.userId : undefined,
      provider: typeof rec.provider === "string" ? rec.provider : undefined,
    };
  } catch {
    return null;
  }
}

export function saveConnection(conn: SavedConnection, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(conn));
  } catch {
    /* storage unavailable — the in-memory connection still works this run */
  }
}

export function clearSavedConnection(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(CONNECTION_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Make ``conn`` (or nothing) the active backend target and notify subscribers. */
export function applyConnection(conn: SavedConnection | null): void {
  current = conn;
  setBackendTarget(
    conn
      ? { origin: conn.origin, basePath: conn.basePath, bearer: () => conn.token }
      : null,
  );
  emit();
}

export function connectTo(conn: SavedConnection): void {
  saveConnection(conn);
  applyConnection(conn);
}

export function disconnect(): void {
  clearSavedConnection();
  applyConnection(null);
}

export function getCurrentConnection(): SavedConnection | null {
  return current;
}

/**
 * Boot-time wiring for the mobile shell: restore the saved connection and
 * drop it whenever the API layer reports the credential is no longer usable.
 * M1: any rejection returns to the connection screen; M2 will try a refresh
 * first and only wipe on the gateway's 401 ``session_expired``.
 */
export function bootstrapMobileConnection(
  target: Pick<Window, "addEventListener"> | null = typeof window === "undefined" ? null : window,
): SavedConnection | null {
  applyConnection(loadSavedConnection());
  target?.addEventListener(REAUTH_EVENT, () => disconnect());
  return current;
}

export function useMobileConnection(): SavedConnection | null {
  return useSyncExternalStore(subscribe, getCurrentConnection, getCurrentConnection);
}
