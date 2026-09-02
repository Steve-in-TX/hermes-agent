/**
 * Browser WebSocket client for the tui_gateway JSON-RPC protocol.
 *
 * Speaks the exact same newline-delimited JSON-RPC dialect that the Ink TUI
 * drives over stdio. The server-side transport abstraction
 * (tui_gateway/transport.py + ws.py) routes the same dispatcher's writes
 * onto either stdout or a WebSocket depending on how the client connected.
 *
 *   const gw = new GatewayClient()
 *   await gw.connect()
 *   const { session_id } = await gw.request<{ session_id: string }>("session.create")
 *   gw.on("message.delta", (ev) => console.log(ev.payload?.text))
 *   await gw.request("prompt.submit", { session_id, text: "hi" })
 */

import {
  JsonRpcGatewayClient,
  buildHermesWebSocketUrl,
  type ConnectionState,
  type GatewayEvent,
  type GatewayEventName,
} from "@hermes/shared";

import { buildWsAuthParam } from "@/lib/api";
import { getBackendTarget, remoteWsLocation } from "@/lib/backend-target";
import { maybeReloadForLoopbackWsAuthFailure } from "@/lib/dashboard-auth-reload";
import { getSocketFactory } from "@/lib/transport/socket";

export type { ConnectionState, GatewayEvent, GatewayEventName };

export class GatewayClient extends JsonRpcGatewayClient {
  constructor() {
    super({
      closedErrorMessage: "WebSocket closed",
      connectErrorMessage: "WebSocket connection failed",
      notConnectedErrorMessage: "gateway not connected",
      onSocketClose: (event) => maybeReloadForLoopbackWsAuthFailure(event.code),
      requestIdPrefix: "w",
      // Native socket in the Android shell; undefined → platform WebSocket.
      socketFactory: getSocketFactory(),
    });
  }

  async connect(token?: string): Promise<void> {
    if (this.connectionState === "open" || this.connectionState === "connecting") {
      return;
    }

    // Gated mode: legacy ``?token=`` is rejected by ``_ws_auth_ok``; the SPA
    // must fetch a single-use ticket. Explicit ``token`` keeps the test-only
    // override path.
    const authParam = token ? (["token", token] as const) : await buildWsAuthParam();
    if (!authParam[1]) {
      throw new Error(
        "Session token not available — page must be served by the Hermes dashboard server",
      );
    }

    await super.connect(
      buildHermesWebSocketUrl({
        authParam,
        basePath: getBackendTarget().basePath,
        path: "/api/ws",
        ...(remoteWsLocation() ?? {}),
      }),
    );
  }
}
