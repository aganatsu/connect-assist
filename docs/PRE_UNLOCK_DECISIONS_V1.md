# Pre-unlock decisions (open; not changed in Step 16)

Both behaviours below **run today** and are part of what the dry run measures. Neither is endorsed as final strategy logic. Each needs a decision, and possibly a fix, **before entries are unlocked**. Step 16 changes neither.

## 1. Route 2 fill vs the stop floor

**Detail:** `ROUTE2_FILL_FLOOR_POLICY_OPEN_V1.md`.

- **Placement:** the stop is anchored to the limit with `|limit − stop| ≥ floor`. The floor is **per pair**: 25 pips on GBP/USD, USD/JPY and CHF/JPY; 20 pips on EUR/USD, NZD/CAD and NZD/CHF (`MIN_SL_PIPS`, `sh/smcAnalysis.ts:2619`).
- **Fill:** the hunt fills at the confirmation price and the stop does not move. So a better-than-limit fill sits closer to the stop than the floor.
- Fill-time sizing keeps dollar risk at 0.5% either way.

**Measured:** all dry-run fills, 2026-10-06 → 10-07. Recorded `fill_sizing`, or `dry_run_context`; the first 4 orders predate `fill_sizing.insideFloor`.

| Order | Pair | Floor | Limit → stop | **Fill → stop** | Inside the floor by | Risk |
|---|---|---|---|---|---|---|
| 2dee2910 | USD/JPY short | 25 | 25.00 | 24.28 | **0.72 pips** | 0.4987% |
| 77134ab8 | CHF/JPY long | 25 | 25.00 | 27.14 | — | 0.4987% |
| 02eb7948 | CHF/JPY long | 25 | 25.00 | 35.85 | — | 0.4982% |
| bcf0216f | CHF/JPY short | 25 | 36.51 | 35.62 | — | 0.4978% |
| 4d8eab45 | GBP/USD long | 25 | 25.00 | 20.05 | **4.95 pips** | 0.4992% |
| 896572f4 | GBP/USD long | 25 | 25.00 | 23.15 | **1.85 pips** | 0.4977% |
| 3758fd3a | GBP/USD long | 25 | 25.00 | 18.55 | **6.45 pips** | 0.4990% |

**4 of 7 fills were inside the floor**, by up to 6.45 pips.

**Options:**
1. Accept.
2. Re-check at fill and skip.
3. Re-anchor the stop at fill.
4. A tolerance.

## 2. `skipped_tp_too_small` (`MIN_TP_PIPS`)

**What it does:**
- bs:7641-7658 rejects a setup when the distance from `analysis.lastPrice` to **`tp`** is below a hard-coded per-pair minimum:
  - GBP/USD 20, USD/JPY 20, EUR/USD 15;
  - every other enabled pair (CHF/JPY, NZD/CAD, NZD/CHF) 12.
- The status written is `skipped_tp_too_small`.

**Why it is in question:**
- **`tp` here is the legacy market-entry target**, measured from the current price (bs:7313-7626). It is either:
  - smcAnalysis's own `analysis.takeProfit`, which survives when there is no recent swing beyond price and the analysis stop is already wider than the floor;
  - or a ratio target off the market-anchored stop.
- That geometry is computed *before* the Route 2 order exists, and the Route 2 order never uses it.
- The ratio path always gives at least 1.1 × the floor ≥ 22 pips, above every minimum. So every refusal comes from the `analysis.takeProfit` path.
  - This is derived from the code: the decision row does not record which path produced the target.
- A Route 2 order's own target is limit ± stop × 1.1, and its stop is at least the pair's floor. So, measured **from the order's entry**, its target is always ≥ 27.5 pips (25-pip pairs) or ≥ 22 pips (20-pip pairs). That is above every minimum in the table.
- The gate measures from the current price to the legacy target instead, so it refuses setups on a target the order would not have had.

**Measured:** 2026-10-07 13:00 → 2026-10-08 00:50 UTC, after Step 14.

| | |
|---|---|
| Decisions | 432 |
| `skipped_tp_too_small` | **78 (18%)**, the second-largest status after `skipped_no_impulse_zone` |
| By pair | GBP/USD 43 (legacy TP 8.7–19.4, median 14.9 vs min 20); NZD/CAD 16 (7.4–12.0 vs 12); USD/JPY 16 (6.7–18.8 vs 20); NZD/CHF 3 (6.8–11.2 vs 12) |
| Caveat | these are decision rows, one per pair per scan. A setup seen on several scans counts several times, so the number of **distinct** setups refused is lower and has not been measured |

**Classification:** a pre-unlock decision / fix candidate, alongside the fill floor. **Not removed, and not changed in Step 16.**

**Measurement to decide with:** for each refused setup, would a Route 2 order have been placed, and what did it go on to do hypothetically? (A replay over stored bars, as the Step 15 resolver does for real orders.)
