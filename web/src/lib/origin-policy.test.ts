import { describe, expect, it } from "vitest";

import { classifyOrigin, originCaveat } from "./origin-policy";

describe("classifyOrigin", () => {
  it.each([
    ["https://gw.example", "https"],
    ["https://192.168.1.86:9137", "https"],
    ["http://127.0.0.1:9119", "loopback"],
    ["http://localhost:9119", "loopback"],
    ["http://[::1]:9119", "loopback"],
    ["http://192.168.1.86:9137", "private-http"],
    ["http://10.0.0.5", "private-http"],
    ["http://172.20.3.4:9119", "private-http"],
    ["http://100.89.248.62:9119", "private-http"],
    ["http://studio.tailnet.ts.net", "private-http"],
    ["http://nas.local:9119", "private-http"],
    ["http://studio:9119", "private-http"],
    ["http://[fd7a:115c:a1e0::1]:9119", "private-http"],
    ["http://203.0.113.9:9119", "public-http"],
    ["http://gateway.example.com", "public-http"],
    ["http://172.32.0.1", "public-http"],
    ["http://100.128.0.1", "public-http"],
    ["ftp://x", null],
    ["nope", null],
  ])("%s → %s", (origin, expected) => {
    expect(classifyOrigin(origin)).toBe(expected);
  });
});

describe("originCaveat", () => {
  it("says nothing for https and warns in proportion otherwise", () => {
    expect(originCaveat("https")).toBeNull();
    expect(originCaveat("private-http")).toMatch(/private network/);
    expect(originCaveat("public-http")).toMatch(/unencrypted/);
    expect(originCaveat("loopback")).toMatch(/loopback/);
    expect(originCaveat(null)).toBeNull();
  });
});
