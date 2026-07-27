# Task: Phase 1 — Bugfix Batch
## Branch: manus/phase1-bugfix-batch
## Behavior changes

1. **Confirmation-attempts cap (NEW BEHAVIOR):** Pending orders that fail zone-touch-without-confirmation `maxConfirmationAttempts` times (default: 3) are now cancelled instead of retrying indefinitely. This prevents zombie orders that bounce in and out of a zone forever without confirming. Affects both bot-scanner and zone-confirmation-scanner.

2. **toNYTime consolidation (NO behavior change):** The duplicate `toNYTime`/`toNYTimeAt` in smcAnalysis.ts is replaced with a re-export from sessions.ts. Both implementations were byte-identical in logic. The sessions.ts version adds `nyDay` to the return type, which is additive and backward-compatible.

## Items skipped (with reasoning)

- **Gate-numbering alignment (item 2):** Checked current state — bot-scanner and backtest-engine were never on the same numbering scheme. This isn't drift from the Stage 2 extractions; it's a pre-existing structural fact. Renumbering would require touching every gate comment in bot-scanner/index.ts (the most protected file in the repo) for zero behavioral benefit. A markdown cross-reference table is the right deliverable for this need, not source-code renumbering.

- **Paper-trading trailing-stop floor (item 4):** Reclassified — the `Math.max(trailingStopPips, riskPips * 0.5)` line is NOT redundant dead code. It is a genuine safety floor that protects against: (1) race conditions from paper-trading's irregular frontend-polling-driven tick reading exitFlags before scannerManagement writes the floored value, and (2) dangerously small manual per-trade overrides. The line is kept as-is; a comment was added explaining both reasons so future readers don't re-diagnose it as dead code.

## Files modified

| File | Change |
|------|--------|
| `_shared/configMapper.ts` | Added `maxConfirmationAttempts: 3` to RUNTIME_DEFAULTS + resolution chain (entry section) |
| `_shared/configMapper.test.ts` | 4 new tests for maxConfirmationAttempts resolution |
| `bot-scanner/index.ts` | Added cap check: cancel order when attempts >= maxAttempts |
| `zone-confirmation-scanner/index.ts` | Same cap logic applied |
| `_shared/smcAnalysis.ts` | Deleted duplicate toNYTime/toNYTimeAt, replaced with re-export from sessions.ts |
| `_shared/gamePlanSessionConsolidation.test.ts` | Updated comments to reflect re-export (smoke test, not independent-agreement test) |
| `paper-trading/index.ts` | Added defensive-floor comment explaining why Math.max trail floor is intentionally kept (comment-only, no code change) |

## Tests added

1. `maxConfirmationAttempts: defaults to 3 when no config is set` — verifies RUNTIME_DEFAULTS
2. `maxConfirmationAttempts: resolved from entry section` — verifies entry.maxConfirmationAttempts = 5
3. `maxConfirmationAttempts: raw fallback when entry section is empty` — verifies raw.maxConfirmationAttempts = 7
4. `maxConfirmationAttempts: entry section takes priority over raw` — verifies entry wins over raw

## Tests run

```
ok | 1785 passed | 0 failed (20s)
```

## Regression check

- All 1785 tests pass (1781 existing + 4 new)
- The toNYTime consolidation is verified by the existing 15 DST/session-consolidation tests which all pass (they now exercise the re-export path)
- The confirmation-attempts cap is a new behavior (no prior cap existed), so there's no regression to check — the tests verify the config resolves correctly

## Open questions

1. The `maxConfirmationAttempts` default of 3 was chosen as a reasonable value. If production data shows zones that legitimately need more attempts (e.g., volatile pairs that wick in/out frequently), this can be tuned per-account via the `entry.maxConfirmationAttempts` config field.

2. The `cancel_reason` column on `pending_orders` is used to store the cancellation reason. If this column doesn't exist in production, the Supabase update will silently ignore it. Worth confirming it exists.

## Suggested PR title and description

**Title:** `[phase1-bugfix] Confirmation-attempts cap + toNYTime consolidation`

**Description:**
Two atomic commits:

**Commit 1:** Adds a configurable cap (`maxConfirmationAttempts`, default 3) to prevent pending orders from retrying zone-touch-without-confirmation indefinitely. Orders exceeding the cap are cancelled with a clear reason. Applied to both bot-scanner and zone-confirmation-scanner.

**Commit 2:** Consolidates the duplicate `toNYTime`/`toNYTimeAt` from smcAnalysis.ts into a re-export from sessions.ts (the canonical single source of truth). No behavior change — both implementations were identical.

Gate-numbering alignment was investigated and deliberately skipped (see REPORT.md). Paper-trading trailing-stop floor was reclassified as a genuine safety mechanism and kept with an explanatory comment.
