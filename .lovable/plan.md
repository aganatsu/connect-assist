# Cross-Timeframe Impulse Authority — Phase 1: Full Per-Timeframe Evidence

Eight controlled phases, one PR each, no live trading behaviour change until evidence proves the new hierarchy. This plan specifies Phase 1 in build-ready detail and locks the roadmap for Phases 2-8.

## Target hierarchy (reference for all phases)

| Style | Context impulse | Executable zone | Confirmation | Refinement |
|---|---|---|---|---|
| Scalper | 1H | 15m | 5m | 1m |
| Day trader | Daily | 4H / 1H | 15m | 5m |
| Swing | Weekly | Daily / 4H | 1H | 15m |

A lower-timeframe impulse must not become an independent trade story just because the higher-timeframe zone failed qualification.

## Phase 1 scope — observation only

Capture and persist everything the zone engine saw on every timeframe slot, for every scan cycle, for every symbol and direction. Zero changes to scoring, gating, ranking, ordering or execution.

### What gets recorded per timeframe slot (top / mid / low)

- Every detected impulse leg, not only the winner: start and end time, high/low range, direction, BOS/CHoCH reference level and whether it printed.
- Every POI mapped inside each leg: OBs and FVGs with bounds, formation time, and type.
- Per-POI measurements: fib depth, displacement (absolute and as ATR multiple), OB body ratio, age in bars, distance to current price in pips.
- Zone state as currently computed: fresh / tapped / mitigated / broken (Phase 3 promotes this to the four-state lifecycle).
- Every rejection reason with the exact failing measurement and threshold (e.g. `body_ratio 0.58 < 0.667`).
- Top three zone candidates per slot, ranked, with their scores and score components.
- The engine options and style policy actually in force: style, timeframe ladder, policy version, base policy hash, policy hash, and the resolved `ZoneEngineOptions`.
- Slot availability: candle counts, why a slot was skipped.

This closes the GBP/CAD evidence gap: the record will show exactly which 1H impulse was evaluated and precisely why it lost.

### Technical design

**1. Evidence builder (new shared module)**

`supabase/functions/_shared/zoneTimeframeEvidence.ts`

- `ZoneTimeframeEvidence` contract, versioned `zone-tf-evidence.v1`.
- `buildTimeframeEvidence(slot, label, candles, result, options)` converts one `ZoneEngineResult` into a slot record.
- `buildScanEvidence(multiTFResult, context)` assembles the three slots plus the scan-level header (symbol, direction, style, policy hashes, scan cycle id, selected TF, final reason).
- Impulse identity uses the existing `buildEntityId` / `buildEvidenceId` helpers in `_shared/conceptEvidence.ts`, so impulse IDs are already stable and reusable as the lineage keys in Phase 4.

**2. Engine instrumentation (additive only)**

`_shared/impulseZoneEngine.ts` currently returns only the winning leg and a single `reason` string per slot. Add optional, opt-in collection:

- `findImpulseLeg` gains an optional `collector` that records every candidate leg it considered and why non-winners were dropped.
- `findBestEntryZone` returns an extra optional `evidence` field holding all mapped POIs, per-POI rejection reasons and the ranked top three.
- `findBestEntryZoneMultiTF` threads a per-slot collector through, keyed by slot label.
- All new fields are optional and default off; existing call signatures, return shapes and selection logic are untouched. Existing tests must pass unmodified.

**3. Persistence**

New table `public.zone_timeframe_evidence`, written by the scanner after the zone decision, never before it:

- Header: `user_id`, `bot_id`, `scan_cycle_id`, `symbol`, `direction`, `observed_at`, `trading_style`, `style_policy_version`, `style_base_policy_hash`, `style_policy_hash`, `contract_version`, `selected_timeframe`, `final_reason`, `evidence_source` (`live_scan` | `replay` | `backtest`), `replay_run_id`.
- Payload: `slots` jsonb (the three slot records), `engine_options` jsonb, `candidates` jsonb (top three per slot), `impulses` jsonb (all legs per slot).
- RLS scoped to `auth.uid() = user_id` for read; writes via service role. Grants: `SELECT` to `authenticated`, `ALL` to `service_role`.
- Indexes on `(user_id, symbol, observed_at desc)` and `(scan_cycle_id)`.
- Retention: `data-cleanup` prunes rows older than 30 days, matching the existing shadow-observation retention.

**4. Write path**

`bot-scanner` and `zone-confirmation-scanner` write evidence for every symbol evaluated, including symbols that produced no zone at all — those are the most diagnostic rows. Writes are fire-and-forget with try/catch so an evidence failure can never affect a scan. `backtest-engine` and the replay path write with `evidence_source` set accordingly.

**5. Read surface**

Extend `ZoneStoryPanel` with a "Timeframe Evidence" section: one collapsible block per slot showing the impulses considered, the top three candidates, and the exact rejection reason for each losing candidate. Read-only, no new controls.

**6. Tests**

- Unit: collector captures every leg, evidence contract shape and version, rejection reasons include measured value and threshold.
- Regression: engine outputs byte-identical selections with the collector enabled vs disabled, across the existing zone-engine fixtures.
- Store: evidence row round-trips through insert and select under RLS.

### Phase 1 acceptance

- A scan on any pair yields a row per symbol showing all three slots, including "no zone" cases.
- The GBP/CAD case can be reconstructed: which 1H impulse existed, which 15m impulse won, and the exact reason the 1H candidate lost.
- No change to any trade decision — verified by the parity regression suite.

## Roadmap (subsequent PRs, each reviewed before merge)

- **Phase 2 — Canonical impulse detector.** One detector shared by scanner, Zone Story, backtest/replay and confirmation. Relative measures (displacement percentile, body-strength percentile, ATR-normalised size, BOS significance, recency, sweep origin, structure intact) with raw absolutes retained for audit.
- **Phase 3 — Zone lifecycle and ranking.** States `fresh` / `tapped_held` / `partially_mitigated` / `violated`. Top-three ranking on zone-local confluence, proximity, sweep quality, retest quality, displacement, structural importance, current-price relevance — a distant candidate cannot beat a nearby coherent one on unrelated confluence.
- **Phase 4 — Cross-timeframe lineage.** Parent impulse ID → child impulse ID → confirmation. Decisions: `qualified_nested`, `context_only`, `standalone_lower_tf`, `timeframe_conflict`, `no_parent_context`. This is the direct GBP/CAD fix.
- **Phase 5 — Gameplan / DV / Zone Story integration.** Frozen strategy context extended with gameplan version, DV version, parent impulse ID, child impulse ID, zone candidate ID, nesting result, style-policy hash, evidence certificate hash. No entry path may bypass it.
- **Phase 6 — Shadow validation.** Replay and evidence systems (not the generic backtest path) compare current vs nested decisions: blocked trades, MAE/MFE, winners retained, losers avoided, missed opportunities, disagreement reasons. The 2:25 GBP/CAD trade becomes a required golden replay test. Observation only.
- **Phase 7 — Bot Config controls.** Cross-Timeframe Authority (Observe / Soft / Hard), Require Nested Impulse, Allow Standalone Lower-TF Setup, Maximum Zone Separation, Minimum Parent-Child Overlap, Sweep-Origin Requirement, Retest Quality, Maximum Candidates Per Timeframe. Nothing shows "Unavailable"; availability and effective runtime value are displayed separately.
- **Phase 8 — Single authority across all entry paths.** Normal, unified, cascade, standalone zone, pending fills, zone-confirmation, backtest/replay and manual Scan Now all call the same cross-timeframe authority and final authorization function. Legacy divergent calculations become observational, then are removed once parity is proven.

Hard mode is enabled only after: GBP/CAD replay classified correctly, every rejected timeframe has a visible exact reason, 1H/15m/5m lineage visible in the trade breakdown, historical winners and losers compared, live shadow evidence collecting, all entry paths passing parity, paper-mode tests showing no duplicate or bypassed entry, and your explicit approval.
