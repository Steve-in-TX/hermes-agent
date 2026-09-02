# Hermes Android client

A Capacitor shell around the `web/` dashboard SPA. The WebView only renders;
every REST call and WebSocket goes through native OkHttp plugins, because the
gateway's CORS and WebSocket-Origin guards refuse the WebView origin
(verified in [`spikes/m0`](spikes/m0/README.md)). The agent itself runs
elsewhere: point the app at any `hermes serve` bound to a reachable address.

Status: **M7 — release hardening.** Origin policy (public plain-http needs
an explicit acknowledgement; loopback refused), backups disabled, foreground
service timeout handled, release signing from the environment with R8
shrinking and keep rules. See [RELEASE.md](RELEASE.md) for the build recipe,
permission rationale, and the foreground-service justification.

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
│       ├── HermesShellPlugin.kt    notifications, foreground service, network, share, dictation
│       ├── HermesConnectionService.kt  foreground service ("Connected to <gateway>")
│       ├── NotificationActionReceiver.kt  Approve/Deny taps → plugin → JS controller
│       └── MainActivity.java       registers the plugins
├── scripts/mint-token.sh      mint a bearer for the "paste a token" fallback
├── testing/
│   ├── mock-inference.mjs     OpenAI-compatible mock model with M3_* scenarios
│   └── rig.sh                 real hermes serve + mock model + manual approvals
├── spikes/m0/                 transport assumptions, proven
└── www/                       gitignored; built from web/ with HERMES_TARGET=mobile
```

The TypeScript half lives in `web/`, selected at runtime, so the dashboard and
the app share one bundle, one typecheck, one test suite:

- `web/src/lib/backend-target.ts`, `web/src/lib/transport/` — remote origin,
  bearer, refresh hook, and the native HTTP/socket drivers (M1).
- `web/src/lib/native-auth*.ts`, `web/src/lib/mobile-connection.ts` — sign-in
  bridge, session store, proactive refresh (M2).
- `apps/shared/src/chat-input-requests.ts` — pure parser for
  `approval.request` / `clarify.request` / `sudo.request` / `secret.request`
  and expiries, with the gateway's choice derivation. Shared so desktop and
  mobile cannot drift.
- `web/src/lib/chat/` — `types.ts` (message model), `reducer.ts` (pure event →
  state), `hydrate.ts` (`session.history` rows → messages), `store.ts`
  (per-session external store), `controller.ts` (socket lifecycle, sessions,
  submit/interrupt, the four responds, reconnect + `approval.pending` replay).
- `web/src/components/chat/` — `MessageList`, `InputRequestCards`
  (ApprovalCard, ClarifyCard), `SecretPrompts` (sudo/secret bottom sheets),
  `Composer`; `web/src/pages/GatewayChatPage.tsx` ties them together.

## Pairing and multiple gateways (M6)

- The browser dashboard's **Mobile app** page (`/mobile`) renders a QR of
  `hermes-gateway:{"v":1,"origin","basePath","name"}` for the URL the phone
  should use (editable; defaults to the dashboard's own origin) and shows
  readiness: auth gate on, `native_pkce` advertised, plain http or not. The
  payload never carries a credential — sign-in follows on the phone. Encoding
  and decoding live in `apps/shared/src/mobile-pairing.ts`; a bare http(s) URL
  in a QR decodes too.
- The Connection screen's **Scan QR** uses `getUserMedia` + `jsqr` in the
  WebView (no ML Kit / Play services dependency, works on de-Googled
  phones); it fills the URL and name, then Sign in proceeds as usual.
- `HermesTokenStore` now keeps one session per gateway (keyed by origin +
  base path) plus the active pointer, migrating the M2 single-session layout
  on first read. `HermesAuth.listSessions / switchSession / removeSession`
  back the **Saved gateways** list: tap to switch (the chat controller drops
  its socket and reconnects to the new target), trash to forget. A non-secret
  registry in `localStorage` keeps names and last-use times.

## Native shell (M5)

- The JS controller keeps owning the socket; Capacitor never pauses the
  WebView, so it keeps handling events in the background. The foreground
  service (`dataSync`, persistent "Connected to <gateway>" notification) only
  stops Android from killing the process. Android 14+ caps `dataSync` at
  6 h per 24 h; `remoteMessaging` is the fallback type if that bites.
- When the app is hidden, `approval.request` raises a high-priority
  notification with **Approve once** and **Deny** (never `always`, never
  sudo/secret); `message.complete` raises a "finished" notification. The
  receiver emits `approvalAction` to the plugin → `approval.respond`; if the
  process is gone, tapping relaunches the app and the action is delivered
  once the WebView is back.
- `ConnectivityManager` → `networkAvailable` → `reconnectNow()`; the app no
  longer waits out a cellular connect timeout when Wi-Fi returns.
- Share target (`ACTION_SEND` text/plain) prefills the composer; the mic
  button uses the system speech recogniser.

## Chat protocol notes (verified live)

- One socket per app lifetime. `session.create {source:"android",
  close_on_disconnect:false}` lazily on the first message; `prompt.submit`
  answers `{status:"streaming"}` and the turn arrives as `message.start` →
  `message.delta`* → (`message.interim`, `tool.start`, `tool.complete`)* →
  `message.complete`.
- **After a socket drop, resume by the STORED session id.** `session.resume`
  with the detached runtime id answers `4007 session not found`; the stored
  id reattaches the same runtime with `running`, `inflight`, and the pending
  approval, and completion events flow to the new socket. The controller does
  this on every reconnect and then calls `approval.pending`.
- `approval.request` is acked with `approval.received`; `choices` are rendered
  verbatim (`once|session|always|deny`, narrowed by the gateway for Tirith
  warnings and smart denials). "Always allow" needs a second tap.
- Batch clarify answers are sent one `clarify.respond` per question,
  sequentially; the last lock resolves the tool.
- Sudo/secret sheets: every dismissal sends an empty answer (close is
  refusal); the backend runs nothing for an empty sudo password.

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

   Or, without a real model, the rig: `apps/mobile/testing/rig.sh 0.0.0.0 9137`
   (user `spike`, password `m0-spike-password`, approvals set to manual). Type
   `M3_TOOL`, `M3_APPROVAL`, `M3_CLARIFY`, or `M3_SLOW` in a message to
   trigger each scenario.

2. In the app: enter the gateway URL, tap **Test connection**, then **Sign
   in**. The system browser opens the gateway's login form; after signing in
   it bounces back to the app and the Chat tab opens.

3. Fallback without a browser: `scripts/mint-token.sh <url> me 'choose-one'`
   prints an access token for **Advanced: paste an access token** on the
   Connection tab.

Plain `http://` gateways work: `network_security_config.xml` permits cleartext
for now (release hardening narrows this). A gateway bound to loopback behind a
tunnel is refused on purpose — it has no auth gate, so nothing the app holds
can authenticate to it.

## Verification status

- Web: typecheck, lint, and the vitest suite cover the seam, the transport,
  the auth bridge, refresh semantics, the 401 retry, the chat reducer
  (against event sequences captured from a real gateway), history hydration,
  the shared input-request parser (every `_approval_request_payload`
  variant), and the controller (fake gateway: lazy create, approval ack,
  resume + replay, reconnect backoff, interrupt, sequential batch clarify).
- Live, opt-in (`HERMES_LIVE_GATEWAY`/`HERMES_LIVE_TOKEN` against the rig):
  `remote-target.live.test.ts` (M1 seam) and `chat/chat.live.test.ts` — plain
  reply, real tool turn, approval answered from the client and the agent
  proceeds, **socket killed mid-approval → reconnect → approval replayed →
  deny applied**, clarify answered, resume with the transcript intact. All
  green as of 2026-09-02.
- Backend: `tests/hermes_cli/test_dashboard_auth_native_flow.py` covers the
  scheme redirect end to end and the rejection table.
- Android, verified on a Pixel 8 Pro (Android 17, Vanadium browser): native
  REST probe, Custom Tab sign-in, scheme-redirect back into the app, token
  exchange, Sessions page over the native transport, session restored after
  `am force-stop`. **Chat on the phone (2026-09-02):** native WebSocket with
  the ticket subprotocol, a streamed tool turn rendered with the tool card,
  a dangerous-command approval tripped and approved from the phone with the
  agent proceeding (the directory was deleted), then Wi-Fi cut mid-approval,
  the app reconnected (after the cellular timeout), the approval card was
  replayed via `approval.pending`, and Deny was applied (the directory
  survived, the tool reported "Command denied").

- M7 on the Pixel 8 Pro: a signed, R8-shrunk release build (2.8 MB vs 10.4 MB
  debug) signed in through the Custom Tab, connected, and ran a tool turn.
  The first release build crashed in the permission lookup because R8 had
  stripped the plugin annotation — now kept, and the lookup fails soft.
- M6 on the Pixel 8 Pro: the M2-format session migrated into the
  per-gateway store and signed in unchanged; Saved gateways lists it as
  current; Scan QR brokered the camera permission and opened a live preview.
  Decoding a real code from the dashboard's page is a manual check (needs the
  code on another screen).
- M5 on the Pixel 8 Pro: notification permission prompt on first connect;
  with the app backgrounded, an approval raised a notification carrying the
  command; **Deny tapped from the shade** reached the gateway (the tool
  reported "Command denied", the directory survived) and a "Hermes finished"
  notification followed.

Device findings to carry forward:

- A browser in HTTPS-only mode (Vanadium, Chrome with the setting on) shows a
  "site doesn't support a secure connection" interstitial for a plain
  `http://` gateway before the login form. Sign-in still works after
  "Continue to site", but M7 should recommend TLS for phone-facing gateways
  and the connection screen should warn when the URL is `http://`.
- (Resolved in M4) The dashboard header overlapped the status bar. The SPA now
  lays out with `--hermes-inset-top/bottom` (`env(safe-area-inset-*)`, which
  Capacitor 8 passes through when the viewport declares `viewport-fit=cover`,
  falling back to the `--safe-area-inset-*` variables it injects on older
  WebViews); the fixed header, its spacer, and the drawer honour them, and
  `SystemBars.style: "DARK"` paints light status-bar icons over the dark chrome.

## Not in M3 core (next)

- Slash commands (`SlashPopover` + `slashExec` exist in web/ and only need a
  live `GatewayClient`), image/file attachments (`image.attach_bytes`), model
  picker on the chat page, message reactions.
- Moving the desktop's `lib/chat-messages` (tool-part projection, timeline
  reconciliation) into `apps/shared` so both clients share one message model;
  today mobile has its own minimal reducer.
- After a reconnect the transcript is rebuilt from history, so a tool that was
  running when the socket dropped has no card until its `tool.complete`
  arrives (history carries no tool row until then). Reusing the shared
  client's seq watermarks across reconnects would replay `tool.start` too.
- A reconnect while the phone falls back to cellular first waits out OkHttp's
  15 s connect timeout to the LAN address; a `ConnectivityManager` callback
  (M5) should trigger `reconnectNow()` the moment Wi-Fi returns.
