# Hermes Android — release notes and policy rationale

## Building a release

```bash
export JAVA_HOME=~/.jdks/jdk-21.0.12.1+1
export ANDROID_HOME=~/Android/Sdk
export HERMES_ANDROID_KEYSTORE=/secure/path/hermes-release.jks
export HERMES_ANDROID_KEYSTORE_PASSWORD='…'
export HERMES_ANDROID_KEY_ALIAS=hermes
export HERMES_ANDROID_KEY_PASSWORD='…'
npm run build:web --workspace apps/mobile && npm run sync --workspace apps/mobile
cd apps/mobile/android && ./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk (signed when the env is set,
#   otherwise app-release-unsigned.apk)
```

Create the keystore once and keep it out of the repo:

```bash
keytool -genkeypair -v -keystore hermes-release.jks -alias hermes \
  -keyalg RSA -keysize 4096 -validity 10000
```

Release builds shrink and obfuscate (R8). `app/proguard-rules.pro` keeps the
Capacitor plugin surface — the plugin classes with their **runtime-visible
annotations** (`@CapacitorPlugin(permissions=…)` is read at runtime; without
`-keepattributes RuntimeVisibleAnnotations` the first permission lookup
NPE'd in the shrunk build), the `@PluginMethod` / `@PermissionCallback` /
`@ActivityCallback` methods reached by reflection — plus the
`-dontwarn` rules Tink needs. Verify with
`apksigner verify --print-certs app-release.apk`, then install and run a
sign-in and a tool turn: the debug build cannot catch R8 problems.

## Security posture

| Concern | Handling |
| --- | --- |
| Credentials at rest | Access/refresh tokens in `EncryptedSharedPreferences` (AES-256-GCM, Keystore master key). JS holds the access token in memory only. `android:allowBackup="false"` — a backup of the prefs would be useless without the device key and must not travel. |
| Sign-in | RFC 8252 in the system browser (Custom Tabs), PKCE S256 generated natively, `state` checked in constant time, codes single-use, redirect via the app's private-use scheme (`com.nousresearch.hermes:/oauth2redirect`, validated server-side) or a loopback listener. No embedded webview login, no cookies. |
| Transport | Native OkHttp for every request; the WebView never talks to a gateway. The gateway's CORS and WebSocket-Origin guards stay intact for browsers. |
| Cleartext | `network_security_config.xml` permits cleartext because LAN and tailnet gateways are commonly plain http. The app classifies the origin: https → silent; private/CGNAT/link-local/`.local`/`.ts.net` → warning; **public http → the user must explicitly acknowledge before signing in**; loopback → refused (no auth gate). Prefer TLS for anything reachable from the internet. |
| Approvals | Choices rendered exactly as the gateway sends them (Tirith warnings and smart denials narrow them). "Always allow" needs a second tap in-app and is never offered from a notification. Sudo passwords and secrets are never requested through notifications; every dismissal of those prompts is a refusal. |
| Logging | Capacitor's bridge logs plugin traffic (including tokens) only in debug builds (`loggingBehavior: debug`). Do not ship debug builds. |

## Permissions

| Permission | Why |
| --- | --- |
| `INTERNET`, `ACCESS_NETWORK_STATE` | Talk to the gateway; reconnect when the network returns. |
| `POST_NOTIFICATIONS` | Approval requests and turn completion while the app is in the background. Requested at first connect; the app works without it. |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC` | Keep the process, and so the gateway socket, alive in the background behind a persistent "Connected to <gateway>" notification, so an approval can reach the phone. |
| `CAMERA` | Scanning the dashboard's pairing QR. Requested by the WebView only when Scan QR is tapped. |

No `RECORD_AUDIO`: dictation uses the system speech recogniser activity.

## Foreground service justification (Play Console "Data sync")

The app is a remote control for an agent running on the user's own server.
The agent blocks on user approval before running dangerous commands; that
approval request arrives over a WebSocket the app holds open. Without a
foreground service Android ends the process within minutes of backgrounding
and the request is lost until the user reopens the app. The service:

- runs only while the app is signed in and connected (started on connect,
  stopped on sign-out / dispose);
- shows a persistent low-importance notification naming the gateway;
- transfers no data itself — it exists so the WebSocket survives.

Android 14+ limits `dataSync` to 6 hours per 24-hour window. On timeout the
service stops itself; the next foreground visit restarts it. If Play review
prefers it, `remoteMessaging` ("transfer messages between devices to
continue a task") is the alternative type with no timeout — change
`foregroundServiceType` in the manifest and `ServiceInfo.FOREGROUND_SERVICE_TYPE_*`
in `HermesConnectionService.kt`.

## Data safety (draft answers)

- Data collected: none by the app publisher. The app talks only to the
  gateway the user configures.
- Data shared: none.
- Data stored on device: gateway addresses and names (unencrypted, non-secret),
  session tokens (encrypted, Keystore-backed).
- Network: plain http allowed for private networks with a warning; public http
  requires explicit acknowledgement.

## Not yet done

- App icon and splash are Capacitor defaults.
- Notification icons use system drawables; replace with branded ones.
- No crash reporting; consider an opt-in.
- `dataSync` 6-hour cap (see above).
