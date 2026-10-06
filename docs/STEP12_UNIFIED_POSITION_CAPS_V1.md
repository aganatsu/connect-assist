# Step 12 — one owner for the position caps (pre-deploy report)

**Status:** built and tested (PR, not merged). The account stays **paused and entries-locked**.

**Activation:** set `simplification.capsMode = "unified"`, `simplification.maxOpenPositions = 3`, `simplification.maxPerSymbol = 1`. With `capsMode` absent, every path keeps its pre-step-12 read, so merging alone changes nothing. No code is deleted.

## Before: five paths, three answers

| Path | Global | Per symbol | Fallback | Pair overrides |
|---|---|---|---|---|
| Placement, Gates 4/5 (`runSafetyGates`) | `config.maxOpenPositions` → 7 | `pairConfig.maxPerSymbol` → 3 | — | yes |
| Hunt, at fill | `config.maxOpenPositions` → 7 | `config.maxPerSymbol` → 3 | `\|\| 3` / `\|\| 2` | no |
| Scan-stop | `config.maxOpenPositions` → 7 | — | `\|\| 3` | — |
| Second poller (off since step 11) | raw `risk.maxOpenPositions` → **3** | raw `risk.maxPerSymbol` (absent) → **2** | 3 / 2 | no |
| Decision record (`portfolio_input`) | `config.maxOpenPositions` | `config.maxPositionsPerSymbol` → **always null** | — | — |

## After

`_shared/positionCaps.ts` → `resolvePositionCaps(rawConfigJson, path, legacyFlatConfig)` is the only reader.

- **Unified:** every path gets `simplification.maxOpenPositions` / `simplification.maxPerSymbol`. Per-pair `maxPerSymbol` overrides and the `risk.*` cap fields are ignored. If a value is missing, non-integer or out of range (1–50 / 1–10), the resolver uses **3 / 1**, never the legacy 7/3.
- **Legacy (`capsMode` absent):** each path's old expression is reproduced exactly, including placement's pair override, the hunt's 3/2 fallbacks and the second poller's raw-config read.
- **Decision record:** now records the caps placement actually enforced for that pair, plus `capsMode`. The null is fixed in both modes.
- **Same-direction stacking:** unchanged and separate. Placement checks it before the per-symbol cap; the hunt checks it after the numeric caps. Both use `allowSameDirectionStacking`, which the resolver never reads.

Not changed:
- `backtest-engine` (it has its own caps and isn't a live path);
- the unused SQL `finalize_*` cap parameters (no caller);
- `bot-config` validation;
- the UI `risk.*` fields (informational under unified mode; step 14 makes config explicit).

## Effect

- **Real positions (history):** caps of 3/1 would have refused 1 trade in the $100k period (an ETH trade, −$298.99; crypto is now excluded) and **0** since 09-29. The hunt's caps never fired; the 4 position-cap cancellations all came from the second poller.
- **While locked (dry run):** no real positions exist, so the caps count 0 and cannot bind. `local-runner/recon/position_book.py` (also in `route2_funnel.py`) replays the dry-run fills as a hypothetical book under 3/1 and 7/3, at fill only and at placement + fill, and reports refusals by reason and the refused trades' bar-based R.
- **First reading:** 2 dry-run orders. The second USD/JPY short was placed 5 s after the first hypothetically filled; a real position would have blocked it at placement by the stacking guard (and by per-symbol 1 at fill).

## Tests

`supabase/tests/_shared/step12UnifiedCaps.test.ts`:
- unified mode gives all five paths 3/1 and ignores pair overrides; invalid values fall back to 3/1;
- unified values without `capsMode` change nothing;
- legacy mode keeps the live per-path values (7/3, 7/3, 7, 3/2) and reproduces each old expression over a grid of inputs;
- source checks:
  - every path calls the resolver with its own label;
  - no active path in bot-scanner or zone-confirmation-scanner reads `config.maxOpenPositions`, `config.maxPerSymbol`, `.maxPositionsPerSymbol`, `risk.maxOpenPositions`, `risk.maxPerSymbol` or `maxConcurrentTrades` (the DEFAULTS object and the dead legacy mapper are excluded);
  - stacking stays a separate rule.

## Deploy plan

1. Merge after CI is green (default legacy, no change).
2. Set the three `simplification` keys; verify the config hash and the change-log entry.
3. Verify on the next scan: the scan-stop log shows `maxOpen=3 (unified: simplification)`, and decision records show `maxOpenPositions 3, maxPositionsPerSymbol 1, capsMode unified`.
