# Cross-Timeframe Impulse Authority — Phase 1: Full Per-Timeframe Evidence

Eight controlled phases, one PR each. Phase 1 is observation only: it records what the engine saw, and changes no scoring, ranking, gating, configuration or execution.

## Exact style hierarchy (canonical, used by every phase)

| Style | Context (parent impulse) | Executable zone | Nested child impulse | Confirmation | Refinement |
|---|---|---|---|---|---|
| Scalper | 1H | 15m | 15m (same slot as executable) | 5m | 1m |
| Day trader | Daily | 4H | 1H | 15m | 5m |
| Swing | Weekly | Daily | 4H | 1H | 15m |

Parent-child pairs are therefore fixed: Scalper 1H→15m, Day trader Daily→4H→1H, Swing Weekly→Daily→4H. No "4H / 1H" ambiguity: for day trader the executable zone is 4H and 1H is the nested child impulse inside it; the 4H zone is the location, 1H is the internal refinement of that location.

A lower-timeframe impulse must not become an independent trade story just because the higher-timeframe zone failed qualification.

## Phase 1 scope

Capture and persist everything the zone engine saw on every timeframe slot, per scan cycle, per symbol, per direction.

### Recorded per slot

- Every detected impulse leg, not only the winner: start/end time, high/low range, direction, BOS/CHoCH reference level and whether it printed.
- Every POI mapped inside each leg: OBs and FVGs with bounds, formation time, type.
- Per-POI measurements: fib depth, displacement (absolute and ATR multiple), OB body ratio, age in bars, distance to current price in pips.
- Zone state as currently computed (fresh / tapped / mitigated / broken). Phase 3 promotes this to the four-state lifecycle.
- Every rejection as a **structured code plus measurement**: `{ code: "ob_body_ratio_below_min", measured: 0.58, threshold: 0.667, comparator: "<", explanation: "OB body ratio 0.58 below required 0.667" }`.
- Top three zone candidates per slot, ranked, with score components.
- Style policy in force: style, timeframe ladder, policy version, base policy hash, policy hash.
- Slot availability: candle counts, and why a slot was skipped.

### Technical design

**1. Evidence contract**

`supabase/functions/_shared/zoneTimeframeEvidence.ts`, versioned `zone-tf-evidence.v1`.

- `buildTimeframeEvidence(slot, label, candles, result, options)` → one slot record.
- `buildScanEvidence(multiTFResult, context)` → header + three slots.
- Impulse and candidate IDs are produced with the existing `buildEntityId` / `buildEvidenceId` from `_shared/conceptEvidence.ts`, and candidate IDs reuse `localConfluence.candidateId` exactly as `zoneShadowObservationStore.ts` writes it. This makes the evidence rows joinable to `zone_candidate_shadow_observations`, to `frozen_strategy_context`, and to `strategy_evidence_certificates` without a translation layer, and gives Phase 4 its lineage keys for free.

**2. Engine instrumentation (additive, opt-in)**

- `findImpulseLeg` gains an optional collector recording every candidate leg and why non-winners dropped.
- `findBestEntryZone` returns an optional `evidence` field with all mapped POIs, structured rejections and the ranked top three.
- `findBestEntryZoneMultiTF` threads a per-slot collector keyed by slot label.
- Defaults off. No existing signature, return shape or selection branch changes.

**3. Persistence**

New table `public.zone_timeframe_evidence`:

- Header: `user_id`, `bot_id`, `scan_cycle_id`, `symbol`, `direction`, `observed_at`, `trading_style`, `style_policy_version`, `style_base_policy_hash`, `style_policy_hash`, `contract_version`, `selected_timeframe`, `final_reason`, `evidence_source` (`live_scan` | `confirmation` | `replay` | `backtest`), `replay_run_id`, `parent_evidence_id`.
- Payload: `slots`, `engine_options`, `candidates`, `impulses` (jsonb), `payload_truncated` boolean plus `truncation_detail` jsonb.
- **Idempotency:** unique index on `(user_id, bot_id, scan_cycle_id, symbol, direction, contract_version, evidence_source)`. All writes are upserts with `ignoreDuplicates`.
- **Immutability:** a BEFORE UPDATE trigger rejects any change to the payload or header columns of an existing row; outcome/annotation columns added in later phases are the only mutable fields.
- **Option whitelist:** `engine_options` persists only an explicit allowlist (`minQualityScore`, `maxAgeBars`, `minBodyRatio`, `minDisplacementATR`, `fibMaxRetracement`, `originOBRetest`, `strictATRMult`, `pipSize`, `zoneLifecycleV2.enabled`). Arbitrary runtime config, candles and credentials are never written.
- **Size limits:** each slot payload is capped (max legs, max POIs, max candidates per slot, and a byte ceiling). Exceeding a cap trims lowest-ranked entries and sets `payload_truncated` with counts in `truncation_detail`.
- RLS: read scoped to `auth.uid() = user_id`; writes service role. `GRANT SELECT` to `authenticated`, `GRANT ALL` to `service_role`.
- Indexes on `(user_id, symbol, observed_at desc)`, `(scan_cycle_id)`, `(replay_run_id)`.
- **Retention:** `data-cleanup` prunes raw payloads after 90 days. Before pruning it writes a compact outcome summary row (selected TF, winner candidate ID, rejection code counts, evidence hash) which is retained indefinitely, alongside any linked evidence certificate.

**4. Write path and ownership**

- **bot-scanner owns the original timeframe evidence.** It builds one row per symbol evaluated — including symbols that produced no zone — collects them for the whole cycle and writes them in a single batched upsert that is **awaited** inside try/catch. A failure is logged and never alters the scan result; there are no unawaited writes.
- **zone-confirmation-scanner does not recompute the timeframe story.** It loads the frozen evidence row for the scan cycle, references it via `parent_evidence_id`, and appends a confirmation-only row (`evidence_source = 'confirmation'`) containing confirmation-TF observations and the re-validation result.
- **backtest-engine / replay** collect evidence only when explicitly enabled by an input flag, always batched, always tagged with `replay_run_id`, mirroring the pattern already used by `zoneReplayEvidence.ts`.

**5. Read surface**

`ZoneStoryPanel` gains a lazy-loaded "Timeframe Evidence" section, fetched only when expanded: one collapsible block per slot showing impulses considered, top three candidates, and each losing candidate's structured rejection with measured value and threshold. Read-only, no new controls.

**6. Tests**

- **Parity (required):** across the existing zone-engine fixtures, collector enabled vs disabled produces identical selected timeframe, selected zone, total score, gate outcomes and final execution decision.
- Collector completeness: every leg the engine considered appears in the evidence.
- Structured rejections carry code, measured value, threshold and explanation.
- Idempotency: repeated writes of the same cycle produce one row; immutability trigger rejects payload mutation.
- Truncation: oversized slots trim deterministically and flag `payload_truncated`.
- Option whitelist: non-allowlisted config never reaches the row.
- Confirmation path: writes a linked child row and performs no timeframe recomputation.

### Phase 1 acceptance

- Every scanned symbol yields one evidence row per cycle, including "no zone" outcomes.
- A fully instrumented historical replay can be run for the GBP/CAD case using the available frozen inputs (candles, frozen strategy context, config snapshot), producing complete per-timeframe evidence under the new contract. Phase 1 does not claim to reconstruct evidence that was never stored at the time of the original trade.
- Every rejected timeframe and candidate has an exact, machine-readable reason.
- Parity suite proves no trade decision changed.

## Roadmap (later PRs, each reviewed before merge)

- **Phase 2 — Canonical impulse detector** shared by scanner, Zone Story, backtest/replay and confirmation. Relative measures (displacement percentile, body-strength percentile, ATR-normalised size, BOS significance, recency, sweep origin, structure intact); raw absolutes retained for audit.
- **Phase 3 — Zone lifecycle and ranking:** `fresh` / `tapped_held` / `partially_mitigated` / `violated`; top-three ranking on zone-local confluence, proximity, sweep quality, retest quality, displacement, structural importance, current-price relevance.
- **Phase 4 — Cross-timeframe lineage** using the hierarchy table above. Decisions: `qualified_nested`, `context_only`, `standalone_lower_tf`, `timeframe_conflict`, `no_parent_context`.
- **Phase 5 — Gameplan / DV / Zone Story integration.** Frozen strategy context extended with gameplan version, DV version, parent impulse ID, child impulse ID, zone candidate ID, nesting result, style-policy hash, evidence certificate hash.
- **Phase 6 — Shadow validation** via replay and evidence systems: blocked trades, MAE/MFE, winners retained, losers avoided, missed opportunities, disagreement reasons. The 2:25 GBP/CAD trade becomes a required golden replay test. Observation only.
- **Phase 7 — Bot Config controls:** Cross-Timeframe Authority (Observe / Soft / Hard), Require Nested Impulse, Allow Standalone Lower-TF Setup, Maximum Zone Separation, Minimum Parent-Child Overlap, Sweep-Origin Requirement, Retest Quality, Maximum Candidates Per Timeframe. Nothing shows "Unavailable"; availability and effective runtime value shown separately.
- **Phase 8 — One authority across all entry paths:** normal, unified, cascade, standalone zone, pending fills, zone-confirmation, backtest/replay, manual Scan Now. Legacy divergent calculations become observational, then removed once parity is proven.

Hard mode only after: GBP/CAD replay classified correctly, every rejected timeframe visibly explained, full lineage in the trade breakdown, historical winners/losers compared, live shadow evidence collecting, all entry paths passing parity, paper-mode tests showing no duplicate or bypassed entry, and your explicit approval.
