/**
 * Native sign-in bridge — the JS contract for the Android ``HermesAuth``
 * plugin (RFC 8252: system browser + PKCE + loopback/scheme redirect, tokens
 * in an encrypted store, refresh).
 *
 * The bridge is injected: the mobile build installs the Capacitor-backed one
 * (``native-auth-capacitor.ts``); everywhere else the "unavailable" bridge
 * makes sign-in fail with a clear message and lets tests substitute fakes.
 *
 * JS only ever sees the access token. The refresh token stays native.
 */

export interface NativeSession {
  origin: string;
  basePath: string;
  accessToken: string;
  /** Unix seconds; ``0`` when unknown. */
  expiresAt: number;
  userId: string;
  provider: string;
}

export type NativeAuthErrorCode = "session_expired" | "unavailable" | "cancelled" | "failed";

export class NativeAuthError extends Error {
  readonly code: NativeAuthErrorCode;

  constructor(code: NativeAuthErrorCode, message: string) {
    super(message);
    this.name = "NativeAuthError";
    this.code = code;
  }
}

export type RedirectMode = "loopback" | "scheme";

export interface NativeLoginOptions {
  origin: string;
  basePath: string;
  provider?: string;
  redirectMode: RedirectMode;
}

export interface NativeAuthBridge {
  /** False in a plain browser: there is no system-browser flow to run. */
  readonly available: boolean;
  getSession(): Promise<NativeSession | null>;
  login(opts: NativeLoginOptions): Promise<NativeSession>;
  /** Rejects with ``NativeAuthError`` ``session_expired`` (store wiped) or ``unavailable`` (kept). */
  refresh(): Promise<NativeSession>;
  /** Manual path: keep a pasted token in the same encrypted store. */
  setSession(session: NativeSession): Promise<NativeSession>;
  logout(): Promise<void>;
}

const NOT_HERE = "Native sign-in is only available in the Hermes app.";

export const unavailableAuthBridge: NativeAuthBridge = {
  available: false,
  getSession: async () => null,
  login: async () => {
    throw new NativeAuthError("unavailable", NOT_HERE);
  },
  refresh: async () => {
    throw new NativeAuthError("unavailable", NOT_HERE);
  },
  setSession: async (session) => session,
  logout: async () => {},
};

let bridge: NativeAuthBridge = unavailableAuthBridge;

export function setNativeAuthBridge(next: NativeAuthBridge | null): void {
  bridge = next ?? unavailableAuthBridge;
}

export function getNativeAuthBridge(): NativeAuthBridge {
  return bridge;
}

/** ``/api/status`` ``auth_flows`` ids (see ``hermes_cli/web_server.py``). */
export const NATIVE_PKCE_FLOW_ID = "native_pkce";
export const NATIVE_SCHEME_FLOW_ID = "native_app_scheme";

/** True when the gateway can broker a native sign-in at all. */
export function gatewaySupportsNativeLogin(authFlows: readonly string[] | undefined): boolean {
  return Array.isArray(authFlows) && authFlows.includes(NATIVE_PKCE_FLOW_ID);
}

/**
 * Prefer the app's private-use scheme when the gateway accepts it (no
 * listener to run, works when the browser is in a separate profile); fall
 * back to the loopback listener every gateway supports.
 */
export function chooseRedirectMode(authFlows: readonly string[] | undefined): RedirectMode {
  return Array.isArray(authFlows) && authFlows.includes(NATIVE_SCHEME_FLOW_ID) ? "scheme" : "loopback";
}

/**
 * Seconds before ``expiresAt`` at which a proactive refresh runs. Matches the
 * plan's 120s so the token never expires mid-request on a slow radio.
 */
export const REFRESH_SKEW_SECONDS = 120;

/** When the next proactive refresh should fire, in ms from now (never negative). */
export function refreshDelayMs(expiresAt: number, nowMs: number = Date.now()): number | null {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;
  return Math.max(0, (expiresAt - REFRESH_SKEW_SECONDS) * 1000 - nowMs);
}
