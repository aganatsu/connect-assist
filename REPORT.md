# Task: Thesis Conviction Tracker
## Branch: manus/thesis-conviction-tracker
## Behavior changes

**BEHAVIOR CHANGES: none — shadow mode only (log output, no trade impact)**

The thesis conviction tracker runs in `shadow` mode by default. It evaluates conviction per pair+direction each scan cycle and logs the result, but does NOT:
- Block any trades
- Revoke impulse-zone credit
- Adjust effective scores
- Kill any thesis

To activate trade impact, set `thesisConvictionMode: "active"` in bot_configs. This is intentionally NOT done in this PR.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/thesisConviction.ts` | **NEW** — Core conviction tracker module (480 lines). Evaluates 5 evidence sources, computes conviction score, determines impulse credit decision. Includes persistence helpers for kv_cache. |
| `supabase/functions/_shared/thesisConviction.test.ts` | **NEW** — 12 unit tests covering all conviction scenarios including XAU regression test. |
| `supabase/functions/bot-scanner/index.ts` | Integration: imports module, adds config defaults, loads/persists conviction state, evaluates per pair in scan loop, logs results. Changed `runSafetyGates` config param from `typeof DEFAULTS` to `any` (was already used loosely; resolves type mismatch with pairConfig). |

## Tests added

| Test | Assertion |
|------|-----------|
| `updateConviction: first cycle with all aligned evidence → conviction stays high` | First cycle with supporting evidence keeps conviction at 100 |
| `updateConviction: opposing regime + verdict decays conviction` | Opposing 4H regime + verdict reduces conviction by expected amount |
| `updateConviction: 4 cycles of opposing evidence → impulse credit revoked` | After minCyclesForRevoke with sustained opposing evidence, credit = "revoked" |
| `updateConviction: conviction recovers when evidence flips back to supporting` | Conviction increases when evidence turns supportive after decay |
| `updateConviction: accelerated decay after 3 consecutive declines` | Decay multiplier kicks in after acceleratedDecayAfter consecutive declines |
| `XAU regression: short thesis degrades as bullish evidence accumulates` | Simulates today's XAU failure — 4 cycles of bullish evidence against short thesis → credit revoked |
| `updateConviction: first cycle cannot revoke even with all opposing evidence` | minCyclesForRevoke prevents premature revocation |
| `evaluateEvidence: handles null directionVerdict, regime, fotsi, gamePlan` | Null inputs produce delta=0 (fail-open) |
| `updateConviction: history capped at maxHistory (12)` | History array never exceeds maxHistory length |
| `buildConvictionKey: produces correct key format` | Key format matches `thesis_conviction:{userId}:{botId}:{symbol}:{direction}` |
| `updateConviction: score adjustment reflects conviction level` | scoreAdjustment matches expected penalty for each conviction zone |
| `evaluateEvidence: neutral verdict direction doesn't oppose thesis` | Neutral verdict doesn't count as opposing evidence |

## Tests run

```
$ deno test --no-check supabase/functions/_shared/thesisConviction.test.ts tests/backtest_gates_test.ts

running 12 tests from ./supabase/functions/_shared/thesisConviction.test.ts
ok | 12 passed | 0 failed (52ms)

running 17 tests from ./tests/backtest_gates_test.ts
ok | 17 passed | 0 failed (22ms)

TOTAL: ok | 29 passed | 0 failed (209ms)
```

Type check: 60 errors in bot-scanner (vs 61 on main — net reduction of 1 pre-existing error).
thesisConviction.ts: 0 type errors.

## Regression check

- **Shadow mode guarantees zero trade impact** — the module logs only, never modifies effectiveScore or blocks trades
- `runSafetyGates` type change from `typeof DEFAULTS` to `any` is safe because:
  - The function already accesses config fields via string keys and optional chaining
  - The actual runtime object always contains all DEFAULTS fields (spread at construction)
  - This resolves a pre-existing type mismatch (pairConfig has extra fields not in DEFAULTS)
- Pre-existing test count: 61 type errors on main → 60 on branch (improvement)
- All 29 tests pass (12 new conviction + 17 existing backtest gate tests)

## Open questions

1. **kv_cache table**: Does the `kv_cache` table have a `key` column (not `user_id` + `key` composite)? The module uses `key` as the primary upsert target with the format `thesis_conviction:{userId}:{botId}:{symbol}:{direction}`. If the table uses a composite key, the persistence helpers need adjustment.

2. **Activation timeline**: When do you want to switch from `shadow` to `active` mode? Recommend running shadow for 1-2 weeks to collect conviction data, then reviewing the logs to validate it would have caught bad trades without blocking good ones.

3. **Config mapper**: The thesis conviction config fields are in bot-scanner's DEFAULTS but NOT in `_shared/configMapper.ts` RUNTIME_DEFAULTS. This means they're only configurable via direct bot_configs JSON edits, not via the UI config mapper. Should I add them to configMapper.ts as well?

## Suggested PR title and description

**Title:** `[thesis-conviction-tracker] Add thesis conviction tracker — shadow mode`

**Description:**
Adds a new shared module (`thesisConviction.ts`) that tracks evidence for/against each active trading thesis across scan cycles. The tracker evaluates 5 evidence sources (direction verdict, 4H regime, opposing factors, FOTSI, game plan bias) and computes a conviction score (0-100) that determines whether impulse-zone credit should be granted, reduced, or revoked.

**Motivation:** Today's XAU trades (2 SL hits at 8:30am) entered a valid zone but the thesis had degraded over 3+ hours as bullish evidence accumulated against the short bias. No single gate catches "the thesis is dying slowly" — this module fills that gap.

**Key design decisions:**
- Shadow mode by default (logs only, no trade impact)
- Fail-open on any error (non-critical path)
- Persistence via kv_cache with 8h TTL
- Config-flagged for instant disable
- 12 unit tests including XAU regression scenario

**To activate:** Set `thesisConvictionMode: "active"` in bot_configs after reviewing shadow logs.
