/**
 * ``NativeShellBridge`` on the Android ``HermesShell`` Capacitor plugin.
 * Only the mobile build executes the dynamic import.
 */
import type { PluginListenerHandle } from "@capacitor/core";

import { setNativeShellBridge, type NativeShellBridge, type ShellEvents } from "./native-shell";
import { isCapacitorNative } from "./transport";

interface HermesShellPlugin {
  requestNotificationPermission(): Promise<{ granted: boolean }>;
  startForeground(opts: { label: string }): Promise<void>;
  stopForeground(): Promise<void>;
  notifyApproval(opts: { sessionId: string; requestId: string; command: string; description: string }): Promise<{ shown: boolean }>;
  notifyTurnComplete(opts: { sessionId: string; text: string; title?: string }): Promise<{ shown: boolean }>;
  cancelApprovalNotification(opts: { requestId: string }): Promise<void>;
  startDictation(): Promise<{ text: string | null }>;
  addListener<K extends keyof ShellEvents>(
    eventName: K,
    listener: (event: ShellEvents[K]) => void,
  ): Promise<PluginListenerHandle>;
}

export function createCapacitorShellBridge(plugin: HermesShellPlugin): NativeShellBridge {
  return {
    available: true,
    requestNotificationPermission: async () => (await plugin.requestNotificationPermission()).granted,
    startForeground: (label) => plugin.startForeground({ label }).catch(() => {}),
    stopForeground: () => plugin.stopForeground().catch(() => {}),
    notifyApproval: (args) => plugin.notifyApproval(args).then(() => {}),
    notifyTurnComplete: (args) => plugin.notifyTurnComplete(args).then(() => {}),
    cancelApprovalNotification: (requestId) => plugin.cancelApprovalNotification({ requestId }).catch(() => {}),
    startDictation: async () => {
      try {
        return (await plugin.startDictation()).text ?? null;
      } catch {
        return null;
      }
    },
    on: (event, handler) => {
      let handle: PluginListenerHandle | null = null;
      let removed = false;
      void plugin.addListener(event, handler).then((h) => {
        if (removed) void h.remove();
        else handle = h;
      });
      return () => {
        removed = true;
        void handle?.remove();
      };
    },
  };
}

export async function installNativeShellIfAvailable(): Promise<boolean> {
  if (typeof __HERMES_TARGET__ === "undefined" || __HERMES_TARGET__ !== "mobile") {
    return false;
  }
  if (!isCapacitorNative()) return false;
  const { registerPlugin } = await import("@capacitor/core");
  setNativeShellBridge(createCapacitorShellBridge(registerPlugin<HermesShellPlugin>("HermesShell")));
  return true;
}
