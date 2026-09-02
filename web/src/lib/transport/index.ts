/**
 * Transport selection. The browser dashboard never changes: ``fetch`` and
 * ``new WebSocket``. The mobile build swaps both for the native OkHttp
 * plugins when it is actually running inside the Capacitor shell.
 *
 * The ``__HERMES_TARGET__`` check is a build-time constant (vite ``define``),
 * so the dynamic import — and ``@capacitor/core`` with it — is dead code in
 * the browser bundle and never emitted as a chunk.
 */
import { setHttpDriver } from "./http-driver";
import { setSocketFactory } from "./socket";

export { driverFetch, getHttpDriver, setHttpDriver } from "./http-driver";
export { getSocketFactory, openDashboardWebSocket, setSocketFactory } from "./socket";

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
}

/** True when the page is hosted by a Capacitor native shell (not a browser). */
export function isCapacitorNative(): boolean {
  const cap = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  return !!cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform();
}

/**
 * Install the native transport when running inside the Android shell.
 * Resolves ``true`` when installed, ``false`` when the platform default
 * stays in place.
 */
export async function installNativeTransportIfAvailable(): Promise<boolean> {
  if (typeof __HERMES_TARGET__ === "undefined" || __HERMES_TARGET__ !== "mobile") {
    return false;
  }
  if (!isCapacitorNative()) return false;
  const native = await import("./capacitor");
  setHttpDriver(native.createCapacitorHttpDriver());
  setSocketFactory(native.createCapacitorSocketFactory());
  return true;
}
