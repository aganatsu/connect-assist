# Phase 1 — Cross-Timeframe Impulse Authority: Full Per-Timeframe Evidence

Branch: `codex/phase1-evidence-review`
Status: implemented and independently corrected, observation-only. No ranking,
gating, config or execution change.

## Behavior changes
None to trading. Additive evidence capture only.

## Migration
`supabase/migrations/20260801200706_5a993ade-4fa3-4bfd-9f34-514247bd3c93.sql`
- `public.zone_timeframe_evidence` (immutable rows; unique on user_id, bot_id, scan_cycle_id, symbol, direction, contract_version, evidence_source, pending_order_id, confirmation_attempt)
- `public.zone_timeframe_evidence_summary` (indefinite compact summaries)
- BEFORE UPDATE immutability trigger, RLS (owner read / service_role write), GRANTs, indexes.

Corrective review:
`supabase/migrations/20260801213000_fix_zone_timeframe_evidence_contract.sql`
- preserves every immutable header/payload field, including parent lineage and
  style-policy provenance;
- adds an atomic per-pending-order confirmation-attempt allocator;
- retains setup/trade lifecycle observations for 90 days through
  `event_linked`, while routine raw observations remain 30 days;
- keeps parent UUIDs and policy provenance in indefinite compact summaries.

## Edge Functions
1. `bot-scanner` — owns original timeframe evidence; one row per scanned symbol per cycle (including "no zone"); bounded awaited chunks (max 10 rows / ~512 KB); write failures logged and swallowed.
2. `zone-confirmation-scanner` — no timeframe recomputation; one immutable
   child row per confirmation attempt, linked to the exact frozen originating
   evidence UUID. Older pending orders retain a compatibility lookup.
3. `data-cleanup` — adaptive retention: 30d raw, 90d linked raw
   (setup/trade/lifecycle/disagreement/replay), summaries indefinite; summary
   written before any prune. Bounded batches can compact up to 10,000 rows per
   run and report a possible backlog.

## Shared modules
- `supabase/functions/_shared/zoneCandidateIdentity.ts` — canonical candidate ID at first POI mapping; reuses `localConfluence.candidateId` verbatim.
- `supabase/functions/_shared/impulseZoneEngine.ts` — opt-in collector records
  the exact impulse candidates, mapped POIs, qualification measurements and
  ranked zones traversed by each engine invocation. The collector defaults off.
- `supabase/functions/_shared/zoneTimeframeEvidence.ts` — evidence contract
  `zone-tf-evidence.v1`, exact engine-snapshot projection, style/timeframe
  provenance, chunking, byte ceiling, top-three candidate limit, option
  allowlist and deterministic truncation.

## Frontend
- `src/components/TimeframeEvidencePanel.tsx` — read-only and genuinely
  lazy-loaded. Historical rows query only their exact frozen evidence UUID;
  latest-by-symbol lookup is restricted to explicit live scan contexts. After
  raw expiry, the same ID resolves to its indefinite compact summary.
- `src/components/ZoneStoryPanel.tsx` — mounts the panel for success, error,
  no-zone and no-impulse outcomes. No strategy control was added.

## Tests run
`deno test --allow-read supabase/functions/_shared/impulseZoneEngine.test.ts supabase/functions/_shared/unifiedZoneEngine.test.ts supabase/functions/_shared/zoneReplayEvidence.test.ts supabase/functions/_shared/zoneReplayWiring.test.ts supabase/functions/_shared/zoneTimeframeEvidenceWiring.test.ts tests/zone_timeframe_evidence_test.ts`

```
ok | 91 passed | 0 failed
```

`npm test -- --run src/components/TimeframeEvidencePanel.test.tsx src/components/ZoneStoryPanel.test.tsx`

```
Test Files  2 passed (2)
Tests       7 passed (7)
```

## Regression check
The collector-on/off parity assertion compares the complete engine decision
object after removing only the additive evidence snapshot. Production frontend
build is clean. No change to scoring, gate evaluation,
Watchlist staging, pending-order creation, market-entry authorization or final
authorization.

## Suggested PR title
Phase 1: per-timeframe zone evidence capture (observation only)
