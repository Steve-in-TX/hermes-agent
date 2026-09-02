/**
 * Mobile connection screen (M1: manual URL + pasted bearer token).
 *
 * Rendered standalone when the app has no saved connection, and as the
 * ``/connect`` route inside the layout to inspect or change it. M2 replaces
 * the pasted token with the RFC 8252 sign-in (Custom Tabs + PKCE); M6 adds QR
 * pairing. The probe/verify helpers are already the shape those need.
 */
import { useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@nous-research/ui/ui/components/button";
import { Input } from "@nous-research/ui/ui/components/input";
import { Card, CardContent, CardHeader, CardTitle } from "@nous-research/ui/ui/components/card";

import { normalizeGatewayUrl } from "@/lib/backend-target";
import {
  probeGatewayStatus,
  verifyGatewayBearer,
  type GatewayStatusProbe,
} from "@/lib/gateway-probe";
import { connectTo, disconnect, useMobileConnection } from "@/lib/mobile-connection";

interface ConnectionPageProps {
  /** Full-screen, no layout around it (first run / signed out). */
  standalone?: boolean;
}

function describeProbe(p: GatewayStatusProbe): string {
  const bits: string[] = [];
  if (p.version) bits.push(`Hermes ${p.version}`);
  if (p.auth_providers?.length) bits.push(`auth: ${p.auth_providers.join(", ")}`);
  if (p.auth_flows?.includes("native_pkce")) bits.push("native sign-in supported");
  return bits.join(" · ") || "Gateway reachable.";
}

export default function ConnectionPage({ standalone = false }: ConnectionPageProps) {
  const navigate = useNavigate();
  const connection = useMobileConnection();
  const [url, setUrl] = useState(() =>
    connection ? `${connection.origin}${connection.basePath}` : "",
  );
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"probe" | "connect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<string | null>(null);

  const handleProbe = async () => {
    setError(null);
    setProbe(null);
    setBusy("probe");
    try {
      const { origin, basePath } = normalizeGatewayUrl(url);
      const status = await probeGatewayStatus(origin, basePath);
      setProbe(describeProbe(status));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleConnect = async () => {
    setError(null);
    setBusy("connect");
    try {
      const { origin, basePath } = normalizeGatewayUrl(url);
      const trimmedToken = token.trim();
      if (!trimmedToken) throw new Error("Paste a bearer token.");
      const me = await verifyGatewayBearer(origin, basePath, trimmedToken);
      connectTo({
        origin,
        basePath,
        token: trimmedToken,
        userId: me.user_id,
        provider: me.provider,
      });
      setToken("");
      navigate("/sessions", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleDisconnect = () => {
    disconnect();
    setProbe(null);
    setError(null);
  };

  return (
    <div
      className={
        standalone
          ? "min-h-dvh flex flex-col justify-center px-4 py-8 pt-[calc(2rem+env(safe-area-inset-top,0px))] pb-[calc(2rem+env(safe-area-inset-bottom,0px))]"
          : "max-w-xl"
      }
    >
      <Card>
        <CardHeader>
          <CardTitle>{connection ? "Gateway connection" : "Connect to a Hermes gateway"}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {connection && (
            <div className="text-sm">
              <div>
                Connected to{" "}
                <span className="font-mono">
                  {connection.origin}
                  {connection.basePath}
                </span>
              </div>
              {connection.userId && (
                <div className="opacity-70">
                  as {connection.userId}
                  {connection.provider ? ` (${connection.provider})` : ""}
                </div>
              )}
            </div>
          )}

          <label className="flex flex-col gap-1 text-sm">
            <span>Gateway URL</span>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://gateway.example:9119"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="url"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span>Bearer token</span>
            <Input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste an access token (temporary — sign-in arrives in M2)"
              type="password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>

          {probe && <div className="text-sm text-green-600 dark:text-green-400">{probe}</div>}
          {error && (
            <div role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void handleProbe()} disabled={busy !== null}>
              {busy === "probe" ? "Testing…" : "Test connection"}
            </Button>
            <Button onClick={() => void handleConnect()} disabled={busy !== null}>
              {busy === "connect" ? "Connecting…" : "Connect"}
            </Button>
            {connection && (
              <Button onClick={handleDisconnect} disabled={busy !== null}>
                Disconnect
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
