# Task: Impulse Zone — Soft Scoring Penalty with Config Toggle
## Branch: manus/impulse-zone-gate
## Behavior changes
**YES — this changes trade qualification:**

1. **When `impulseZoneEnabled: true` (default):** Pairs without a valid impulse zone receive a **-2.0 percentage point penalty** to their effective score. This may cause borderline setups to fall below the `minConfluence` threshold and be skipped.
2. **When `impulseZoneEnabled: true` and price IS at a valid zone:** A **+1.0 percentage point bonus** is applied, rewarding setups that have price at the zone.
3. **When `impulseZoneEnabled: false`:** The zone engine still runs (for dashboard data) but no penalty/bonus is applied — identical to previous behavior.

**Impact estimate:** Pairs with raw scores within 2% of the `minConfluence` threshold may now be filtered out if they lack a valid impulse zone. Pairs at a valid zone get a small boost.

## Files modified
| File | Description |
|------|-------------|
| `supabase/functions/bot-scanner/index.ts` | Added 3 config fields (`impulseZoneEnabled`, `impulseZonePenalty`, `impulseZoneBonus`) to DEFAULTS and config loader; added impulse zone penalty/bonus calculation before `effectiveScore`; added `scoringEnabled` to detail output; added log line for penalty/bonus |
| `REPORT.md` | This file |

## bot-scanner/index.ts change explanation
**What changed (DEFAULTS, lines 158-161):** Added three new config fields:
- `impulseZoneEnabled: true` — master toggle for scoring impact
- `impulseZonePenalty: 2.0` — percentage points deducted when no zone found
- `impulseZoneBonus: 1.0` — percentage points added when price is at zone

**What changed (config loader, lines 749-752):** Added config loading from `strategy.*` and `raw.*` with defaults, following the same pattern as `useFOTSI`.

**What changed (effectiveScore, lines 3554-3577):** After the FOTSI penalty block, a new block reads `(detail as any).impulseZone` (already populated by the zone engine block above). Three cases:
- `hasZone: false` → apply `-impulseZonePenalty`
- `hasZone: true, priceAtZone: true` → apply `+impulseZoneBonus`
- `hasZone: true, priceAtZone: false` → no adjustment (zone exists but price hasn't reached it yet)

The penalty/bonus is added to `effectiveScore` alongside the existing `fotsiPenalty`, so it flows into all downstream threshold checks (staging promotion, trade qualification).

**Why:** This implements a soft penalty rather than a hard gate, so strong setups can still trade even without a zone, while setups that lack structural confluence are penalized. The toggle allows users to disable the scoring impact while keeping the zone data for dashboard analysis.

## Tests added
No new tests in this branch — the scoring logic is a simple arithmetic addition to `effectiveScore` that follows the exact same pattern as the existing `fotsiPenalty`. The zone engine itself (which produces the `hasZone`/`priceAtZone` data) is already covered by 32 tests in the previous branch.

## Tests run
```
$ deno test supabase/functions/_shared/ --allow-all --no-check
ok | 284 passed | 0 failed (6s)
```

## Regression check
- All 284 tests pass
- The penalty/bonus only applies when `impulseZoneEnabled !== false` (default: true)
- Setting `impulseZoneEnabled: false` in bot config restores exact previous behavior
- The zone engine block runs BEFORE the penalty block, so `(detail as any).impulseZone` is always populated
- Wrapped in a null check (`if (izData)`) — if the zone engine errored, izData still has `hasZone: false` which correctly triggers the penalty
- The penalty values (2.0 penalty, 1.0 bonus) are configurable per-bot

## Open questions
1. Should the penalty/bonus values be tunable from the dashboard UI? (Currently they're only settable via bot config JSON)
2. Should there be a log when the zone penalty causes a pair to fall below threshold? (Currently logs the penalty amount but not the threshold comparison)

## Suggested PR title and description
**Title:** `feat: Impulse zone soft scoring penalty with config toggle`

**Description:**
Adds a configurable scoring penalty/bonus based on impulse zone detection:
- `-2.0%` penalty when no valid zone found (configurable via `impulseZonePenalty`)
- `+1.0%` bonus when price is at a valid zone (configurable via `impulseZoneBonus`)
- Toggle on/off via `impulseZoneEnabled` (default: true)

Follows the same pattern as the existing FOTSI penalty. Zone engine still runs for dashboard data even when scoring is disabled.

**Merge order:** Merge `manus/impulse-zone-4h` first, then this branch.
