/**
 * "Mobile app" page (browser dashboard): shows the QR code the Android app
 * scans to find this gateway, plus the readiness checks the app depends on.
 * The QR carries only the address — sign-in happens in the phone's browser.
 */
import { useEffect, useMemo, useState } from "react";
import * as QRCode from "qrcode";
import { Smartphone } from "lucide-react";

import { Badge } from "@nous-research/ui/ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@nous-research/ui/ui/components/card";
import { Input } from "@nous-research/ui/ui/components/input";

import { encodePairingPayload } from "@hermes/shared";

import { usePageHeader } from "@/contexts/usePageHeader";
import { HERMES_BASE_PATH, api, type StatusResponse } from "@/lib/api";
import { isCleartextOrigin } from "@/lib/backend-target";

function defaultGatewayUrl(): string {
  if (typeof window === "undefined") return "";
  return `${window.location.origin}${HERMES_BASE_PATH}`;
}

function defaultName(): string {
  if (typeof window === "undefined") return "";
  return window.location.hostname;
}

export default function MobilePairingPage() {
  const { setTitle } = usePageHeader();
  const [url, setUrl] = useState(defaultGatewayUrl);
  const [name, setName] = useState(defaultName);
  const [qr, setQr] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);

  useEffect(() => {
    setTitle("Mobile app");
    return () => setTitle(null);
  }, [setTitle]);

  useEffect(() => {
    api
      .getStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  const payload = useMemo(() => {
    try {
      const parsed = new URL(url.trim());
      return encodePairingPayload({ origin: parsed.origin, basePath: parsed.pathname, name });
    } catch {
      return null;
    }
  }, [url, name]);

  useEffect(() => {
    if (!payload) {
      setQr(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(payload, { errorCorrectionLevel: "M", margin: 2, width: 280 })
      .then((dataUrl) => {
        if (!cancelled) setQr(dataUrl);
      })
      .catch(() => setQr(null));
    return () => {
      cancelled = true;
    };
  }, [payload]);

  const authGate = status?.auth_required === true;
  const nativeFlow = !!status?.auth_flows?.includes("native_pkce");
  const schemeFlow = !!status?.auth_flows?.includes("native_app_scheme");
  let origin = "";
  try {
    origin = new URL(url.trim()).origin;
  } catch {
    /* invalid while typing */
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Smartphone className="size-4" /> Pair the Hermes Android app
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 md:flex-row">
          <div className="flex shrink-0 flex-col items-center gap-2">
            {qr ? (
              <img src={qr} alt="Gateway pairing QR code" width={280} height={280} className="rounded bg-white p-2" />
            ) : (
              <div className="flex size-[280px] items-center justify-center rounded border border-border text-sm opacity-60">
                Enter a valid http(s) URL
              </div>
            )}
            <div className="text-xs opacity-60">The code holds only the address; you sign in on the phone.</div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span>Gateway URL the phone should use</span>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} autoCapitalize="none" spellCheck={false} />
              <span className="text-xs opacity-60">
                Must be reachable from the phone (LAN IP, Tailscale name, or public host) — not 127.0.0.1.
              </span>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>Name shown in the app</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
            </label>
            {payload && (
              <div className="text-xs">
                <div className="opacity-60">Or type it in the app:</div>
                <code className="break-all font-mono">{url.trim()}</code>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Readiness</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <div className="flex items-center gap-2">
            <Badge tone={authGate ? "success" : "destructive"}>{authGate ? "auth gate on" : "no auth gate"}</Badge>
            <span className="opacity-80">
              {authGate
                ? "This gateway requires sign-in, which is what the app needs."
                : "Bound to loopback with no auth gate: the app cannot sign in. Run `hermes serve --host 0.0.0.0` (or a LAN/Tailscale address) with a password or OAuth provider."}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={nativeFlow ? "success" : "warning"}>{nativeFlow ? "native sign-in" : "no native sign-in"}</Badge>
            <span className="opacity-80">
              {nativeFlow
                ? schemeFlow
                  ? "System-browser sign-in with the app's own redirect scheme."
                  : "System-browser sign-in via a loopback redirect (older gateway)."
                : "This gateway does not advertise native_pkce; the app falls back to pasting a token."}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={origin && isCleartextOrigin(origin) ? "warning" : "success"}>
              {origin && isCleartextOrigin(origin) ? "plain http" : "https / local"}
            </Badge>
            <span className="opacity-80">
              {origin && isCleartextOrigin(origin)
                ? "Fine on a trusted LAN or Tailscale; over the internet put the gateway behind TLS — the phone's browser will warn at sign-in otherwise."
                : "Encrypted, or loopback."}
            </span>
          </div>
          <div className="text-xs opacity-60">
            Providers: {status?.auth_providers?.join(", ") || "none advertised"} · Hermes {status?.version ?? "?"}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
