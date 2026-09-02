# Hermes Android client

A Capacitor shell around the `web/` dashboard SPA. The WebView only renders;
every REST call and WebSocket goes through native OkHttp plugins, because the
gateway's CORS and WebSocket-Origin guards refuse the WebView origin
(verified in [`spikes/m0`](spikes/m0/README.md)). The agent itself runs
elsewhere: point the app at any `hermes serve` bound to a reachable address.

Status: **M2 — real sign-in.** RFC 8252 login in the system browser (Custom
Tabs + PKCE), tokens in an encrypted store, proactive refresh. Sessions page
(REST-only). No chat yet (M3).

## Layout

```
apps/mobile/
├── capacitor.config.ts        appId com.nousresearch.hermes, webDir www/
├── android/                   Capacitor Android project (committed)
│   └── app/src/main/java/com/nousresearch/hermes/
│       ├── HermesTransport.kt      shared OkHttpClient
│       ├── HermesHttpPlugin.kt     fetch-shaped REST over OkHttp
│       ├── HermesSocketPlugin.kt   WebSockets over OkHttp (no Origin header)
│       ├── HermesTokenStore.kt     EncryptedSharedPreferences (Keystore master key)
│       ├── HermesAuthPlugin.kt     RFC 8252 login, refresh, session store API
│       └── MainActivity.java       registers the plugins
├── scripts/mint-token.sh      mint a bearer for the "paste a token" fallback
├── spikes/m0/                 transport assumptions, proven
└── www/                       gitignored; built from web/ with HERMES_TARGET=mobile
```

The TypeScript half lives in `web/`, selected at runtime, so the dashboard and
the app share one bundle, one typecheck, one test suite:

- `web/src/lib/backend-target.ts` — origin + base path + bearer + refresh
  hook; the default is byte-identical to the browser dashboard.
- `web/src/lib/transport/` — `HttpDriver` and `SocketFactory` seams;
  `capacitor.ts` implements both on the native plugins and is dead code in the
  browser build.
- `web/src/lib/native-auth.ts` — the `NativeAuthBridge` contract;
  `native-auth-capacitor.ts` binds it to the `HermesAuth` plugin.
- `web/src/lib/mobile-connection.ts` — active session, proactive refresh
  120s before expiry, single-flighted refresh on 401, wipe only on the
  gateway's terminal `session_expired`.
- `web/src/pages/ConnectionPage.tsx` — URL, test, **Sign in**, and an
  advanced "paste a token" fallback.

## Sign-in flow

1. The app probes public `/api/status`. `auth_flows` must contain
   `native_pkce`; if it also contains `native_app_scheme` the app asks for a
   redirect to `com.nousresearch.hermes:/oauth2redirect` (intent filter),
   otherwise it opens a loopback listener on `127.0.0.1:<random>`.
2. `HermesAuthPlugin.login` generates PKCE + `state` natively and opens
   `<gateway>/auth/native/authorize?…` in a Chrome Custom Tab. Password
   providers land on the gateway's `/login` form (OS password managers can
   autofill there); OAuth providers go through their IDP.
3. The gateway redirects the browser with `?code=&state=`. The plugin checks
   `state`, POSTs `/auth/native/token` with the verifier, and stores
   `{access, refresh, expires_at, user, provider, origin}` in
   `EncryptedSharedPreferences`. JS receives the access token only.
4. `fetchJSON` sends `Authorization: Bearer`. On a 401 it asks the bridge to
   refresh once and retries; `POST /auth/native/refresh` answering 401
   `session_expired` wipes the store and returns the app to the connection
   screen, while 503 or a network failure keeps the session.

The backend side of the scheme redirect is `_validate_native_redirect_uri`
in `hermes_cli/dashboard_auth/routes.py` (loopback branch unchanged; the
private-use scheme must be exactly `com.nousresearch.hermes:/oauth2redirect`)
and the `native_app_scheme` entry in `/api/status` `auth_flows`. Gateways
without it still work through the loopback listener.

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

## Try it

1. Run a gateway on an address the phone can reach, with the bundled password
   provider (any non-loopback bind requires an auth provider):

   ```bash
   HERMES_DASHBOARD_BASIC_AUTH_USERNAME=me \
   HERMES_DASHBOARD_BASIC_AUTH_PASSWORD='choose-one' \
     hermes serve --host 0.0.0.0 --port 9119
   ```

2. In the app: enter the gateway URL, tap **Test connection**, then **Sign
   in**. The system browser opens the gateway's login form; after signing in
   it bounces back to the app and the Sessions page loads over the native
   transport.

3. Fallback without a browser: `scripts/mint-token.sh <url> me 'choose-one'`
   prints an access token for **Advanced: paste an access token**.

Plain `http://` gateways work: `network_security_config.xml` permits cleartext
for now (release hardening narrows this). A gateway bound to loopback behind a
tunnel is refused on purpose — it has no auth gate, so nothing the app holds
can authenticate to it.

## Verification status

- Web: typecheck, lint, and the vitest suite cover the seam, the transport,
  the auth bridge, refresh semantics, and the 401 retry. An opt-in live test
  (`HERMES_LIVE_GATEWAY`/`HERMES_LIVE_TOKEN`) drives the real `api.ts` path
  against a running gateway.
- Backend: `tests/hermes_cli/test_dashboard_auth_native_flow.py` covers the
  scheme redirect end to end and the rejection table.
- Android, verified on a Pixel 8 Pro (Android 17, Vanadium browser) against a
  gateway on the LAN: native REST probe, Custom Tab sign-in to the password
  form, redirect back through the `com.nousresearch.hermes:/oauth2redirect`
  intent filter, token exchange, Sessions page over the native transport, and
  the session restored from the encrypted store after `am force-stop`.
  Not yet exercised on a device: the loopback-listener redirect (only used
  against gateways without `native_app_scheme`), token refresh at expiry, and
  any WebSocket (nothing on the Sessions page opens one; M3 will).

Device findings to carry forward:

- A browser in HTTPS-only mode (Vanadium, Chrome with the setting on) shows a
  "site doesn't support a secure connection" interstitial for a plain
  `http://` gateway before the login form. Sign-in still works after
  "Continue to site", but M7 should recommend TLS for phone-facing gateways
  and the connection screen should warn when the URL is `http://`.
- The dashboard header overlaps the status bar: no top safe-area inset yet
  (the M4 `useSafeAreaInsets` item).

## Notes for M3+

- `/api/ws` closes before the upgrade on both auth and origin failures, so the
  client sees HTTP 403 either way; diagnose with a REST probe first.
- The mobile bundle never mounts the xterm chat page and disables the
  dashboard plugin slot system (same-origin assumptions).
