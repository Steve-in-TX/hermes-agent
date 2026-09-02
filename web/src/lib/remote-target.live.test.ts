/**
 * Live check of the remote-target seam against a real gateway — the same
 * ``api.ts`` code path the Android app uses, run from Node (which, like the
 * native transport, is outside CORS). Skipped unless HERMES_LIVE_GATEWAY and
 * HERMES_LIVE_TOKEN are set:
 *
 *   HERMES_LIVE_GATEWAY=http://192.168.1.86:9137 \
 *   HERMES_LIVE_TOKEN="$(apps/mobile/scripts/mint-token.sh http://192.168.1.86:9137 user pass)" \
 *     npx vitest run src/lib/remote-target.live.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, buildWsUrl, getWsTicket } from "./api";
import { normalizeGatewayUrl, setBackendTarget } from "./backend-target";

const GATEWAY = process.env.HERMES_LIVE_GATEWAY ?? "";
const TOKEN = process.env.HERMES_LIVE_TOKEN ?? "";

describe.skipIf(!GATEWAY || !TOKEN)("remote target against a live gateway", () => {
  beforeAll(() => {
    const { origin, basePath } = normalizeGatewayUrl(GATEWAY);
    setBackendTarget({ origin, basePath, bearer: () => TOKEN });
  });
  afterAll(() => setBackendTarget(null));

  it("lists sessions with the bearer (what SessionsPage renders)", async () => {
    const page = await api.getSessions(5, 0);
    expect(Array.isArray(page.sessions)).toBe(true);
  });

  it("identifies the bearer's user", async () => {
    const me = await api.getAuthMe();
    expect(me.user_id).toBeTruthy();
  });

  it("mints a ws ticket and the gateway socket answers with gateway.ready", async () => {
    const { ticket } = await getWsTicket();
    expect(ticket).toBeTruthy();
    const url = await buildWsUrl("/api/ws");
    expect(url.startsWith(GATEWAY.replace(/^http/, "ws"))).toBe(true);

    const first = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error("no frame within 10s")), 10_000);
      ws.addEventListener("message", (ev) => {
        clearTimeout(timer);
        ws.close();
        resolve(String(ev.data));
      });
      ws.addEventListener("error", () => reject(new Error("socket error")));
      ws.addEventListener("close", (ev) => {
        if (ev.code !== 1000 && ev.code !== 1005) reject(new Error(`closed ${ev.code}`));
      });
    });
    expect(first).toContain('"gateway.ready"');
  });

  it("rejects a bad bearer with 401 (no navigation, plain error)", async () => {
    const { origin, basePath } = normalizeGatewayUrl(GATEWAY);
    setBackendTarget({ origin, basePath, bearer: () => "not-a-token" });
    await expect(api.getAuthMe()).rejects.toThrow(/^401/);
    setBackendTarget({ origin, basePath, bearer: () => TOKEN });
  });
});
