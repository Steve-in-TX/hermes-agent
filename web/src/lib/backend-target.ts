/**
 * Backend target — WHERE the dashboard's ``/api/...`` calls go.
 *
 * Default (browser dashboard): same origin, the path prefix the server injects
 * into ``window.__HERMES_BASE_PATH__``, no bearer. This is byte-identical to
 * the pre-seam behaviour: ``resolveUrl("/api/x")`` is ``"<basePath>/api/x"``.
 *
 * Remote (the Android app, later any bundled client): an absolute origin, the
 * gateway's own path prefix, and a bearer token minted by the gateway's
 * RFC 8252 native flow. Nothing is injected into ``window`` in that mode —
 * the bundle never loads from the gateway — so everything comes from here.
 *
 * ``api.ts`` is the only consumer that should build URLs; the ~130 endpoint
 * wrappers there keep passing dashboard-relative paths and never see this.
 */

export interface BackendTarget {
  /** Absolute origin such as ``"https://gw.example:9119"``, or ``""`` for same-origin. */
  origin: string;
  /** ``""`` when served at the root, else ``"/prefix"`` (leading slash, no trailing). */
  basePath: string;
  /** Bearer for remote targets; ``null`` in the browser dashboard. */
  bearer: () => string | null;
  /**
   * Try to obtain a fresh bearer after a 401. Resolves ``true`` when
   * ``bearer()`` now returns a new credential worth retrying with; ``false``
   * (never throws) when the session is gone or the refresh could not run.
   */
  refresh?: () => Promise<boolean>;
}

export interface RemoteBackendTarget {
  origin: string;
  basePath?: string;
  bearer: () => string | null;
  refresh?: () => Promise<boolean>;
}

/** Window event fired when a remote target's credential is rejected or dropped. */
export const REAUTH_EVENT = "hermes:reauth-required";

export interface ReauthDetail {
  reason: "unauthorized" | "logout";
}

function normalizeBasePath(raw: string | undefined): string {
  if (!raw) return "";
  const withLead = raw.startsWith("/") ? raw : `/${raw}`;
  return withLead.replace(/\/+$/, "");
}

/**
 * The server-injected path prefix for a reverse-proxied dashboard. Empty when
 * the SPA is served at the root or when there is no server at all (bundled
 * client, SSR, tests).
 */
export function readInjectedBasePath(): string {
  if (typeof window === "undefined") return "";
  const raw =
    (window as { __HERMES_BASE_PATH__?: string }).__HERMES_BASE_PATH__ ?? "";
  return normalizeBasePath(raw);
}

function defaultTarget(): BackendTarget {
  return { origin: "", basePath: readInjectedBasePath(), bearer: () => null };
}

let current: BackendTarget = defaultTarget();

export function getBackendTarget(): BackendTarget {
  return current;
}

/**
 * Point the API layer at a remote gateway, or back at the default
 * (``null``). Idempotent; the origin is normalised so ``resolveUrl`` can
 * concatenate without producing ``//``.
 */
export function setBackendTarget(target: RemoteBackendTarget | null): void {
  if (target === null) {
    current = defaultTarget();
    return;
  }
  current = {
    origin: target.origin.replace(/\/+$/, ""),
    basePath: normalizeBasePath(target.basePath),
    bearer: target.bearer,
    refresh: target.refresh,
  };
}

export function isRemoteTarget(): boolean {
  return current.origin !== "";
}

/** Dashboard-relative path (``"/api/x?y=1"``) → the URL to actually fetch. */
export function resolveUrl(path: string): string {
  return `${current.origin}${current.basePath}${path}`;
}

/**
 * ``host`` / ``protocol`` overrides for ``buildHermesWebSocketUrl`` when the
 * target is remote; ``null`` for the default target (the helper then reads
 * ``window.location`` exactly as before).
 */
export function remoteWsLocation(): { host: string; protocol: string } | null {
  if (!isRemoteTarget()) return null;
  const parsed = new URL(current.origin);
  return { host: parsed.host, protocol: parsed.protocol };
}

/**
 * Parse what a person types into a "gateway URL" field. Accepts a bare
 * ``host[:port]`` (assumed ``http://`` — LAN and Tailscale gateways are
 * plain HTTP, and the desktop makes the same assumption) or a full URL whose
 * path becomes the base prefix. Query and fragment are dropped.
 */
export function normalizeGatewayUrl(input: string): { origin: string; basePath: string } {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter the gateway URL.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error("That does not look like a URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Gateway URLs must start with http:// or https://.");
  }
  return { origin: parsed.origin, basePath: normalizeBasePath(parsed.pathname) };
}

/**
 * True for a plain-http gateway that is not loopback. Phones reach these
 * over LAN/Tailscale, but HTTPS-only browsers interpose a security
 * interstitial at sign-in and the bearer travels unencrypted on the wire.
 */
export function isCleartextOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && !["127.0.0.1", "::1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** Announce that the remote credential is no longer usable. */
export function dispatchReauthRequired(reason: ReauthDetail["reason"]): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent<ReauthDetail>(REAUTH_EVENT, { detail: { reason } }));
}
