// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  api,
  authedFetch,
  buildWsAuthParam,
  buildWsUrl,
  fetchJSON,
  getWsTicket,
  setManagementProfile,
} from "./api";
import { REAUTH_EVENT, setBackendTarget } from "./backend-target";

const reloadMocks = vi.hoisted(() => ({
  attemptDashboardTokenReloadOnce: vi.fn(() => false),
  clearDashboardTokenReloadAttempt: vi.fn(),
}));

vi.mock("./dashboard-auth-reload", () => ({
  attemptDashboardTokenReloadOnce: reloadMocks.attemptDashboardTokenReloadOnce,
  clearDashboardTokenReloadAttempt: reloadMocks.clearDashboardTokenReloadAttempt,
}));

const SESSION_HEADER = "X-Hermes-Session-Token";

beforeEach(() => {
  reloadMocks.attemptDashboardTokenReloadOnce.mockReset();
  reloadMocks.attemptDashboardTokenReloadOnce.mockReturnValue(false);
  reloadMocks.clearDashboardTokenReloadAttempt.mockReset();

  Object.defineProperty(window, "__HERMES_SESSION_TOKEN__", {
    configurable: true,
    value: "stale-token",
    writable: true,
  });
  Object.defineProperty(window, "__HERMES_AUTH_REQUIRED__", {
    configurable: true,
    value: false,
    writable: true,
  });
});

afterEach(() => {
  setManagementProfile("");
  setBackendTarget(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jsonFetchMock(body: unknown = { ok: true }) {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
  );
}

describe("fetchJSON", () => {
  it("tries the one-shot reload path for loopback 401s", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        clone: () => ({
          json: async () => ({}),
        }),
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "Unauthorized",
      })),
    );
    reloadMocks.attemptDashboardTokenReloadOnce.mockReturnValue(true);

    const pending = fetchJSON("/api/status");
    await expect(Promise.race([pending, Promise.resolve("pending")])).resolves.toBe(
      "pending",
    );

    expect(reloadMocks.attemptDashboardTokenReloadOnce).toHaveBeenCalledTimes(1);
    expect(reloadMocks.clearDashboardTokenReloadAttempt).not.toHaveBeenCalled();
  });

  it("clears the reload latch after a successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        json: async () => ({ ok: true }),
        ok: true,
        status: 200,
      })),
    );

    await expect(fetchJSON("/api/status")).resolves.toEqual({ ok: true });

    expect(reloadMocks.clearDashboardTokenReloadAttempt).toHaveBeenCalledTimes(1);
  });
});

describe("api.getModelOptions", () => {
  it("requests a live model refresh when asked", async () => {
    vi.stubGlobal("window", {});

    const fetchMock = jsonFetchMock({ providers: [] });
    vi.stubGlobal("fetch", fetchMock);

    await api.getModelOptions({ refresh: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/model/options?refresh=1&include_unconfigured=1",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("keeps explicit profile scoping when refreshing", async () => {
    vi.stubGlobal("window", {});

    const fetchMock = jsonFetchMock({ providers: [] });
    vi.stubGlobal("fetch", fetchMock);

    await api.getModelOptions({ profile: "default", refresh: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/model/options?profile=default&refresh=1&include_unconfigured=1",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});

describe("api OAuth helpers", () => {
  it("starts OAuth login in gated mode without requiring an injected session token", async () => {
    vi.stubGlobal("window", { __HERMES_AUTH_REQUIRED__: true });
    const fetchMock = jsonFetchMock({
      flow: "device_code",
      session_id: "oauth-session",
    });
    vi.stubGlobal("fetch", fetchMock);

    await api.startOAuthLogin("openai-codex");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/providers/oauth/openai-codex/start",
      expect.objectContaining({
        body: "{}",
        credentials: "include",
        method: "POST",
      }),
    );
    const headers = fetchMock.mock.calls[0][1]?.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.has(SESSION_HEADER)).toBe(false);
  });

  it("still sends the injected session token for OAuth login in loopback mode", async () => {
    vi.stubGlobal("window", { __HERMES_SESSION_TOKEN__: "loopback-token" });
    const fetchMock = jsonFetchMock({
      flow: "device_code",
      session_id: "oauth-session",
    });
    vi.stubGlobal("fetch", fetchMock);

    await api.startOAuthLogin("openai-codex");

    const headers = fetchMock.mock.calls[0][1]?.headers as Headers;
    expect(headers.get(SESSION_HEADER)).toBe("loopback-token");
  });

  it("runs provider auth mutations in gated mode via cookie auth", async () => {
    vi.stubGlobal("window", { __HERMES_AUTH_REQUIRED__: true });
    const fetchMock = jsonFetchMock({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await api.disconnectOAuthProvider("anthropic");
    await api.submitOAuthCode("anthropic", "oauth-session", "code-123");
    await api.cancelOAuthSession("oauth-session");
    await api.revealEnvVar("OPENAI_API_KEY");

    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.credentials).toBe("include");
      expect((init.headers as Headers).has(SESSION_HEADER)).toBe(false);
    }
  });

  it("keeps every OAuth operation on the selected management profile", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = jsonFetchMock({
      flow: "device_code",
      session_id: "oauth-session",
    });
    vi.stubGlobal("fetch", fetchMock);
    setManagementProfile("worker");

    await api.getOAuthProviders();
    await api.disconnectOAuthProvider("anthropic");
    await api.startOAuthLogin("openai-codex");
    await api.submitOAuthCode("anthropic", "oauth-session", "code-123");
    await api.pollOAuthSession("anthropic", "oauth-session");
    await api.cancelOAuthSession("oauth-session");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/providers/oauth?profile=worker",
      "/api/providers/oauth/anthropic?profile=worker",
      "/api/providers/oauth/openai-codex/start?profile=worker",
      "/api/providers/oauth/anthropic/submit?profile=worker",
      "/api/providers/oauth/anthropic/poll/oauth-session?profile=worker",
      "/api/providers/oauth/sessions/oauth-session?profile=worker",
    ]);
  });
});

describe("remote backend target (bundled client)", () => {
  const REMOTE = {
    origin: "https://gw.example:9119",
    basePath: "/hermes",
    bearer: () => "tok-123",
  };

  it("keeps the default target byte-identical: relative URL, session header, cookies included", async () => {
    const fetchMock = jsonFetchMock({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await fetchJSON("/api/status");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/status");
    expect((init as RequestInit).credentials).toBe("include");
    const headers = (init as RequestInit).headers as Headers;
    expect(headers.get(SESSION_HEADER)).toBe("stale-token");
    expect(headers.has("Authorization")).toBe(false);
  });

  it.each([
    ["fetchJSON", () => fetchJSON("/api/sessions?limit=1")],
    ["authedFetch", () => authedFetch("/api/sessions?limit=1")],
  ])("%s: absolute URL, bearer, credentials omitted, no session header", async (_name, run) => {
    setBackendTarget(REMOTE);
    const fetchMock = jsonFetchMock({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await run();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://gw.example:9119/hermes/api/sessions?limit=1");
    expect((init as RequestInit).credentials).toBe("omit");
    const headers = (init as RequestInit).headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer tok-123");
    expect(headers.has(SESSION_HEADER)).toBe(false);
  });

  it("mints ws tickets with the bearer and always uses ticket auth for sockets", async () => {
    setBackendTarget(REMOTE);
    const fetchMock = jsonFetchMock({ ticket: "t-1", ttl_seconds: 30 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getWsTicket()).resolves.toEqual({ ticket: "t-1", ttl_seconds: 30 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://gw.example:9119/hermes/api/auth/ws-ticket");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).credentials).toBe("omit");
    expect(((init as RequestInit).headers as Headers).get("Authorization")).toBe("Bearer tok-123");

    // __HERMES_AUTH_REQUIRED__ is false in this suite; remote still means ticket.
    await expect(buildWsAuthParam()).resolves.toEqual(["ticket", "t-1"]);
    await expect(buildWsUrl("/api/events", { channel: "c" })).resolves.toBe(
      "wss://gw.example:9119/hermes/api/events?channel=c&ticket=t-1",
    );
  });

  it("turns a remote 401 into a reauth event and a plain error, never a navigation", async () => {
    setBackendTarget(REMOTE);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "session_expired", login_url: "/login" }), { status: 401 })),
    );
    const onReauth = vi.fn();
    window.addEventListener(REAUTH_EVENT, onReauth);

    await expect(fetchJSON("/api/status")).rejects.toThrow(/^401/);

    expect(onReauth).toHaveBeenCalledTimes(1);
    expect(reloadMocks.attemptDashboardTokenReloadOnce).not.toHaveBeenCalled();
    window.removeEventListener(REAUTH_EVENT, onReauth);
  });

  it("refreshes once and retries a remote 401, then gives up with a reauth event", async () => {
    let token = "stale";
    const refresh = vi.fn(async () => {
      token = "fresh";
      return true;
    });
    setBackendTarget({ ...REMOTE, bearer: () => token, refresh });
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const auth = (init?.headers as Headers).get("Authorization");
      return auth === "Bearer fresh"
        ? new Response(JSON.stringify({ ok: true }), { status: 200 })
        : new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onReauth = vi.fn();
    window.addEventListener(REAUTH_EVENT, onReauth);

    await expect(fetchJSON("/api/status")).resolves.toEqual({ ok: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onReauth).not.toHaveBeenCalled();

    // Refresh "succeeds" but the gateway still says 401: exactly one retry, then reauth.
    token = "stale";
    refresh.mockImplementation(async () => true);
    await expect(fetchJSON("/api/status")).rejects.toThrow(/^401/);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(onReauth).toHaveBeenCalledTimes(1);
    window.removeEventListener(REAUTH_EVENT, onReauth);
  });

  it("logout on a remote target only announces reauth", async () => {
    setBackendTarget(REMOTE);
    const fetchMock = jsonFetchMock({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const onReauth = vi.fn();
    window.addEventListener(REAUTH_EVENT, onReauth);

    await api.logout();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onReauth).toHaveBeenCalledTimes(1);
    window.removeEventListener(REAUTH_EVENT, onReauth);
  });
});
