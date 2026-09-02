/*
 * M0 spike — proves the Android transport assumptions against a real
 * `hermes serve` using OkHttp, the same stack the Kotlin plugins will use.
 *
 *   (a) an OkHttp WebSocket with NO Origin header is accepted by /api/ws on a
 *       gateway bound to a specific (non-0.0.0.0) address, and the first frame
 *       is `gateway.ready`;
 *   (a') the WS-Origin canary: the same handshake with `Origin: https://localhost`
 *       (Capacitor's default WebView origin) is refused before upgrade on a
 *       specific-address bind (HTTP 403), and accepted on a 0.0.0.0 bind;
 *   (c) the RFC 8252 loopback flow (PKCE + 127.0.0.1 listener) returns bearer
 *       tokens in the JSON body, the bearer works on a gated REST route, and
 *       /auth/native/refresh honours the 401-vs-503 split.
 *
 * Plain Java (not Kotlin) only because no kotlinc is installed on the spike
 * host; the network behaviour under test is OkHttp's, which is identical.
 * No JSON library on purpose — the payloads are tiny and regex extraction keeps
 * the classpath to okhttp + okio + kotlin-stdlib.
 *
 * Usage: java -cp <okhttp:okio:kotlin-stdlib:.> M0Spike <baseUrl> <user> <password> [specific|wildcard]
 *   The 4th arg says how the gateway is bound: a specific address (default —
 *   the canary case) or 0.0.0.0/:: (where the server deliberately accepts any
 *   Origin, so the WebView-origin canary is expected to be *accepted*).
 */

import okhttp3.Headers;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class M0Spike {
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private static final OkHttpClient http = new OkHttpClient.Builder()
            .followRedirects(false)
            .callTimeout(15, TimeUnit.SECONDS)
            .build();

    private static String base;
    private static int failures = 0;

    public static void main(String[] args) throws Exception {
        if (args.length < 3) {
            System.err.println("usage: M0Spike <baseUrl> <user> <password>");
            System.exit(2);
        }
        base = args[0].replaceAll("/+$", "");
        String user = args[1], pass = args[2];
        boolean wildcardBind = args.length > 3 && args[3].equalsIgnoreCase("wildcard");

        section("0. capability probe");
        String status = get("/api/status", null).body;
        String flows = jsonArray(status, "auth_flows");
        check("gateway advertises native_pkce", flows.contains("native_pkce"), "auth_flows=" + flows);

        section("(c) RFC 8252 loopback flow -> bearer tokens (server half; Custom Tabs is the UI hop)");
        String verifier = b64url(random(32));
        String challenge = b64url(sha256(verifier.getBytes(StandardCharsets.US_ASCII)));
        String state = b64url(random(16));

        // The loopback listener the Android app will run on 127.0.0.1:0.
        ServerSocket listener = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
        String redirectUri = "http://127.0.0.1:" + listener.getLocalPort() + "/callback";
        CompletableFuture<String> codeFuture = new CompletableFuture<>();
        Thread lt = new Thread(() -> codeFuture.complete(acceptOnce(listener)));
        lt.setDaemon(true);
        lt.start();

        String authorizeUrl = "/auth/native/authorize?provider=basic"
                + "&code_challenge=" + enc(challenge)
                + "&code_challenge_method=S256"
                + "&redirect_uri=" + enc(redirectUri)
                + "&state=" + enc(state);
        Resp authz = get(authorizeUrl, null);
        check("authorize -> 302 to /login (password provider branch)",
                authz.code == 302 && authz.location.endsWith("/login"),
                "code=" + authz.code + " location=" + authz.location);
        String pkceCookie = cookiePair(authz.setCookie);
        check("authorize set the server PKCE cookie", pkceCookie != null, "set-cookie=" + authz.setCookie);

        // The system browser (Custom Tabs on Android) submits the /login form.
        // We POST what that page's script POSTs, carrying the same cookie.
        Resp login = post("/auth/password-login",
                "{\"provider\":\"basic\",\"username\":" + q(user) + ",\"password\":" + q(pass) + ",\"next\":\"/\"}",
                Headers.of("Cookie", pkceCookie));
        String next = jsonString(login.body, "next");
        // The only Set-Cookie allowed here is the PKCE cookie being *cleared*
        // (Max-Age=0); a real session cookie would mean the native branch
        // was skipped and the browser got a session instead of the app.
        // The server clears every prefix variant (__Host-, __Secure-, plain).
        boolean noSessionCookie = true;
        if (login.setCookie != null) {
            for (String c : login.setCookie.split(" \\| ")) {
                if (!(c.contains("hermes_session_pkce=\"\"") && c.contains("Max-Age=0"))) noSessionCookie = false;
            }
        }
        check("password-login -> next is the loopback redirect, only cookie op is PKCE clear",
                login.code == 200 && next != null && next.startsWith(redirectUri) && noSessionCookie,
                "code=" + login.code + " next=" + next + " set-cookie=" + login.setCookie);

        // The browser navigates to `next`; our listener catches ?code=&state=.
        Resp hop = get(next, null);
        String query = codeFuture.get(10, TimeUnit.SECONDS);
        String code = param(query, "code");
        String gotState = param(query, "state");
        check("loopback listener received code + matching state",
                code != null && state.equals(gotState), "query=" + query);

        Resp tok = post("/auth/native/token",
                "{\"code\":" + q(code) + ",\"code_verifier\":" + q(verifier) + "}", null);
        String access = jsonString(tok.body, "access_token");
        String refresh = jsonString(tok.body, "refresh_token");
        check("native/token -> bearer tokens in JSON body",
                tok.code == 200 && access != null && refresh != null,
                "code=" + tok.code + " body=" + redact(tok.body));

        Resp replay = post("/auth/native/token",
                "{\"code\":" + q(code) + ",\"code_verifier\":" + q(verifier) + "}", null);
        check("gateway code is single-use (replay -> 400)", replay.code == 400, "code=" + replay.code);

        Headers bearer = Headers.of("Authorization", "Bearer " + access);
        Resp me = get("/api/auth/me", bearer);
        check("bearer accepted on gated REST route /api/auth/me", me.code == 200, "code=" + me.code + " body=" + me.body);
        Resp noauth = get("/api/auth/me", null);
        check("same route without bearer -> 401", noauth.code == 401, "code=" + noauth.code);

        Resp refreshed = post("/auth/native/refresh",
                "{\"refresh_token\":" + q(refresh) + ",\"provider\":\"basic\"}", null);
        String access2 = jsonString(refreshed.body, "access_token");
        check("native/refresh rotates tokens", refreshed.code == 200 && access2 != null,
                "code=" + refreshed.code);
        Resp badRefresh = post("/auth/native/refresh",
                "{\"refresh_token\":\"not-a-real-token\",\"provider\":\"basic\"}", null);
        check("bogus refresh token -> 401 session_expired (not 503)",
                badRefresh.code == 401 && badRefresh.body.contains("session_expired"),
                "code=" + badRefresh.code + " body=" + badRefresh.body);
        if (access2 != null) access = access2;

        section("(a) OkHttp WebSocket, no Origin, ticket via Sec-WebSocket-Protocol");
        String ticket = mintTicket(access);
        WsResult a = connectWs(ticket, null);
        check("handshake accepted (101) and server selected hermes-gateway-v1",
                a.accepted && "hermes-gateway-v1".equals(a.selectedProtocol),
                "accepted=" + a.accepted + " protocol=" + a.selectedProtocol + " close=" + a.closeCode + " err=" + a.error);
        check("first frame is gateway.ready", a.firstFrame != null && a.firstFrame.contains("\"gateway.ready\""),
                "frame=" + trim(a.firstFrame));
        if (a.firstFrame != null && a.firstFrame.contains("\"gateway.ready\"")) {
            System.out.println("    M0(a) EXIT CRITERION: gateway.ready frame = " + trim(a.firstFrame));
        }
        check("JSON-RPC round trip (gateway.ping) answered", a.pingReply != null, "reply=" + trim(a.pingReply));

        section("(a') canaries: Origin header variants on the same bind");
        WsResult c1 = connectWs(mintTicket(access), "https://localhost");
        // /api/ws closes BEFORE accept on both auth and origin failures, so the
        // client sees plain HTTP 403 either way (no 4401/4403 close frame —
        // that distinction exists only on /api/pty).
        if (wildcardBind) {
            check("Origin: https://localhost on a 0.0.0.0 bind -> accepted (any host allowed by design)",
                    c1.accepted, describe(c1));
        } else {
            check("Origin: https://localhost (Capacitor WebView default) on a specific bind -> refused before upgrade",
                    !c1.accepted, describe(c1));
        }
        WsResult c2 = connectWs(mintTicket(access), base.replaceFirst("^ws", "http"));
        check("Origin: <gateway origin> -> accepted", c2.accepted && c2.firstFrame != null, describe(c2));
        WsResult c3 = connectWs("bogus-ticket", null);
        check("bad ticket, no Origin -> refused before upgrade (auth still enforced)",
                !c3.accepted, describe(c3));
        WsResult c4 = connectWsQueryTicket(mintTicket(access));
        check("legacy ?ticket= query form still accepted (fallback path)", c4.accepted && c4.firstFrame != null, describe(c4));

        System.out.println();
        System.out.println(failures == 0 ? "M0 SPIKE: ALL CHECKS PASSED" : "M0 SPIKE: " + failures + " CHECK(S) FAILED");
        http.dispatcher().executorService().shutdown();
        http.connectionPool().evictAll();
        System.exit(failures == 0 ? 0 : 1);
    }

    // ---- WebSocket ---------------------------------------------------------

    static final class WsResult {
        boolean accepted;
        String selectedProtocol;
        String firstFrame;
        String pingReply;
        int closeCode = -1;
        String error;
    }

    static String describe(WsResult r) {
        return "accepted=" + r.accepted + " close=" + r.closeCode + " protocol=" + r.selectedProtocol
                + " err=" + r.error + " frame=" + trim(r.firstFrame);
    }

    static WsResult connectWs(String ticket, String origin) throws Exception {
        Request.Builder rb = new Request.Builder()
                .url(wsUrl("/api/ws"))
                .header("Sec-WebSocket-Protocol", "hermes-gateway-v1, hermes-gateway-ticket." + ticket);
        if (origin != null) rb.header("Origin", origin);
        return runWs(rb.build());
    }

    static WsResult connectWsQueryTicket(String ticket) throws Exception {
        return runWs(new Request.Builder().url(wsUrl("/api/ws") + "?ticket=" + enc(ticket)).build());
    }

    static WsResult runWs(Request req) throws Exception {
        WsResult r = new WsResult();
        CompletableFuture<Void> done = new CompletableFuture<>();
        WebSocket ws = http.newWebSocket(req, new WebSocketListener() {
            @Override public void onOpen(WebSocket s, Response resp) {
                r.accepted = resp.code() == 101;
                r.selectedProtocol = resp.header("Sec-WebSocket-Protocol");
            }
            @Override public void onMessage(WebSocket s, String text) {
                if (r.firstFrame == null) {
                    r.firstFrame = text;
                    s.send("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"gateway.ping\",\"params\":{}}");
                } else if (text.contains("\"id\": 1") || text.contains("\"id\":1")) {
                    r.pingReply = text;
                    s.close(1000, "spike done");
                    done.complete(null);
                }
            }
            @Override public void onClosing(WebSocket s, int code, String reason) {
                r.closeCode = code; r.error = reason; s.close(code, null); done.complete(null);
            }
            @Override public void onClosed(WebSocket s, int code, String reason) {
                if (r.closeCode < 0) r.closeCode = code; done.complete(null);
            }
            @Override public void onFailure(WebSocket s, Throwable t, Response resp) {
                r.error = t.toString() + (resp != null ? " http=" + resp.code() : "");
                done.complete(null);
            }
        });
        try { done.get(10, TimeUnit.SECONDS); } catch (Exception e) { r.error = "timeout waiting for ws"; ws.cancel(); }
        return r;
    }

    static String mintTicket(String access) throws Exception {
        Resp t = post("/api/auth/ws-ticket", "{}", Headers.of("Authorization", "Bearer " + access));
        String ticket = jsonString(t.body, "ticket");
        if (ticket == null) throw new IllegalStateException("ws-ticket failed: " + t.code + " " + t.body);
        return ticket;
    }

    // ---- loopback listener ---------------------------------------------------

    static String acceptOnce(ServerSocket listener) {
        try (Socket s = listener.accept()) {
            BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.US_ASCII));
            String reqLine = in.readLine();               // GET /callback?code=..&state=.. HTTP/1.1
            String line; while ((line = in.readLine()) != null && !line.isEmpty()) { /* drain headers */ }
            byte[] body = "<html><body>You can close this window.</body></html>".getBytes(StandardCharsets.UTF_8);
            OutputStream out = s.getOutputStream();
            out.write(("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            out.write(body); out.flush();
            String path = reqLine.split(" ")[1];
            int qi = path.indexOf('?');
            return qi < 0 ? "" : path.substring(qi + 1);
        } catch (Exception e) {
            return "ERROR " + e;
        } finally {
            try { listener.close(); } catch (Exception ignored) {}
        }
    }

    // ---- HTTP helpers ----------------------------------------------------------

    static final class Resp { int code; String body; String location; String setCookie; }

    static Resp get(String pathOrUrl, Headers h) throws Exception {
        Request.Builder rb = new Request.Builder().url(abs(pathOrUrl));
        if (h != null) rb.headers(h);
        return exec(rb.build());
    }

    static Resp post(String path, String json, Headers h) throws Exception {
        Request.Builder rb = new Request.Builder().url(abs(path)).post(RequestBody.create(json, JSON));
        if (h != null) rb.headers(h);
        return exec(rb.build());
    }

    static Resp exec(Request req) throws Exception {
        try (Response resp = http.newCall(req).execute()) {
            Resp r = new Resp();
            r.code = resp.code();
            r.body = resp.body() != null ? resp.body().string() : "";
            r.location = resp.header("Location", "");
            r.setCookie = String.join(" | ", resp.headers("Set-Cookie"));
            if (r.setCookie.isEmpty()) r.setCookie = null;
            return r;
        }
    }

    static String abs(String p) { return p.startsWith("http") ? p : base + p; }
    static String wsUrl(String p) { return base.replaceFirst("^http", "ws") + p; }

    // ---- tiny utils ----------------------------------------------------------------

    static byte[] random(int n) { byte[] b = new byte[n]; new SecureRandom().nextBytes(b); return b; }
    static byte[] sha256(byte[] in) throws Exception { return MessageDigest.getInstance("SHA-256").digest(in); }
    static String b64url(byte[] b) { return Base64.getUrlEncoder().withoutPadding().encodeToString(b); }
    static String enc(String s) throws Exception { return URLEncoder.encode(s, "UTF-8"); }
    static String q(String s) { return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""; }

    static String jsonString(String body, String key) {
        if (body == null) return null;
        Matcher m = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(body);
        return m.find() ? m.group(1).replace("\\/", "/") : null;
    }

    static String jsonArray(String body, String key) {
        Matcher m = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*(\\[[^\\]]*\\])").matcher(body);
        return m.find() ? m.group(1) : "[]";
    }

    static String cookiePair(String setCookie) {
        if (setCookie == null) return null;
        int semi = setCookie.indexOf(';');
        return semi < 0 ? setCookie : setCookie.substring(0, semi);
    }

    static String param(String query, String name) throws Exception {
        if (query == null) return null;
        for (String kv : query.split("&")) {
            int eq = kv.indexOf('=');
            if (eq > 0 && kv.substring(0, eq).equals(name)) return URLDecoder.decode(kv.substring(eq + 1), "UTF-8");
        }
        return null;
    }

    static String redact(String body) {
        return body == null ? null : body.replaceAll("\"(access_token|refresh_token)\"\\s*:\\s*\"[^\"]*\"", "\"$1\":\"<redacted>\"");
    }

    static String trim(String s) { return s == null ? null : (s.length() > 200 ? s.substring(0, 200) + "…" : s); }

    static void section(String title) { System.out.println(); System.out.println("== " + title); }

    static void check(String what, boolean ok, String detail) {
        if (!ok) failures++;
        System.out.println("  [" + (ok ? "PASS" : "FAIL") + "] " + what + (ok ? "" : "  -- " + detail));
        if (ok && detail != null && !detail.isEmpty()) System.out.println("         " + detail);
    }
}
