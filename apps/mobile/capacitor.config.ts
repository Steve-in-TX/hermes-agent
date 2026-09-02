import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Hermes Android client.
 *
 * The WebView only renders the bundled `web/` SPA (built with
 * `HERMES_TARGET=mobile`, emitted to `www/`). It never talks to a gateway
 * itself — every REST call and WebSocket goes through the native
 * HermesHttp / HermesSocket plugins (OkHttp), because the gateway's CORS and
 * WS-Origin guards refuse the WebView origin. See spikes/m0/README.md.
 */
const config: CapacitorConfig = {
  appId: "com.nousresearch.hermes",
  appName: "Hermes",
  webDir: "www",
  android: {
    // Gateways are reached by the native layer, so the WebView needs no
    // cleartext exemption of its own; OkHttp is configured separately.
    allowMixedContent: false,
  },
};

export default config;
