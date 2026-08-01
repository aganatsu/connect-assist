# Phase 1 — Cross-Timeframe Impulse Authority: Full Per-Timeframe Evidence

Branch slug: `phase1-cross-tf-evidence`
Status: implemented, observation-only. No ranking, gating, config or execution change.

## Behavior changes
None to trading. Additive evidence capture only.

## Migration
`supabase/migrations/20260801200706_5a993ade-4fa3-4bfd-9f34-514247bd3c93.sql`
- `public.zone_timeframe_evidence` (immutable rows; unique on user_id, bot_id, scan_cycle_id, symbol, direction, contract_version, evidence_source, pending_order_id, confirmation_attempt)
- `public.zone_timeframe_evidence_summary` (indefinite compact summaries)
- BEFORE UPDATE immutability trigger, RLS (owner read / service_role write), GRANTs, indexes.

## Edge Functions
1. `bot-scanner` — owns original timeframe evidence; one row per scanned symbol per cycle (including "no zone"); bounded awaited chunks (max 10 rows / ~512 KB); write failures logged and swallowed.
2. `zone-confirmation-scanner` — no timeframe recomputation; one immutable child row per confirmation attempt, linked via `parent_evidence_id`.
3. `data-cleanup` — adaptive retention: 30d raw, 90d linked raw (setup/trade/disagreement/replay), summaries indefinite; summary written before any prune.

## Shared modules
- `supabase/functions/_shared/zoneCandidateIdentity.ts` — canonical candidate ID at first POI mapping; reuses `localConfluence.candidateId` verbatim.
- `supabase/functions/_shared/zoneTimeframeEvidence.ts` — evidence contract `zone-tf-evidence.v1`, chunking, byte ceiling, option allowlist, truncation.

## Frontend
- `src/components/TimeframeEvidencePanel.tsx` — read-only, lazy-loaded per-slot evidence (impulses, top-3 candidates, structured rejections with measured value + threshold).
- `src/components/ZoneStoryPanel.tsx` — mounts the panel in a collapsible "Timeframe Evidence" section. No new controls.

## Tests run
`deno test --no-check --allow-read --allow-net --allow-env tests/zone_timeframe_evidence_test.ts`

```
running 6 tests from ./tests/zone_timeframe_evidence_test.ts
scan evidence build does not mutate engine inputs ... ok (3ms)
scan evidence row carries no execution fields ... ok (0ms)
chunking respects both row-count and byte ceilings ... ok (0ms)
persistence never throws into the scan path ... ok (0ms)
persistence upserts on the multi-attempt identity ... ok (0ms)
each confirmation attempt is a distinct immutable row ... ok (0ms)

ok | 6 passed | 0 failed (12ms)
```

## Regression check
Frontend typecheck clean. No change to scoring, gate evaluation, Watchlist staging, pending-order creation, market-entry authorization or final authorization.

## Suggested PR title
Phase 1: per-timeframe zone evidence capture (observation only)
