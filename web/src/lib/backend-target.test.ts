// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  REAUTH_EVENT,
  dispatchReauthRequired,
  getBackendTarget,
  isCleartextOrigin,
  isRemoteTarget,
  normalizeGatewayUrl,
  remoteWsLocation,
  resolveUrl,
  setBackendTarget,
} from "./backend-target";

afterEach(() => {
  setBackendTarget(null);
});

describe("backend target", () => {
  it("defaults to same-origin with no bearer (browser dashboard)", () => {
    expect(isRemoteTarget()).toBe(false);
    expect(resolveUrl("/api/status")).toBe("/api/status");
    expect(getBackendTarget().bearer()).toBeNull();
    expect(remoteWsLocation()).toBeNull();
  });

  it("resolves absolute URLs for a remote target and normalises slashes", () => {
    setBackendTarget({
      origin: "https://gw.example:9119/",
      basePath: "hermes/",
      bearer: () => "tok",
    });
    expect(isRemoteTarget()).toBe(true);
    expect(resolveUrl("/api/status")).toBe("https://gw.example:9119/hermes/api/status");
    expect(getBackendTarget().bearer()).toBe("tok");
    expect(remoteWsLocation()).toEqual({ host: "gw.example:9119", protocol: "https:" });
  });

  it("resets to the default when cleared", () => {
    setBackendTarget({ origin: "http://10.0.0.5:9119", bearer: () => "tok" });
    setBackendTarget(null);
    expect(isRemoteTarget()).toBe(false);
    expect(resolveUrl("/api/x")).toBe("/api/x");
  });
});

describe("normalizeGatewayUrl", () => {
  it.each([
    ["https://gw.example/hermes/", "https://gw.example", "/hermes"],
    ["http://10.0.0.5:9119", "http://10.0.0.5:9119", ""],
    ["10.0.0.5:9119", "http://10.0.0.5:9119", ""],
    ["  https://gw.example:9119/?x=1#frag ", "https://gw.example:9119", ""],
    ["gw.tailnet.ts.net/prefix", "http://gw.tailnet.ts.net", "/prefix"],
  ])("%s → origin %s, basePath %s", (input, origin, basePath) => {
    expect(normalizeGatewayUrl(input)).toEqual({ origin, basePath });
  });

  it.each(["", "   ", "ftp://gw.example", "ws://gw.example:9119", "http://"])(
    "rejects %j",
    (input) => {
      expect(() => normalizeGatewayUrl(input)).toThrow();
    },
  );
});

describe("isCleartextOrigin", () => {
  it.each([
    ["http://192.168.1.86:9137", true],
    ["http://gw.tailnet.ts.net", true],
    ["https://gw.example", false],
    ["http://127.0.0.1:9119", false],
    ["http://localhost:9119", false],
    ["not a url", false],
  ])("%s → %s", (origin, expected) => {
    expect(isCleartextOrigin(origin)).toBe(expected);
  });
});

describe("dispatchReauthRequired", () => {
  it("fires a window event with the reason", () => {
    const handler = vi.fn();
    window.addEventListener(REAUTH_EVENT, handler);
    dispatchReauthRequired("logout");
    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual({ reason: "logout" });
    window.removeEventListener(REAUTH_EVENT, handler);
  });
});
