#!/usr/bin/env bash
# Proves the LIVE IPO schema enforces the paper contract, not just that the
# migration file says so.
#
# Every row is namespaced strategy_id='ipo_fixture_validation' and deleted at
# both ends of the run, so it cannot mix with real paper data. It asserts both
# directions: the shapes the contract produces are ACCEPTED, and the shapes it
# must never produce are REJECTED by the database rather than by convention.
#
#   cd local-runner && set -a && . ./.env.local && set +a && bash ../scripts/ipo_schema_constraint_proof.sh
#
# Keys come from the environment and are never printed.

U="$SUPABASE_URL/rest/v1"
H=(-H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Content-Type: application/json")
NS="ipo_fixture_validation"
USER="57c79dee-db6b-4fae-b34a-4b64ce33ca34"

cleanup() {
  for t in ipo_execution_events ipo_paper_trade_history ipo_paper_positions; do
    curl -s -o /dev/null -X DELETE "${H[@]}" "$U/$t?strategy_id=eq.$NS"
  done
}
post() { curl -s -w '\n%{http_code}' -X POST "${H[@]}" -H "Prefer: return=minimal" --data "$2" "$U/$1"; }
check() { # check <label> <expect: OK|REJECT> <status+body>
  local code; code=$(printf '%s' "$3" | tail -n1); local body; body=$(printf '%s' "$3" | sed '$d' | tr -d '\n')
  if [ "$2" = "OK" ]; then
    [ "$code" = "201" ] && echo "  PASS  $1 (accepted)" || { echo "  FAIL  $1 -> $code ${body:0:150}"; FAILED=1; }
  else
    case "$code" in
      4*) echo "  PASS  $1 (rejected $code: $(printf '%s' "$body" | python3 -c 'import sys,json;d=json.load(sys.stdin);print((d.get("message") or "")[:90])' 2>/dev/null))" ;;
      *)  echo "  FAIL  $1 was ACCEPTED ($code) — the constraint is not enforced"; FAILED=1 ;;
    esac
  fi
}
FAILED=0
cleanup
echo "=== history: a real TARGET_2R row ==="
check "TARGET_2R history" OK "$(post ipo_paper_trade_history '{"strategy_id":"'$NS'","strategy_version":"spec-1.1","setup_id":"stp_t","intent_id":"int_t","user_id":"'$USER'","symbol":"EUR/USD","timeframe":"1h","direction":"long","entry_time":"2026-01-05T00:00:00Z","entry_price":98.27791,"target_price":101.77847,"s2_invalidation_level":96.52763,"nominal_risk_distance":1.75028,"cost_r":0.0001,"reference_balance_at_entry":100000,"nominal_risk_pct":0.20,"nominal_risk_usd":200,"exit_time":"2026-01-05T01:00:00Z","exit_price":101.77847,"exit_reason":"TARGET_2R","realized_r":1.9999,"gross_r":2,"realized_pnl_usd":399.98,"mae_r":0.26,"mfe_r":2.1,"bars_held":1,"same_bar_ambiguous":false,"excluded_from_stats":false}')"

echo "=== history: a real S2 row losing more than 1R ==="
check "S2 history (-1.9474R)" OK "$(post ipo_paper_trade_history '{"strategy_id":"'$NS'","strategy_version":"spec-1.1","setup_id":"stp_s","intent_id":"int_s","user_id":"'$USER'","symbol":"EUR/USD","timeframe":"1h","direction":"short","entry_time":"2026-01-06T00:00:00Z","entry_price":97.84366,"target_price":96.29610,"s2_invalidation_level":98.61744,"nominal_risk_distance":0.77378,"cost_r":0.0002,"reference_balance_at_entry":100000,"nominal_risk_pct":0.20,"nominal_risk_usd":200,"exit_time":"2026-01-06T01:00:00Z","exit_price":99.35033,"exit_reason":"S2_CLOSE_INVALIDATION","realized_r":-1.9474,"gross_r":-1.9472,"realized_pnl_usd":-389.49,"mae_r":3.35,"mfe_r":0.4,"bars_held":1,"same_bar_ambiguous":false,"excluded_from_stats":false}')"

echo "=== history: a coherent DATA_GAP_ABORTED row ==="
check "abort, no price no R" OK "$(post ipo_paper_trade_history '{"strategy_id":"'$NS'","strategy_version":"spec-1.1","setup_id":"stp_g","intent_id":"int_g","user_id":"'$USER'","symbol":"EUR/USD","timeframe":"1h","direction":"long","entry_time":"2026-01-07T00:00:00Z","entry_price":100,"target_price":102,"s2_invalidation_level":99,"nominal_risk_distance":1,"cost_r":0,"reference_balance_at_entry":100000,"nominal_risk_pct":0.20,"nominal_risk_usd":200,"exit_time":"2026-01-21T00:00:00Z","exit_price":null,"exit_reason":"DATA_GAP_ABORTED","realized_r":null,"gross_r":null,"realized_pnl_usd":null,"mae_r":0.5,"mfe_r":0.2,"bars_held":0,"same_bar_ambiguous":false,"excluded_from_stats":true,"exclusion_reason":"FEED_STALE: no usable bars","gap_from_bar_time":"2026-01-07T05:00:00Z"}')"

echo "=== history: the incoherent shapes the CHECK must refuse ==="
check "abort WITH a realized R" REJECT "$(post ipo_paper_trade_history '{"strategy_id":"'$NS'","strategy_version":"spec-1.1","setup_id":"stp_x1","intent_id":"int_x1","user_id":"'$USER'","symbol":"EUR/USD","timeframe":"1h","direction":"long","entry_time":"2026-01-08T00:00:00Z","entry_price":100,"target_price":102,"s2_invalidation_level":99,"nominal_risk_distance":1,"cost_r":0,"reference_balance_at_entry":100000,"nominal_risk_pct":0.20,"nominal_risk_usd":200,"exit_time":"2026-01-08T01:00:00Z","exit_price":101,"exit_reason":"DATA_GAP_ABORTED","realized_r":1.0,"gross_r":1.0,"realized_pnl_usd":200,"mae_r":0,"mfe_r":1,"bars_held":1,"same_bar_ambiguous":false,"excluded_from_stats":true,"exclusion_reason":"x"}')"
check "abort NOT excluded" REJECT "$(post ipo_paper_trade_history '{"strategy_id":"'$NS'","strategy_version":"spec-1.1","setup_id":"stp_x2","intent_id":"int_x2","user_id":"'$USER'","symbol":"EUR/USD","timeframe":"1h","direction":"long","entry_time":"2026-01-09T00:00:00Z","entry_price":100,"target_price":102,"s2_invalidation_level":99,"nominal_risk_distance":1,"cost_r":0,"reference_balance_at_entry":100000,"nominal_risk_pct":0.20,"nominal_risk_usd":200,"exit_time":"2026-01-09T01:00:00Z","exit_price":null,"exit_reason":"DATA_GAP_ABORTED","realized_r":null,"excluded_from_stats":false,"exclusion_reason":"x","mae_r":0,"mfe_r":0,"bars_held":0,"same_bar_ambiguous":false}')"
check "real exit with NULL R" REJECT "$(post ipo_paper_trade_history '{"strategy_id":"'$NS'","strategy_version":"spec-1.1","setup_id":"stp_x3","intent_id":"int_x3","user_id":"'$USER'","symbol":"EUR/USD","timeframe":"1h","direction":"long","entry_time":"2026-01-10T00:00:00Z","entry_price":100,"target_price":102,"s2_invalidation_level":99,"nominal_risk_distance":1,"cost_r":0,"reference_balance_at_entry":100000,"nominal_risk_pct":0.20,"nominal_risk_usd":200,"exit_time":"2026-01-10T01:00:00Z","exit_price":102,"exit_reason":"TARGET_2R","realized_r":null,"excluded_from_stats":false,"mae_r":0,"mfe_r":2,"bars_held":1,"same_bar_ambiguous":false}')"
check "duplicate intent_id" REJECT "$(post ipo_paper_trade_history '{"strategy_id":"'$NS'","strategy_version":"spec-1.1","setup_id":"stp_t","intent_id":"int_t","user_id":"'$USER'","symbol":"EUR/USD","timeframe":"1h","direction":"long","entry_time":"2026-01-05T00:00:00Z","entry_price":98,"target_price":101,"s2_invalidation_level":96,"nominal_risk_distance":1,"cost_r":0,"reference_balance_at_entry":100000,"nominal_risk_pct":0.20,"nominal_risk_usd":200,"exit_time":"2026-01-05T01:00:00Z","exit_price":101,"exit_reason":"TARGET_2R","realized_r":2,"gross_r":2,"realized_pnl_usd":400,"mae_r":0,"mfe_r":2,"bars_held":1,"same_bar_ambiguous":false,"excluded_from_stats":false}')"

echo "=== positions: one open per strategy/symbol, paper only ==="
POS='{"strategy_id":"'$NS'","strategy_version":"spec-1.1","setup_id":"stp_p","intent_id":"int_p1","user_id":"'$USER'","symbol":"EUR/USD","timeframe":"1h","direction":"long","entry_time":"2026-01-11T00:00:00Z","entry_price":100,"target_price":102,"s2_invalidation_level":99,"nominal_risk_distance":1,"cost_r":0,"reference_balance_at_entry":100000,"nominal_risk_pct":0.20,"nominal_risk_usd":200,"ipo_candle_time":"2026-01-10T00:00:00Z","volatility_bucket":"MID_VOL","status":"open","mae_r":0,"mfe_r":0,"last_managed_bar_time":"2026-01-11T00:00:00Z"}'
check "first open position" OK "$(post ipo_paper_positions "$POS")"
check "SECOND open, same symbol" REJECT "$(post ipo_paper_positions "$(printf '%s' "$POS" | sed 's/int_p1/int_p2/;s/stp_p/stp_p2/')")"
check "execution_mode=live" REJECT "$(post ipo_paper_positions "$(printf '%s' "$POS" | sed 's/int_p1/int_p3/;s/"status":"open"/"status":"open","execution_mode":"live"/;s/"symbol":"EUR\/USD"/"symbol":"USD\/JPY"/')")"

echo "=== events: append-only audit, unique event_id ==="
EV='{"event_id":"evt_fixture_1","strategy_id":"'$NS'","strategy_version":"spec-1.1","setup_id":"stp_t","intent_id":"int_t","user_id":"'$USER'","symbol":"EUR/USD","bar_time":"2026-01-05T00:00:00Z","event_type":"FILLED","strategy_decision":"WOULD_ENTER","account_decision":"UNAVAILABLE","reason_codes":[],"payload":{}}'
check "event insert" OK "$(post ipo_execution_events "$EV")"
check "duplicate event_id" REJECT "$(post ipo_execution_events "$EV")"
check "unknown event_type" REJECT "$(post ipo_execution_events "$(printf '%s' "$EV" | sed 's/evt_fixture_1/evt_fixture_2/;s/"FILLED"/"BROKER_ORDER_SENT"/')")"

echo
echo "=== cleanup ==="
cleanup
for t in ipo_paper_positions ipo_paper_trade_history ipo_execution_events; do
  n=$(curl -s -o /dev/null -D- "${H[@]}" -H "Prefer: count=exact" -H "Range: 0-0" "$U/$t?select=id&strategy_id=eq.$NS" | grep -i content-range | tr -d '\r' | sed 's|.*/||')
  printf "  %-26s fixture rows remaining: %s\n" "$t" "$n"
done
exit $FAILED
