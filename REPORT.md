# Task: Direction Hysteresis + Prop Firm Safety Fixes

## Branch: manus/direction-hysteresis

## Behavior changes

1. **Direction engine hysteresis (paths 3 & 4 in `determineDirection`):** When the 4H is retracing and the 1H has no recent confirming BOS, the engine no longer nullifies direction. Instead it checks for an **opposing 1H CHoCH**. If no opposing CHoCH exists, direction is maintained. If an opposing CHoCH is found, direction is nullified. This prevents flip-flopping when a BOS simply ages out of the lookback window.

2. **`useSimpleDirection` now defaults to `true` for all pairs.** Previously defaulted to `false`, meaning the old `confluenceScoring.ts` P/D logic determined direction. Now all pairs use the ICT top-down direction engine (Daily→4H→1H) with hysteresis, unless explicitly overridden to `false` in the database/strategy config. This means:
   - Pairs like BTC/USD and ETH/USD that previously showed "No direction determined" will now get a direction from the new engine.
   - More pairs will proceed to impulse zone detection where they previously were skipped.
   - Any pair with `useSimpleDirection: false` explicitly set in the database will continue to use the old logic (the DB value takes precedence over the default).

3. **Prop firm gate: live accounts skip check when broker equity unavailable.** Previously, if the MetaApi equity fetch failed, the system fell back to paper_accounts balance (often wrong for live accounts). Now it skips the prop firm check entirely and logs a warning. This prevents false emergency closes caused by comparing a $10K paper balance against a $90K drawdown floor.

4. **Prop firm gate: equity sanity check.** If `currentEquity < 50% of initial_balance`, the check is skipped with a warning. This catches obvious data errors (stale prices, wrong account source) before they trigger emergency actions.

5. **Prop firm emergency close: weekend FX guard.** When FX market is closed (weekends), emergency close only affects crypto positions. FX positions are left untouched since they can't be executed on weekends anyway and stale prices could produce incorrect P&L calculations.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/directionEngine.ts` | Added hysteresis logic to paths 3 and 4: check for opposing 1H CHoCH before nullifying direction. |
| `supabase/functions/_shared/directionEngine.test.ts` | Updated existing test for non-deterministic data; added 4 hysteresis regression tests + 2 guard tests for the default config. |
| `supabase/functions/_shared/propFirmGate.ts` | Added: (1) live account safety skip when broker equity unavailable, (2) equity sanity check (<50% of initial_balance), (3) weekend FX guard in emergency close. |
| `supabase/functions/_shared/propFirmGate.test.ts` | **New file:** 7 tests covering all three prop firm safety fixes. |
| `supabase/functions/bot-scanner/index.ts` **(CAUTION FILE)** | (1) `useSimpleDirection` default changed to `true` (line 167 + line 773 fallback). (2) Passed `isLiveAccount` and `fxMarketClosed` to prop firm gate functions. |

## bot-scanner/index.ts changes (caution file — detailed explanation)

**What changed:** Four modifications in `bot-scanner/index.ts`:

- **Line 167 (DEFAULTS object):** `useSimpleDirection: false` → `true`. Default config for all pairs.
- **Line 773 (config merge):** `?? false` → `?? true`. Per-pair config builder fallback.
- **Line 2805 (runPropFirmGate call):** Added `isLiveAccount: account.execution_mode === "live"` and `fxMarketClosed` to the options object.
- **Line 2816 (propFirmEmergencyClose call):** Added `{ fxMarketClosed }` options parameter.

**Why:** 
- Lines 167/773: Activates the direction engine fleet-wide (see behavior change #2).
- Lines 2805/2816: Passes context needed for the prop firm safety guards. Without `isLiveAccount`, the gate can't distinguish between a live account with failed equity fetch vs a paper account. Without `fxMarketClosed`, the emergency close can't skip FX positions on weekends.

**No gate definitions, factor weights, or smcAnalysis.ts were modified.**

## Tests added

| Test | Assertion |
|------|-----------|
| `HYSTERESIS: direction maintained when 1H BOS rolls off but no opposing CHoCH` | Daily bullish + 4H retracing + 1H flat → direction = "long" (not null) |
| `HYSTERESIS: direction nullified when 1H CHoCH against bias appears` | Daily bullish + 4H retracing + 1H bearish CHoCH → direction = null |
| `HYSTERESIS: consecutive scans without 1H confirmation produce stable direction` | Two identical calls produce identical direction (no flip-flop) |
| `HYSTERESIS: source code contains hysteresis check for opposing CHoCH` | Structural guard verifying key variables/comments exist in source |
| `GUARD: bot-scanner DEFAULTS has useSimpleDirection = true` | Reads bot-scanner source, verifies DEFAULTS object has `useSimpleDirection: true` |
| `GUARD: bot-scanner config merge falls back to useSimpleDirection = true` | Reads bot-scanner source, verifies config merge line falls back to `true` |
| `propFirmGate: live account without broker equity skips check (safety)` | Live account + no broker equity → allowed=true, reason includes "Broker equity unavailable" |
| `propFirmGate: live account WITH broker equity proceeds normally` | Live account + valid equity → full compliance check runs |
| `propFirmGate: equity sanity check blocks false emergency (paper mode)` | Equity $10K vs initial $100K → skipped, reason includes "sanity check failed" |
| `propFirmGate: equity at 60% of initial_balance passes sanity check` | Equity $60K vs initial $100K → proceeds to normal check |
| `propFirmEmergencyClose: weekend skips FX positions, only closes crypto` | fxMarketClosed=true → only BTCUSD closed, EURUSD/GBPUSD/USDCAD skipped |
| `propFirmEmergencyClose: weekday closes all positions` | fxMarketClosed=false → all positions closed |
| `propFirmEmergencyClose: no opts (backward compat) closes all` | No opts → all positions closed (backward compatible) |

## Tests run

```
$ deno test --no-check --allow-read --allow-net --allow-env --ignore="src/test/example.test.ts"
ok | 478 passed | 0 failed (8s)
```

## Regression check

1. **Direction engine:** Deterministic fixture tests prove that when 1H has no structure breaks, direction is maintained (new behavior). When opposing CHoCH exists, direction is nullified (same as before). All other paths (daily bias, 4H CHoCH, 1H confirmed) produce identical results.
2. **Prop firm gate:** Tests verify that live accounts with valid broker equity still proceed through full compliance checks. Paper accounts with realistic equity (>50% of initial) still trigger real drawdown/daily loss checks. The sanity guard only fires on obviously bad data.
3. **Emergency close:** Tests verify that weekday behavior is unchanged (all positions closed). Only weekend behavior changes (FX positions skipped).
4. **Full suite:** 478 tests pass. The `impulseZoneEngine.test.ts:949` test is flaky (passes alone, occasionally fails in batch) — confirmed pre-existing on `main`.

## Open questions

1. **Crypto symbol detection:** The weekend FX guard uses a hardcoded set of crypto symbols (`BTCUSD`, `ETHUSD`, `XRPUSD`, etc.). Should this use `SPECS[symbol].type === "crypto"` instead? (I avoided importing SPECS into propFirmGate.ts to keep it decoupled.)

2. **Sanity threshold:** The 50% threshold is conservative. A real FTMO account can lose up to 10% (max drawdown). Should this be tightened to 70%? Or configurable per prop firm config?

3. **Per-pair DB overrides:** Any pair that has `useSimpleDirection: false` explicitly in the database will still use the old logic. Should those be cleaned up?

4. **Pre-existing flaky test:** `impulseZoneEngine.test.ts:949` occasionally fails in batch runs. Unrelated but should be investigated separately.

## Suggested PR title and description

**Title:** `feat: direction hysteresis + prop firm safety guards`

**Description:**

Two related fixes for the live trading bot:

### 1. Direction Engine Hysteresis
Fixes direction flip-flopping caused by 1H BOS aging out of the lookback window. Direction is now only nullified when an active opposing 1H CHoCH is detected. Also enables `useSimpleDirection=true` fleet-wide.

### 2. Prop Firm Safety Guards (Bug Fix)
On Saturday 05/10, the prop firm gate falsely triggered emergency close on two profitable USD/CAD positions because:
- MetaApi equity fetch failed → fell back to paper balance ($10K vs real $100K)
- Compared $10K against $90K drawdown floor → triggered emergency
- Closed FX positions on a weekend (market closed)

Fixes:
- Live accounts: skip prop firm check entirely if broker equity unavailable
- Sanity check: skip if equity < 50% of initial_balance (obvious data error)
- Weekend guard: emergency close only affects crypto positions when FX is closed

**Testing:** 478 tests pass. 13 new tests covering all changes.
