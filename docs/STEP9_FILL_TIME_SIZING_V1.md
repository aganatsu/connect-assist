# Step 9 — fill-time 0.5% sizing: before/after effect (pre-deploy report)

**Status:** built and tested (PR, not merged). The account stays **paused and entries-locked**.

**Activation:** the config switch `simplification.sizingMode = "fill_time"`, with `riskPercent = 0.5` and `maxLotsPerTrade = 20`. The code defaults to `legacy`, so merging alone changes nothing.

## What changes

| | Before (today) | After (fill_time) |
|---|---|---|
| When size is decided | at **placement**, from the limit price | at the **actual fill**, from the fill price, the order's stop and the balance at fill |
| Rule | percent risk, then lot caps, then **0.5× for standalone** (Unified 1.0×) | **one rule:** `0.5% × balance ÷ (|fill − stop| × lot units × quote→USD + commission)` |
| Rounding | nearest 0.01, which can exceed target | **down** to 0.01; risk never exceeds target |
| Caps | FX 5 lots, crypto 100, 10× leverage — applied **before** the 0.5× cut, so they routinely bound (2.5 / 50 lots) | 10× leverage and `maxLotsPerTrade` 20 — a **safety ceiling applied last**; when one binds, the record shows the real lower risk |
| Missing FX rate | silent fallback rate | **refuse to fill this cycle**; the order stays armed and retries |
| Record on the trade | the market-path size the order never had | `signal_reason.fillSizing`: balance, risk target/actual, per-lot risk, stop distance, cap info |
| Second poller (zone-confirmation-scanner) | fills with the placement size | does **not** fill under fill_time; it can't size exactly (it lacks the FX rate map). Removed in step 11. |

## Effect on the $100k period's Route 2 fills (exact risk from P&L ÷ R, all 14 fills)

| Symbol | Position | Lots before | Risk before | Lots after | Risk after | Size × | P/L before | P/L at 0.5% |
|---|---|---|---|---|---|---|---|---|
| USD/JPY | `a439f5bc` | 2.50 | 0.49% | 2.55 | 0.50% | 1.02× | +325.20 | +331.70 |
| NZD/CAD | `9394117f` | 2.50 | 0.23% | 5.52 | 0.50% | 2.21× | -237.22 | -523.78 |
| CHF/JPY | `f0ad0e2e` | 4.60 | 1.00% | 2.29 | 0.50% | 0.50× | +1,146.27 | +570.64 |
| ETH/USD | `5f3dadd2` | 50.00 | 0.74% | 33.79 | 0.50% | 0.68× | -782.36 | -528.72 |
| BTC/USD | `4314a4ac` | 1.48 | 0.22% | 3.42 | 0.50% | 2.31× | -226.71 | -523.88 |
| ETH/USD | `58b9a4c5` | 32.38 | 0.35% | 46.67 | 0.50% | 1.44× | +736.46 | +1,061.48 |
| NZD/CAD | `59050a46` | 2.50 | 0.24% | 5.22 | 0.50% | 2.09× | +281.11 | +586.96 |
| ETH/USD | `1d474b73` | 44.49 | 0.19% | 117.33 | 0.50% | 2.64× | -200.52 | -528.82 |
| USD/JPY | `4d72b003` | 2.50 | 0.35% | 3.61 | 0.50% | 1.44× | +313.85 | +453.20 |
| BTC/USD | `ee809be7` | 1.71 | 0.63% | 1.35 | 0.50% | 0.79× | +447.71 | +353.46 |
| CHF/JPY | `2527bfa5` | 4.47 | 1.21% | 1.84 | 0.50% | 0.41× | -1,283.93 | -528.51 |
| GBP/USD | `3f39df7b` | 2.46 | 0.92% | 1.34 | 0.50% | 0.55× | -971.50 | -529.19 |
| ETH/USD | `65ce1fe9` | 37.82 | 0.41% | 45.87 | 0.50% | 1.21× | +669.93 | +812.52 |
| CHF/JPY | `32978692` | 5.00 | 0.73% | 3.41 | 0.50% | 0.68× | +527.69 | +359.88 |

- **Risk per trade:** before, median 0.45% with a range of **0.19%–1.21%**. After, **0.497%–0.500%**.
- **Size change:** median 1.12×, range 0.41×–2.64×. Big losers were oversized: CHF/JPY 0.41×, GBP/USD 0.55×. Several small-risk trades were undersized: NZD/CAD 2.2×, BTC 2.3×, ETH 2.6×.
- **P/L of these 14 at flat 0.5%:** +$1,366.94 instead of +$745.98. FX only (8): +$720.90 instead of +$101.47.
  **This is not a performance claim.** It's 14 trades, and it shows only that dollar results become proportional to R (about $500 per 1R) instead of being distorted by drifting size.
- **Caps:** none would bind on the FX fills. ETH `1d474b73` would have needed 117 lots and would hit the 20-lot ceiling, but crypto is excluded from the experiment.
- **Trade count:** no effect. Sizing doesn't change which trades happen. The only new refusal is a fill with a missing FX rate, which is retried next cycle.

## Tests

- `step9FillTimeSizing.test.ts`:
  - exact sizing, plus the real CHF/JPY `2527bfa5` case (1.21% → ≤ 0.5%);
  - rounding never exceeds target, and commission is included;
  - a missing rate refuses to size, and caps are recorded;
  - degenerate inputs fail closed;
  - switches default to legacy;
  - wiring in both pollers.
- Full Deno suite: 3,274 passed / 0 failed.

## Deploy plan (after your approval)

1. Merge the PR. This is code only, with the legacy default, so behaviour is unchanged.
2. Set `simplification.sizingMode = "fill_time"`, `riskPercent = 0.5`, `maxLotsPerTrade = 20` (SQL, hand-applied).
3. Dry-run fills then record `dry_run_context.fillSizing`, so the sizing is visible in the funnel before any unlock.
