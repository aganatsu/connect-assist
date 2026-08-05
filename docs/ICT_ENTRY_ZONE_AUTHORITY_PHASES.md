# ICT Entry Zone Authority

## Objective

Replace separate OB, FVG, Breaker and Unicorn selection paths with one
explainable authority:

`authoritative impulse -> eligible zone -> liquidity -> confirmation -> authorization`

Legacy percentages, tiers and factor weights remain diagnostics. They do not
select the production entry zone.

## Phase Status

### Phase 1: Contract and breaker semantics - in progress

- [x] Define type-neutral OB, FVG and Breaker components.
- [x] Define OB + FVG and Breaker + FVG composite candidates.
- [x] Correct breaker far-boundary invalidation direction.
- [x] Require an opposite structure break for a true breaker.
- [x] Prevent historical breaker retests from creating fresh orders.
- [x] Add observation-only selection to the unified zone result.
- [ ] Complete CI and regression review.

### Phase 2: Selection evidence - pending

- [ ] Persist legacy-versus-authority candidate decisions.
- [ ] Compare winner retention, losers avoided and missed opportunities.
- [ ] Display the selection reason in Shadow Evidence.
- [ ] Establish certification thresholds for controlled promotion.

### Phase 3: Lifecycle parity - pending

- [ ] Freeze the selected authority through Watchlist and staged setup.
- [ ] Preserve it through pending order, fill and position.
- [ ] Revalidate impulse, lifecycle, price contact and confirmation at fill.
- [ ] Use the same pure selector in backtest and live paths.
- [ ] Remove the independent Breaker pending-order authority.

## Safety Rule

The new candidate authority remains `observe_only` until replay evidence is
certified. Production behavior must not silently switch selectors.

## Resume Prompt

Continue from `docs/ICT_ENTRY_ZONE_AUTHORITY_PHASES.md`. Verify the current
branch and CI first, then complete the first unchecked item without changing
production authority before certification.
