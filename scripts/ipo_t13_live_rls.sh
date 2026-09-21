#!/usr/bin/env bash
# T13 — live RLS verification for the IPO tables. Deferred from Phase D because
# it cannot be answered without a real database; run it after D.2 Step 1.
#
# WHAT IT PROVES, AND WHY IT IS NOT THE SAME AS THE SQL CHECK.
# ipo_phase_d_verify.sql asks the catalog what is configured. This asks PostgREST
# what actually happens when a browser tries. Those come apart: a table with RLS
# enabled but grants intact answers a browser with an empty array rather than a
# refusal, and an empty array is indistinguishable from "no rows yet" until the
# day it is not. Only the request settles it.
#
# KEYS ARE READ FROM THE ENVIRONMENT AND NEVER PRINTED. Nothing here echoes a
# key, and no key should be pasted into a transcript.
#
#   export SUPABASE_URL=https://<project>.supabase.co
#   export SUPABASE_ANON_KEY=...            # the publishable anon key
#   export SUPABASE_SERVICE_ROLE_KEY=...    # optional; enables the positive test
#   ./scripts/ipo_t13_live_rls.sh
#
# Exit code 0 means every expectation held.

set -uo pipefail

: "${SUPABASE_URL:?set SUPABASE_URL}"
: "${SUPABASE_ANON_KEY:?set SUPABASE_ANON_KEY}"

IPO_TABLES=(ipo_paper_positions ipo_paper_trade_history ipo_execution_events)
fails=0

say() { printf '%-6s %s\n' "$1" "$2"; }
ok()   { say "PASS" "$1"; }
bad()  { say "FAIL" "$1"; fails=$((fails+1)); }

req() {  # req <method> <path> <key> [body] -> prints HTTP status
  local method=$1 path=$2 key=$3 body=${4:-}
  if [ -n "$body" ]; then
    curl -s -o /dev/null -w '%{http_code}' -X "$method" \
      -H "apikey: $key" -H "Authorization: Bearer $key" \
      -H "Content-Type: application/json" -H "Prefer: return=minimal" \
      --data "$body" "$SUPABASE_URL/rest/v1/$path"
  else
    curl -s -o /dev/null -w '%{http_code}' -X "$method" \
      -H "apikey: $key" -H "Authorization: Bearer $key" \
      "$SUPABASE_URL/rest/v1/$path"
  fi
}

echo "=== T13: the browser roles must not reach the IPO tables ==="
for t in "${IPO_TABLES[@]}"; do
  # A refusal is 401/403 (no grant) or 404 (not exposed). A 200 is a failure even
  # with an empty body: reachable-but-empty is not the guarantee we claimed.
  code=$(req GET "$t?select=*&limit=1" "$SUPABASE_ANON_KEY")
  case "$code" in
    401|403|404) ok  "anon SELECT $t refused ($code)" ;;
    200)         bad "anon SELECT $t RETURNED 200 — the table is reachable" ;;
    *)           bad "anon SELECT $t unexpected status $code" ;;
  esac

  code=$(req POST "$t" "$SUPABASE_ANON_KEY" '{"symbol":"T13/PROBE"}')
  case "$code" in
    401|403|404) ok  "anon INSERT $t refused ($code)" ;;
    *)           bad "anon INSERT $t unexpected status $code" ;;
  esac

  code=$(req PATCH "$t?symbol=eq.T13%2FPROBE" "$SUPABASE_ANON_KEY" '{"symbol":"T13/PROBE2"}')
  case "$code" in
    401|403|404) ok  "anon UPDATE $t refused ($code)" ;;
    *)           bad "anon UPDATE $t unexpected status $code" ;;
  esac

  code=$(req DELETE "$t?symbol=eq.T13%2FPROBE" "$SUPABASE_ANON_KEY")
  case "$code" in
    401|403|404) ok  "anon DELETE $t refused ($code)" ;;
    *)           bad "anon DELETE $t unexpected status $code" ;;
  esac
done

echo
echo "=== the service role must still work, or the worker cannot run ==="
if [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  for t in "${IPO_TABLES[@]}"; do
    code=$(req GET "$t?select=*&limit=1" "$SUPABASE_SERVICE_ROLE_KEY")
    if [ "$code" = "200" ]; then ok "service_role SELECT $t ($code)"
    else bad "service_role SELECT $t got $code — the worker would fail"; fi
  done
else
  say "SKIP" "SUPABASE_SERVICE_ROLE_KEY not set; the positive half was not run"
fi

echo
echo "=== the SMC tables are untouched by this change ==="
# Not an IPO guarantee, a regression check: whatever the browser could do before
# D.2, it must still do. These are expected to be reachable under their own RLS.
for t in paper_positions pending_orders paper_trade_history; do
  code=$(req GET "$t?select=*&limit=1" "$SUPABASE_ANON_KEY")
  say "INFO" "anon SELECT $t -> $code (unchanged by D.2; recorded for the record)"
done

echo
if [ "$fails" -eq 0 ]; then
  echo "T13 PASSED — no IPO table is reachable from a browser."
else
  echo "T13 FAILED — $fails expectation(s) broken. Do not proceed to D.2 Step 2."
fi
exit "$fails"
