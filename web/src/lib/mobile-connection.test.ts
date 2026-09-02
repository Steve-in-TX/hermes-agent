// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REAUTH_EVENT, getBackendTarget, isRemoteTarget, resolveUrl } from "./backend-target";
import {
  CONNECTION_STORAGE_KEY,
  applySession,
  bootstrapMobileConnection,
  connectWithToken,
  disconnect,
  forgetGateway,
  getAccessToken,
  getCurrentConnection,
  listGateways,
  loadSavedSession,
  refreshSession,
  rememberGateway,
  signIn,
  switchGateway,
} from "./mobile-connection";
import {
  NativeAuthError,
  setNativeAuthBridge,
  type NativeAuthBridge,
  type NativeSession,
} from "./native-auth";

const SESSION: NativeSession = {
  origin: "https://gw.example:9119",
  basePath: "/hermes",
  accessToken: "tok-1",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  userId: "steve",
  provider: "basic",
};

function fakeBridge(overrides: Partial<NativeAuthBridge> = {}): NativeAuthBridge {
  let stored: NativeSession | null = null;
  return {
    available: true,
    getSession: vi.fn(async () => stored),
    login: vi.fn(async () => {
      stored = SESSION;
      return SESSION;
    }),
    refresh: vi.fn(async () => {
      stored = { ...SESSION, accessToken: "tok-2" };
      return stored;
    }),
    setSession: vi.fn(async (s) => {
      stored = s;
      return s;
    }),
    logout: vi.fn(async () => {
      stored = null;
    }),
    listSessions: vi.fn(async () => (stored ? [stored] : [])),
    switchSession: vi.fn(async (origin: string) => (stored && stored.origin === origin ? stored : null)),
    removeSession: vi.fn(async () => {
      stored = null;
    }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await disconnect();
  setNativeAuthBridge(null);
  window.localStorage.clear();
  vi.useRealTimers();
});

describe("without a native bridge (browser dev)", () => {
  it("connectWithToken persists to localStorage and points the target at the gateway", async () => {
    await connectWithToken(SESSION);
    expect(isRemoteTarget()).toBe(true);
    expect(resolveUrl("/api/status")).toBe("https://gw.example:9119/hermes/api/status");
    expect(getBackendTarget().bearer()).toBe("tok-1");
    expect(loadSavedSession()).toEqual(SESSION);
    expect(getCurrentConnection()).toMatchObject({ origin: SESSION.origin, userId: "steve" });
  });

  it("bootstrap restores the saved session and a reauth event disconnects", async () => {
    window.localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(SESSION));
    await expect(bootstrapMobileConnection()).resolves.toMatchObject({ origin: SESSION.origin });
    expect(isRemoteTarget()).toBe(true);

    window.dispatchEvent(new CustomEvent(REAUTH_EVENT, { detail: { reason: "unauthorized" } }));
    await vi.runAllTimersAsync();

    expect(getCurrentConnection()).toBeNull();
    expect(loadSavedSession()).toBeNull();
    expect(isRemoteTarget()).toBe(false);
  });

  it("signIn fails clearly and refresh reports false", async () => {
    await expect(
      signIn({ origin: SESSION.origin, basePath: "", redirectMode: "loopback" }),
    ).rejects.toBeInstanceOf(NativeAuthError);
    await expect(refreshSession()).resolves.toBe(false);
  });

  it("ignores malformed saved sessions", () => {
    window.localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify({ origin: "x" }));
    expect(loadSavedSession()).toBeNull();
  });
});

describe("gateway registry", () => {
  it("lists remembered gateways with sign-in state, most recent first", async () => {
    const bridge = fakeBridge({ listSessions: vi.fn(async () => [SESSION]) });
    setNativeAuthBridge(bridge);
    rememberGateway("https://old.example", "", "old");
    vi.setSystemTime(Date.now() + 1000);
    rememberGateway(SESSION.origin, SESSION.basePath, "studio");
    const list = await listGateways();
    expect(list.map((g) => [g.name, g.signedIn, g.userId])).toEqual([
      ["studio", true, "steve"],
      ["old", false, undefined],
    ]);
  });

  it("switches to a signed-in gateway and refuses one without a session", async () => {
    const bridge = fakeBridge({
      listSessions: vi.fn(async () => [SESSION]),
      switchSession: vi.fn(async (origin: string) => (origin === SESSION.origin ? SESSION : null)),
    });
    setNativeAuthBridge(bridge);
    await expect(switchGateway("https://nowhere.example", "")).resolves.toBe(false);
    expect(isRemoteTarget()).toBe(false);
    await expect(switchGateway(SESSION.origin, SESSION.basePath)).resolves.toBe(true);
    expect(getBackendTarget().bearer()).toBe("tok-1");
    expect((await listGateways())[0]).toMatchObject({ origin: SESSION.origin, signedIn: true });
  });

  it("forgetting the active gateway signs out; forgetting another does not", async () => {
    const bridge = fakeBridge();
    setNativeAuthBridge(bridge);
    rememberGateway("https://other.example", "", "other");
    applySession(SESSION);
    await forgetGateway("https://other.example", "");
    expect(getCurrentConnection()).not.toBeNull();
    await forgetGateway(SESSION.origin, SESSION.basePath);
    expect(bridge.removeSession).toHaveBeenCalledWith(SESSION.origin, SESSION.basePath);
    expect(getCurrentConnection()).toBeNull();
    expect(await listGateways()).toEqual([]);
  });
});

describe("with the native bridge", () => {
  it("bootstrap reads the session from the bridge, never localStorage", async () => {
    const bridge = fakeBridge({ getSession: vi.fn(async () => SESSION) });
    setNativeAuthBridge(bridge);
    await bootstrapMobileConnection();
    expect(bridge.getSession).toHaveBeenCalledTimes(1);
    expect(getBackendTarget().bearer()).toBe("tok-1");
    expect(window.localStorage.getItem(CONNECTION_STORAGE_KEY)).toBeNull();
  });

  it("signIn runs the native login and applies the session with a refresh hook", async () => {
    const bridge = fakeBridge();
    setNativeAuthBridge(bridge);
    await signIn({ origin: SESSION.origin, basePath: "/hermes", redirectMode: "scheme" });
    expect(bridge.login).toHaveBeenCalledWith({
      origin: SESSION.origin,
      basePath: "/hermes",
      redirectMode: "scheme",
    });
    expect(getBackendTarget().bearer()).toBe("tok-1");
    expect(typeof getBackendTarget().refresh).toBe("function");
  });

  it("refresh is single-flighted and swaps the bearer", async () => {
    const bridge = fakeBridge();
    setNativeAuthBridge(bridge);
    applySession(SESSION);
    const [a, b] = await Promise.all([refreshSession(), refreshSession()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(bridge.refresh).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBe("tok-2");
  });

  it("session_expired wipes the connection; unavailable keeps it", async () => {
    const expired = fakeBridge({
      refresh: vi.fn(async () => {
        throw new NativeAuthError("session_expired", "gone");
      }),
    });
    setNativeAuthBridge(expired);
    applySession(SESSION);
    await expect(refreshSession()).resolves.toBe(false);
    expect(getCurrentConnection()).toBeNull();
    expect(isRemoteTarget()).toBe(false);

    const outage = fakeBridge({
      refresh: vi.fn(async () => {
        throw new NativeAuthError("unavailable", "idp down");
      }),
    });
    setNativeAuthBridge(outage);
    applySession(SESSION);
    await expect(refreshSession()).resolves.toBe(false);
    expect(getCurrentConnection()).not.toBeNull();
    expect(getBackendTarget().bearer()).toBe("tok-1");
  });

  it("refreshes proactively 120s before expiry", async () => {
    const bridge = fakeBridge();
    setNativeAuthBridge(bridge);
    const now = Math.floor(Date.now() / 1000);
    applySession({ ...SESSION, expiresAt: now + 600 });
    await vi.advanceTimersByTimeAsync(479_000);
    expect(bridge.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(bridge.refresh).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBe("tok-2");
  });

  it("disconnect clears the native store", async () => {
    const bridge = fakeBridge();
    setNativeAuthBridge(bridge);
    applySession(SESSION);
    await disconnect();
    expect(bridge.logout).toHaveBeenCalledTimes(1);
    expect(getCurrentConnection()).toBeNull();
  });

  it("a reauth event after a failed retry tries one refresh and keeps the session on outage", async () => {
    const outage = fakeBridge({
      getSession: vi.fn(async () => SESSION),
      refresh: vi.fn(async () => {
        throw new NativeAuthError("unavailable", "idp down");
      }),
    });
    setNativeAuthBridge(outage);
    await bootstrapMobileConnection();
    window.dispatchEvent(new CustomEvent(REAUTH_EVENT, { detail: { reason: "unauthorized" } }));
    // Flush the listener only — running all timers would also fire the
    // proactive refresh scheduled for 120s before expiry.
    await vi.advanceTimersByTimeAsync(10);
    expect(outage.refresh).toHaveBeenCalledTimes(1);
    expect(getCurrentConnection()).not.toBeNull();
  });
});
