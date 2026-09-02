/**
 * Full-screen QR scanner on getUserMedia + jsQR. No native plugin and no
 * Play-services dependency (the decoder is pure JS), so it works in the
 * WebView on any Android, and in a desktop browser for development.
 */
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { Button } from "@nous-research/ui/ui/components/button";

export interface QrScannerProps {
  onResult: (text: string) => void;
  onClose: () => void;
}

export function canScanQr(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

export function QrScanner({ onResult, onClose }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let done = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const stop = () => {
      done = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };

    (async () => {
      let jsQR: typeof import("jsqr").default;
      try {
        jsQR = (await import("jsqr")).default;
      } catch {
        setError("QR decoder failed to load.");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
      } catch (err) {
        setError(err instanceof Error ? `Camera unavailable: ${err.message}` : "Camera unavailable.");
        return;
      }
      const video = videoRef.current;
      if (!video || done) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      video.srcObject = stream;
      await video.play().catch(() => {});

      const tick = () => {
        if (done) return;
        if (video.readyState >= 2 && ctx) {
          const w = video.videoWidth;
          const h = video.videoHeight;
          if (w && h) {
            canvas.width = w;
            canvas.height = h;
            ctx.drawImage(video, 0, 0, w, h);
            const image = ctx.getImageData(0, 0, w, h);
            const code = jsQR(image.data, w, h, { inversionAttempts: "dontInvert" });
            if (code?.data) {
              stop();
              onResult(code.data);
              return;
            }
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    })();

    return stop;
  }, [onResult]);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black text-white" role="dialog" aria-label="Scan a gateway QR code">
      <div className="flex items-center justify-between px-3 pt-[calc(0.5rem+var(--hermes-inset-top))] pb-2">
        <span className="text-sm">Point the camera at the pairing code</span>
        <Button ghost size="icon" aria-label="Close scanner" onClick={onClose} className="text-white">
          <X className="size-5" />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        <video ref={videoRef} className="size-full object-cover" playsInline muted />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="size-64 rounded-lg border-2 border-white/80" />
        </div>
      </div>
      {error && (
        <div role="alert" className="px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}
      <div className="px-4 pb-[calc(1rem+var(--hermes-inset-bottom))] pt-2 text-xs opacity-70">
        The dashboard's "Mobile app" page shows the code. It carries only the gateway address.
      </div>
    </div>
  );
}
