# Task: Fix SL Modify Rejection Detection + Close Broker Filter

## Branch: manus/fix-sl-modify-rejection

## Behavior changes

1. **SL modify rejections are now detected and logged.** Previously, when MetaAPI returned HTTP 200 but the broker rejected the SL modification (e.g., `TRADE_RETCODE_INVALID_STOPS`, `TRADE_RETCODE_FROZEN`), the scanner logged "SL modified to X" — a false success. Now it logs a warning: `SL modify REJECTED by broker — <stringCode>: <message>`. This means you will see explicit warnings in your Edge Function logs when FTMO rejects a trailing stop move, instead of silent failures.

2. **SL/TP breach close and reverse signal close now fan out to OANDA connections** (in addition to MetaAPI). Previously, only `broker_type = "metaapi"` connections received close commands. This only affects users who have OANDA broker connections — MetaAPI-only users see no change.

## Files modified

- `supabase/functions/bot-scanner/index.ts` — Added stringCode rejection checking to MetaAPI SL modify response (lines 2111-2119). Changed `.eq("broker_type", "metaapi")` to `.in("broker_type", ["metaapi", "oanda"])` in two close sections (SL/TP breach close at line 2481, reverse signal close at line 5703).
- `supabase/functions/_shared/slModifyRejection.test.ts` — New test file (13 tests).

## Tests added

1. `SL modify: TRADE_RETCODE_INVALID_STOPS is detected as rejection` — verifies the most common FTMO rejection
2. `SL modify: TRADE_RETCODE_INVALID is detected as rejection` — invalid request detection
3. `SL modify: TRADE_RETCODE_MARKET_CLOSED is detected as rejection` — market closed detection
4. `SL modify: TRADE_RETCODE_DONE is NOT a rejection` — success case passes through
5. `SL modify: ERR_NO_ERROR is NOT a rejection` — alternative success code passes
6. `SL modify: response without stringCode is NOT a rejection (legacy format)` — backward compat
7. `SL modify: empty response body does not throw` — defensive handling
8. `SL modify: malformed JSON does not throw` — defensive handling
9. `SL modify: TRADE_RETCODE_FROZEN is detected as rejection` — freeze level rejection (common on FTMO)
10. `broker_type filter: old filter misses OANDA connections` — proves the bug existed
11. `broker_type filter: new filter includes both metaapi and oanda` — proves the fix works
12. `broker_type filter: new filter still works with metaapi-only connections` — no regression for MetaAPI users
13. `broker_type filter: new filter excludes unknown broker types` — safety check

## Tests run

```
$ deno test --allow-all supabase/functions/_shared/slModifyRejection.test.ts
running 13 tests
ok | 13 passed | 0 failed (12ms)

$ deno test --allow-all supabase/functions/_shared/calcPnl.test.ts
ok | 35 passed | 0 failed (135ms)

$ deno test --allow-all supabase/functions/_shared/confluenceScoring.test.ts
ok | 22 passed | 0 failed (103ms)
```

Note: `brokerFillPriceBE.test.ts` has 5 pre-existing failures unrelated to this change (confirmed by running on main before applying fix).

## Regression check

- The SL modify code path is additive: it only adds a `stringCode` check AFTER the existing `res.ok` check. If `res.ok` is false, behavior is unchanged. If `res.ok` is true, the new code parses the body and checks for rejection — this was previously not done at all, so there is no prior behavior to regress.
- The broker_type filter change is also additive: `.in("broker_type", ["metaapi", "oanda"])` is a superset of `.eq("broker_type", "metaapi")`. For users with only MetaAPI connections, the query returns identical results.
- Verified by running `calcPnl.test.ts` (35 tests) and `confluenceScoring.test.ts` (22 tests) — all pass.

## Open questions

1. **Should the scanner retry with adjusted SL when it gets TRADE_RETCODE_INVALID_STOPS?** Currently it just logs the rejection. A future enhancement could retry with a wider SL (e.g., add 1 more pip of buffer). This would require modifying `scannerManagement.ts` which is a protected file.

2. **Should the rejection be stored in a database table for dashboard visibility?** Currently it only appears in Edge Function logs. Adding a `broker_action_log` table would let you see rejections in the dashboard.

## Suggested PR title and description

**Title:** fix: detect MetaAPI SL modify rejections + include OANDA in close fan-out

**Description:**
Fixes two bugs in trade management broker sync:

1. **SL modify silent failures:** MetaAPI returns HTTP 200 even when the broker rejects a position modification (e.g., `TRADE_RETCODE_INVALID_STOPS` for freeze-level violations). The scanner previously only checked `res.ok` and logged success. Now it parses the response body for `stringCode` rejection codes — the same pattern already used for trade placement (line 6324). This explains why trailing stops were being "moved" in the paper system but not on MT5.

2. **Close fan-out missing OANDA:** The SL/TP breach close and reverse signal close sections only queried `broker_type = "metaapi"`, missing OANDA connections. Changed to `.in("broker_type", ["metaapi", "oanda"])` to match the pattern already used in the SL modify section (line 2017).

13 new tests added. No behavior change for correctly-functioning MetaAPI connections (success responses pass through unchanged).
