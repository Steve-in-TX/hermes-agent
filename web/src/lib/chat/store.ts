/**
 * External store for chat state: one `SessionChatState` per runtime session
 * id plus a small shell record (socket state, active session). Plain
 * `useSyncExternalStore` — no store library, and the reducer stays pure.
 *
 * Keyed per session on purpose: a background session can park an approval
 * while another is in the foreground (the plan's "per-session keying").
 */
import { useSyncExternalStore } from "react";

import type { ConnectionState } from "@hermes/shared";

import { createSessionChatState, type SessionChatState } from "./types";

export interface ChatShellState {
  connection: ConnectionState;
  activeSessionId: string | null;
  /** Reconnect attempt counter (0 = connected or never tried). */
  reconnectAttempt: number;
  error: string | null;
}

const sessions = new Map<string, SessionChatState>();
let shell: ChatShellState = { connection: "idle", activeSessionId: null, reconnectAttempt: 0, error: null };

const sessionListeners = new Map<string, Set<() => void>>();
const shellListeners = new Set<() => void>();

const EMPTY = createSessionChatState("");

function notifySession(id: string): void {
  sessionListeners.get(id)?.forEach((l) => l());
}

export function getSessionState(id: string | null): SessionChatState {
  if (!id) return EMPTY;
  return sessions.get(id) ?? EMPTY;
}

export function hasSession(id: string): boolean {
  return sessions.has(id);
}

export function setSessionState(id: string, next: SessionChatState): void {
  sessions.set(id, next);
  notifySession(id);
}

export function updateSession(id: string, fn: (state: SessionChatState) => SessionChatState): void {
  const current = sessions.get(id) ?? createSessionChatState(id);
  const next = fn(current);
  if (next === current && sessions.has(id)) return;
  sessions.set(id, next);
  notifySession(id);
}

export function removeSession(id: string): void {
  sessions.delete(id);
  notifySession(id);
}

export function getShell(): ChatShellState {
  return shell;
}

export function updateShell(patch: Partial<ChatShellState>): void {
  shell = { ...shell, ...patch };
  shellListeners.forEach((l) => l());
}

/** Test hook. */
export function resetChatStore(): void {
  sessions.clear();
  shell = { connection: "idle", activeSessionId: null, reconnectAttempt: 0, error: null };
  shellListeners.forEach((l) => l());
}

function subscribeSession(id: string | null): (listener: () => void) => () => void {
  return (listener) => {
    if (!id) return () => {};
    let set = sessionListeners.get(id);
    if (!set) {
      set = new Set();
      sessionListeners.set(id, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };
}

export function useSessionChat(id: string | null): SessionChatState {
  const subscribe = subscribeSession(id);
  return useSyncExternalStore(subscribe, () => getSessionState(id), () => getSessionState(id));
}

function subscribeShell(listener: () => void): () => void {
  shellListeners.add(listener);
  return () => {
    shellListeners.delete(listener);
  };
}

export function useChatShell(): ChatShellState {
  return useSyncExternalStore(subscribeShell, getShell, getShell);
}
