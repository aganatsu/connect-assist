# Task: Thesis Validation + Rejected Setup Logging

## Branch: manus/thesis-validation-rejected-logging

## Behavior changes

1. **Pending orders are now cancelled when their trade thesis is invalidated.** Three checks run every scan cycle on each pending/awaiting_confirmation order:
   - **Direction Flip** (HARD cancel): D1/4H/1H structure reversed with ≥60% confidence
   - **FOTSI Veto** (HARD cancel): Currency exhaustion would now block this entry
   - **Game Plan Bias Reversal** (SOFT cancel): Session bias flipped with ≥60% confidence

   All checks are **fail-open**: missing data or errors keep the order alive. The feature is enabled by default (`thesisValidationEnabled` config key, defaults to `true`).

2. **Rejected setups are now logged to a new `rejected_setups` table.** Two categories:
   - `gate_blocked`: Setups that passed confluence threshold but were blocked by safety gates
   - `below_threshold_strong_t1`: Setups below threshold but with ≥2 Tier 1 factors present

3. **Outcome tracking**: A new hourly cron function (`outcome-tracker`) simulates what would have happened to rejected setups by checking if price reached entry, hit TP/SL, and calculating MFE/MAE in pips.

4. **Telegram alerts**: When a pending order is thesis-cancelled, a notification is sent. When >50% of resolved rejected setups over a rolling 7-day window would have been winners, a gate-effectiveness alert is sent.

5. **30-day retention**: The outcome-tracker automatically deletes rejected_setups records older than 30 days.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/thesisValidator.ts` | **NEW** — Thesis validation logic (3 checks, fail-open) |
| `supabase/functions/_shared/thesisValidator.test.ts` | **NEW** — 16 unit tests |
| `supabase/functions/_shared/rejectedSetupLogger.ts` | **NEW** — Non-fatal logging helper |
| `supabase/functions/_shared/rejectedSetupLogger.test.ts` | **NEW** — 10 unit tests |
| `supabase/functions/outcome-tracker/index.ts` | **NEW** — Hourly cron Edge Function |
| `supabase/functions/bot-scanner/index.ts` | Added imports, thesis validation in pending order loop, rejected setup logging in gate rejection + below-threshold paths, game plan loading for thesis validation |
| `supabase/migrations/20260523100000_create_rejected_setups.sql` | **NEW** — Creates `rejected_setups` table + adds `thesis_cancel_reason` column to `pending_orders` |
| `supabase/migrations/20260523100001_add_outcome_tracker_cron.sql` | **NEW** — pg_cron schedule for outcome-tracker (hourly at :15) |

## Caution file explanation: bot-scanner/index.ts

**What changed:** Added two import lines (thesisValidator, rejectedSetupLogger). Added a ~30-line block before the pending order loop to load the most recent game plan from scan_logs for thesis validation. Added a ~60-line thesis validation block inside the per-order loop (between SL check and zone confirmation). Added ~35 lines of rejected setup logging at the gate rejection point. Added ~30 lines of below-threshold logging before the staging section.

**Why:** These are the natural insertion points — thesis validation must run before zone confirmation (to cancel early), and rejected setup logging must run at the point where we know the setup was blocked. All additions are wrapped in try/catch with fail-open behavior and cannot affect existing trade execution paths.

## Tests added

| Test file | Count | What it asserts |
|-----------|-------|-----------------|
| `thesisValidator.test.ts` | 16 | Fail-open behavior (missing data → valid), FOTSI veto integration, GP bias reversal at various confidence levels, neutral/aligned bias passes, estimateDirectionConfidence helper, check ordering (cheapest first), custom threshold overrides |
| `rejectedSetupLogger.test.ts` | 10 | shouldLogBelowThreshold threshold (0,1,2,5 T1), correct row construction for gate_blocked and below_threshold, DB error returns false (non-fatal), exception in client returns false, default/custom bot_id |

## Tests run

```
$ deno test --allow-all
FAILED | 802 passed | 1 failed (13s)
```

The 1 failure (`bidirectionalScoring.test.ts:304 — "Regression: aligned factors still produce positive weight after bidirectional changes"`) is **pre-existing** — verified by stashing our changes and running the test on the clean branch head, which also fails. This is unrelated to our changes.

Our 26 new tests all pass:
```
$ deno test --allow-all supabase/functions/_shared/thesisValidator.test.ts supabase/functions/_shared/rejectedSetupLogger.test.ts
ok | 26 passed | 0 failed (152ms)
```

## Regression check

1. **No gate definitions modified** — the 21 gates in bot-scanner are untouched.
2. **No factor weights modified** — DEFAULT_FACTOR_WEIGHTS is not changed.
3. **No scoring logic modified** — confluenceScoring.ts is not touched.
4. **Fail-open design** — thesis validation errors/missing data never cancel orders; rejected setup logging errors never block the scanner.
5. **Existing pending order flow preserved** — expiry, SL invalidation, zone confirmation, and fill logic are all unchanged. Thesis validation is inserted between SL check and zone confirmation as an additional guard.
6. **Pre-existing test failure** — `bidirectionalScoring.test.ts:304` fails identically with and without our changes (verified via `git stash` test).

## Open questions

1. The `bidirectionalScoring.test.ts` regression test failure is pre-existing. Should this be fixed in a separate task?
2. The `outcome-tracker` cron migration uses `YOUR_PROJECT_REF` placeholder — this needs to be replaced with the actual Supabase project ref before applying to production.
3. The `rejected_setups` table migration needs to be applied (`supabase db push` or manual SQL execution).
4. Should the thesis validation Telegram notification be rate-limited or batched? Currently it sends one message per cancelled order.

## Suggested PR title and description

**Title:** feat: Add pending order thesis validation + rejected setup logging + outcome tracking

**Description:**
Adds three interconnected features to improve trade quality and provide data for gate tuning:

1. **Thesis Validation** — Pending orders are now continuously validated against current market structure. Three fail-open checks (direction flip, FOTSI veto, GP bias reversal) cancel orders whose original thesis has been invalidated, preventing entries into reversed markets.

2. **Rejected Setup Logging** — Setups blocked by gates or below threshold (with ≥2 T1 factors) are logged to a new `rejected_setups` table with full context (score, factors, FOTSI, game plan, entry/SL/TP levels).

3. **Outcome Tracker** — An hourly cron function simulates counterfactual outcomes for rejected setups, calculating MFE/MAE and whether they would have won or lost. Alerts when >50% of blocked setups would have been profitable.

All features are fail-open and non-blocking — errors in validation/logging never prevent the scanner from operating normally.

**Breaking changes:** None. Existing pending orders will naturally adopt the new flow.
**Migration required:** `20260523100000_create_rejected_setups.sql` + `20260523100001_add_outcome_tracker_cron.sql`
