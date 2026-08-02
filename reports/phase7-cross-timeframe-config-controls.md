# Cross-Timeframe Impulse Authority — Phase 7

## Outcome

The complete policy is now configurable and observable without granting new
trade authority.

## Controls

- Authority mode: Observe, Soft or Hard
- Require nested impulse
- Allow standalone lower-timeframe setups
- Maximum parent/child zone separation in ATR
- Minimum parent/child overlap percentage
- Sweep-origin requirement
- Retest quality
- Maximum candidates per timeframe

## Safety model

The saved mode is a request. Runtime separately resolves:

1. requested mode,
2. evidence-certified maximum,
3. effective mode.

Missing, disabled, unapproved or scope-incompatible activation always caps the
effective mode at Observe. The scanner records the resolved policy in scan
evidence and continues using the Phase-6 observation decision only. Phase 7
does not block, penalize, size, stage or execute trades.

The read-only `cross_timeframe_authority_runtime_status` view provides the same
requested/certified/effective separation for backend verification.

## Validation

- Authority resolver unit tests
- Runtime config mapping tests
- UI and scanner wiring contract tests
- Frontend typecheck and production build
