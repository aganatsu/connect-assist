# Step 16 — implementation plan and PR breakdown (proposed, nothing built yet)

**Basis:**
- the approved audit decisions (2026-10-08, items 1–11);
- `docs/STEP16_AUDIT_V1.md`;
- the inventory `docs/step16/STEP16_CONFIG_INVENTORY_V1.md`.

**Unchanged throughout:**
- the account stays $100,000, paused and entries-locked, with no unlock;
- no fill-floor change and no `MIN_TP_PIPS` change;
- no cron change;
- no migration in any PR;
- no change to the resolver or to attribution rows.

## Validation done for this plan (evidence)

| Assumption | Checked against | Result |
|---|---|---|
| Float noise and real supersedes are separable | all 31 superseded orders ever, parsed from `cancel_reason` | noise max \|Δ\| **4.5e-13**; smallest real move **1.015 pips** (1.0e-4, GBP/USD); smallest overall 0.0625 (ETH). A 0.001-pip tolerance (FX 1e-7, JPY 1e-5) separates them by ≥ 5 orders of magnitude both ways |
| Only one exact-equality site | grep `Number(..) === Number(..)` in `supabase/functions` | only bs:8111 / 8114 |
| Float noise doesn't also spam lifecycle events | `refreshed_in_place` events | 0 so far; event-only even if it occurs; out of scope |
| `reset_paper_account` already refuses with open positions | migration `20261006010000` | **no**: it refuses only on forbidden / invalid balance / missing account. A guard must sit in the caller |
| The guard can live in the SQL function instead | `systemReset.ts` order of steps | **no**: the system-reset workflow calls `reset_paper_account` *before* clearing active state. A SQL-level pending-order refusal would break it. The guard goes in paper-trading `reset_account` only |
| The 13 default-only keys can be stored without code | `configMapper.ts` 514–548, 700 | all 13 read `strategy.<key> ?? raw.<key> ?? RUNTIME_DEFAULTS`, so a config-only change works |
| Storing them can't change backtests | backtest-engine:357 and run-backtest-local use the same `mapNestedToFlat`; the inline fallbacks (`?? 10`, `?? 8`) equal the mapper defaults | identical |
| The UI agrees and won't break | BotConfigModal `getEnabled(field, fallback = true)` shows a missing ICT HTF as on (= runtime); bot-config `update` saves the loaded form state wholesale | display unchanged; keys round-trip; if one were ever dropped, its default is the same value |
| Pinned tests | `pendingSupersedeChurn.test.ts` (regex-pins the `===` at :75; a simulated copy of the split at :41), `paper-trading/reset.test.ts` | updated in the PRs that change the code |
| Cron state | your confirmed list (item 11) | matches the audit's expected set; nothing to change |

## PR breakdown

### PR 16-A — frozen baseline documentation (docs only)

| File | Change |
|---|---|
| `docs/STEP16_FROZEN_BASELINE_V1.md` (new) | The frozen spec as implemented. Items 1–5 listed below |
| `docs/PRE_UNLOCK_DECISIONS_V1.md` (new) | Two open decisions, listed below |
| `docs/STEP16_AUDIT_V1.md`, `docs/step16/STEP16_CONFIG_INVENTORY_V1.md` | add (the audit and inventory, as sent) |
| `docs/STEP14_OVERRIDE_MAP_V1.md` | correction header: entry depth does not reach Route 2; Gate 15 is not delegated; conflict-at-3 is inert |
| `docs/ROUTE2_FILL_FLOOR_POLICY_OPEN_V1.md` | measured table updated to 7 fills (4 inside the floor); points to the pre-unlock doc |

**`STEP16_FROZEN_BASELINE_V1.md` covers:**
1. Entry: Impulse refined entry, else zone midpoint. `zoneEntryDepth` is recorded / legacy.
2. Already-active behaviours, added to the baseline:
   - the per-pair stop floor (25 / 20 pips; the approved wording said 25, see the 16-A report);
   - the 480-minute order lifetime;
   - thesis direction-flip cancellation;
   - the direction-engine settings;
   - Gate 15 ($3,000 realised loss, UTC day, not delegated);
   - the 1.5 × H1 ATR distance cap.
3. Stop cap = max(floor × 1.5, leg × 1.2), with leg buffer 0.02.
4. Conflict-at-3 is inert.
5. Correlation is checked at placement only.

Each item carries its config key or constant and its file:line.

**`PRE_UNLOCK_DECISIONS_V1.md` covers:**
- the fill floor (4 of 7 fills inside);
- **`skipped_tp_too_small`**: it uses the legacy market-entry target and blocked 78 of 432 decisions. Classified as a pre-unlock decision / fix candidate, not as final strategy logic.

**Runtime:** none. Docs only, so the function deploy does not trigger. No config, migration or cron change.

### PR 16-B — hypothetical cap-adjusted reporting (reporting only)

| File | Change |
|---|---|
| `supabase/functions/_shared/hypotheticalCapBook.ts` (new, pure) | `capBook(fills, nowMs, {global: 3, perSymbol: 1})`, described below |
| `local-runner/attribution-report.ts` (new) | read-only CLI, described below |
| `supabase/tests/_shared/step16HypotheticalCapBook.test.ts` (new) | tests, described below |

**`capBook` behaviour:**
- Fills are processed in time order.
- A fill occupies a slot from `filled_at` until `closed_at`, or until now while unresolved; a deferred fill counts as open.
- A slot frees when `closed_at ≤` the next fill.
- Caps are checked global first, then per symbol (the live fill order).
- Each fill gets `admissible` or `blocked_by_global_cap` / `blocked_by_symbol_cap`, plus the blocking `signal_id` / `order_id` list.
- Totals, raw and cap-adjusted side by side: fills, resolved, gross R, net R, hypothetical P/L.
- Correlation is reported as **not modelled**.

**`attribution-report.ts` behaviour:**
- Reads `trade_attribution` (SELECT only; service key from `local-runner/.env.local` like the other local-runner scripts) and prints the per-fill table plus both totals.
- Writes nothing.

**Tests cover:**
- symbol cap and global cap;
- a slot freeing at the close;
- a pending fill blocking later fills;
- a blocked fill not occupying a slot;
- totals;
- raw input not mutated;
- today's 3 GBP/USD fills (1 admissible, 2 blocked by 4d8eab45);
- the 7-fill context (−1.85R raw / −0.85R capped).

**Runtime:** none. Nothing imports the module.
- `deploy-functions.yml` will bulk-redeploy all functions (the path matches `supabase/functions/**`) with identical code, as #646 did.
- If you want zero redeploy, the module can live in `local-runner/` instead, at the cost of not being covered by the CI test job.

### PR 16-C — float-noise supersede fix (RUNTIME: bot-scanner)

| File | Change |
|---|---|
| `supabase/functions/_shared/supersedeLevel.ts` (new, pure) | `sameLevel(a, b, pipSize)` = \|a − b\| ≤ pipSize × 0.001; `splitByLevel(orders, newPrice, pipSize)` → `{ same, moved }` |
| `supabase/functions/bot-scanner/index.ts` ~8110–8115 | replace the two `===` / `!==` filters with `splitByLevel(stalePending, limitEntry.price, spec.pipSize)`. Nothing else in the block changes (refresh fields, no TTL refresh, `cap.signal_id` link, supersede payload) |
| `supabase/tests/_shared/step16SupersedeTolerance.test.ts` (new) | tests, described below |
| `supabase/tests/_shared/pendingSupersedeChurn.test.ts` | its simulated copy (:41) is replaced by the real `splitByLevel`; the `===` regex pin (:75) becomes "the scanner uses `splitByLevel`" |

**`step16SupersedeTolerance.test.ts` covers:**
- **all 31 historical cases** from production as fixtures (symbol, old, new): the 14 noise cases are `same`, the 17 real moves are `moved`;
- boundaries: exactly at the tolerance, JPY pip size;
- a mixed batch;
- a wiring test that the scanner calls `splitByLevel` with the pair's pip size.

**Behaviour effect, to be re-measured in its effect report:**
- A re-detection whose level differs only by float noise now **refreshes in place**: no cancel, no new `order_id` / `signal_id`, and `expires_at` is not extended.
- Real moves (≥ 1 pip in history) still supersede exactly as today.
- Historical incidence: 14 of 31 supersedes; 0 since PR 2.
- This changes which orders exist (it removes fake replacements and their renewed 8 h windows), restoring the documented intent. It was approved as execution plumbing.

**Deploy:** merge → bot-scanner. No migration, no config.

### PR 16-D — `reset_account` fail-closed (RUNTIME: paper-trading)

| File | Change |
|---|---|
| `supabase/functions/paper-trading/index.ts` `reset_account` (≈1878) | before `resetPaperAccount`: count the user's `paper_positions` (any status) and active orders (`pending_orders.status in ('pending','awaiting_confirmation')`, decision 1 below). If any exist: return `{ error, refused: true, code: "reset_refused_not_flat", open_positions, active_orders }` and change nothing. **Remove** `paper_positions.delete()`: when flat it deletes nothing, so behaviour is unchanged, and the line can never delete anything again. The flat path is otherwise identical (ledger reset, pause, counters) |
| `supabase/functions/paper-trading/reset.test.ts` | the block must not delete `paper_positions`; the guard runs before the reset RPC; the refusal returns without calling it; the flat path is unchanged. Plus a behaviour test with a stub client |

**Not changed:**
- `reset_paper_account` (SQL);
- system-reset;
- `set_balance` / `reset_balance_only` (decision 2 below).

**Known limit:** the check and the reset are not one transaction (TOCTOU). While entries are locked no real fill can occur. An atomic version needs a SQL function plus a migration, which is not proposed.

**Deploy:** merge → paper-trading. No migration.

### PR 16-E — store the 13 live default-only controls (CONFIG ROW only, no code)

- **Row:** `bot_configs` `327912ae-4e5b-4677-ad04-7c5d566f7990` (the only row). Service-key PATCH adding **under `strategy`**:
  - `impulseZoneEnabled: true`, `legStopBufferPct: 0.02`, `legStopCapMultiple: 1.2`;
  - `useSimpleDirection: true`, `useConfirmedTrend: true`, `confirmedTrendFibFactor: 0.25`, `confirmedTrendSwingLookback: 5`;
  - `simpleDirectionH1BosLookback: 8`, `simpleDirectionH4ChochLookback: 10`;
  - `zoneChaseMaxZoneWidths: 1`, `thesisValidationEnabled: true`, `thesisCheckDirectionFlip: true`, `ictHTFEnabled: true`.
- **Equivalence proof before the PATCH** (`supabase/tests/_shared/step16ExplicitDefaults.test.ts` + `docs/step16/step16_config_patch.json`):
  - take the live stored config (fixture) before and after the patch;
  - run `mapNestedToFlat` → `applyPairOverrides` for all 6 pairs, plus `resolveSimplification` and `resolvePositionCaps` (placement / hunt_fill / scan_stop);
  - require canonical-JSON **byte-identical** output;
  - also compare against the runtime `pairConfig` the scanner recorded at the 00:20 scan.
  - The PR carries only the test, the patch file and the doc; its runtime effect is none.
- **After the PATCH:** the next full scan's recorded `pairConfig` must be identical to the 00:20 one; `bot_config_change_log` gets one row 3d5b8fb0 → new hash.
- **Consequence to accept:** `config_version` changes, so new attribution rows carry a new hash with identical behaviour. The report pools the two hashes as one behaviour era, documented in the baseline doc.

## Order and gates

1. **16-A** (docs).
2. **16-B** (reporting).
3. **16-C** and **16-D** (independent runtime PRs, one at a time). Each gets an effect report, full tests, CI green and your merge approval.
4. **16-E** last. Patch only after the equivalence test passes in CI and you approve the PATCH. Then verify on the next scan.

## Decisions resolved (2026-10-08)

These decisions supersede the corresponding parts of the PR descriptions above.

1. **Reset (16-D):**
   - `reset_account` fails closed when any real position is open or any active **real** order exists.
   - Active dry-run orders alone do not block. Their count is reported and logged on every attempt, and they are never cancelled silently.
   - Cancelling dry-run orders to start a new experiment epoch is a separate, explicit action (not built in Step 16).
2. **Accounting guard (16-D), expanded:** the same real-exposure guard applies to `set_balance`, `reset_balance_only` and `reset_account`. All three must:
   - refuse while real positions or active real orders exist;
   - make no partial changes on refusal;
   - behave exactly as today when flat;
   - not be blocked by dry-run orders alone.
3. **Explicit defaults (16-E):** approved in principle.
   - The new canonical hash is recorded as a **behaviour-equivalent** config version, *not* as identical, marking the explicit frozen-config boundary.
   - Reports may aggregate across the two hashes only by recording that equivalence explicitly.
   - **Proof before the PATCH:** the effective runtime config before and after, compared byte for byte and value for value, for every live effective control on all six pairs, with no admission / order / sizing / stop / management / cap change.
   - **After the PATCH:** the next scan records the new hash and the same effective configuration.
4. **Cap-book module (16-B):** `_shared`, CI-covered. A redeploy of unchanged functions is accepted.
5. **16-C extra requirements:**
   - the tolerance is a **named constant** with a comment on the historical evidence (no inline magic number);
   - tests prove 14 / 14 noise → same, 17 / 17 genuine → moved, and that the smallest genuine move (1.015 pips) sits materially above the threshold;
   - **a repo-wide search for any other exact float equality on order / setup geometry**, reported before merge.

**Order:** 16-A docs → review / merge → 16-B → 16-C → 16-D → 16-E.

**Unchanged throughout:**
- the fill floor;
- `MIN_TP_PIPS` / `skipped_tp_too_small`;
- lock / pause;
- crons;
- the resolver.

**Correction to item 2 of the approved baseline wording:** the stop floor is **per pair** (25 pips GBP/USD, USD/JPY, CHF/JPY; 20 pips EUR/USD, NZD/CAD, NZD/CHF). It is documented as implemented in `STEP16_FROZEN_BASELINE_V1.md` §4.
