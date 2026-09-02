#!/usr/bin/env bash
# Mint a bearer token for the M1 "paste a token" connection screen by driving
# the gateway's RFC 8252 native flow with curl (password provider only —
# exactly what the app will do itself from M2, minus the system browser).
#
#   ./mint-token.sh http://192.168.1.86:9137 spike 'm0-spike-password'
#
# Prints the access token on stdout; everything else goes to stderr.
set -euo pipefail

BASE="${1:?gateway base URL}"
USER="${2:?username}"
PASS="${3:?password}"
BASE="${BASE%/}"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

verifier="$(head -c 32 /dev/urandom | b64url)"
challenge="$(printf '%s' "$verifier" | openssl dgst -sha256 -binary | b64url)"
state="$(head -c 16 /dev/urandom | b64url)"
# Any loopback IP literal passes _validate_loopback_redirect_uri; nothing listens
# here because we read the code straight out of the login response instead.
redirect="http://127.0.0.1:1/callback"

jar="$(mktemp)"; trap 'rm -f "$jar"' EXIT

authz_code="$(curl -sS -o /dev/null -w '%{http_code}' -c "$jar" \
  "$BASE/auth/native/authorize?provider=basic&code_challenge=$challenge&code_challenge_method=S256&redirect_uri=$(printf '%s' "$redirect" | sed 's|/|%2F|g;s|:|%3A|g')&state=$state")"
[ "$authz_code" = "302" ] || { echo "authorize failed: HTTP $authz_code" >&2; exit 1; }

login_json="$(curl -sS -b "$jar" -H 'content-type: application/json' \
  -d "$(printf '{"provider":"basic","username":"%s","password":"%s","next":"/"}' "$USER" "$PASS")" \
  "$BASE/auth/password-login")"
next="$(printf '%s' "$login_json" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("next",""))')"
case "$next" in
  "$redirect"*) ;;
  *) echo "login did not return the loopback redirect: $login_json" >&2; exit 1 ;;
esac
code="$(printf '%s' "$next" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')"
got_state="$(printf '%s' "$next" | sed -n 's/.*[?&]state=\([^&]*\).*/\1/p')"
[ "$got_state" = "$state" ] || { echo "state mismatch" >&2; exit 1; }

token_json="$(curl -sS -H 'content-type: application/json' \
  -d "$(printf '{"code":"%s","code_verifier":"%s"}' "$code" "$verifier")" \
  "$BASE/auth/native/token")"
printf '%s' "$token_json" | python3 -c '
import sys, json
d = json.load(sys.stdin)
tok = d.get("access_token")
if not tok:
    sys.stderr.write("token exchange failed: %s\n" % json.dumps(d)); sys.exit(1)
sys.stderr.write("user=%s provider=%s expires_at=%s\n" % (d.get("user_id"), d.get("provider"), d.get("expires_at")))
print(tok)
'
