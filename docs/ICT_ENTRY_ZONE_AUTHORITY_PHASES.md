# ICT Entry Zone Authority

## Objective

Replace separate OB, FVG, Breaker and Unicorn selection paths with one
explainable authority:

`authoritative impulse -> eligible zone -> liquidity -> confirmation -> authorization`

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
- [x] Establish a 30-resolved-disagreement review threshold.

### Phase 3: Lifecycle parity - pending

- [x] Freeze the observed authority through Watchlist and staged setup.
- [x] Preserve it through the existing frozen strategy context.
- [x] Revalidate breaker ownership, far-boundary lifecycle, thesis and confirmation at fill.
- [x] Use the same pure selector in unified live and backtest analysis.
- [ ] Remove the independent Breaker pending-order authority.

## Safety Rule

The new candidate authority remains `observe_only` until forward outcome evidence is
certified. Production behavior must not silently switch selectors.

## Resume Prompt

Continue from `docs/ICT_ENTRY_ZONE_AUTHORITY_PHASES.md`. Verify the current
branch and CI first, then complete the first unchecked item without changing
production authority before certification.
