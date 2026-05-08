# Task: Bidirectional Scoring — Factors Communicate Direction

## Branch: manus/bidirectional-scoring

## Behavior changes

1. **Reversal candle opposing penalty**: A bearish reversal candle on a long entry (or bullish on short) now scores **-0.5** (with displacement) or **-0.25** (without displacement) instead of the previous +0.25 to +1.5. Aligned reversals still score positively as before.

2. **AMD opposing penalty**: When AMD detects a bias opposing the trade direction, it now penalizes **-0.5** (distribution phase) or **-0.3** (other phases) instead of scoring 0. Aligned AMD still scores +1.0 to +1.5.

3. **P/D zone direction fallback removed**: When the entry timeframe is ranging AND daily has no BOS AND fractals are balanced, the system now returns `direction = null` (no trade) instead of using Premium/Discount zone to generate a direction. This eliminates the "buying in discount during a breakdown" failure mode.

4. **OB direction mismatch penalty increased**: Price inside an opposing OB now scores at x0.25 of max (was x0.3), making the penalty slightly stronger.

5. **config.direction override**: The scoring function now accepts an explicit `config.direction` field. When set (by bot-scanner or tests), it overrides the internal direction determination.

## Files modified

- `supabase/functions/_shared/confluenceScoring.ts` — Reversal candle bidirectional logic (Factor 8), AMD opposing penalty (Factor 17), P/D zone fallback removal, OB mismatch increase, config.direction override, AMD factor weight fix for negative pts
- `supabase/functions/_shared/confluenceScoring.test.ts` — Updated fixture tests to accept null direction, updated assertExists for direction field
- `supabase/functions/_shared/bidirectionalScoring.test.ts` — NEW: 7 regression tests for all bidirectional scoring changes
- `supabase/functions/_shared/__snapshots__/*.json` — Regenerated snapshots reflecting new scoring behavior

## Tests added

1. **Bearish reversal on LONG produces penalty** — verifies opposing reversal candle gets negative weight or OPPOSES detail
2. **Bullish reversal on LONG produces positive score** — verifies aligned reversal still scores positively (no regression)
3. **P/D zone direction fallback code is removed** — source code verification that old P/D fallback patterns are gone
4. **AMD opposing bias produces penalty** — verifies AMD with opposing bias gets negative weight
5. **OB direction mismatch penalty text says x0.25** — verifies increased penalty in source
6. **Reversal candle with direction=null scores normally** — verifies no penalty when direction is undetermined
7. **Bidirectional reversal logic exists in source** — verifies code comments and variable names exist

## Tests run

```
322 passed | 1 failed (pre-existing src/test/example.test.ts Vitest internal error — unrelated)
```

## Regression check

- Snapshot tests regenerated and verified stable on second run (bullish, bearish, ranging fixtures)
- All 322 tests pass (excluding pre-existing Vitest internal error)
- Direction override does NOT affect existing bot-scanner flow (bot-scanner doesn't pass config.direction currently)
- Falling knife guard becomes redundant (P/D fallback removed) but left in place as defense-in-depth

## Extra caution note (confluenceScoring.ts)

This change modifies live scoring behavior in four ways:
1. Reversal candles opposing direction now penalize — trades with bearish reversals at OBs while going long will score lower
2. AMD opposing direction now penalizes — trades during distribution phase opposing your direction will score lower
3. P/D zone no longer generates direction for ranging markets — fewer trades will be taken
4. OB mismatch is slightly more penalized

Net effect: **Fewer trades, higher quality.** The specific trade shown by the user (long in a bullish OB with bearish reversal candle, AMD distribution, ranging market) would now be blocked.

## Open questions

1. **Falling knife guard redundancy**: With P/D fallback removed, the falling knife guard (Fix #6) is now unreachable. Remove for clarity or keep as defense-in-depth?
2. **bot-scanner direction flow**: Should bot-scanner pass its pre-determined direction via `config.direction` to get accurate bidirectional penalties?

## Suggested PR title and description

**Title:** feat: Bidirectional scoring — factors penalize when opposing trade direction

**Description:**
Factors now communicate directional opinions instead of operating in silos. When a factor detects a signal opposing the trade direction, it penalizes the score instead of scoring 0 (neutral).

Changes:
- Reversal candle: +1 aligned, -0.5 opposing (with displacement) / -0.25 (without)
- AMD phase: +1.5 aligned, -0.5 opposing (distribution) / -0.3 (other)
- P/D zone direction fallback removed (ranging + no BOS = no trade)
- OB mismatch penalty: x0.3 -> x0.25
- config.direction override for explicit direction passing

Fixes the scenario where a bearish reversal candle at an OB during a long entry scored +1.0 (rewarding a contradiction) instead of penalizing it.
