/**
 * Pre-connection probes for the mobile connection screen. These deliberately
 * bypass ``api.ts`` (which targets the *current* backend) so a candidate
 * gateway can be tested before it is committed as the target.
 */
import { driverFetch } from "@/lib/transport/http-driver";

export interface GatewayStatusProbe {
  version?: string;
  auth_required?: boolean;
  auth_flows?: string[];
  auth_providers?: string[];
}

export interface GatewayIdentity {
  user_id: string;
  provider: string;
  display_name?: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Public ``GET /api/status`` — reachable without credentials. */
export async function probeGatewayStatus(
  origin: string,
  basePath: string,
  fetchImpl: FetchLike = driverFetch,
): Promise<GatewayStatusProbe> {
  const res = await fetchImpl(`${origin}${basePath}/api/status`, {
    method: "GET",
    credentials: "omit",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Gateway answered HTTP ${res.status} on /api/status.`);
  }
  const body = (await res.json()) as GatewayStatusProbe;
  if (body.auth_required === false) {
    throw new Error(
      "This gateway is bound to loopback and has no auth gate; the app cannot sign in to it. Bind it to a reachable address (hermes serve --host …).",
    );
  }
  return body;
}

/** ``GET /api/auth/me`` with a bearer — proves the token before saving it. */
export async function verifyGatewayBearer(
  origin: string,
  basePath: string,
  token: string,
  fetchImpl: FetchLike = driverFetch,
): Promise<GatewayIdentity> {
  const res = await fetchImpl(`${origin}${basePath}/api/auth/me`, {
    method: "GET",
    credentials: "omit",
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    throw new Error("The gateway rejected that token.");
  }
  if (!res.ok) {
    throw new Error(`Gateway answered HTTP ${res.status} on /api/auth/me.`);
  }
  return (await res.json()) as GatewayIdentity;
}
