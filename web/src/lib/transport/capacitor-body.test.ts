// Node environment on purpose: jsdom's FormData cannot be consumed by Node's
// Response (it hangs), and the real WebView has one consistent platform.
import { describe, expect, it } from "vitest";

import { base64ToBytes, encodeRequestBody } from "./capacitor";

describe("encodeRequestBody", () => {
  it("passes strings through as text", async () => {
    expect(await encodeRequestBody('{"a":1}')).toEqual({ body: '{"a":1}' });
  });

  it("form-encodes URLSearchParams", async () => {
    expect(await encodeRequestBody(new URLSearchParams({ a: "1", b: "x y" }))).toEqual({
      body: "a=1&b=x+y",
      contentType: "application/x-www-form-urlencoded;charset=UTF-8",
    });
  });

  it("serialises FormData as multipart with the platform boundary", async () => {
    const fd = new FormData();
    fd.append("file", new Blob(["hello"], { type: "text/plain" }), "a.txt");
    const encoded = await encodeRequestBody(fd);
    expect(encoded.contentType).toMatch(/^multipart\/form-data; boundary=/);
    const text = new TextDecoder().decode(base64ToBytes(encoded.bodyBase64!));
    expect(text).toContain('name="file"; filename="a.txt"');
    expect(text).toContain("hello");
  });
});

