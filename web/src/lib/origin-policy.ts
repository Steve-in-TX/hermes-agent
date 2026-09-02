/**
 * Transport policy for a gateway origin.
 *
 * - ``https``      encrypted; no caveat.
 * - ``loopback``   127.0.0.1 / ::1 / localhost — never usable by the app
 *                  (no auth gate), reported so the UI can say why.
 * - ``private-http`` plain http to a private/CGNAT/link-local/ULA address, a
 *                  `.local` name, or a Tailscale `.ts.net` name: expected for
 *                  LAN and tailnet gateways; warn, don't block.
 * - ``public-http`` plain http to anything else: the bearer would cross the
 *                  internet in the clear. The UI requires an explicit
 *                  acknowledgement before signing in.
 */
export type OriginClass = "https" | "loopback" | "private-http" | "public-http";

const PRIVATE_V4 = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64/10 (Tailscale)
  /^169\.254\./, // link-local
];

function isPrivateHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".ts.net") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true;
  if (!h.includes(".") && !h.includes(":")) return true; // bare single-label LAN name
  if (PRIVATE_V4.some((re) => re.test(h))) return true;
  // IPv6 ULA fc00::/7 and link-local fe80::/10
  if (/^f[cd][0-9a-f]{2}:/i.test(h) || /^fe[89ab][0-9a-f]:/i.test(h)) return true;
  return false;
}

function isLoopbackHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "::1" || h === "localhost" || /^127\./.test(h);
}

export function classifyOrigin(origin: string): OriginClass | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol === "https:") return "https";
  if (url.protocol !== "http:") return null;
  if (isLoopbackHostname(url.hostname)) return "loopback";
  return isPrivateHostname(url.hostname) ? "private-http" : "public-http";
}

/** Copy for the connection screen, or null when nothing needs saying. */
export function originCaveat(cls: OriginClass | null): string | null {
  switch (cls) {
    case "private-http":
      return "Plain http on a private network: fine on a trusted LAN or tailnet. The sign-in browser may still show a security warning.";
    case "public-http":
      return "Plain http to a public address: your sign-in and access token would cross the internet unencrypted. Put the gateway behind TLS, or acknowledge the risk to continue.";
    case "loopback":
      return "That is the phone's own loopback address. Enter the gateway's LAN, tailnet, or public address instead.";
    default:
      return null;
  }
}
