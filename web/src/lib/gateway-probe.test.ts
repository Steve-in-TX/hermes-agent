import { describe, expect, it, vi } from "vitest";

import { probeGatewayStatus, verifyGatewayBearer } from "./gateway-probe";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function respond(status: number, body: unknown) {
  return vi.fn<FetchLike>(async () => new Response(JSON.stringify(body), { status }));
}

describe("probeGatewayStatus", () => {
  it("hits the public status route without credentials", async () => {
    const fetchImpl = respond(200, {
      version: "0.21.0",
      auth_required: true,
      auth_flows: ["cookie", "native_pkce"],
    });
    const status = await probeGatewayStatus("https://gw:9119", "/hermes", fetchImpl);
    expect(status.auth_flows).toContain("native_pkce");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://gw:9119/hermes/api/status",
      expect.objectContaining({ method: "GET", credentials: "omit" }),
    );
  });

  it("refuses a loopback gateway with no auth gate (the app can never sign in)", async () => {
    await expect(
      probeGatewayStatus("http://127.0.0.1:9119", "", respond(200, { auth_required: false })),
    ).rejects.toThrow(/loopback/);
  });

  it("reports a non-2xx status", async () => {
    await expect(probeGatewayStatus("https://gw", "", respond(502, {}))).rejects.toThrow(/502/);
  });
});

describe("verifyGatewayBearer", () => {
  it("sends the bearer and returns the identity", async () => {
    const fetchImpl = respond(200, { user_id: "steve", provider: "basic" });
    await expect(verifyGatewayBearer("https://gw", "", "tok", fetchImpl)).resolves.toEqual({
      user_id: "steve",
      provider: "basic",
    });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(init.credentials).toBe("omit");
  });

  it("distinguishes a rejected token from other failures", async () => {
    await expect(verifyGatewayBearer("https://gw", "", "bad", respond(401, {}))).rejects.toThrow(
      /rejected/,
    );
    await expect(verifyGatewayBearer("https://gw", "", "tok", respond(500, {}))).rejects.toThrow(
      /500/,
    );
  });
});
