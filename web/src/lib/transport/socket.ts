/**
 * WebSocket factory seam — the socket counterpart of ``http-driver.ts``.
 *
 * Every dashboard WebSocket (``/api/ws`` via ``GatewayClient``, ``/api/events``,
 * ``/api/pty``, ``/api/console``) is opened through ``openDashboardWebSocket``
 * so a bundled client can substitute a native socket. The browser dashboard
 * gets ``new WebSocket(url)`` exactly as before.
 *
 * ``JsonRpcGatewayClient`` already exposes a ``socketFactory`` option; the web
 * ``GatewayClient`` wires ``getSocketFactory()`` into it.
 */
export type SocketFactory = (url: string) => WebSocket;

export const browserSocketFactory: SocketFactory = (url) => new WebSocket(url);

let active: SocketFactory | null = null;

/** Install a factory, or ``null`` to restore the browser default. */
export function setSocketFactory(factory: SocketFactory | null): void {
  active = factory;
}

/**
 * The installed factory, or ``undefined`` when the platform default applies
 * — shaped for ``GatewayClientOptions.socketFactory``.
 */
export function getSocketFactory(): SocketFactory | undefined {
  return active ?? undefined;
}

export function openDashboardWebSocket(url: string): WebSocket {
  return (active ?? browserSocketFactory)(url);
}
