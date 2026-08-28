# ICT Entry Zone Authority

## Objective

Replace separate OB, FVG, Breaker and Unicorn selection paths with one
explainable authority:

`authoritative setup context -> eligible zone -> liquidity -> confirmation -> authorization`

Legacy percentages, tiers and factor weights remain diagnostics. They do not
select the production entry zone.

## Phase Status

### Phase 1: Contract and breaker semantics - complete

- [x] Define type-neutral OB, FVG and Breaker components.
- [x] Define OB + FVG and Breaker + FVG composite candidates.
- [x] Correct breaker far-boundary invalidation direction.
- [x] Require an opposite structure break for a true breaker.
- [x] Prevent historical breaker retests from creating fresh orders.
- [x] Add observation-only selection to the unified zone result.
- [x] Complete CI and regression review.

### Phase 2: Selection evidence - complete

- [x] Persist legacy-versus-authority candidate decisions.
- [x] Compare winner retention, losers avoided and missed opportunities.
- [x] Display the selection summary in Shadow Evidence.
- [x] Replay the same authority on historical candles with source separation.
- [x] Keep retrospective rows permanently ineligible for runtime activation.
- [x] Establish a 30-resolved-disagreement review threshold.

### Phase 3: Lifecycle parity - pending

- [x] Freeze the observed authority through Watchlist and staged setup.
- [x] Preserve it through the existing frozen strategy context.
- [x] Revalidate breaker ownership, far-boundary lifecycle, thesis and confirmation at fill.
- [x] Use the same pure selector in unified live and backtest analysis.
- [ ] Remove the independent Breaker pending-order authority.

### Non-impulse extension: structure POI research

- [x] Add an explicit `structure_poi` mode to this existing authority.
- [x] Require stable entity/evidence IDs and closed-bar provenance.
- [x] Restrict candidates to the resolved style's setup, structure, and
      confirmation timeframes.
- [x] Reuse the existing type-neutral scoring and overlap construction.
- [x] Keep the result permanently `observe_only` at this phase.
- [x] Generalize and version the frozen setup contract before any paper rollout.
      New writes use `setup-policy-freeze.v2` with one neutral `entryZone`;
      historical `scenarioZoneStory` / `zoneStory` / `impulse_zone` evidence is
      normalized by compatibility readers without changing runtime authority.
- [ ] Wire identical observation inputs from live scanning and backtest.
- [ ] Collect forward outcomes; retrospective replay cannot unlock execution.

## Safety Rule

The new candidate authority remains `observe_only` until forward outcome evidence is
certified. Production behavior must not silently switch selectors.

## Resume Prompt

Continue from `docs/ICT_ENTRY_ZONE_AUTHORITY_PHASES.md`. Verify the current
branch and CI first, then complete the first unchecked item without changing
production authority before certification.
