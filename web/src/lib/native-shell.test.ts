import { describe, expect, it, vi } from "vitest";

import { createCapacitorShellBridge } from "./native-shell-capacitor";
import { noopShellBridge, notificationSnippet } from "./native-shell";

describe("notificationSnippet", () => {
  it("collapses whitespace and truncates with an ellipsis", () => {
    expect(notificationSnippet("  The\n\n tool   said hi ")).toBe("The tool said hi");
    const long = "x".repeat(200);
    expect(notificationSnippet(long, 20)).toBe(`${"x".repeat(19)}…`);
  });
});

describe("noop shell bridge", () => {
  it("is inert and unsubscribable", async () => {
    expect(noopShellBridge.available).toBe(false);
    await expect(noopShellBridge.requestNotificationPermission()).resolves.toBe(false);
    await expect(noopShellBridge.startDictation()).resolves.toBeNull();
    expect(typeof noopShellBridge.on("networkAvailable", () => {})).toBe("function");
  });
});

describe("capacitor shell bridge", () => {
  it("maps calls onto the plugin and unwraps results", async () => {
    const remove = vi.fn(async () => {});
    const plugin = {
      requestNotificationPermission: vi.fn(async () => ({ granted: true })),
      startForeground: vi.fn(async () => {}),
      stopForeground: vi.fn(async () => {}),
      notifyApproval: vi.fn(async () => ({ shown: true })),
      notifyTurnComplete: vi.fn(async () => ({ shown: true })),
      cancelApprovalNotification: vi.fn(async () => {}),
      startDictation: vi.fn(async () => ({ text: "hello" })),
      addListener: vi.fn(async () => ({ remove })),
    };
    const bridge = createCapacitorShellBridge(plugin);
    await expect(bridge.requestNotificationPermission()).resolves.toBe(true);
    await bridge.startForeground("gw.example");
    expect(plugin.startForeground).toHaveBeenCalledWith({ label: "gw.example" });
    await bridge.cancelApprovalNotification("r1");
    expect(plugin.cancelApprovalNotification).toHaveBeenCalledWith({ requestId: "r1" });
    await expect(bridge.startDictation()).resolves.toBe("hello");

    const off = bridge.on("networkAvailable", () => {});
    await Promise.resolve();
    expect(plugin.addListener).toHaveBeenCalledWith("networkAvailable", expect.any(Function));
    off();
    await Promise.resolve();
    expect(remove).toHaveBeenCalled();
  });

  it("treats a failed or cancelled dictation as null", async () => {
    const plugin = {
      requestNotificationPermission: vi.fn(async () => ({ granted: false })),
      startForeground: vi.fn(async () => {
        throw new Error("no service");
      }),
      stopForeground: vi.fn(async () => {}),
      notifyApproval: vi.fn(async () => ({ shown: false })),
      notifyTurnComplete: vi.fn(async () => ({ shown: false })),
      cancelApprovalNotification: vi.fn(async () => {}),
      startDictation: vi.fn(async () => {
        throw new Error("cancelled");
      }),
      addListener: vi.fn(async () => ({ remove: async () => {} })),
    };
    const bridge = createCapacitorShellBridge(plugin);
    await expect(bridge.startDictation()).resolves.toBeNull();
    await expect(bridge.startForeground("x")).resolves.toBeUndefined();
  });
});
