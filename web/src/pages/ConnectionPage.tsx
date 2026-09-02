/**
 * Mobile connection screen.
 *
 * Primary path (M2): gateway URL → probe public ``/api/status`` → RFC 8252
 * sign-in in the system browser via the native bridge → connected.
 * Fallback: paste an access token (kept for gateways without the native
 * flow and for testing without a browser). M6 adds QR pairing on top.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { QrCode, Trash2 } from "lucide-react";

import { Button } from "@nous-research/ui/ui/components/button";
import { Input } from "@nous-research/ui/ui/components/input";
import { Card, CardContent, CardHeader, CardTitle } from "@nous-research/ui/ui/components/card";

import { decodePairingPayload } from "@hermes/shared";

import { QrScanner, canScanQr } from "@/components/QrScanner";
import { normalizeGatewayUrl } from "@/lib/backend-target";
import { classifyOrigin, originCaveat, type OriginClass } from "@/lib/origin-policy";
import {
  probeGatewayStatus,
  verifyGatewayBearer,
  type GatewayStatusProbe,
} from "@/lib/gateway-probe";
import {
  connectWithToken,
  disconnect,
  forgetGateway,
  listGateways,
  signIn,
  switchGateway,
  useMobileConnection,
  type KnownGateway,
} from "@/lib/mobile-connection";
import { getChatController } from "@/pages/GatewayChatPage";
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
  const [name, setName] = useState<string | undefined>(undefined);
  const [scanning, setScanning] = useState(false);
  const [gateways, setGateways] = useState<KnownGateway[]>([]);
  const [gatewaysNonce, setGatewaysNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listGateways().then((list) => {
      if (!cancelled) setGateways(list);
    });
    return () => {
      cancelled = true;
    };
  }, [connection, gatewaysNonce]);

  const [ackPublicHttp, setAckPublicHttp] = useState(false);
  const originClass: OriginClass | null = (() => {
    try {
      return classifyOrigin(normalizeGatewayUrl(url).origin);
    } catch {
      return null;
    }
  })();
  const caveat = originCaveat(originClass);
  // Public plain-http needs the acknowledgement; loopback can never sign in.
  const blocked = originClass === "loopback" || (originClass === "public-http" && !ackPublicHttp);
  useEffect(() => setAckPublicHttp(false), [url]);

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

  const handleScan = useCallback((text: string) => {
    setScanning(false);
    const payload = decodePairingPayload(text);
    if (!payload) {
      setError("That code is not a Hermes gateway pairing code.");
      return;
    }
    setError(null);
    setUrl(`${payload.origin}${payload.basePath}`);
    setName(payload.name);
    setProbe(null);
  }, []);

  const handleSwitch = async (gw: KnownGateway) => {
    setError(null);
    if (!gw.signedIn) {
      setUrl(`${gw.origin}${gw.basePath}`);
      setName(gw.name);
      return;
    }
    setBusy("signin");
    try {
      if (await switchGateway(gw.origin, gw.basePath)) {
        getChatController().switchGateway();
        navigate("/chat", { replace: true });
      } else {
        setUrl(`${gw.origin}${gw.basePath}`);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleForget = async (gw: KnownGateway) => {
    await forgetGateway(gw.origin, gw.basePath);
    setGatewaysNonce((n) => n + 1);
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
      await signIn({ origin, basePath, redirectMode: chooseRedirectMode(status.auth_flows), name });
      getChatController().switchGateway();
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
      await connectWithToken(
        {
          origin,
          basePath,
          accessToken: trimmedToken,
          expiresAt: me.expires_at ?? 0,
          userId: me.user_id,
          provider: me.provider,
        },
        name,
      );
      setToken("");
      getChatController().switchGateway();
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

          {caveat && (
            <div className={originClass === "public-http" ? "text-xs text-red-600 dark:text-red-400" : "text-xs text-amber-600 dark:text-amber-400"}>
              {caveat}
            </div>
          )}
          {originClass === "public-http" && (
            <label className="flex min-h-12 items-center gap-2 text-sm">
              <input type="checkbox" className="size-5" checked={ackPublicHttp} onChange={(e) => setAckPublicHttp(e.target.checked)} />
              I understand this gateway is reached over plain http.
            </label>
          )}
          {probe && <div className="text-sm text-green-600 dark:text-green-400">{probe}</div>}
          {error && (
            <div role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {canScanQr() && (
              <Button outlined onClick={() => setScanning(true)} disabled={busy !== null} prefix={<QrCode className="size-4" />}>
                Scan QR
              </Button>
            )}
            <Button onClick={() => void handleProbe()} disabled={busy !== null}>
              {busy === "probe" ? "Testing…" : "Test connection"}
            </Button>
            <Button onClick={() => void handleSignIn()} disabled={busy !== null || !nativeAvailable || blocked}>
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
                <Button onClick={() => void handleToken()} disabled={busy !== null || blocked}>
                  {busy === "token" ? "Connecting…" : "Connect with token"}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {gateways.length > 0 && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Saved gateways</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {gateways.map((gw) => {
              const isCurrent =
                !!connection && connection.origin === gw.origin && connection.basePath === gw.basePath;
              return (
                <div key={`${gw.origin}${gw.basePath}`} className="flex items-center gap-2">
                  <button
                    type="button"
                    className="flex min-h-12 min-w-0 flex-1 flex-col items-start rounded border border-border px-3 py-2 text-left"
                    disabled={busy !== null || isCurrent}
                    onClick={() => void handleSwitch(gw)}
                  >
                    <span className="truncate text-sm font-medium">
                      {gw.name || gw.origin}
                      {isCurrent ? " · current" : ""}
                    </span>
                    <span className="truncate font-mono text-xs opacity-70">
                      {gw.origin}
                      {gw.basePath}
                      {gw.signedIn ? ` · ${gw.userId ?? "signed in"}` : " · sign in required"}
                    </span>
                  </button>
                  <Button ghost size="icon" aria-label={`Forget ${gw.name || gw.origin}`} disabled={busy !== null} onClick={() => void handleForget(gw)}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {scanning && <QrScanner onResult={handleScan} onClose={() => setScanning(false)} />}
    </div>
  );
}
