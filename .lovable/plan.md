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
- Impulse and candidate IDs are produced with the existing `buildEntityId` / `buildEvidenceId` from `_shared/conceptEvidence.ts`. This makes the evidence rows joinable to `zone_candidate_shadow_observations`, to `frozen_strategy_context`, and to `strategy_evidence_certificates` without a translation layer, and gives Phase 4 its lineage keys for free.
- **Canonical candidate ID assigned at first POI mapping.** The moment a POI is mapped inside a leg — before any qualification, scoring or local-confluence processing — it receives a deterministic ID from a single shared helper: `hash(symbol, timeframe, poi.type, poi.high, poi.low, formation candle timestamp, contract version)`. When `localConfluence.candidateId` exists it is reused verbatim (the helper is the same function that produces it), so shadow-observation joins stay exact; candidates rejected before local-confluence processing get the identical ID from the same helper. Every candidate in the evidence payload therefore carries a stable ID regardless of how early it was rejected.

**2. Engine instrumentation (additive, opt-in)**

- `findImpulseLeg` gains an optional collector recording every candidate leg and why non-winners dropped.
- `findBestEntryZone` returns an optional `evidence` field with all mapped POIs, structured rejections and the ranked top three.
- `findBestEntryZoneMultiTF` threads a per-slot collector keyed by slot label.
- Defaults off. No existing signature, return shape or selection branch changes.

**3. Persistence**

New table `public.zone_timeframe_evidence`:

- Header: `user_id`, `bot_id`, `scan_cycle_id`, `symbol`, `direction`, `observed_at`, `trading_style`, `style_policy_version`, `style_base_policy_hash`, `style_policy_hash`, `contract_version`, `selected_timeframe`, `final_reason`, `evidence_source` (`live_scan` | `confirmation` | `replay` | `backtest`), `replay_run_id`, `parent_evidence_id`.
- Payload: `slots`, `engine_options`, `candidates`, `impulses` (jsonb), `payload_truncated` boolean plus `truncation_detail` jsonb.
- **Idempotency:** unique index on `(user_id, bot_id, scan_cycle_id, symbol, direction, contract_version, evidence_source, pending_order_id, confirmation_attempt)`. `pending_order_id` defaults to the nil UUID and `confirmation_attempt` to `0` for scan rows, so a `live_scan` row stays exactly one per cycle/symbol/direction. Confirmation rows carry the real `pending_order_id`, an incrementing `confirmation_attempt`, and their own `evaluated_at`, so **every confirmation attempt persists as its own immutable row** — `ignoreDuplicates` can only collapse a genuine byte-identical retry of the same attempt, never a later attempt.
- `confirmation_attempt` is derived server-side as `max(confirmation_attempt) + 1` for the `(scan_cycle_id, symbol, direction, pending_order_id)` group inside the same insert statement, so concurrent retries cannot silently overwrite each other; a unique-violation on the derived attempt is retried once.
- **Immutability:** a BEFORE UPDATE trigger rejects any change to the payload or header columns of an existing row; outcome/annotation columns added in later phases are the only mutable fields.
- **Option whitelist:** `engine_options` persists only an explicit allowlist (`minQualityScore`, `maxAgeBars`, `minBodyRatio`, `minDisplacementATR`, `fibMaxRetracement`, `originOBRetest`, `strictATRMult`, `pipSize`, `zoneLifecycleV2.enabled`). Arbitrary runtime config, candles and credentials are never written.
- **Size limits:** each slot payload is capped (max legs, max POIs, max candidates per slot, and a byte ceiling). Exceeding a cap trims lowest-ranked entries and sets `payload_truncated` with counts in `truncation_detail`.
- Row `evaluated_at` records when the evidence was produced (distinct from `observed_at`, the source candle time).
- RLS: read scoped to `auth.uid() = user_id`; writes service role. `GRANT SELECT` to `authenticated`, `GRANT ALL` to `service_role`.
- Indexes on `(user_id, symbol, observed_at desc)`, `(scan_cycle_id)`, `(replay_run_id)`.
- **Adaptive retention** (enforced in `data-cleanup`):
  - all raw evidence — 30 days;
  - raw evidence linked to a staged setup, a trade/position, a recorded shadow disagreement, or a golden replay — 90 days;
  - compact summaries (selected TF, winner candidate ID, rejection-code counts, evidence hash) and evidence certificates — indefinitely.
  A compact summary is written before any raw payload is pruned, so nothing is lost silently.

**4. Write path and ownership**

- **bot-scanner owns the original timeframe evidence.** It builds one row per symbol evaluated — including symbols that produced no zone — and writes them in **bounded, awaited chunks**: a chunk closes at whichever limit is hit first, a maximum row count (default 10 rows) or a maximum serialized byte size (default ~512 KB per request). Never one unrestricted request containing all enabled pairs. Each chunk is awaited inside try/catch; a failed chunk is logged, skipped, and never alters the scan result. There are no unawaited writes. A single row that alone exceeds the byte ceiling is truncated per the size-limit rules before being sent.
- **zone-confirmation-scanner does not recompute the timeframe story.** It loads the frozen evidence row for the scan cycle, references it via `parent_evidence_id`, and appends a confirmation-only row (`evidence_source = 'confirmation'`) containing confirmation-TF observations and the re-validation result.
- **backtest-engine / replay** collect evidence only when explicitly enabled by an input flag, always chunked under the same row/byte limits, always tagged with `replay_run_id`, mirroring the pattern already used by `zoneReplayEvidence.ts`.

**4b. Replay provenance — no false "exact reconstruction" claims**

Golden Replay today preserves an input fingerprint, not the complete historical candle arrays. Every evidence row and replay result therefore carries an explicit `replay_provenance` enum:

- `exact_input` — the complete original candle arrays and config snapshot were stored and reused byte-for-byte; the fingerprint matches.
- `historically_refetched` — candles were re-fetched from the data provider for the original window; may differ from what the bot actually saw. **Never labelled exact.**
- `approximate_config` — config or style policy had to be reconstructed rather than read from a stored snapshot.
- `unreplayable` — required inputs are missing; no evidence is claimed.

The UI and any replay report display the provenance label alongside the result; a replay is only described as a reconstruction of what the bot saw when provenance is `exact_input`.

**5. Read surface**

`ZoneStoryPanel` gains a lazy-loaded "Timeframe Evidence" section, fetched only when expanded: one collapsible block per slot showing impulses considered, top three candidates, and each losing candidate's structured rejection with measured value and threshold. Read-only, no new controls.

**6. Tests**

- **Engine parity (required):** across the existing zone-engine fixtures, collector enabled vs disabled produces identical selected timeframe, selected zone, total score, gate outcomes and final execution decision.
- **Scanner-level parity (required):** running `bot-scanner` over recorded fixtures with evidence collection on vs off produces byte-identical results for: unified/zone score, every gate outcome and rejection reason, Watchlist staging decisions, pending-order creation, market-entry authorization, and the final authorization decision. Ordering of persisted trading rows is unchanged, and evidence-write failures are asserted not to change any of the above.
- Collector completeness: every leg the engine considered appears in the evidence.
- Structured rejections carry code, measured value, threshold and explanation.
- Idempotency: repeated writes of the same cycle produce one row; immutability trigger rejects payload mutation.
- Truncation: oversized slots trim deterministically and flag `payload_truncated`.
- Option whitelist: non-allowlisted config never reaches the row.
- Confirmation path: writes a linked child row per attempt and performs no timeframe recomputation; a second confirmation attempt on the same pending order persists a second row rather than being discarded.
- Chunking: a cycle with many pairs is written as multiple bounded, awaited requests respecting both row and byte limits.
- Retention: 30/90-day tiers select the correct rows and a compact summary exists before any raw prune.
- Candidate IDs: a POI rejected before local-confluence processing gets the same deterministic ID it would have received had it survived.
- Replay provenance: refetched inputs are never labelled `exact_input`.

### Phase 1 acceptance

- Every scanned symbol yields one evidence row per cycle, including "no zone" outcomes.
- A fully instrumented historical replay can be run for the GBP/CAD case using the available frozen inputs, producing complete per-timeframe evidence under the new contract, labelled with its honest `replay_provenance`. Phase 1 does not claim to reconstruct evidence that was never stored at the time of the original trade.
- Every rejected timeframe and candidate has an exact, machine-readable reason.
- Engine and scanner parity suites both prove no trade decision changed.

## Roadmap (later PRs, each reviewed before merge)

- **Phase 2 — Canonical impulse detector** shared by scanner, Zone Story, backtest/replay and confirmation. Relative measures (displacement percentile, body-strength percentile, ATR-normalised size, BOS significance, recency, sweep origin, structure intact); raw absolutes retained for audit.
- **Phase 3 — Zone lifecycle and ranking:** `fresh` / `tapped_held` / `partially_mitigated` / `violated`; top-three ranking on zone-local confluence, proximity, sweep quality, retest quality, displacement, structural importance, current-price relevance.
- **Phase 4 — Cross-timeframe lineage** using the hierarchy table above. Decisions: `qualified_nested`, `context_only`, `standalone_lower_tf`, `timeframe_conflict`, `no_parent_context`.
- **Phase 5 — Gameplan / DV / Zone Story integration.** Frozen strategy context extended with gameplan version, DV version, parent impulse ID, child impulse ID, zone candidate ID, nesting result, style-policy hash, evidence certificate hash.
- **Phase 6 — Shadow validation** via replay and evidence systems: blocked trades, MAE/MFE, winners retained, losers avoided, missed opportunities, disagreement reasons. The 2:25 GBP/CAD trade becomes a required golden replay test. Observation only.
- **Phase 7 — Bot Config controls:** Cross-Timeframe Authority (Observe / Soft / Hard), Require Nested Impulse, Allow Standalone Lower-TF Setup, Maximum Zone Separation, Minimum Parent-Child Overlap, Sweep-Origin Requirement, Retest Quality, Maximum Candidates Per Timeframe. Nothing shows "Unavailable"; availability and effective runtime value shown separately.
- **Phase 8 — One authority across all entry paths:** normal, unified, cascade, standalone zone, pending fills, zone-confirmation, backtest/replay, manual Scan Now. Legacy divergent calculations become observational, then removed once parity is proven.

Hard mode only after: GBP/CAD replay classified correctly, every rejected timeframe visibly explained, full lineage in the trade breakdown, historical winners/losers compared, live shadow evidence collecting, all entry paths passing parity, paper-mode tests showing no duplicate or bypassed entry, and your explicit approval.
