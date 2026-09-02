/**
 * Mobile connection screen.
 *
 * Primary path (M2): gateway URL → probe public ``/api/status`` → RFC 8252
 * sign-in in the system browser via the native bridge → connected.
 * Fallback: paste an access token (kept for gateways without the native
 * flow and for testing without a browser). M6 adds QR pairing on top.
 */
import { useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@nous-research/ui/ui/components/button";
import { Input } from "@nous-research/ui/ui/components/input";
import { Card, CardContent, CardHeader, CardTitle } from "@nous-research/ui/ui/components/card";

import { isCleartextOrigin, normalizeGatewayUrl } from "@/lib/backend-target";
import {
  probeGatewayStatus,
  verifyGatewayBearer,
  type GatewayStatusProbe,
} from "@/lib/gateway-probe";
import {
  connectWithToken,
  disconnect,
  signIn,
  useMobileConnection,
} from "@/lib/mobile-connection";
import {
  NativeAuthError,
  chooseRedirectMode,
  gatewaySupportsNativeLogin,
  getNativeAuthBridge,
} from "@/lib/native-auth";

interface ConnectionPageProps {
  /** Full-screen, no layout around it (first run / signed out). */
  standalone?: boolean;
}

function describeProbe(p: GatewayStatusProbe): string {
  const bits: string[] = [];
  if (p.version) bits.push(`Hermes ${p.version}`);
  if (p.auth_providers?.length) bits.push(`auth: ${p.auth_providers.join(", ")}`);
  bits.push(gatewaySupportsNativeLogin(p.auth_flows) ? "sign-in supported" : "no native sign-in (paste a token)");
  return bits.join(" · ");
}

function describeError(err: unknown): string {
  if (err instanceof NativeAuthError) {
    switch (err.code) {
      case "cancelled":
        return "Sign-in was cancelled.";
      case "session_expired":
        return "The session has expired. Sign in again.";
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

export default function ConnectionPage({ standalone = false }: ConnectionPageProps) {
  const navigate = useNavigate();
  const connection = useMobileConnection();
  const nativeAvailable = getNativeAuthBridge().available;
  const [url, setUrl] = useState(() =>
    connection ? `${connection.origin}${connection.basePath}` : "",
  );
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState<"probe" | "signin" | "token" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<string | null>(null);
  const cleartext = (() => {
    try {
      return isCleartextOrigin(normalizeGatewayUrl(url).origin);
    } catch {
      return false;
    }
  })();

  const handleProbe = async () => {
    setError(null);
    setProbe(null);
    setBusy("probe");
    try {
      const { origin, basePath } = normalizeGatewayUrl(url);
      const status = await probeGatewayStatus(origin, basePath);
      setProbe(describeProbe(status));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleSignIn = async () => {
    setError(null);
    setBusy("signin");
    try {
      const { origin, basePath } = normalizeGatewayUrl(url);
      const status = await probeGatewayStatus(origin, basePath);
      if (!gatewaySupportsNativeLogin(status.auth_flows)) {
        throw new Error("This gateway is too old for native sign-in. Update it, or paste a token below.");
      }
      await signIn({ origin, basePath, redirectMode: chooseRedirectMode(status.auth_flows) });
      navigate("/chat", { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleToken = async () => {
    setError(null);
    setBusy("token");
    try {
      const { origin, basePath } = normalizeGatewayUrl(url);
      const trimmedToken = token.trim();
      if (!trimmedToken) throw new Error("Paste an access token.");
      const me = await verifyGatewayBearer(origin, basePath, trimmedToken);
      await connectWithToken({
        origin,
        basePath,
        accessToken: trimmedToken,
        expiresAt: me.expires_at ?? 0,
        userId: me.user_id,
        provider: me.provider,
      });
      setToken("");
      navigate("/chat", { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleDisconnect = async () => {
    await disconnect();
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

          {cleartext && (
            <div className="text-xs text-amber-600 dark:text-amber-400">
              Plain http: the sign-in browser may show a security warning, and the token travels unencrypted. Prefer https for gateways reached over the internet.
            </div>
          )}
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
            <Button onClick={() => void handleSignIn()} disabled={busy !== null || !nativeAvailable}>
              {busy === "signin" ? "Waiting for browser…" : "Sign in"}
            </Button>
            {connection && (
              <Button onClick={() => void handleDisconnect()} disabled={busy !== null}>
                Disconnect
              </Button>
            )}
          </div>
          {!nativeAvailable && (
            <div className="text-xs opacity-70">
              Sign-in opens the system browser and is only available in the Hermes app.
            </div>
          )}

          <button
            type="button"
            className="text-left text-xs underline opacity-70"
            onClick={() => setShowToken((v) => !v)}
          >
            {showToken ? "Hide advanced" : "Advanced: paste an access token"}
          </button>
          {showToken && (
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1 text-sm">
                <span>Access token</span>
                <Input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Paste a bearer token"
                  type="password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </label>
              <div>
                <Button onClick={() => void handleToken()} disabled={busy !== null}>
                  {busy === "token" ? "Connecting…" : "Connect with token"}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
