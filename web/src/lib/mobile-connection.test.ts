// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { REAUTH_EVENT, isRemoteTarget, resolveUrl, getBackendTarget } from "./backend-target";
import {
  CONNECTION_STORAGE_KEY,
  applyConnection,
  bootstrapMobileConnection,
  clearSavedConnection,
  connectTo,
  disconnect,
  getCurrentConnection,
  loadSavedConnection,
  saveConnection,
} from "./mobile-connection";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

const CONN = {
  origin: "https://gw.example:9119",
  basePath: "/hermes",
  token: "tok-1",
  userId: "steve",
  provider: "basic",
};

afterEach(() => {
  disconnect();
  window.localStorage.clear();
});

describe("saved connection storage", () => {
  it("round-trips through storage", () => {
    const store = memoryStorage();
    saveConnection(CONN, store);
    expect(loadSavedConnection(store)).toEqual(CONN);
    clearSavedConnection(store);
    expect(loadSavedConnection(store)).toBeNull();
  });

  it.each([
    ["garbage", "not json"],
    ["missing token", JSON.stringify({ origin: "https://x" })],
    ["empty origin", JSON.stringify({ origin: "", token: "t" })],
    ["wrong types", JSON.stringify({ origin: 1, token: 2 })],
  ])("ignores %s", (_label, raw) => {
    expect(loadSavedConnection(memoryStorage({ [CONNECTION_STORAGE_KEY]: raw }))).toBeNull();
  });
});

describe("applying a connection", () => {
  it("points the backend target at the gateway with the bearer", () => {
    applyConnection(CONN);
    expect(isRemoteTarget()).toBe(true);
    expect(resolveUrl("/api/status")).toBe("https://gw.example:9119/hermes/api/status");
    expect(getBackendTarget().bearer()).toBe("tok-1");
    expect(getCurrentConnection()).toEqual(CONN);
  });

  it("connectTo persists and disconnect wipes", () => {
    connectTo(CONN);
    expect(loadSavedConnection()).toEqual(CONN);
    disconnect();
    expect(loadSavedConnection()).toBeNull();
    expect(isRemoteTarget()).toBe(false);
    expect(getCurrentConnection()).toBeNull();
  });
});

describe("bootstrapMobileConnection", () => {
  it("restores the saved connection and drops it on a reauth event", () => {
    saveConnection(CONN);
    expect(bootstrapMobileConnection()).toEqual(CONN);
    expect(isRemoteTarget()).toBe(true);

    window.dispatchEvent(new CustomEvent(REAUTH_EVENT, { detail: { reason: "unauthorized" } }));

    expect(getCurrentConnection()).toBeNull();
    expect(isRemoteTarget()).toBe(false);
    expect(loadSavedConnection()).toBeNull();
  });

  it("returns null with nothing saved", () => {
    expect(bootstrapMobileConnection()).toBeNull();
    expect(isRemoteTarget()).toBe(false);
  });
});
