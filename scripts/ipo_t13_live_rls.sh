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
#   export SUPABASE_ANON_KEY=...            # publishable key; see the note below
#   ./scripts/ipo_t13_live_rls.sh
#
# SUPABASE_URL defaults to the project in supabase/config.toml, so the anon key
# is the only thing you have to supply.
#
# THE ANON KEY IS NOT A SECRET. It is compiled into the frontend bundle that
# every visitor downloads; its whole security model is that it grants nothing
# RLS and grants do not already allow. That is exactly what this script checks.
# The SERVICE ROLE key is a different matter and is optional here — set it only
# if you want the positive half, and never paste it into a transcript.
#
# Exit code 0 means every expectation held.

set -uo pipefail

# Default the URL from the project ref the repo already declares.
if [ -z "${SUPABASE_URL:-}" ] && [ -r supabase/config.toml ]; then
  REF=$(grep -m1 '^project_id' supabase/config.toml | cut -d'"' -f2)
  [ -n "$REF" ] && SUPABASE_URL="https://$REF.supabase.co"
fi
: "${SUPABASE_URL:?could not determine SUPABASE_URL}"
: "${SUPABASE_ANON_KEY:?set SUPABASE_ANON_KEY (the publishable key — it is not a secret)}"

IPO_TABLES=(ipo_paper_positions ipo_paper_trade_history ipo_execution_events)
fails=0

say() { printf '%-6s %s\n' "$1" "$2"; }
ok()   { say "PASS" "$1"; }
bad()  { say "FAIL" "$1"; fails=$((fails+1)); }

# Returns "<status> <body>" so the REASON can be checked, not just the code.
req() {  # req <method> <path> <key> [body]
  local method=$1 path=$2 key=$3 body=${4:-} out
  if [ -n "$body" ]; then
    out=$(curl -s -w '\n%{http_code}' -X "$method" \
      -H "apikey: $key" -H "Authorization: Bearer $key" \
      -H "Content-Type: application/json" -H "Prefer: return=minimal" \
      --data "$body" "$SUPABASE_URL/rest/v1/$path")
  else
    out=$(curl -s -w '\n%{http_code}' -X "$method" \
      -H "apikey: $key" -H "Authorization: Bearer $key" \
      "$SUPABASE_URL/rest/v1/$path")
  fi
  printf '%s %s' "$(printf '%s' "$out" | tail -n1)" "$(printf '%s' "$out" | sed '$d' | tr -d '\n')"
}

# A refusal must be a PERMISSION refusal. An invalid key also returns 401, and
# it would make every assertion below pass while proving nothing — so the reason
# is checked, not just the status.
refused() {  # refused <status+body>
  case "$1" in
    *"Invalid API key"*) return 1 ;;
    401*|403*|404*)      return 0 ;;
    *)                   return 1 ;;
  esac
}

# ── the key must actually work, or the whole test is vacuous ─────────────────
echo "=== precondition: the key is valid ==="
probe=$(req GET "paper_positions?select=id&limit=1" "$SUPABASE_ANON_KEY")
case "$probe" in
  200*) ok "the anon key is accepted (a known-reachable table returns 200)" ;;
  *"Invalid API key"*)
    bad "the anon key is INVALID — every refusal below would be meaningless"
    echo; echo "T13 ABORTED."; exit 1 ;;
  *) bad "unexpected precondition response: ${probe:0:120}"
     echo; echo "T13 ABORTED."; exit 1 ;;
esac

echo
echo "=== T13: the browser roles must not reach the IPO tables ==="
for t in "${IPO_TABLES[@]}"; do
  # A refusal must be 401/403 (no grant) or 404 (not exposed), AND must not be
  # an invalid-key error. A 200 is a failure even with an empty body:
  # reachable-but-empty is not the guarantee we claimed.
  for probe in \
      "GET|$t?select=*&limit=1|" \
      "POST|$t|{\"symbol\":\"T13/PROBE\"}" \
      "PATCH|$t?symbol=eq.T13%2FPROBE|{\"symbol\":\"T13/PROBE2\"}" \
      "DELETE|$t?symbol=eq.T13%2FPROBE|"; do
    m=${probe%%|*}; rest=${probe#*|}; path=${rest%%|*}; payload=${rest#*|}
    r=$(req "$m" "$path" "$SUPABASE_ANON_KEY" "$payload")
    if refused "$r"; then
      ok "anon $m $t refused (${r%% *})"
    elif [ "${r%% *}" = "200" ] || [ "${r%% *}" = "201" ] || [ "${r%% *}" = "204" ]; then
      bad "anon $m $t SUCCEEDED (${r%% *}) — the table is reachable"
    else
      bad "anon $m $t not a permission refusal: ${r:0:140}"
    fi
  done
done

echo
echo "=== the service role must still work, or the worker cannot run ==="
if [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  for t in "${IPO_TABLES[@]}"; do
    r=$(req GET "$t?select=*&limit=1" "$SUPABASE_SERVICE_ROLE_KEY")
    if [ "${r%% *}" = "200" ]; then ok "service_role SELECT $t (200)"
    else bad "service_role SELECT $t got ${r:0:100} — the worker would fail"; fi
  done
else
  say "SKIP" "SUPABASE_SERVICE_ROLE_KEY not set; the positive half was not run"
fi

echo
echo "=== control: the SMC tables are UNCHANGED, and the key demonstrably works ==="
# This is an assertion, not a note. If these also refused, the IPO refusals above
# would be explained by a broken key rather than by the grants — the test would
# look green while proving nothing. They must succeed.
for t in paper_positions pending_orders paper_trade_history; do
  r=$(req GET "$t?select=*&limit=1" "$SUPABASE_ANON_KEY")
  if [ "${r%% *}" = "200" ]; then
    ok "anon SELECT $t -> 200 (reachable, as before D.2)"
  else
    bad "anon SELECT $t -> ${r:0:100} — D.2 changed SMC reachability, or the key is bad"
  fi
done

echo
if [ "$fails" -eq 0 ]; then
  echo "T13 PASSED — no IPO table is reachable from a browser."
else
  echo "T13 FAILED — $fails expectation(s) broken. Do not proceed to D.2 Step 2."
fi
exit "$fails"
