# V3.2c history audit V1 (2026-10-14) — epoch, continuity, closure calendar

Read-only analysis of the 1H history held locally; no API call, no import, no backfill. The reserved V2.1.1 window 2026-10-12 → 10-23 was
not read. Scripts and outputs live outside the repo in `~/strategy-v2/v32c-integration-evidence/`:

| File | sha256 |
|---|---|
| `history_audit.ts` | `2328cc136d9e0a88716dff6eefbc884333014167254a723f47e85d55d1651097` |
| `closures.ts` | `010db8425cc51da66286ab70c26b43eba528181214f267d359c2bca571240725` |
| `CLOSURES.txt` | `63ade00e6606f28493a35496ec103b8efdb4e7615d1157c79a1590482b98a279` |
| `convergence.ts` | `48d2a8dafffd0f4a8672b7d8a61ccf2c642e48487f6620cd3f6f9520032c9ea6` |
| `CONVERGENCE.txt` | `30d42481e7e37166f49e22e1e4fb92a1e9d26ebde1577d37c6a963a80cf7a7d0` |
| `conv_diag.ts` | `944d2b08ce522b0f4eb5d0ae086a0efd981c05bce5825082770918f8af08ad05` |
| `perf.ts` | `c92a64dc8a602b7d961f66c3f095bcd232d28e0ff6f887615c4814b1f2115c55` |

## 1. Locally held datasets (TwelveData `time_series`, `timezone=UTC`, sha256-manifested)

| Dataset | Span (UTC) | Dataset sha256 | Retrieved |
|---|---|---|---|
| unseen-2024 | 2024-04-16 21:00 → 2025-04-16 21:00 | `29c1c5f0f274b7fe…` | 2026-10-14 |
| validation-2025 | 2025-04-16 21:00 → 2026-04-16 21:00 | `c5655420cd2edf31…` | 2026-10-14 |
| v22-hist | 2026-04-16 21:00 → 2026-09-07 21:00 | `f9ac3466c19a8f7f…` | 2026-10-13 |
| phase3 | 2026-09-07 21:00 → 2026-10-09 21:00 | `2cc0c4b3c5badf60…` | 2026-10-11 |

## 2. Continuity (expected = FX-open hours under the frozen V3.2c `fxOpen`)

| Pair | 1H bars | Missing | Longest gap | Gaps ≥ 6h start | Invalid OHLC |
|---|---|---|---|---|---|
| EUR/USD | 17,197 | 247 (1.59%) | 33h | holidays 2024/25; 2025-04-28 10:00 | 12 (2024-07 → 2025-03) |
| GBP/USD | 17,229 | 222 (1.43%) | 32h | holidays 2024/25 | 0 |
| USD/JPY | 17,168 | 237 (1.52%) | 28h | holidays 2024/25 | 0 |
| CHF/JPY | 17,196 | 233 (1.50%) | 28h | holidays 2024/25 | 0 |
| NZD/CAD | 17,199 | 230 (1.48%) | 29h | holidays 2024/25 | 0 |
| NZD/CHF | 17,198 | 232 (1.49%) | 30h | holidays 2024/25 | 0 |

- About 1,880 bars per pair fall outside FX hours (provider weekend hours); the frozen aggregation drops them.
- EUR/USD 5m in the unseen-2024 set has corrupt bars from 2024-07-16 to 2025-03-28 (open / close outside high–low). In-range corruption cannot be detected.
- The 2025 set carries float32 price artefacts (e.g. `0.82209003`). The canonical store rounds them to the pair's price grid (5 dp; 3 dp for JPY), symmetric in sign.

## 3. Epoch (D19)

- **Epoch:** **2025-04-16 21:00Z.**
  - Sources: `validation-2025` + `v22-hist` + `phase3`, 0 API calls.
  - No invalid OHLC in any pair from the epoch onward.
- **2026-10-09 → go-live:** filled from production `smc_scan_bars` after the V2.1.1 OOS run completes (D26). The reserved window is not imported before then.
- **Overlap 2026-09-25 → 10-09:** local data vs `smc_scan_bars` parity is a PR2 gate.
- **Warm-up needed:** frozen V3.2c state is start-dependent (`CONVERGENCE.txt`). Late starts converge after tens to hundreds of bars, sometimes thousands (EUR/USD 1H: 4,170 bars), and some pair / TFs did not converge within a year. That is why the epoch is fixed.
- **What the epoch provides:** ≥ 18 months of history before go-live.
- **Replay cost** (`perf.ts`, EUR/USD, 1 year): D 2 ms, 4H 5 ms, 1H 55 ms per pair.

## 4. Closure calendar 2024/25 (D21; monitoring classification only, D27)

Hours inside nominal FX hours where **all six** pairs have no 1H bar (`CLOSURES.txt`):

| Closure | NY time | UTC | Class |
|---|---|---|---|
| Christmas 2024 | Dec 24 08:00 → Dec 25 08:00 | 2024-12-24 13:00 → 2024-12-25 13:00 | holiday (24 h) |
| New Year 2025 | Dec 31 08:00 → Jan 1 12:00 | 2024-12-31 13:00 → 2025-01-01 17:00 | holiday (28 h) |
| Christmas 2025 | Dec 24 08:00 → Dec 25 08:00 | 2025-12-24 13:00 → 2025-12-25 13:00 | holiday (24 h) |
| New Year 2026 | Dec 31 08:00 → Jan 1 08:00 | 2025-12-31 13:00 → 2026-01-01 13:00 | holiday (24 h) |
| Weekly open, DST weeks | Sunday 17:00 → 19:00 | 21:00 → 23:00 | expected provider absence. Observed weekly 2024-04-21 → 2024-09-29 and 2025-04-06 → 2025-09-28; not in 2024-10 DST weeks; not in 2026 |

- **Pair-specific missing hours** (EUR/USD 35, USD/JPY 25, CHF/JPY 21, NZD/CHF 20, NZD/CAD 18, GBP/USD 10 over 2.5 years) are data gaps, not closures.
- **Consequence under the frozen aggregation (unchanged by decision D27):** in those DST weeks, each Monday Daily bucket (22/24 h) and each Sunday 17:00–21:00 NY 4H bucket is skipped. In the epoch dataset that is 33–37 D/4H buckets per pair. The research runs skipped the same buckets, so production replay from the epoch stays research-equivalent. No candle is synthesized, filled or made valid.
- **Before PR2 freezes the calendar,** cross-check the holiday rows against an external published FX holiday schedule.
