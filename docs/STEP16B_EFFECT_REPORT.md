# Step 16-B — cap-adjusted dry-run reporting: effect report

**Status:** built and tested; PR open, **not merged**. Reporting only.

**Unchanged:**
- no migration, config change or cron change;
- no change to the resolver, attribution rows or trading path;
- the account stays $100,000, paused and entries-locked.

## What it adds

| File | Role |
|---|---|
| `supabase/functions/_shared/hypotheticalCapBook.ts` | pure model (no DB, no clock). Nothing on the trading path imports it (test-enforced) |
| `local-runner/attribution-report.ts` | read-only CLI: SELECTs `trade_attribution` hypothetical fills and prints the per-fill table plus totals. `--json` gives the full report |
| `supabase/tests/_shared/step16HypotheticalCapBook.test.ts` | 15 tests (below) |

### The model

1. **Raw:** the Step 15 resolver outcome per fill, never modified (a test checks the input is unchanged).
2. **Cap-adjusted (the requirement):**
   - the live unified caps, 3 global / 1 per symbol, checked at the fill in the live order (global, then per symbol);
   - an admissible fill holds a slot from `filled_at` until `closed_at`, or through now while unresolved; a deferred fill counts as open;
   - a slot is free once `closed_at ≤` the next fill;
   - a blocked fill holds none and records `blocked_by_global_cap` / `blocked_by_symbol_cap` plus the blocking `signal_id` / `order_id`.
3. **Caps + correlation:** shown separately. The cap-adjusted totals above stay as you specified.
4. **Ties:** `filled_at`, then order placement time (the live hunt processes orders by `placed_at`, bs:3596-3598, pinned), then signal id. The result is deterministic regardless of input order.
5. **Config versions:** slots are account-wide, but totals pool only within a registered behaviour-equivalence class (`CONFIG_EQUIVALENCE_CLASSES`, today only `3d5b8fb0…`). An unregistered hash is its own class, and no pooled total is printed when classes are mixed. 16-E adds its hash here only with its equivalence proof.

### Correlation: reconstructable, so modelled (not `correlation_not_modelled`)

**Evidence that the historical state can be reconstructed exactly:**
- Gate 22 calls `getCorrelation(symbol, pos.symbol)` **without** a dynamic matrix. It uses the static `STATIC_CORRELATIONS`, last changed 2026-09-02, before the 10-06 reset.
- Its fallbacks are static too: `SMT_PAIRS` and currency decomposition.
- It runs at **placement only** (`runSafetyGates`); the hunt fill re-checks caps, not correlation.
- The inputs are recorded per fill: symbol, direction, `order_placed_at`, `filled_at`, `closed_at`.

**How the module mirrors it:**
- It reuses the same shared functions (`getCorrelation`, `getDirectionalCorrelation`, `parsePairCurrencies`, `SMT_PAIRS`) and mirrors the ~20-line block rule: any hedge blocks; doubling blocks at ≥ max.
- Source pins fail CI if Gate 22's call, rules or fallbacks change, or if the hunt starts checking correlation.

**What it can block today:**
- Among the six live pairs, only **EUR/USD ↔ GBP/USD** reaches 0.8 (ρ 0.85). Every other pair is |ρ| ≤ 0.4.
- Doubling can't reach max 2 under 1 per symbol.
- So the only reachable block is an **EUR/USD ↔ GBP/USD opposite-direction hedge open at placement** (test-enumerated over all 6 × 6 × 2 × 2 combinations).
- A fill without a placement time is marked `correlation_not_evaluable` and is not blocked.

## Runs on real data (read-only)

### All attributed dry-run fills (`attribution-report.ts`, 2026-10-08 01:48 UTC)

| Fill | Symbol | Filled | Outcome | Caps | Caps + correlation |
|---|---|---|---|---|---|
| 088f22f7 / 4d8eab45 | GBP/USD long | 18:22 | open | admissible | admissible |
| 4be9b5c9 / 896572f4 | GBP/USD long | 18:52 | open | **blocked_by_symbol_cap ← 088f22f7/4d8eab45** | same |
| fff2ae4e / 3758fd3a | GBP/USD long | 22:42 | open | **blocked_by_symbol_cap ← 088f22f7/4d8eab45** | same |

| `frozen_impulse_route2_v1` | Fills | Blocked | Resolved | Open | Gross R | Net R | P/L | Net P/L |
|---|---|---|---|---|---|---|---|---|
| raw | 3 | — | 0 | 3 | 0 | 0 | $0 | $0 |
| cap-adjusted | **1** | **2** | 0 | 1 | 0 | 0 | $0 | $0 |
| caps + correlation | 1 | 2 | 0 | 1 | 0 | 0 | $0 | $0 |

No attributed fill has resolved yet, so every R and P/L total is 0.

### The audit's 7-fill sample, incl. 4 pre-attribution fills

Outcomes are from the shipped resolver code, read-only; gross R only, because there are no attribution risk dollars for the 4 pre-attribution fills.

| Order | Pair | Filled | Outcome | Caps |
|---|---|---|---|---|
| 2dee2910 | USD/JPY short | 10-06 23:20 | stop −1R | admissible |
| 77134ab8 | CHF/JPY long | 10-07 01:33 | stop −1R | admissible |
| 02eb7948 | CHF/JPY long | 07:34 | stop −1R | **blocked_by_symbol_cap ← 77134ab8** |
| bcf0216f | CHF/JPY short | 14:52 | target +1.1521R | admissible (77134ab8 closed 08:00) |
| 4d8eab45 | GBP/USD long | 18:22 | open | admissible |
| 896572f4 | GBP/USD long | 18:52 | open | **blocked_by_symbol_cap ← 4d8eab45** |
| 3758fd3a | GBP/USD long | 22:42 | open | **blocked_by_symbol_cap ← 4d8eab45** |

| | Fills | Resolved | Gross R |
|---|---|---|---|
| raw | 7 | 4 | **−1.8479** |
| cap-adjusted | 4 (3 blocked) | 3 | **−0.8479** |
| caps + correlation | 4 (3 blocked) | 3 | −0.8479 (no EUR/USD ↔ GBP/USD overlap) |

This matches the Step 16 audit prototype exactly.

## Tests

`step16HypotheticalCapBook.test.ts`, 15 tests:

| Area | Covered |
|---|---|
| overlapping symbols | second fill blocked, naming the blocker; another symbol unaffected |
| global-cap saturation | 4th concurrent symbol `blocked_by_global_cap` listing all 3; global reported before symbol when both are full |
| resolved positions free slots | closed exactly at the next fill counts as free; closed 1 s later does not; the same for global slots |
| unresolved holds through now | — |
| simultaneous timestamps | earlier placement wins, then signal id; same result for either input order |
| blocked fills hold no slot | per symbol and globally |
| totals | raw vs cap-adjusted sums over resolved fills; net P/L = R net × risk dollars; missing net counted; open excluded |
| raw input untouched | — |
| correlation | hedge at placement blocked; same direction allowed; a partner fill after placement not re-checked; `correlation_not_evaluable`; full enumeration over the six pairs |
| config classes | registered vs unregistered; no silent pooling |
| production fixtures | the 3 attributed fills; the 7-fill sample (−1.8479 / −0.8479) |
| source pins | Gate 22 static call, rules and fallbacks; hunt has no correlation; hunt order `placed_at`; no Edge Function imports the module |

**Mutation check** (temporary, reverted):
- letting blocked fills take a slot fails 2 tests;
- freeing a slot one instant late fails 1.

| Suite | Result |
|---|---|
| Deno, CI command (`supabase/tests` + `supabase/functions`) | **3,400 passed, 0 failed** (3,385 + 15) |
| `deno check` (module, CLI, test) | clean |
| frontend | no `src/` change |

## Deploy effect

`deploy-functions.yml` triggers on `supabase/functions/**`, so merging redeploys every function with **identical code**: no function's source changes, and the new module is imported by none. This was accepted in decision 4. Nothing else runs on merge.
