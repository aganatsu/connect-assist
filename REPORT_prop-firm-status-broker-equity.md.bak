# Task: Prop Firm Status — Broker Equity from MetaAPI
## Branch: manus/prop-firm-status-broker-equity

## Behavior changes

1. **Prop firm `status` endpoint now returns real MetaAPI broker equity as `currentBalance`** when the user has an active MetaAPI broker connection. Previously, `currentBalance` always came from `paper_accounts.balance`, which was corrupted ($10,205.70 instead of the real ~$100,000 FTMO demo balance). Now the endpoint fetches equity from MetaAPI cloud and uses it as the primary source.

2. **New `equitySource` field in `derived` response object.** The status response now includes `derived.equitySource` which is either `"metaapi"` (broker equity was successfully fetched) or `"paper"` (fallback to paper_accounts balance). The frontend can use this to show the user where the balance number comes from.

3. **No change for users without broker connections.** If no active MetaAPI broker connection exists, behavior is identical to before — `currentBalance` comes from `paper_accounts.balance` as it always did.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/prop-firm/index.ts` | Added `fetchBrokerEquity()` function with region-aware MetaAPI fetch (london, new-york, singapore). In the `status` action handler, added broker_connections query and MetaAPI equity fetch. `currentBalance` now uses broker equity when available, falls back to paper balance. Added `equitySource` to the `derived` response object. |
| `supabase/functions/prop-firm/propFirmStatusBrokerEquity.test.ts` | New test file with 12 tests covering: broker_connections query, fetchBrokerEquity signature, region-aware fetch, URL format, priority chain, equitySource field, graceful fallback, NaN guard, no-regression for users without broker connections, response body single-consume pattern, region cache, and user-scoped query. |

### Extra caution note for `supabase/functions/prop-firm/index.ts`

This file serves the prop firm compliance status to the frontend. The change adds a MetaAPI equity fetch to the `status` action handler. The fetch is wrapped in try/catch at two levels: (1) the `fetchBrokerEquity` function catches per-region errors and returns `undefined` on total failure, and (2) the caller catches any unexpected error from `fetchBrokerEquity` itself. If anything goes wrong, the code falls back to the existing paper_accounts balance, so the worst case is the old behavior (showing paper balance instead of broker equity). The change does NOT affect any other actions (config.get, config.save, config.delete, events, daily_history). The change does NOT modify any gate logic, trade execution, or position sizing.

## Tests added

| Test | Assertion |
|------|-----------|
| `status handler queries broker_connections for MetaAPI connection` | Verifies the status handler queries broker_connections with correct filters (broker_type=metaapi, is_active=true) |
| `fetchBrokerEquity function exists with region-aware logic` | Verifies the function signature and return type |
| `fetchBrokerEquity tries all 3 MetaAPI regions` | Verifies META_REGIONS array, regionCache, and region iteration loop |
| `MetaAPI URL uses region-aware format` | Verifies region-aware URL pattern is used, NOT the non-region variant |
| `currentBalance uses broker equity when available, falls back to paper` | Verifies `brokerEquity ?? paperBalance` priority chain |
| `derived object includes equitySource field` | Verifies equitySource is typed and included in response |
| `broker equity fetch has try/catch with graceful fallback` | Verifies both outer and inner error handling |
| `fetchBrokerEquity guards against NaN and non-positive equity` | Verifies Number.isFinite and > 0 checks |
| `users without broker connections still get paper balance` | Verifies optional chaining and paper_accounts query still present |
| `fetchBrokerEquity reads response body once` | Verifies res.text() + JSON.parse pattern (no double-consume bug) |
| `region cache stores successful region` | Verifies regionCache.set and regionCache.get |
| `broker_connections query is scoped to authenticated user` | Verifies user_id filter prevents cross-user data leaks |

## Tests run

```
ok | 544 passed | 0 failed (9s)
```

(1 pre-existing failure in `src/test/example.test.ts` due to vitest import in Deno context — not related to this change, excluded with `--ignore=src/`)

## Regression check

- The `status` action handler still queries `paper_accounts` and computes `paperBalance` identically to before.
- When `brokerEquity` is `undefined` (no broker connection, or fetch failure), `currentBalance = brokerEquity ?? paperBalance` resolves to `paperBalance` — identical to the old `currentBalance = acct ? parseFloat(acct.balance) : config.initial_balance`.
- All other actions (config.get, config.save, config.delete, events, daily_history) are untouched.
- All 544 existing tests pass.

## Open questions

1. **Frontend `equitySource` display**: The frontend (`PropFirm.tsx`) currently shows "Current Balance" without indicating the source. Should we add a small badge/label like "(MetaAPI)" or "(Paper)" next to the balance to make the source visible? This is a frontend-only change and can be done separately.

2. **Corrupted paper_accounts.balance**: The paper_accounts table still has the corrupted balance ($10,205.70). Now that the status endpoint uses MetaAPI equity, this is no longer displayed — but it may still affect other parts of the system (e.g., paper-trading P&L calculations). A SQL fix to reset it to $100,000 (or the actual initial balance from prop_firm_config) may still be needed.

3. **3 NaN entry price positions**: There are still 3 open positions with NaN entry prices from the previous bug. These should be manually closed or their entry prices corrected in the database.

## Suggested PR title and description

**Title:** `[prop-firm-status-broker-equity] Fetch real MetaAPI equity for prop firm status endpoint`

**Description:**
The prop firm compliance page was showing $10,205.70 (corrupted paper_accounts balance) instead of the real FTMO demo account equity (~$99,999.67). This PR updates the `prop-firm` edge function's `status` action to:

- Query `broker_connections` for the user's active MetaAPI connection
- Fetch real equity from MetaAPI cloud using region-aware failover (london → new-york → singapore)
- Use broker equity as `currentBalance` in the response, with graceful fallback to paper balance
- Include `equitySource: "metaapi" | "paper"` in the derived object for frontend transparency

No behavior change for users without broker connections. All 544 tests pass. 12 new tests added.
