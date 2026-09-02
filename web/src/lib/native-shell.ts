/**
 * Native shell bridge — the JS contract for the Android ``HermesShell``
 * plugin: foreground service, approval / turn notifications, notification
 * action events, connectivity events, share target, dictation.
 *
 * Injected like the other bridges: the mobile build installs the Capacitor
 * one; the default is a no-op so the chat controller can call it
 * unconditionally and tests substitute a fake.
 *
 * Only ``once`` and ``deny`` ever come back from a notification action.
 * Sudo/secret prompts are never surfaced here.
 */

export interface ApprovalActionEvent {
  sessionId: string;
  requestId: string;
  choice: "once" | "deny";
}

export interface ShellEvents {
  approvalAction: ApprovalActionEvent;
  networkAvailable: Record<string, never>;
  shareText: { text: string };
}

export interface NativeShellBridge {
  readonly available: boolean;
  /** Android 13+: ask for POST_NOTIFICATIONS. Resolves whether notifications are enabled. */
  requestNotificationPermission(): Promise<boolean>;
  startForeground(label: string): Promise<void>;
  stopForeground(): Promise<void>;
  notifyApproval(args: { sessionId: string; requestId: string; command: string; description: string }): Promise<void>;
  notifyTurnComplete(args: { sessionId: string; text: string; title?: string }): Promise<void>;
  cancelApprovalNotification(requestId: string): Promise<void>;
  /** Resolves the recognised text, or null when cancelled / unavailable. */
  startDictation(): Promise<string | null>;
  on<K extends keyof ShellEvents>(event: K, handler: (payload: ShellEvents[K]) => void): () => void;
}

export const noopShellBridge: NativeShellBridge = {
  available: false,
  requestNotificationPermission: async () => false,
  startForeground: async () => {},
  stopForeground: async () => {},
  notifyApproval: async () => {},
  notifyTurnComplete: async () => {},
  cancelApprovalNotification: async () => {},
  startDictation: async () => null,
  on: () => () => {},
};

let bridge: NativeShellBridge = noopShellBridge;

export function setNativeShellBridge(next: NativeShellBridge | null): void {
  bridge = next ?? noopShellBridge;
}

export function getNativeShellBridge(): NativeShellBridge {
  return bridge;
}

/** Shorten a reply for a notification body. */
export function notificationSnippet(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
