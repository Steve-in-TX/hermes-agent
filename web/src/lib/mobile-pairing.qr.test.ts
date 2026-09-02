/**
 * The pairing code the dashboard renders (via `qrcode`) must decode with the
 * phone's decoder (`jsqr`). Rasterise the QR matrix into RGBA the way the
 * scanner sees a camera frame and run the real decoder over it — the
 * headless stand-in for pointing a phone at the dashboard.
 */
import jsQR from "jsqr";
import * as QRCode from "qrcode";
import { describe, expect, it } from "vitest";

import { decodePairingPayload, encodePairingPayload } from "@hermes/shared";

function rasterise(text: string, scale = 6, quiet = 4): { data: Uint8ClampedArray; width: number; height: number } {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const dim = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!qr.modules.get(y, x)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((y + quiet) * scale + dy) * dim + (x + quiet) * scale + dx;
          data[px * 4] = 0;
          data[px * 4 + 1] = 0;
          data[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

describe("pairing QR end to end", () => {
  it("encodes with qrcode and decodes with jsqr into the same payload", () => {
    const text = encodePairingPayload({ origin: "http://192.168.1.86:9137", basePath: "", name: "studio" });
    const { data, width, height } = rasterise(text);
    const code = jsQR(data, width, height, { inversionAttempts: "dontInvert" });
    expect(code?.data).toBe(text);
    expect(decodePairingPayload(code!.data)).toEqual({ v: 1, origin: "http://192.168.1.86:9137", basePath: "", name: "studio" });
  });

  it("survives a long https origin with a base path", () => {
    const text = encodePairingPayload({
      origin: "https://hermes-gateway.some-long-tailnet-name.ts.net:9119",
      basePath: "/hermes/dashboard",
      name: "a name that is rather long for a phone screen",
    });
    const { data, width, height } = rasterise(text, 4);
    const code = jsQR(data, width, height);
    expect(code?.data).toBe(text);
  });
});
