import { describe, expect, it, vi } from "vitest";

import { createCapacitorAuthBridge } from "./native-auth-capacitor";
import {
  NativeAuthError,
  chooseRedirectMode,
  gatewaySupportsNativeLogin,
  refreshDelayMs,
  unavailableAuthBridge,
} from "./native-auth";

describe("capability checks", () => {
  it.each([
    [["cookie", "native_pkce"], true, "loopback"],
    [["cookie", "native_pkce", "native_app_scheme"], true, "scheme"],
    [["cookie"], false, "loopback"],
    [undefined, false, "loopback"],
  ])("auth_flows %j → native=%s mode=%s", (flows, native, mode) => {
    expect(gatewaySupportsNativeLogin(flows)).toBe(native);
    expect(chooseRedirectMode(flows)).toBe(mode);
  });
});

describe("refreshDelayMs", () => {
  it("fires 120s before expiry and never in the past", () => {
    const now = 1_000_000_000;
    expect(refreshDelayMs(now + 600, now * 1000)).toBe(480_000);
    expect(refreshDelayMs(now + 60, now * 1000)).toBe(0);
    expect(refreshDelayMs(0, now * 1000)).toBeNull();
  });
});

describe("unavailable bridge", () => {
  it("rejects sign-in and refresh with a typed error", async () => {
    await expect(
      unavailableAuthBridge.login({ origin: "https://gw", basePath: "", redirectMode: "loopback" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(unavailableAuthBridge.refresh()).rejects.toBeInstanceOf(NativeAuthError);
    await expect(unavailableAuthBridge.getSession()).resolves.toBeNull();
  });
});

describe("capacitor bridge", () => {
  const session = {
    origin: "https://gw",
    basePath: "",
    accessToken: "t",
    expiresAt: 1,
    userId: "u",
    provider: "basic",
  };

  it("unwraps plugin results", async () => {
    const plugin = {
      getSession: vi.fn(async () => ({ session })),
      login: vi.fn(async () => ({ session })),
      refresh: vi.fn(async () => ({ session })),
      setSession: vi.fn(async () => ({ session })),
      logout: vi.fn(async () => {}),
      listSessions: vi.fn(async () => ({ sessions: [session] })),
      switchSession: vi.fn(async () => ({ session })),
      removeSession: vi.fn(async () => {}),
    };
    const bridge = createCapacitorAuthBridge(plugin);
    expect(bridge.available).toBe(true);
    await expect(bridge.listSessions()).resolves.toEqual([session]);
    await expect(bridge.switchSession("https://gw", "")).resolves.toEqual(session);
    expect(plugin.switchSession).toHaveBeenCalledWith({ origin: "https://gw", basePath: "" });
    await expect(bridge.getSession()).resolves.toEqual(session);
    await expect(bridge.login({ origin: "https://gw", basePath: "", redirectMode: "scheme" })).resolves.toEqual(session);
    expect(plugin.login).toHaveBeenCalledWith({ origin: "https://gw", basePath: "", redirectMode: "scheme" });
  });

  it("maps plugin rejection codes onto NativeAuthError", async () => {
    const plugin = {
      getSession: vi.fn(async () => ({ session: null })),
      login: vi.fn(async () => {
        throw { message: "user backed out", code: "cancelled" };
      }),
      refresh: vi.fn(async () => {
        throw { message: "gone", code: "session_expired" };
      }),
      setSession: vi.fn(async () => ({ session })),
      logout: vi.fn(async () => {
        throw new Error("boom");
      }),
      listSessions: vi.fn(async () => ({ sessions: [] })),
      switchSession: vi.fn(async () => ({ session: null })),
      removeSession: vi.fn(async () => {}),
    };
    const bridge = createCapacitorAuthBridge(plugin);
    await expect(bridge.login({ origin: "https://gw", basePath: "", redirectMode: "loopback" })).rejects.toMatchObject({
      code: "cancelled",
      message: "user backed out",
    });
    await expect(bridge.refresh()).rejects.toMatchObject({ code: "session_expired" });
    await expect(bridge.logout()).rejects.toMatchObject({ code: "failed", message: "boom" });
  });
});
