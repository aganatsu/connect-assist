# Task: Self-Contradiction Audit
## Branch: manus/self-contradiction-audit

## Behavior changes

1. **Reversal Candle factor now scores 0 when the candle direction opposes the trade direction.** Previously, a bearish pin bar could score up to 1.5 points on a long trade (or vice versa). Now, a bearish reversal on a long trade (or bullish reversal on a short trade) scores 0 with detail "OPPOSES {direction} direction — no score". This removes false-positive confluence inflation from counter-directional reversal candles.

2. **Gate 17 reason string updated (cosmetic/debugging only).** Changed from `"FOTSI PENALTY (-2.0 applied)"` to `"FOTSI WARNING (-2.0 penalty applied to effectiveScore)"`. No functional change — the penalty was always applied downstream at line ~3756, not by the gate itself.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/confluenceScoring.ts` | Added directional alignment check to Factor 8 (Reversal Candle). Bearish reversal on long trade (or vice versa) now scores 0 instead of up to 1.5. |
| `supabase/functions/bot-scanner/index.ts` | Clarified Gate 17 reason string to accurately reflect that the -2.0 penalty is applied downstream, not by the gate itself. |
| `supabase/functions/_shared/reversalCandleAlignment.test.ts` | New test file verifying the directional alignment fix. |
| `AUDIT_FINDINGS.md` | Full audit report documenting all 10 findings across 4 categories. |
| `REPORT.md` | This file. |

### Extra caution note: bot-scanner/index.ts

The change is a single-line string replacement in Gate 17's reason message. No control flow, no gate logic, no scoring logic modified. The gate still always passes (it's informational). The -2.0 penalty application at line ~3756 is untouched.

### Extra caution note: confluenceScoring.ts

The change wraps the existing Factor 8 scoring block in a directional alignment check. If the reversal candle type does NOT match the trade direction, we short-circuit to `pts = 0`. If it DOES match (or direction is null), the existing scoring logic runs unchanged. No other factors are affected.

## Tests added

| Test | Assertion |
|------|-----------|
| `Reversal Candle: bearish reversal on LONG trade scores 0 (directional mismatch)` | Bearish pin bar at end of uptrend → factor.present = false, detail includes "OPPOSES" |
| `Reversal Candle: bullish reversal on LONG trade scores > 0 (directional match)` | Bullish pin bar at end of pullback in uptrend → factor.present = true, no "OPPOSES" |
| `Reversal Candle: no direction (null) allows any reversal to score` | Ranging market with no direction → reversal not blocked by alignment check |

## Tests run

```
$ deno test --allow-all --no-check supabase/functions/_shared/
ok | 379 passed | 0 failed (7s)
```

## Regression check

1. Ran the full existing `confluenceScoring.test.ts` suite (17 tests) — all pass.
2. Ran all 379 tests in `_shared/` — all pass.
3. The fix is strictly subtractive: it only adds a check that can reduce a score from >0 to 0. It cannot increase any score or change any gate behavior. Existing trades that had aligned reversal candles continue to score identically.
4. Verified on base branch (git stash) that the intermittent `impulseZoneEngine.test.ts` failure is pre-existing and unrelated (passes when run in isolation, fails intermittently in parallel due to test ordering).

## Open questions

1. **Pre-existing flaky test** (`findImpulseLeg — ETH-like bearish impulse`): Intermittently fails when run in parallel with all other tests. Passes in isolation. Unrelated to this change. Should be investigated separately.

2. **HTF POI double-scoring** (Finding 3 in AUDIT_FINDINGS.md): The same 4H OB/FVG can contribute to both the HTF POI Alignment factor score AND the impulse zone's htfConfluenceScore. Documented as intentional (different questions), but flagged for awareness.

## Suggested PR title and description

**Title:** `[self-contradiction-audit] Fix reversal candle scoring counter-directional setups`

**Description:**
Systematic audit of all 21 gates, 18+ scoring factors, impulse zone engine, and FOTSI penalty system for self-contradictions.

**Fix:** Reversal Candle factor (Factor 8) now checks directional alignment before scoring. A bearish reversal candle on a long trade (or vice versa) scores 0 instead of up to 1.5 points. This prevents counter-directional reversal candles from inflating confluence scores and pushing marginal trades over the minimum threshold.

**Cosmetic:** Gate 17 reason string clarified to accurately reflect that the -2.0 FOTSI penalty is applied downstream to effectiveScore, not by the gate itself.

**Full audit findings:** See `AUDIT_FINDINGS.md` for the complete 10-finding report covering contradictions, redundancies, and confirmed non-issues.

**Tests:** 3 new + 376 existing = 379 total, all passing.
