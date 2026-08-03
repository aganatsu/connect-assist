> Current unresolved authority work is tracked in
> [SYSTEM_AUTHORITY_STATUS_2026-08-03.md](./SYSTEM_AUTHORITY_STATUS_2026-08-03.md).
> This roadmap retains historical slice details and should not be used alone to
> infer current deployment or enforcement status.

# System hardening roadmap

This file is the repository-level status tracker for the agreed eight-phase
implementation plan. A phase is only marked complete after its migration,
functions and UI have been deployed and verified.

| Phase | Purpose | Status |
|---|---|---|
| 1 | One execution authority | Complete and concurrency-verified |
| 2 | Bot Config contract | Complete |
| 3 | Unify Gameplan, Direction Verdict and thesis | Complete and production-verified |
| 4 | Watchlist and Zone Setup lifecycle | Implementation complete; deployment verification pending |
| 5 | Operations and scanner reliability | In progress — Phase 5A merged; Phase 5B in review |
| 6 | Rejected Setups and shadow evidence | Phase 6A deployed; collecting evidence |
| 7 | Backtest/live parity | Complete and deterministic-fixture verified |
| 8 | Strategy validation and controlled activation | Phase 8A production-verified; Phase 8B evidence certificates in review |

## Corrective Phase 2C / 3C — style-aware policy consistency

This workstream was added after the full critical-path audit found that the UI,
full scanner, fast confirmation scanner, manual Gameplan refresh, position
management and backtest engine do not all interpret the selected trading style
the same way. It must finish before Phase 6 begins.

| Slice | Purpose | Status |
|---|---|---|
| 1 | Shared resolved style-policy contract and durable observability | Complete and production-verified |
| 2 | One configuration resolution path for every runtime surface | Complete and production-verified |
| 3 | Remove duplicate UI presets and show the effective runtime policy | Complete and production-verified |
| 4 | Make timeframe roles authoritative for every analysis module | Complete and production-verified |
| 5 | Rewire Gameplan, Direction Verdict, thesis and conviction to those roles | Complete and production-verified |
| 6 | Make Gameplan validity windows style-aware | Merged; deployment verification pending |
| 7 | Freeze the policy through Watchlist, pending, confirmation and fill | Direct-entry path production-verified; Slice 7.1 in review |
| 8 | Use one style-frozen management engine in live and backtest paths | Slice 8A deployed; Slice 8B in progress |

Slice 1 is observe-only. It assigns two stable fingerprints: a base-policy hash
for comparing shared style/configuration across surfaces, and an exact policy
hash that includes pair-specific execution adjustments. It records the
effective style, timeframe roles, cadence, qualification thresholds, risk,
management, lifecycle values and override provenance on active Gameplans,
Direction Verdicts, Watchlist setups, pending orders and positions. Scan logs
and backtest results expose the same snapshot. It does not alter authorization,
position sizing, order placement or management behavior.

Slice 1 was production-verified on 2026-07-29. Automatic Gameplan version
`1375a448` and all eight matching Direction Verdicts persisted
`style-policy.v1.1`, the same non-null base-policy hash, the selected `scalper`
style and matching Gameplan-version references.

Slice 2 introduces one canonical resolution order for server-side runtime
surfaces: stored/request configuration → canonical field mapping → selected
trading-style profile. The automatic scanner resolves before its interval gate
and position-management cycle; the fast confirmation scanner, manual Gameplan
refresh and backtest engine use that same resolver. Surface-specific backtest
constraints remain explicit post-resolution overrides.

Slice 2 was production-verified on 2026-07-29 from main merge `014dc901`.
Natural scanner and confirmation cycles loaded the shared resolver, resolved
the selected `scalper` style to a five-minute cadence and completed without
configuration-resolution, import or runtime errors.

Slice 3 removes the frontend's executable conservative/moderate/aggressive
style presets. Selecting Scalper, Day Trader or Swing Trader now changes only
the requested style and preserves every explicit Bot Config override. The
backend resolver remains the sole owner of executable profile values. Bot
Config and the scan header display the persisted effective policy—including
cadence, timeframes, confluence gate, target ratio, risk, management behavior,
contract version and base-policy hash—rather than recreating those values in
the browser. User-saved custom full-config presets remain available.

Slice 3 was production-verified on 2026-07-29 from main merge `f11e4d3`.
The live Bot Config displayed `style-policy.v1.1`, base hash
`a538f6b1f46d`, Scalper, five-minute cadence, 5m/1H runtime timeframes, a
20% effective gate, 2:1 target, 0.5% risk, trailing management and four
preserved overrides. An unsaved Day Trader selection changed only the pending
selection and left the effective live policy unchanged.

Slice 4 introduces one policy-derived timeframe authority for structural
analysis. Direction and unified-zone engines in both the automatic scanner and
backtest now bind candles by the immutable bias → structure → setup roles
instead of maintaining separate style switches. Direction labels and zone
labels are generated from the same role contract. The backtest now fetches
actual 15-minute structure candles for Scalper instead of substituting 1-hour
candles, closing a material live/backtest parity gap. The separate
confirmation and refinement roles remain explicit for the next decision-layer
slice; they are not silently repurposed as structural inputs.

Slice 4 was production-verified on 2026-07-29 from main merge `0d5d061`.
The redeployed scanner resolved Scalper with the persisted
`style-policy.v1.1` ladder 1H bias → 15m structure → 5m setup, retained the
user's protected overrides and completed a natural cycle without boot, import
or runtime errors.

Slice 5 introduces `style-decision-evidence.v1`, one auditable structural
snapshot built from the Slice 4 authority. Automatic and manual Gameplans now
use its bias and structure layers for their two primary structural votes;
Direction Verdict uses its confirmed trend and style-bias regime; thesis
revalidation uses its current structural direction; and both structural and
rolling thesis conviction use its style structure layer. Live scanning,
backtesting, manual Gameplan refresh and fast confirmation all construct the
same contract. Weekly context contributes to Direction Verdict only when
Weekly is the selected style's bias role. Legacy fields remain as compatibility
fallbacks, but they no longer override a present style decision snapshot.

Slice 5 was production-verified on 2026-07-29 from main merge `0869c6f`.
Scalper resolved to the expected 1H bias → 15m structure → 5m setup ladder.
The follow-up review prevents a transient candle-source failure from activating
a partial Gameplan, retries missing pairs during manual refresh, preserves the
previous complete plan when generation remains incomplete, and renders
conflict reasons with the active style's timeframe labels.

Slice 6 introduces `gameplan-validity.v1`, a persisted validity decision shared
by automatic and manual Gameplan generation. Scalper plans have a maximum
two-hour lifetime, Day Trader plans four hours and Swing Trader plans 24 hours.
The scanner reuses a plan only while its saved style, session and expiry still
match the current runtime policy; a saved style change therefore regenerates
the plan before it can become candidate context. The selected duration, style,
valid-from time and expiry are stored on the immutable plan version and exposed
in the Gameplan UI. Existing `style-policy.v1.1` evidence remains readable,
while a legacy Gameplan without a validity contract is regenerated once.

Slice 6 does not change entry authorization or make narrative scenarios
executable. It only makes the lifetime of their owning Gameplan explicit and
style-aware.

Slice 7 introduces `setup-policy-freeze.v1`, an immutable origin package that
travels from Watchlist qualification through pending confirmation and fill.
It freezes the exact resolved style policy, Gameplan and Direction Verdict
versions, originating zone, same-direction narrative scenario candidates,
confirmation method, indicator threshold, confirmation/refinement timeframes
and maximum confirmation attempts. Both confirmation scanners now use those
frozen timeframes and limits even if Bot Config changes while the setup waits.
The database fingerprints the package and rejects later attempts to replace it.

Narrative scenarios remain explicitly `observe_only`: the system records which
same-direction scenarios existed, but does not claim that one matched or use
scenario prose to authorize execution. Fill-time account, kill-switch, broker,
spread, prop-firm, fresh-thesis and current-direction safety checks remain
current. They can reject an old setup without rewriting the evidence that
originally qualified it.

Slice 7's direct-entry path was production-verified on 2026-07-30. A natural
CAD/JPY market entry persisted a non-null frozen strategy hash, policy freeze
timestamp, candidate ID and `style-policy.v1.2` evidence on its position.
Watchlist and pending propagation remained unobservable because the active
configuration requires a complete unified zone and uses market rather than
limit orders.

Slice 7.1 separates Watchlist visibility from execution eligibility. A
directional candidate above the normal Watchlist floor can appear as
`waiting_for_unified_zone`, but the database prevents that observation from
creating an order or position. When a complete zone appears, the observation
is resolved and a fresh candidate—with a new ID and complete frozen zone
evidence—is created. Complete zones waiting for price, confirmation or a
liquidity sweep are staged before the hard unified-zone skip. The hard
execution gate and all zone qualification thresholds remain unchanged.

## Scenario and Zone Story integration thread

The Gameplan scenario, zone story and executable entry path are one decision
chain, but they are activated in controlled phases:

- Slice 6 keeps scenarios observational while making their owning plan's
  validity auditable.
- Slice 7 freezes the exact scenario/zone evidence and matching rule through
  Watchlist, pending, confirmation and fill, so the setup cannot silently
  change after qualification.
- Slice 8 uses the same frozen evidence in live and backtest management. Only
  after parity and rejected-setup evidence demonstrate value can a scenario
  matcher move from observation to a configurable execution gate.

Slice 8A introduces `management-policy.v1` and upgrades the style snapshot to
`style-policy.v1.3`. The snapshot now includes every break-even and adaptive
trailing input, not only the visible on/off settings. Live position management
prefers the immutable setup policy that existed when the trade opened; entry
intent is the compatibility source for legacy positions, and an explicit
per-trade override is the only supported way to change an open trade.

The backtest freezes the same pair-specific management projection on every
position and retains it through chunk continuation and the completed trade
record. Break-even, trailing, max-hold and session-close calculations now call
the same pure decision engine in live and backtest paths.

Slice 8B introduces `exit-parity.v1` for the two remaining decision gaps.
Partial closes now use one pure trigger, size-rounding and P&L/commission
calculation. The fill model remains explicit: live uses the observed market
fill, while candle backtests use the exact R threshold instead of receiving
unrealistic full-candle price improvement. Database and broker writes remain
surface adapters; the shared contract records the trigger, fill, closed and
remaining size, gross P&L, commission and net P&L.

Structure invalidation now uses the same 120-candle entry-timeframe window and
252-completed-daily-candle regime window in both paths. Both surfaces apply
the same rule that suppresses internal-only opposing CHoCH in ranging or
transitional conditions before calling the common SL calculator. Live
positions retain the evidence in their management history, and backtest trades
retain the same evidence in their results. Slice 8 is complete only after 8B
is merged, deployed and verified against a natural management event or a
controlled paper/backtest parity fixture.

The next Phase 7 slice introduces the observational `golden-replay.v1`
candidate snapshot. Live scans and historical runs now emit the same
timestamped decision shape for style policy, direction, Gameplan, zone story,
scenario evidence, score, normalized gates, entry eligibility, stop and
target. Surface-specific gate wording remains visible as evidence but is not
allowed to create false mismatches; normalized gate codes drive the parity
hash. Database and in-memory Gameplan/Direction Verdict IDs remain attached as
provenance, but do not affect the semantic decision hash because those record
identities can legitimately differ between live and replay surfaces.

Backtests retain the latest 500 candidate snapshots through chunk
continuations and expose them in the completed result. Live scans attach the
same snapshot to the pair detail. Missing fields are reported as incomplete
coverage instead of being treated as agreement. Scenario candidates remain
`observe_only` and cannot authorize, block, size or place a trade in this
slice. Phase 7 is not complete until deterministic candle fixtures exercise
both engines and the remaining event-lifecycle fields are captured and
compared.

Phase 7B finalizes that snapshot after the existing engine has made its actual
execution decision. Live market and limit paths now record the final entry,
SL, TP, risk-to-reward, computed position size, order type and lifecycle
outcome. The durable pending/position signal evidence retains the authorized
snapshot, while scan detail records the subsequent created, opened, blocked or
failed result. Backtests finalize the same contract after their existing
position-sizing calculation and retain it on the opened and completed trade.

This slice does not unify or alter the sizing algorithms. Live sizing still
applies its configured volatility, prop-firm, correlation and signal-source
adjustments; the historical engine still records the size it actually
calculated. A size mismatch is therefore visible evidence for the deterministic
replay phase, not silently rewritten agreement. Phase 7 remains incomplete
until identical candle fixtures drive both candidate engines and every
intentional surface difference is classified.

Phase 7C introduces `golden-replay-report.v1`. It pairs live and backtest
observations by symbol and normalized candle timestamp, prefers exact decision
hash matches when more than one lifecycle observation exists, and reports
every mismatch by its precise decision path. A difference can be classified
as intentional only through an explicit path-and-reason rule; it remains
visible in the report.

A matching decision is not deterministic proof by itself. Both surfaces must
carry the same canonical `golden-replay-input.v1` fingerprint, built from the
symbol, normalized timestamp, base policy, timeframe roles, exact candle
arrays and configuration projection. Both snapshots must have complete
coverage, neither surface may be missing, and every difference must either be
absent or explicitly documented. The report separately counts input
mismatches, unverified inputs, incomplete evidence, missing observations,
unexpected mismatches and intentional differences.

The authenticated backtest endpoint exposes this as the bounded
`golden_replay_report` action. It validates `golden-replay.v1` inputs and
accepts at most 1,000 observations per surface; it performs no scan, backtest,
trade or database mutation.

The shared decision-fixture runner proves the report contract with identical
fingerprinted inputs, deliberate sizing drift, documented fill-model
differences and missing/incomplete observations. This does not yet claim that
the two monolithic runtime orchestrators consumed the same raw candles.
Phase 7 becomes complete only when the live candidate and historical adapters
both emit fingerprints from the same canonical candle/configuration fixture
and the resulting report passes.

Phase 7D wires those fingerprints into both runtime adapters. Each live and
historical candidate snapshot now hashes the exact role-bound candle arrays
used for bias, structure, setup, confirmation, refinement, runtime entry and
runtime HTF decisions, together with the resolved style policy and public
runtime configuration consumed by that surface. Pair scratch fields beginning
with `_` are excluded because they are derived evidence already represented
by the canonical candle/decision contracts; wall-clock policy resolution time
is also excluded.

This remains observational and changes no scan, gate, sizing, order or
management behavior. Production live and historical fingerprints are allowed
to disagree when their candle windows or runtime overrides genuinely differ;
the report must label that as `input_mismatch`, not manufacture parity.
Phase 7 is operationally complete only after one controlled identical-input
fixture produces matching fingerprints, complete evidence and a deterministic
passing report.

Phase 7E closes the position-size calculation gap exposed by the runtime
fingerprints. Historical entries now use the same commission-aware unified
sizing engine as live entries, with the same volatility-regime mapping,
portfolio-concentration advisory multiplier, signal-source multiplier,
rounding order and minimum-lot floor. The live path calls those same shared
post-sizing helpers, preserving its existing behavior while preventing the two
surfaces from drifting independently.

Live prop-firm sizing remains current-account evidence that a historical
fixture cannot reconstruct. A controlled parity fixture must therefore either
disable that context on both surfaces or record its difference explicitly.
The phase is still not complete until the identical-input report passes.

Phase 7 completion was verified on 2026-07-30 with the controlled EUR/USD
fixture at `2026-07-22T09:45:00Z`. Both surface adapters independently produced
input fingerprint
`golden-replay-input.v1:72342b915f418c19ada025b9ce705f37fe08636028747e12492c6330018c8c34`
and decision hash
`3e07d8887e7fa21209a7af099f2cf86f9aa2de3615fed97ea6cd6019631327f8`.
Both snapshots had complete coverage, the finalized position size was `0.29`,
and `golden-replay-report.v1` returned one match with zero input, decision,
coverage or missing-surface failures and `deterministicPass=true`. Those values
are locked into the regression fixture so later behavioral drift must be
reviewed explicitly.

## Phase 3 implementation record

- Phase 3A moved active Gameplans into dedicated immutable versioned storage
  and made manual and automatic refreshes use the same data/configuration path.
- Phase 3B establishes the ordered decision hierarchy:
  Gameplan context → Direction Verdict authority → thesis validity → entry
  confirmation.
- Direction Verdict now has its own versioned source of truth instead of being
  recovered from general scan logs.
- Candidate observations, pending orders and positions retain the exact
  Gameplan version, Direction Verdict, thesis result and confirmation evidence
  used at their stage.
- Thesis validity is a hard fill-time safety decision. Thesis Conviction is
  explicitly observational and cannot authorize a trade.

Phase 3 was production-verified on 2026-07-29. A natural eight-pair scan
persisted eight active Direction Verdicts, and every verdict referenced the
matching active Gameplan ID and shared plan version. No Direction Verdict
authority or persistence errors were present in that scan cycle.

## Phase 4 implementation record

- Watchlist and Zone Setup candidates now use one auditable lifecycle:
  watching → qualified → pending → awaiting confirmation → filled, with
  explicit invalidated, expired, cancelled and blocked-after-qualification
  outcomes.
- Crossing the score gate records qualification only. A setup is not treated
  as successfully promoted until its pending order or position is created.
- Every setup carries a stable candidate ID plus its exact Gameplan, Direction
  Verdict, thesis, originating zone, confirmation rule and authorization
  evidence through pending order and position creation.
- Confirmation mode and its indicator threshold are frozen when the setup is
  created. Later Bot Config changes do not rewrite an in-flight setup.
- Database triggers preserve status changes in an owner-readable lifecycle
  event history and keep Watchlist state synchronized with downstream pending
  orders and positions.

Phase 4 becomes operationally complete after the migration is applied, both
scanners and the frontend are deployed, and a natural paper-mode setup proves
that one candidate ID and matching decision evidence appear from Watchlist
qualification through its final outcome.

## Phase 5 implementation record

- Phase 5A introduces a durable per-user, per-bot runtime timeline before
  background scanner work begins.
- Full scans record invocation, scan start, live pair progress, pair-processing
  completion and final completion. Management and confirmation cycles record
  their own start, heartbeat and completion evidence.
- Scheduled Tasks reads this runtime evidence instead of treating manual
  `run_now` updates as proof that cron executed.
- Full-scan overlap protection moves from the mutable `paper_accounts` timestamp
  to an atomic user + bot + scope lease. Manual scans cannot clear another
  invocation's valid lease.

Phase 5A becomes operationally complete after its migration is applied, the
three Edge Functions and frontend are deployed, and natural cron cycles show
advancing heartbeats and completion timestamps.

- Phase 5B adds a one-minute database health evaluator with an initial grace
  window, durable deduplicated alerts and automatic recovery.
- It detects missing heartbeats, incomplete runs, MetaAPI certificate and
  connection failures, total candle-source exhaustion, stale confirmation
  orders, repeated scheduler authorization failures and required migration
  drift.
- Scheduled Tasks displays the active alerts and their repeat count. Alerts
  resolve automatically when the underlying condition recovers.

## Phase 6 implementation record

- Phase 6A adds a read-only Shadow Evidence report to Rejected Setups. It
  compares the current system decision with the Gameplan Hierarchy and Thesis
  Conviction proposal across distinct rejected opportunities and completed
  trades.
- The report separately counts rescued winners, avoided losses, admitted
  losses and blocked winners. It reports evidence coverage, resolved samples,
  changed decisions and breakdowns by trading style and pair.
- Repeated rejected-setup scans and partial-close history rows are collapsed
  before evaluation so scanner frequency and partial exits do not inflate the
  sample.
- Thesis Conviction evidence, exact style policy, candidate decision context,
  effective score and threshold are now persisted on new rejected setups.
  Existing historical rows without those fields remain visible as missing
  coverage rather than being guessed or backfilled.
- A feature remains `COLLECTING` until it has at least 30 resolved
  observations, 10 resolved decision changes and 50% evidence coverage.
  Crossing that screening threshold can only mark it as a paper candidate; it
  does not alter scoring, authorization, sizing or execution.

## Phase 8 implementation record

- Phase 8A adds a durable activation registry and evidence-certificate history.
  It separates a feature's decision authority (`shadow` → `log_only` →
  `soft_adjustment` → `hard_block`) from where it is permitted to run
  (`observation` → `paper` → `live_canary` → `live`).
- Forward transitions can advance only one axis by one step. The database
  requires minimum samples, decision changes, evidence coverage, useful rate,
  out-of-sample and walk-forward agreement before Log-only; paper-forward
  evidence before Soft adjustment; and live-canary evidence before Hard block.
- Paper, live-canary and live scopes require explicit user approval in the
  evidence certificate. Concurrent updates are protected by a revision check,
  and an emergency rollback returns directly to Shadow / Observation.
- Rejected Setups displays the registered authority, runtime scope and
  enforcement state beside each Shadow Evidence feature. Missing registry rows
  safely resolve to Shadow / Observation.
- Phase 8A deliberately leaves `runtime_enforced=false` and does not wire the
  scanner to this registry. Applying the migration and publishing the UI cannot
  change scoring, authorization, sizing, order placement, management or broker
  execution. Runtime activation will be a separate reviewed slice after the
  evidence-certificate path is verified.
- Phase 8A was production-verified on 2026-07-30 after merge `b406977`.
  Rejected Setups displayed both Gameplan Hierarchy and Thesis Conviction as
  `SHADOW · OBSERVATION · NOT ENFORCED`, with no activation rows present.
- Phase 8B introduces immutable `strategy-evidence.v1` certificates generated
  server-side from distinct rejected opportunities and completed trades. The
  engine normalizes outcomes into R, collapses repeated scans and partial
  closes, then measures expectancy, maximum drawdown, useful decision changes
  and good-trade retention.
- Each certificate uses a chronological 70/30 train/test split. Log-only
  eligibility requires the Phase 6 sample and coverage floors, positive
  out-of-sample results, consistent train/test direction, and either improved
  expectancy or materially lower drawdown without discarding too many winning
  trades.
- Certificate publication is service-role-only, immutable and owner-readable.
  It records a recommendation but never calls the activation transition RPC.
  Rejected Setups exposes a manual Certify action and clearly labels every
  result as observational.
