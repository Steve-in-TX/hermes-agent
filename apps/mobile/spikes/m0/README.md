# M0 spike — Android transport assumptions

Proves the risky assumptions in the Android-client plan against a real
`hermes serve`, using OkHttp 4.12 (the stack the Kotlin plugins will use).
Nothing here ships; it exists so nobody re-litigates the transport design.

## Run

```bash
# 1. gateway, bound to a SPECIFIC address (the canary case), password provider
HERMES_HOME=/tmp/m0-home HERMES_SERVE_HEADLESS=1 \
HERMES_DASHBOARD_BASIC_AUTH_USERNAME=spike \
HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=m0-spike-password \
  python hermes serve --host 192.168.1.86 --port 9137 --skip-build

# 2. client (compiles M0Spike.java against the OkHttp jars in ~/.gradle)
./run.sh http://192.168.1.86:9137 spike m0-spike-password specific
# against a 0.0.0.0 bind pass `wildcard` instead of `specific`
```

## Result (2026-09-01, source tree at 180291162f, server reports 0.21.0)

All 18 checks pass on both a specific-address bind and a `0.0.0.0` bind.

### (a) OkHttp WebSocket with no Origin — **PASS, exit criterion met**

- Handshake to `/api/ws` with `Sec-WebSocket-Protocol: hermes-gateway-v1, hermes-gateway-ticket.<t>`
  and no `Origin` header is accepted (101) on a gateway bound to `192.168.1.86`.
- Server selects only `hermes-gateway-v1`; the ticket protocol is never echoed back.
- First frame is `{"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready", …}}`.
- A `gateway.ping` JSON-RPC round trip answers `{"ok": true}`.
- Legacy `?ticket=` query form also works (fallback, but keep the subprotocol form).

### (a') WS-Origin canary — **confirmed**

| bind | `Origin: https://localhost` (Capacitor WebView default) | no Origin | `Origin: <gateway origin>` |
| --- | --- | --- | --- |
| `192.168.1.86` | **refused** (HTTP 403 before upgrade) | accepted | accepted |
| `0.0.0.0` | accepted (any host allowed by design) | accepted | accepted |

So a WebView-driven socket only works on wildcard binds. Native OkHttp works on both.

### (b) WebView credentialed fetch — **fails as predicted** (curl, specific bind)

```
OPTIONS /api/auth/ws-ticket  Origin: https://localhost
  Access-Control-Request-Headers: authorization,content-type
→ HTTP/1.1 401 Unauthorized, no access-control-* headers   (auth gate outranks CORS)

GET /api/status  Origin: https://localhost
→ 200, access-control-allow-origin: https://localhost, NO allow-credentials
```

A browser discards a `credentials:"include"` response without
`Access-Control-Allow-Credentials`, and the bearer-header preflight is 401'd
before `CORSMiddleware` sees it. This holds on every bind, so even where the
WS origin guard passes (wildcard bind) REST from the WebView still cannot work.
**Decision stands: all Hermes traffic goes through native code.**

### (c) RFC 8252 loopback flow — **PASS for the server half**

Driven exactly as Chrome Custom Tabs would drive it, minus the visible browser:

1. `GET /auth/native/authorize?provider=basic&code_challenge=…&code_challenge_method=S256&redirect_uri=http://127.0.0.1:<port>/callback&state=…`
   → 302 `/login` + server-set PKCE cookie carrying `{provider, broker}`.
2. `POST /auth/password-login` with that cookie → `{"ok":true,"next":"http://127.0.0.1:<port>/callback?code=…&state=…"}`.
   The only cookie operations are clears of the PKCE cookie (all three prefix variants). No session cookie.
3. The app's `ServerSocket` on `127.0.0.1:0` receives `code` + the matching `state`.
4. `POST /auth/native/token {code, code_verifier}` → `access_token`, `refresh_token`, `expires_at`, `provider`, `user_id` in the JSON body. Replay → 400.
5. `Authorization: Bearer` works on the gated `/api/auth/me` (401 without it) and mints `/api/auth/ws-ticket`.
6. `POST /auth/native/refresh` rotates; a bogus refresh token → 401 `session_expired` (the 401-vs-503 split the app must honour).

**Not proven here:** the Custom Tabs UI hop itself (opening the authorize URL in
the system browser and it landing on the loopback listener). That needs a device
or emulator; none was attached to the spike host. It is the same mechanism the
desktop uses today, so the residual risk is Android plumbing, not protocol.

## Findings worth carrying into M1

- `/api/ws` closes **before** accept on both auth and host/origin failures, so
  OkHttp sees a plain HTTP 403 either way. The 4401/4403 close-code distinction
  exists only on `/api/pty`. The connection UI cannot tell "bad ticket" from
  "origin refused" from the handshake alone; diagnose via a REST probe first.
- The server clears `__Host-`, `__Secure-`, and plain `hermes_session_pkce`
  cookies on the native branch; a native HTTP client must carry the PKCE cookie
  from the authorize response to the login POST. In the real flow the system
  browser does this automatically, so the app never handles that cookie.
- No backend changes were needed for any of (a), (b), (c).
