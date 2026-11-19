# IMPULSE_STRETCH_PREREG_V1 — stop stretching the impulse when its origin breaks, pre-registered

**Written 2026-11-19, before any replay of either arm was run. Owner asked for the measurement.**

## The case

GBP/NZD 1H, long at 2.39552 on 2026-11-18 16:25 UTC, stopped −1R on 2026-11-19 03:00.
The bot's latest bullish break was 17 Nov 21:00 (close above 2.40444, peak 2.40693). Its origin,
the 2.3973 swing low (17 Nov 09:00), was closed through on 18 Nov 10:00 (2.39591), and so was
the next swing low (2.3954). `validateImpulseFromBOS` then tried older swing lows until one still
held — 2.39019 (16 Nov 07:00) — so the "impulse" became 4 breaks / 39 hours, its 71% zone fell to
2.3950, and the bot bought there seven hours after a bearish 1H CHoCH.

Reproduced exactly from the code (`supabase/tests/_shared/impulseOriginFallback.test.ts`).

## The rule under test (STRICT)

In `findImpulseLeg`, take the latest break in the trade direction and its nearest origin (the most
recent opposite swing before it whose leg is at least 3 bars). **If any candle after the leg's
extreme has closed beyond that origin, there is no leg in that direction** — no older swing, no
older break. Everything else is unchanged. Switch: `setImpulseOriginFallback(false)`.

This can remove trades (stretched legs) and, rarely, change which timeframe's zone is used.

## Test

`local-runner/impulse-stretch-replay.ts`: the corrected SMC replay (no lookahead, weekend bars
dropped, live-parity guards; costs frozen as before), now with **the owner's Bot Config** (direction
lookbacks 96, TP 2.0R, SL cap 1.5×, fib max 1, EQ-H/L 3, liquidity touches 2), close-based breaks,
live series depths (300 bars; 4h 800 → 300) and the forming bar rebuilt from closed 5m bars.

- **BASE** = current code. **STRICT** = the rule above. Same everything else.
- **IS:** 7 FX majors, decisions 2026-03-29 → 2026-09-25, 1m execution; halves split 2026-06-27.
- **OOS:** same pairs, 2024-03-01 → 2025-12-24, 5m execution; halves split 2025-01-01.
- REMOVED = BASE trades STRICT does not take (matched on symbol, direction and fill time).

## Gate — all must hold

1. IS: STRICT net expectancy > BASE, overall **and** in each half;
2. IS: REMOVED has ≥ 30 trades with net expectancy < 0 (it cuts losers, not winners);
3. IS: STRICT keeps ≥ 40% of BASE's trades;
4. OOS: STRICT net expectancy > BASE overall, and REMOVED net expectancy < 0.

Pass → a Bot Config switch ("Strict impulse origin"), **default off**; the owner decides.
Fail → no change. Before-cost results and by-pair splits are reported but not decisive.

Caveat stated up front: the replay is the SMC decision path (direction + zone engine), not every
live gate (news, sessions, unified-vs-standalone routing). Decision parity with live was 98–99% on
direction and ~100% on zone edges with the owner's config.

## Result (run 2026-11-19, after the gate above was written)

`python3 -I local-runner/impulse-stretch-report.py`

| | BASE | STRICT | REMOVED | ADDED |
|---|---|---|---|---|
| IS trades / net exp | 318 / −0.032R | 244 / **+0.024R** | 89 / −0.067R | 15 / +0.666R |
| IS 1st / 2nd half | −0.147 / +0.083 | −0.098 / +0.151 | | |
| OOS trades / net exp | 1244 / −0.069R | 937 / **−0.045R** | 345 / −0.110R | 38 / +0.154R |
| OOS 1st / 2nd half | −0.122 / −0.031 | −0.043 / −0.047 | | |

**All four gates pass.** STRICT removes ~25% of trades; the removed ones lose more than the kept
ones in both periods (IS −0.067R, OOS −0.110R), and STRICT is better in 10 of 14 pair-periods (IS 6/7, OOS 4/7).

Read with care:
- The effect is small: +0.056R IS, +0.024R OOS. Every 95% CI spans zero, and OOS 2nd half is a
  hair worse (−0.047 vs −0.031).
- Part of the IS gain is 15 ADDED trades (+0.666R). Without them STRICT is −0.018R vs −0.032R.
- It trims losses; it does not make the bot profitable (OOS still −0.045R net).

Per the gate: ship as a Bot Config switch, default off; the owner decides.

**Owner decision (2026-11-19):** after seeing the result and the GBP/NZD walkthrough
(`docs/exports/gbpnzd_strict_walkthrough_2026-11-18.png`), the owner chose to ship it **on**:
Bot Config `strategy.strictImpulseOrigin`, default true; false restores the reaching-back rule.
