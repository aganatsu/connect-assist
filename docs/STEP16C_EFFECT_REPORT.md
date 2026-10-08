# Step 16-C — Route 2 float-noise supersede fix: effect report

**Status:** built and tested; PR open, **not merged**.

**Unchanged:**
- no config, migration or cron change;
- no fill-floor or `MIN_TP_PIPS` change;
- the resolver and the cap-book (16-B) are untouched;
- the account stays $100,000, paused and entries-locked.

## The change (runtime: bot-scanner)

| File | Change |
|---|---|
| `supabase/functions/_shared/route2SameLevel.ts` (new) | `ROUTE2_SAME_LEVEL_TOLERANCE_PIPS = 0.001`, a named constant with the historical evidence in its comment; `levelDistancePips` (\|a − b\| / pipSize); `isSameLevelPips` (inclusive); `isSameLevel` (non-finite input or pip size → never "same", i.e. supersede as before); `splitByLevel` |
| `supabase/functions/bot-scanner/index.ts` | the two exact filters `Number(s.entry_price) === / !== Number(limitEntry.price)` are replaced by `splitByLevel<any>(stalePending ?? [], limitEntry.price, spec.pipSize)`, which compares **in pip space** with the pair's own pip size. Plus the import. Plus one comment fix: the comment above the block said `expires_at` "is still extended"; the code below it says, and does, the opposite ("DELIBERATELY NOT REFRESHED"). **No other line changes** |

**Same-level path, unchanged code:**
- updates exactly `signal_score`, `current_price`, `stop_loss`, `take_profit`, `size` on the **existing** `order_id`;
- links the decision to the **existing** `signal_id`;
- `continue`s, so there is no insert and no `route2_place_order`;
- does **not** write `expires_at`, `status`, `signal_id`, `order_id`, `entry_price`, confirmation or touch fields.

The PR 2 lifecycle trigger records a `refreshed_in_place` event if the stop, target or size changed.

**Moved path, unchanged code:** the orders go into the `supersede` list of `route2_place_order`, which cancels them and inserts the new order and its attribution in one transaction, linked both ways.

## Behaviour effect

Only re-detections whose level differs from the live `pending` order by ≤ 0.001 pip change behaviour. They now **refresh in place** instead of being cancelled and replaced. For those re-detections:
- no new `order_id` / `signal_id`;
- no reset of the hunt state;
- **no fresh 8-hour window**: the fixed `ROUTE2_TTL_MINUTES` lifetime from first placement is kept, which is the documented intent.

Genuine moves supersede exactly as before.

| Measured (production) | |
|---|---|
| Supersedes ever recorded | 31: **14 float noise** (would now refresh in place), 17 genuine (unchanged) |
| Since the 10-06 reset | 2: d11627e7 (noise, 10-06 23:50, pre-attribution) and b25f637f (genuine) |
| Since attribution went live (PR 2) | 0 |
| Live orders now | 1 (68a11a83 GBP/USD), `awaiting_confirmation`. The stale lookup only matches `pending`, so it is unaffected |

The historical pattern this removes: NZD/CAD re-placed 4 times in 30 minutes (09-28) and CHF/JPY 6 times in 2 hours (10-05), each with a fresh 8-hour window and a reset hunt.

## Evidence for the tolerance (replayed in tests)

- **Noise:** \|Δ\| ≤ 4.5×10⁻¹³ in price, ≈ 4.5×10⁻⁹ pips. That is more than 4 orders of magnitude below 0.001 pip.
- **Smallest genuine move:** **1.015 pips** (0756f0ce, GBP/USD 1.3255765 → 1.325475), 1,000× the tolerance. All others are ≥ 1.7 pips.
- **Correction to the audit wording:** ETH/USD's pip size is 0.01, not 1, so its smallest move (0.0625) is 6.25 pips. In pip space the smallest genuine move overall is the GBP/USD 1.015.

## Repo-wide search: other exact float comparisons on order / setup geometry

| Location | What | Verdict |
|---|---|---|
| bs:8111 / 8114 | Route 2 same-level split | **fixed here** (the only one that decides anything) |
| bs:7624 `tpAdjust.adjustedTP !== tp` | regime-adaptive TP; `adjustTPForRegime` returns the input value when it makes no change | identity comparison; feature off (`regimeAdaptiveTPEnabled false`); logging only |
| `smcAnalysis.ts:733-734` `x.high === highSoFar` | finds the candle that produced a running max / min | identity comparison of the same stored values, not arithmetic; not order geometry |
| `ipoEngineState.ts:267`, `ipoZones.ts:968` | IPO engine | parked strategy, not on the live path |
| `structureShadow.ts:190` | shadow structure | already uses a tolerance (`LEVEL_TOL`) |
| PR 2 trigger `(stop_loss, take_profit, size, entry_price) IS DISTINCT FROM (OLD…)` | `refreshed_in_place` event | **event only** (no behaviour). Exact on stored `numeric`; a noise-only rewrite could add an event, but none has occurred (0 events) |
| step 15 settlement `fill_price <> fill_stop_price` | division-by-zero guard for R | correct as exact (`numeric`) |
| bs:2412, bs:5530 | timeframe / zone **labels** | strings |

No other exact float comparison decides order or setup geometry.

## Tests

### `step16SameLevelTolerance.test.ts` (new, 9 tests)

- **History:** all 31 production supersedes are replayed from their verbatim `cancel_reason` prices with SPECS pip sizes. **14 / 14 noise → same, 17 / 17 genuine → moved.** The old exact comparison called all 31 "moved".
- **Evidence:** noise ≤ 4.6e-13; the smallest genuine move is 0756f0ce at 1.015 pips, ≥ 1000× the tolerance; the constant is 0.001.
- **Edges in pip space:** 0.000999 → same; 0.001 → same (inclusive); 0.001001 → moved; 0 → same.
- **Edges in price space:** EUR/USD, GBP/USD (pip 0.0001), USD/JPY and CHF/JPY (pip 0.01), moves up and down: 0.0009 pip → same; 0.0011, 0.1 and 1 pip → moved. The same price gap is the same level on JPY (0.0005 pip) but moved on non-JPY (0.05 pip), proving the comparison is in pip space.
- **Long and short** orders split identically; a stored NUMERIC string compares as a number.
- **Invalid inputs** (NaN, zero pip, infinity, null) → moved (the old fail-safe).
- **Wiring:** the import and the `splitByLevel` call with `spec.pipSize`; no exact comparison remains.
- **Same level:** the payload writes exactly the 5 fields on the existing `order_id`; the forbidden fields are absent; no insert / RPC / placement in the block; the decision links to the **existing** `signal_id`; `continue` before placement.
- **Moved:** the `supersede` list flows into `placeRoute2Order` → `route2_place_order`, which cancels inside the RPC. The real-Postgres tests "supersede links both directions in one transaction" and "invalid attribution → NO new order, NO supersede cancel" (step 15 harness, unchanged) still pass.

### Updated tests (same properties, new mechanism)

- `pendingSupersedeChurn.test.ts`: its simulated copy of the split is replaced by the real `splitByLevel`; the regex pin now checks for `splitByLevel`; the docstring's stale "expires_at is extended" line is corrected.
- `refreshAndStaleGamePlan.test.ts`: "entry price is deliberately not rewritten" now pins `splitByLevel`.

### Mutation check (temporary, reverted)

| Mutation | Result |
|---|---|
| exact equality | 4 failures |
| 2-pip tolerance | 4 failures |
| price-space comparison (no pip division) | 3 failures |

### Suites

| Suite | Result |
|---|---|
| Deno, CI command | **3,409 passed, 0 failed** |
| `deno check` (bot-scanner, module, tests) | clean |
| frontend | no `src/` change |

## Deploy effect

Merge → `deploy-functions.yml` redeploys the functions. Only bot-scanner's behaviour changes (as above).

**Verify after deploy:**
1. scans continue;
2. a noise-only re-detection logs "re-detected at the same level … refreshed in place";
3. no new supersede whose old and new entries are within 0.001 pip.
