/**
 * HTTP driver seam.
 *
 * ``api.ts`` never calls ``fetch`` directly; it calls ``driverFetch``. In the
 * browser dashboard the driver is the platform ``fetch`` (looked up lazily so
 * tests that stub ``globalThis.fetch`` keep working). In the Android app the
 * driver is swapped for one backed by the native OkHttp plugin, because the
 * gateway's CORS configuration refuses the WebView origin — see
 * ``apps/mobile/spikes/m0/README.md``.
 *
 * Deliberately NOT ``CapacitorHttp``'s global ``window.fetch`` patch: that
 * monkey-patches every fetch app-wide and its ``Response`` shim cannot carry
 * blobs or ``FormData``, both of which the dashboard uses.
 */
export interface HttpDriver {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export const browserHttpDriver: HttpDriver = {
  fetch: (url, init) => globalThis.fetch(url, init),
};

let active: HttpDriver = browserHttpDriver;

/** Install a driver, or ``null`` to restore the browser default. */
export function setHttpDriver(driver: HttpDriver | null): void {
  active = driver ?? browserHttpDriver;
}

export function getHttpDriver(): HttpDriver {
  return active;
}

export function driverFetch(url: string, init?: RequestInit): Promise<Response> {
  return active.fetch(url, init);
}
