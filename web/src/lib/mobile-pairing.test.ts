import { describe, expect, it } from "vitest";

import { decodePairingPayload, encodePairingPayload, gatewayKey } from "@hermes/shared";

describe("pairing payload", () => {
  it("round-trips origin, base path, and name", () => {
    const text = encodePairingPayload({ origin: "https://gw.example:9119", basePath: "hermes/", name: "  studio  " });
    expect(text.startsWith("hermes-gateway:")).toBe(true);
    expect(decodePairingPayload(text)).toEqual({ v: 1, origin: "https://gw.example:9119", basePath: "/hermes", name: "studio" });
  });

  it("never carries credentials and drops query/fragment", () => {
    const text = encodePairingPayload({ origin: "http://10.0.0.5:9119", basePath: "/?token=x#y" });
    expect(text).not.toContain("token");
    expect(decodePairingPayload(text)).toEqual({ v: 1, origin: "http://10.0.0.5:9119", basePath: "" });
  });

  it("accepts a bare gateway URL as a fallback", () => {
    expect(decodePairingPayload("https://gw.example/prefix/")).toEqual({ v: 1, origin: "https://gw.example", basePath: "/prefix" });
  });

  it.each([
    "hermes-gateway:not json",
    'hermes-gateway:{"v":2,"origin":"https://x"}',
    'hermes-gateway:{"v":1,"origin":"ftp://x"}',
    "ftp://gw.example",
    "just some text",
    "",
  ])("rejects %j", (input) => {
    expect(decodePairingPayload(input)).toBeNull();
  });

  it("refuses to encode a non-http origin", () => {
    expect(() => encodePairingPayload({ origin: "ws://gw" })).toThrow();
  });

  it("gateway keys normalise slashes", () => {
    expect(gatewayKey("https://gw.example/", "prefix/")).toBe("https://gw.example/prefix");
    expect(gatewayKey("https://gw.example", "")).toBe("https://gw.example");
  });
});
