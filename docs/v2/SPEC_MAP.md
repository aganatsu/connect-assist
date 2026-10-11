# V2 Phase 2 — spec → module → test map

Spec: `STRATEGY_SPEC_V2.1.1_FROZEN.md` (sha256 `3369eda73a27ecb264dd360de8201e5f7ba772264ad3fac915f747e2fad4fb93`). V2.0.2 (PARKED) is reproducible at tag `v2.0.2-parked`.
Engine: `supabase/functions/_shared/v2/` (pure — no I/O, clock, DB or network). Independent checker: `supabase/functions/_shared/v2check/`.
Tests: `supabase/tests/v2/` — every test is tagged `[§…]`; `coverage.test.ts` fails if a normative clause has no tagged test.
Review charts: `scripts/v2/chart.ts`, runner `scripts/v2/replay.ts`.

Prices are integers (1,000 points per pip), so every threshold comparison is exact.

| Spec | Module / function | Tests |
|---|---|---|
| 0.1, 6.5 | `spec.ts` constants, `QUOTE_TO_USD`, `COST_PTS` | stop_rr_sizing: cost table, commission back-check |
| 0.2, 0.4 | `v2Lifecycle.runEngine` (5m decision grid), `v2Direction` (1H/15m) | lifecycle: full lifecycle, touch timing; direction |
| 0.3, 1.2, 1.3, 1.3a, 1.4 | `barStore` (`toPoints`, `buildSeries` segments, `isProviderWide`, `lastClosed`) | structure: points, segments, dropped bars, provider-wide |
| 0.5, 11.4 | `atr.atrSum` → `smcAnalysis.calculateATR` (only Baseline A function used) | structure: ATR; imports |
| 0.6, 2.0 a–e | `v2Structure` (`buildStructure`, `unbrokenAt`, `view`, `visibleSwings/Breaks`, `swingRecord`) | structure: fractal strictness, single break, window/segment, swing record |
| 0.7 | `v2Poi.isDisplacement` colour | poi: displacement thresholds |
| 0.8, 0.9, 0.11, 1.1, AM3 | `calendar` (IANA `Intl` America/New_York; closures; window; trading day; Asian; news week) | calendar: DST 2026/27, closures, window edges; checker DST rule = IANA hourly 2026–2027 |
| 0.10 | `v2NetRR` | stop_rr_sizing: R:R boundary, gross/net R |
| 1.5, 1.6, 1.9 | `v2Lifecycle` step 1 | lifecycle: DATA_GAP_ARMED, FRESHNESS_UNKNOWN, PROVIDER_WIDE, 1H gap |
| 1.7, 9 | `v2Lifecycle.exitStep` | lifecycle: SL+TP same bar, gap open beyond SL/TP |
| 1.8, 2.1 | `v2Direction.direction` | direction: bias, veto at 10th/11th bar, NOT COMPUTABLE cases, post-gap recovery |
| 2.2, 2.3 | `v2Lifecycle` step 5 / `setupStep` | lifecycle: SPENT_DIRECTION, DIRECTION_FLIP |
| 3.1–3.7, O1 | `v2Poi.legsAt`, `poisOf` | poi: leg geometry, b−o boundary, O1, reference unbroken, segment span, FVG/OB/depth/identity |
| 3.8, 3.9 | `v2Lifecycle` step 2 | lifecycle: LOOKBACK_EXPIRED at index 149, LEG_INVALIDATED |
| 3.10–3.12, 4.1–4.3 | `v2Lifecycle` step 5 | lifecycle: touch boundary, every spend reason, SAME_BAR, ARMED_AND_INVALIDATED, PAIR_BUSY |
| 5.1–5.5 | `v2Structure.protectedSwing`, `v2Lifecycle.setupStep` | structure: protected swing; lifecycle: CHoCH, INVALIDATED, EXPIRED, one confirmation |
| 6.1–6.4 | `v2Lifecycle.entryStep`, `v2Stop`, `v2Sizing` | lifecycle: each entry check; stop_rr_sizing |
| 7.1–7.6, 7.1a, AM2 | `v2Target.selectTarget` | target: sweep strictness, merge, limiter, UNKNOWN between, AM2, price-unknown, Asian edge |
| 7.4, 6.3d, AM1 | `v2Lifecycle` pre-touch snapshot → `entryStep` / `selectTarget` | lifecycle: AM1 (prior-armed and same-bar-armed), spent-before-k |
| 8.1–8.4 | `v2News` (`validate`, `feedAt`, `newsBlock`); replay = `"REPLAY"` | news; lifecycle: NEWS_BLOCK, NEWS_BLOCKED_CONFIRMATION, FEED_UNAVAILABLE |
| 10.1–10.3 | `v2Lifecycle` step 5 ranking | lifecycle: cap ranking, exit frees slot on the same bar |
| 11.6 | `v2Lifecycle` schedule (`tradable`, `runTime`) | lifecycle: SPENT_DATA_PENDING, DATA_PENDING_CONFIRMATION, late run; fidelity: random schedules |
| 12.1–12.5, 12.7 | `v2Evaluation` | evaluation; fidelity |
| TP1 (2.1–2.4, 4.1, 11.6) | `v2Lifecycle`: no direction check at arming, no DIRECTION_FLIP; D1′ logged as DIR telemetry only | lifecycle: 15m veto ignored, 1H flip ignored |
| SA1 (5.3, 6.2, 6.3a) | `v2Stop.chochOrigin`, `stopLoss`; `v2Lifecycle.entryStep` | stop_rr_sizing: CHoCH origin; lifecycle: every entry check with the new SL |
| LO1 (4.2, 5.4, 13, 15) | `v2Lifecycle.setupStep`: no far-edge invalidation; LEG_INVALIDATED (step 2) is the only price-based setup end | lifecycle: far-edge close survives, leg invalidation precedes CHoCH |
| CF1 (3.13) | `v2Lifecycle` step 5: both directions of a pair eligible on one bar → both SPENT_CONFLICT, before 10.3 ranking | lifecycle: conflict (mirrored), ineligible bars are not conflicts |
| 0.12, W1 | `EngineInput.measuredStart`; `v2Lifecycle` step 5 warm-up branch (SPENT_WARMUP) | lifecycle: W1 ×3; fidelity: warm-up |
| GT (7.1a) | `v2Target.sweepState` (SWEPT → UNKNOWN → VALID) | target: swept-before-gap, valid-at-gap, swept-after-gap; lifecycle: GT at entry |
| PS (2.0, 5.1) | `v2Structure.protectedSwing` (swing bar ≥ b close; left context may precede) | structure: PS scope, missing left context |
| B1 (12.2) | `v2Evaluation` (`mulberry32`, `dayBlocks`, `resample`, `bootstrapCI`) | evaluation: reference implementation from the spec text, block duplication |
| 13, 16 | `V2Event` log; `v2Lifecycle` sole state changer | coverage: every reason asserted; fidelity |
| 15 | `v2Lifecycle.processDecision` (steps 1–4 per pair, joint step 5) | lifecycle: precedence cases |
| OWN, 11.5 | import graph | imports: v2 isolation, checker independence, nothing in production imports V2 |

Deferred (no Phase 2 behaviour; listed in `coverage.test.ts`):
- 11.1–11.3 — forward storage, fetching and credit accounting (Phase 4 runtime).
- 12.6, 12.8 — governance and reporting.
- 14 — no V2 code.

## Fidelity checker
`v2check/checker.ts` imports nothing outside `v2check/`. It differs from the engine in four ways:
- New York time comes from a hand-written US DST rule (verified equal to IANA for every hour of 2026–2027).
- It has its own price conversion and its own ATR.
- It recomputes every swing, break, leg, POI, protected swing and target by brute force at each decision time.
- It runs its own state machine.

`compare.ts` diffs the full event logs: direction changes, every POI/setup/trade transition and reason, and entry/SL/TP/lots/exit prices.
