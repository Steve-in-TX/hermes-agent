# Hermes Android client

A Capacitor shell around the `web/` dashboard SPA. The WebView only renders;
every REST call and WebSocket goes through native OkHttp plugins, because the
gateway's CORS and WebSocket-Origin guards refuse the WebView origin
(verified in [`spikes/m0`](spikes/m0/README.md)). The agent itself runs
elsewhere: point the app at any `hermes serve` bound to a reachable address.

Status: **M1 walking skeleton.** Manual gateway URL + pasted bearer token,
Sessions page (REST-only). No sign-in flow yet (M2), no chat (M3).

## Layout

```
apps/mobile/
├── capacitor.config.ts        appId com.nousresearch.hermes, webDir www/
├── android/                   Capacitor Android project (committed)
│   └── app/src/main/java/com/nousresearch/hermes/
│       ├── HermesTransport.kt      shared OkHttpClient
│       ├── HermesHttpPlugin.kt     fetch-shaped REST over OkHttp
│       ├── HermesSocketPlugin.kt   WebSockets over OkHttp (no Origin header)
│       └── MainActivity.java       registers the plugins
├── scripts/mint-token.sh      mint a bearer for the M1 token field
├── spikes/m0/                 transport assumptions, proven
└── www/                       gitignored; built from web/ with HERMES_TARGET=mobile
```

The TypeScript half lives in `web/`, selected at runtime, so the dashboard and
the app share one bundle, one typecheck, one test suite:

- `web/src/lib/backend-target.ts` — origin + base path + bearer; the default is
  byte-identical to the browser dashboard.
- `web/src/lib/transport/` — `HttpDriver` and `SocketFactory` seams;
  `capacitor.ts` implements both on the native plugins and is dead code in the
  browser build.
- `web/src/lib/mobile-connection.ts` — saved connection, applied at boot,
  dropped on `hermes:reauth-required`.
- `web/src/pages/ConnectionPage.tsx` — the M1 connection screen.

## Build

Requirements: Node 22, JDK 21 (Capacitor 8 compiles against it), the Android
SDK with platform 36 and build-tools 36.

```bash
npm install --workspace web --workspace apps/mobile
export JAVA_HOME=~/.jdks/jdk-21.0.12.1+1     # or wherever your JDK 21 lives
export ANDROID_HOME=~/Android/Sdk
npm run build --workspace apps/mobile        # web (mobile target) → cap sync → assembleDebug
adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Individually: `npm run build:web`, `npm run sync`, `npm run apk`, or
`npm run open` for Android Studio.

## Try it (M1)

1. Run a gateway on an address the phone can reach, with the bundled password
   provider (any non-loopback bind requires an auth provider):

   ```bash
   HERMES_DASHBOARD_BASIC_AUTH_USERNAME=me \
   HERMES_DASHBOARD_BASIC_AUTH_PASSWORD='choose-one' \
     hermes serve --host 0.0.0.0 --port 9119
   ```

2. Mint a bearer token (this drives the same RFC 8252 flow the app will use
   itself from M2):

   ```bash
   apps/mobile/scripts/mint-token.sh http://<gateway-ip>:9119 me 'choose-one'
   ```

3. In the app: enter the gateway URL, tap **Test connection** (public
   `/api/status`, shows version and auth flows), paste the token, tap
   **Connect** (`/api/auth/me` with the bearer). The Sessions page loads over
   the native transport.

Plain `http://` gateways work: `network_security_config.xml` permits cleartext
for now (release hardening narrows this). A gateway bound to loopback behind a
tunnel is refused on purpose — it has no auth gate, so nothing the app holds
can authenticate to it.

## Notes for M2+

- The bearer is in `localStorage` only because M1 pastes it by hand. M2 moves
  it to a `HermesTokenStore` plugin (EncryptedSharedPreferences) and replaces
  the field with Custom Tabs + PKCE + loopback listener; `gateway-probe.ts`
  already reads `auth_flows` for the capability check.
- `/api/ws` closes before the upgrade on both auth and origin failures, so the
  client sees HTTP 403 either way; diagnose with a REST probe first.
- The mobile bundle never mounts the xterm chat page and disables the
  dashboard plugin slot system (same-origin assumptions).
