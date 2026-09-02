/**
 * ``NativeAuthBridge`` on the Android ``HermesAuth`` Capacitor plugin. Only
 * the mobile build ever executes the dynamic import; the ``__HERMES_TARGET__``
 * guard keeps ``@capacitor/core`` out of the browser bundle.
 */
import { NativeAuthError, setNativeAuthBridge, type NativeAuthBridge, type NativeSession } from "./native-auth";
import { isCapacitorNative } from "./transport";

interface HermesAuthPlugin {
  getSession(): Promise<{ session: NativeSession | null }>;
  login(opts: {
    origin: string;
    basePath: string;
    provider?: string;
    redirectMode: "loopback" | "scheme";
  }): Promise<{ session: NativeSession }>;
  refresh(): Promise<{ session: NativeSession }>;
  setSession(session: NativeSession & { refreshToken?: string }): Promise<{ session: NativeSession }>;
  logout(): Promise<void>;
  listSessions(): Promise<{ sessions: NativeSession[] }>;
  switchSession(opts: { origin: string; basePath: string }): Promise<{ session: NativeSession | null }>;
  removeSession(opts: { origin: string; basePath: string }): Promise<void>;
}

/** Capacitor rejections carry ``{ message, code }``; map them to ``NativeAuthError``. */
function toAuthError(err: unknown): NativeAuthError {
  if (err instanceof NativeAuthError) return err;
  const rec = (typeof err === "object" && err !== null ? err : {}) as { code?: unknown; message?: unknown };
  const code = rec.code;
  const known: NativeAuthError["code"] =
    code === "session_expired" || code === "unavailable" || code === "cancelled" ? code : "failed";
  return new NativeAuthError(known, typeof rec.message === "string" ? rec.message : String(err));
}

export function createCapacitorAuthBridge(plugin: HermesAuthPlugin): NativeAuthBridge {
  const wrap = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      throw toAuthError(err);
    }
  };
  return {
    available: true,
    getSession: () => wrap(async () => (await plugin.getSession()).session ?? null),
    login: (opts) => wrap(async () => (await plugin.login(opts)).session),
    refresh: () => wrap(async () => (await plugin.refresh()).session),
    setSession: (session) => wrap(async () => (await plugin.setSession(session)).session),
    logout: () => wrap(() => plugin.logout()),
    listSessions: () => wrap(async () => (await plugin.listSessions()).sessions ?? []),
    switchSession: (origin, basePath) => wrap(async () => (await plugin.switchSession({ origin, basePath })).session ?? null),
    removeSession: (origin, basePath) => wrap(() => plugin.removeSession({ origin, basePath })),
  };
}

export async function installNativeAuthIfAvailable(): Promise<boolean> {
  if (typeof __HERMES_TARGET__ === "undefined" || __HERMES_TARGET__ !== "mobile") {
    return false;
  }
  if (!isCapacitorNative()) return false;
  const { registerPlugin } = await import("@capacitor/core");
  setNativeAuthBridge(createCapacitorAuthBridge(registerPlugin<HermesAuthPlugin>("HermesAuth")));
  return true;
}
