# IPO Multi-Strategy Integration Design System

**Repository:** aganatsu/connect-assist  
**Branch:** feature/ipo-live-integration  
**Status:** DESIGN / ENGINEERING AUDIT REQUIRED  
**Version:** 1.0

> This is an architecture contract, not permission to refactor production. Audit every referenced table, function, scheduler, broker path, UI surface, and assumption before implementation. Report mismatches before changing code.

## 1. Goal

Evolve connect-assist from a single-strategy bot into a multi-strategy platform that can run **SMC** and **IPO C-E-T** side by side.

The user should experience one platform: auth, broker connections, market data, charts, journal, scheduler, risk/prop-firm controls, strategy control and account reporting.

The code must keep strategy semantics and strategy-owned state isolated.

Long-term strategy lifecycle:

```
OFF -> OBSERVATION -> PAPER -> LIVE_CANARY -> LIVE
```

Only OBSERVATION and PAPER may be enabled initially. LIVE paths must be architecturally supported but hard-disabled until separately approved.

## 2. Non-negotiable invariants

### 2.1 SMC no-regression

Adding IPO must not silently change current SMC:
- scan behavior
- scoring/confluence
- position sizing
- SL/TP management
- paper behavior
- live execution
- bot_configs semantics
- broker reconciliation
- scheduled tasks
- BotView detail behavior

Any shared-code change requires SMC regression proof.

### 2.2 Explicit strategy ownership

Every setup, position, order, scan event, trade, rejection and runtime state must have a non-null strategy owner.

Canonical IDs:
```
smc
ipo_cet
```

No strategy may adopt records because strategy_id/bot_id is missing.

### 2.3 Signal and execution are separate

A valid setup remains valid even when account safety blocks execution.

Example:
```
IPO SIGNAL: VALID
EXECUTION: BLOCKED
REASON: CORRELATED_EXPOSURE
```

Correlation, FTMO, kill switch, broker health or execution mode must not erase the strategy decision.

### 2.4 Locked IPO semantics

Engineering work must not mutate the locked IPO rules:
- causal IPO lifecycle
- FVG admission required
- E2 IPO-candle midpoint geometry
- S2 close invalidation
- 2R target
- first-touch sequencing
- one trade per instrument at a time
- current validated volatility behavior
- validated instrument/timeframe configs

Fib/H1/H5 and future research remain research-only unless a new strategy version is separately validated.

### 2.5 Same engine across modes

Observation, paper, live-canary and live consume the same strategy decision output. Differences belong to execution/fills/broker/account safety, not signal generation.

### 2.6 Broker-agnostic strategy

IPO never calls MetaAPI/OANDA directly. It emits a normalized trade intent. The execution router chooses observation, paper, live-canary or live and then the broker adapter.

### 2.7 Closed-bar causality

IPO decisions use only information available at the relevant closed bar. The corrected causal replay remains the reference oracle until the incremental engine proves equivalence.

### 2.8 Auditability

Every major decision should retain:
```
strategy_id
strategy_version
instrument
timeframe
decision_time
candidate/setup_id
signal_status
execution_status
reason_codes
source_bar_time
runtime_state_version
risk_decision_id
execution_intent_id
broker_order_id (when live)
```

## 3. Target architecture

```
                           CONNECT-ASSIST
                                |
      +-------------------------+-------------------------+
      |                         |                         |
  Market/Data             Strategy Control          Account Safety
      |                         |                         |
      |                 +-------+-------+                 |
      +--------------> SMC             IPO <--------------+
                        |               |
                    Trade Intent    Trade Intent
                         \             /
                          +-----------+
                               |
                    Portfolio/Risk Governor
                               |
                       Execution Router
                   +-----------+-----------+
                   |           |           |
               OBSERVE       PAPER      LIVE/CANARY
                                           |
                                     Broker Adapters
                                  +--------+--------+
                                  |                 |
                               MetaAPI            OANDA
```

The platform is shared. Strategy brains, strategy state and strategy management are not.

## 4. Current state to protect and audit

The agent must confirm the exact current implementation, including:

- bot-scanner call graph
- current paper-trading path
- paper_positions readers/writers
- pending_orders readers/writers
- paper_trade_history readers/writers
- bot_configs consumers
- zone-confirmation-scanner
- existing position management
- broker-execute call sites
- prop-firm gate
- strategy_activation_registry/events
- scheduled tasks
- BotView master/detail
- Journal
- Chart
- Backtest
- RejectedSetups
- Brokers
- Dashboard

Initial rule: IPO must not write to SMC trading-state tables such as paper_positions, pending_orders or paper_trade_history because those rows can become enrolled in existing SMC management.

## 5. Strategy versioning and drift control

Canonical IPO identity:
```
strategy_id = "ipo_cet"
strategy_version = "ipo-cet-v1"
```

Create a machine-readable rules manifest, conceptually:

```json
{
  "strategy_id": "ipo_cet",
  "strategy_version": "ipo-cet-v1",
  "entry_model": "IPO_CANDLE_MIDPOINT",
  "target_model": "FIXED_2R",
  "invalidation_model": "S2_CLOSE_BEYOND_FAR_EXTREME",
  "fvg_required": true,
  "sequencing": "FIRST_TOUCH",
  "one_trade_per_instrument": true
}
```

Fingerprint/hash the manifest in CI. If an engineering PR changes strategy semantics, it must explicitly create/approve a new strategy version rather than silently drifting v1.

## 6. Strategy modes / control plane

Preferred control source: audit and reuse:
- strategy_activation_registry
- strategy_activation_events

Recommended naming convention:
```
feature_key = "strategy.ipo_cet"
variant_key = "validated_v1"
```

Modes:
```
OFF
OBSERVATION
PAPER
LIVE_CANARY
LIVE
```

Must support:
```
SMC = LIVE
IPO = PAPER
```

IPO must not inherit paper_accounts.execution_mode or another SMC/account-global mode.

High-risk transitions such as PAPER -> LIVE_CANARY and LIVE_CANARY -> LIVE require server-side permission, reason/audit event, revision check, broker/risk preflight and explicit approval.

## 7. IPO engine

### 7.1 Reference oracle

Keep corrected causal replay as a slow source of truth for validation, rebuilds and regression.

### 7.2 Incremental production engine

After bootstrap, process one newly CLOSED candle at a time.

Conceptual contract:

```ts
processClosedBar({
  strategyId,
  strategyVersion,
  instrument,
  timeframe,
  bar,
  previousState
}) => {
  nextState,
  emittedEvents,
  tradeIntents
}
```

Persist enough state to reproduce the oracle:
- last processed closed bar
- active IPOs
- pending candidates
- lifecycle state
- contraction/expansion/trend state
- FVG qualification
- volatility state/warmup
- current open IPO trade state
- previous exit time/index
- sequencing state
- strategy version
- state schema version

### 7.3 Bootstrap

```
no state
 -> load historical closed bars
 -> causal rebuild
 -> materialize current incremental state
 -> write checkpoint
 -> process only new bars
```

### 7.4 Idempotency

The same closed bar processed twice must not duplicate candidates, events, positions, intents or broker orders.

Use a deterministic processing key based on strategy/version/instrument/timeframe/bar time.

### 7.5 Gap recovery

If expected bars are missing, fetch/process them chronologically before continuing. Never jump state across missing bars.

### 7.6 Rebuild

State health should distinguish:
```
HEALTHY
STALE
GAP
VERSION_MISMATCH
CORRUPT
REBUILD_REQUIRED
```

Rebuild from the causal oracle, not an ad-hoc patch.

## 8. Instrument eligibility

Engine support and trading approval are separate.

Current validated reference configurations:
```
EUR/USD  1H
USD/JPY  30M
BTC/USD  1H HIGH_VOL
```

Recommended eligibility:
```
UNVALIDATED
RESEARCH
OBSERVATION_APPROVED
PAPER_APPROVED
LIVE_CANARY_APPROVED
LIVE_APPROVED
```

A new symbol defaults to UNVALIDATED. It may be observable/researchable without inheriting EUR/USD approval.

## 9. Data ownership

Shared platform concepts:
- auth/users
- broker connections
- market-data provider config
- symbol specs
- notifications
- account/prop-firm config
- strategy activation
- shared audit/telemetry

Treat current SMC state as SMC-owned during initial IPO integration.

Recommended IPO logical entities:
```
ipo_runtime_state
ipo_scan_events
ipo_setups
ipo_execution_intents
ipo_positions
ipo_trade_history
ipo_strategy_instruments
ipo_reconciliation_events
```

Exact tables should follow engine requirements, not precede them.

If shared tables are introduced later, strategy ownership must be NOT NULL.

## 10. Normalized strategy trade intent

Conceptual contract:

```ts
type StrategyTradeIntent = {
  intentId: string;
  strategyId: "ipo_cet";
  strategyVersion: string;
  instrument: string;
  timeframe: string;
  direction: "long" | "short";
  setupId: string;
  sourceBarTime: string;
  decisionTime: string;
  intendedEntry: number;
  targetModel: "FIXED_2R";
  intendedTarget: number;
  invalidationModel: "S2_CLOSE";
  strategyInvalidationLevel: number;
  nominalRiskDistance: number;
  metadata: Record<string, unknown>;
}
```

The strategy does not place orders or decide paper/live.

## 11. Execution decision

The shared safety layer consumes the intent and returns:

```ts
type ExecutionDecision = {
  intentId: string;
  strategyId: string;
  mode: "observation" | "paper" | "live_canary" | "live";
  signalValid: boolean;
  executionAllowed: boolean;
  blockReasons: string[];
  requestedRiskUsd: number | null;
  approvedRiskUsd: number | null;
  correlationDecisionId?: string;
  propFirmDecisionId?: string;
  portfolioDecisionId?: string;
}
```

This preserves VALID SIGNAL + BLOCKED EXECUTION.

## 12. Correlation / portfolio exposure

Correlation belongs after signal generation and before execution.

Audit the current repo to determine exactly which of these are enforced vs informational:
- correlationFilterEnabled
- maxCorrelatedPositions
- static correlation groups
- dynamic Pearson correlation
- directional correlation
- currency exposure
- position-size correlation adjustment
- concentration scoring

Cross-strategy account safety should eventually see both SMC and IPO positions.

If correlation blocks:
```
setup_status = VALID
execution_status = BLOCKED
execution_reason = CORRELATION
```

Do not mark the IPO invalid.

Questions such as same-symbol conflicts, total account heat, same-currency exposure and cross-strategy hedging belong to the future portfolio governor, not IPO rules.

## 13. Prop-firm / FTMO layer

FTMO/account rules sit after strategy validity.

Required account view:
- balance
- equity
- floating P/L
- daily closed P/L
- commissions
- swaps when available
- open positions across strategies
- pending intents
- daily reset time
- prop-firm thresholds

Example:
```
SIGNAL: VALID
CORRELATION: PASS
PROP_FIRM: BLOCK
REASON: DAILY_LOSS_RESERVE
```

IPO's S2 close invalidation can tolerate large intrabar adverse excursion. In future live mode, account emergency exits must be logged separately as ACCOUNT_SAFETY_OVERRIDE rather than pretending they were normal S2 exits.

## 14. Paper execution

IPO paper positions stay outside SMC position-management tables/loops.

Paper state should retain:
- strategy/version
- setup/intent
- instrument/direction
- entry time/price
- nominal risk distance
- target
- strategy invalidation
- status
- realized R
- exit reason
- execution mode

IPO paper management uses IPO rules only:
- fixed 2R
- S2 close invalidation
- no SMC break-even
- no SMC trailing
- no SMC partial TP
- no SMC wick-stop substitution

unless a later strategy version explicitly adopts them.

## 15. Long-term live execution

Flow:
```
IPO Engine
 -> Trade Intent
 -> Portfolio/Risk Governor
 -> Execution Decision
 -> Execution Router
 -> Broker Adapter
 -> Broker
```

Router behavior:
```
OBSERVATION -> audit only
PAPER       -> IPO paper executor
LIVE_CANARY -> real broker with canary caps
LIVE        -> real broker
```

Broker adapters:
```
MetaApiBrokerAdapter
OandaBrokerAdapter
FutureBrokerAdapter
```

Conceptual interface:
```ts
interface BrokerAdapter {
  getAccountSnapshot(): Promise<AccountSnapshot>;
  placeOrder(req: NormalizedOrderRequest): Promise<BrokerOrderAck>;
  cancelOrder(orderId: string): Promise<void>;
  closePosition(req: ClosePositionRequest): Promise<BrokerOrderAck>;
  getOpenOrders(): Promise<BrokerOrder[]>;
  getOpenPositions(): Promise<BrokerPosition[]>;
  getOrder(orderId: string): Promise<BrokerOrder | null>;
}
```

### Live idempotency / reconciliation

A network retry must not create a duplicate order.

State model should support:
```
INTENT_CREATED
RISK_APPROVED
SUBMITTING
BROKER_ACKNOWLEDGED
PARTIALLY_FILLED
FILLED
OPEN
CLOSING
CLOSED
REJECTED
RECONCILIATION_REQUIRED
```

On restart/disconnect compare local expected state with broker actual state and classify:
```
MATCHED
MISSING_LOCAL
MISSING_BROKER
DUPLICATE
UNKNOWN_BROKER_POSITION
```

Block new IPO live execution on unresolved high-severity reconciliation errors.

## 16. LIVE_CANARY

LIVE_CANARY must be real risk containment, not only a label.

Architecture must support:
- instrument allowlist
- lower risk cap
- max live IPO positions
- max IPO live trades/day
- canary daily-loss cap
- broker-health requirement
- clean reconciliation requirement
- IPO-specific kill switch
- no automatic promotion to LIVE

Exact values require later approval.

## 17. Strategy invalidation vs catastrophe stop

Before real live execution, explicitly decide the relationship between:
- S2 strategy invalidation
- optional broker catastrophe/account-protection stop

They are not the same.

If an emergency stop triggers before S2, log it as an account safety override. Do not silently redefine IPO results.

## 18. UI / product integration

### Strategy center

Recommended route:
```
/strategies
```

Show independent cards for SMC and IPO with mode, health, version, open positions and last processing time.

### Bot page

Keep the current shell and add:
```
[ SMC ] [ IPO ]
```

SMC tab renders the current experience unchanged.

IPO tab gets dedicated IPO scanner/detail components.

Prefer:
```
<SmcScanner />
<IpoScanner />
<SmcScanDetail />
<IpoScanDetail />
```

Do not convert legacy SMC components into huge strategy conditionals.

### IPO scanner

Rows should distinguish:
- pair
- timeframe
- direction
- lifecycle state
- signal validity
- validation approval
- execution eligibility
- execution mode

### IPO detail

Show:
- candidate/setup identity
- IPO candle and geometry
- zone high/low/midpoint
- direction
- FVG
- move-away
- contraction
- expansion
- touch
- trend
- opposite-side clearance
- volatility state
- intended entry
- 2R target
- S2 invalidation
- correlation result
- portfolio/prop-firm result
- execution status
- outcome / realized R

## 19. Settings

Keep global settings separate from strategy settings.

SMC continues using existing SMC config semantics.

IPO initially exposes operational controls only:
- mode
- instrument enablement
- observation/paper approval
- notifications
- chart display
- approved paper risk controls

Display locked strategy rules read-only:
```
FVG required                LOCKED
Entry: IPO candle midpoint  LOCKED
Target: 2R                  LOCKED
Invalidation: S2 close      LOCKED
Sequencing: first-touch     LOCKED
```

## 20. Journal / Chart / Dashboard / Backtest / Brokers

### Journal
Add strategy/mode labels and filters:
```
[ ALL ] [ SMC ] [ IPO ]
```
Never mix IPO PAPER P/L into real LIVE P/L without explicit labels.

### Chart
Add independent overlay toggles for SMC and IPO. IPO zones must be visually distinguishable from SMC order blocks.

### Dashboard
Metrics must be scoped. Do not show one ambiguous win rate/P&L that silently combines paper and live.

### Backtest
Select strategy and invoke the appropriate engine. Common reporting UI may be shared; strategy engines remain distinct.

### Brokers
Connections are platform-level; execution permission is strategy-level:
```
MetaAPI connected
SMC: LIVE
IPO: PAPER / LIVE LOCKED
```

## 21. Scheduled tasks

Preserve current SMC tasks.

IPO conceptual tasks:
- closed-bar processor
- IPO paper/live manager
- reconciliation
- outcome/audit

IPO runs when relevant bars close, not arbitrary frequent polling. Use last-processed-bar idempotency to tolerate delayed data/scheduler retries.

## 22. Market data

Reuse existing candle/data infrastructure and symbol specs where safe.

Do not refactor the working SMC data supply merely to save a few IPO API calls.

Define a canonical closed candle and reject non-closed bars.

## 23. Observability

Recommended events:
```
IPO_BAR_PROCESSED
IPO_CANDIDATE_CREATED
IPO_LIFECYCLE_CHANGED
IPO_VALIDATED
IPO_INVALIDATED
IPO_TOUCHED
IPO_TRADE_INTENT_CREATED
IPO_EXECUTION_BLOCKED
IPO_PAPER_OPENED
IPO_PAPER_CLOSED
IPO_LIVE_SUBMITTED
IPO_LIVE_ACKNOWLEDGED
IPO_RECONCILIATION_WARNING
IPO_SAFETY_OVERRIDE
```

Metrics:
- processing latency
- bars behind
- rebuild count
- active/valid IPO count
- blocked executions by reason
- correlation blocks
- prop-firm blocks
- broker rejection rate
- reconciliation mismatches

## 24. Security / RLS

All new IPO tables require explicit RLS/privilege review.

Requirements:
- RLS enabled
- ownership policy documented
- execution state not directly client-writable
- service-role-only tables explicitly protected
- browser never receives service-role secrets
- broker secrets never stored in IPO strategy tables
- immutable audit rows where practical

Re-audit the currently proposed IPO ledger security before deployment.

## 25. Failure handling

- Market data unavailable: do not fabricate bars.
- Strategy processing failure: do not advance last processed bar.
- Persistence failure: do not execute real order.
- Broker timeout: reconcile before retrying.
- Risk-service failure: fail closed for live.
- Reconciliation failure: block new IPO live orders.

Critical processing should be atomic where possible:
```
load state
process closed bar
write next state/events/intents
commit
```

A real order must not be submitted before durable local intent + risk approval exist.

## 26. Feature drift controls

1. Strategy-rule changes are separate PRs from engineering/infrastructure PRs.
2. Keep frozen golden fixtures: closed bars -> exact IPO events/intents.
3. Require causal replay == incremental output.
4. CI watches the rules manifest.
5. No hidden behavior-changing defaults.
6. A strategy semantic change requires versioning + validation.

Oracle equivalence compares:
- candidate identity/time
- direction
- lifecycle transitions
- FVG
- volatility
- touch/fill
- target
- invalidation
- exit
- realized R
- sequencing

## 27. SMC regression protection

Before each integration phase verify:
- SMC fixture outputs unchanged
- bot config mapping unchanged
- SMC paper manager unchanged
- SMC broker route unchanged
- SMC correlation/prop-firm behavior unchanged
- SMC BotView unchanged
- scheduled tasks unchanged
- no SMC manager reads IPO position tables
- no IPO manager reads SMC position tables

## 28. Research boundary

Keep explicit layers:
```
Research/batch
Causal reference replay
Incremental production engine
Paper-forward runtime
Live execution
```

Research features can propose a future version but cannot silently mutate ipo-cet-v1.

Current design implications:
- Fib remains informational/research, not a v1 ranking/filter.
- H1/H5 remain outside locked v1.
- portfolio correlation must be shared account safety.
- pair expansion requires pair-level and account-level validation.

## 29. Multi-strategy conflicts that must remain explicit decisions

Do not guess:
- Can SMC and IPO hold opposite positions on the same symbol?
- Can they hold same-direction positions on the same symbol?
- Is max open positions global, per strategy, or both?
- Is account heat global, per strategy, or both?
- Does IPO paper simulate current live-SMC portfolio blocks or run an independent paper portfolio?
- What is the future IPO nominal-risk policy?
- What catastrophe-stop policy is acceptable with S2?
- Which additional pairs/timeframes become paper/live approved?

## 30. Deployment phases / hard stops

### Phase A - engineering audit only
Deliver:
- actual current architecture map
- data ownership/read-write matrix
- broker call graph
- correlation enforcement map
- prop-firm map
- scheduler map
- UI impact map
- differences from this design
- lowest-risk implementation proposal

STOP.

### Phase B - incremental engine
Build incremental engine, state, rebuild/gap/idempotency and oracle equivalence.

STOP.

### Phase C - observation
Build observation backend + IPO scanner/detail UI. No paper/live orders.

STOP.

### Phase D - isolated IPO paper
Build IPO paper positions/manager/history and strategy controls. No broker path.

STOP.

### Phase E - shared safety/UI integration
Correlation/prop-firm visibility, Journal/Chart/Dashboard strategy awareness.

STOP.

### Phase F - live infrastructure, disabled
Build execution router, broker adapter boundary, live persistence, reconciliation, idempotency, emergency controls. Keep IPO live disabled.

STOP.

### Phase G - demo/sandbox
Verify broker submission, duplicate prevention, rejection, reconnect and reconciliation.

STOP.

### Phase H - LIVE_CANARY
Explicit approval required.

### Phase I - LIVE
Separate explicit approval required.

## 31. Rollback

Observation/paper rollback:
```
IPO mode OFF
disable IPO scheduled tasks
leave SMC untouched
```

Live rollback:
- stop new IPO execution
- keep reconciliation/management alive
- resolve existing broker positions
- then disable runtime

Never delete local live state while broker positions remain unresolved.

## 32. Release gates

Before any deployment:
- SMC regression green
- IPO tests green
- oracle equivalence green
- manifest unchanged or explicitly versioned
- migrations reviewed
- RLS reviewed
- modes/permissions reviewed
- no IPO broker path while live locked
- scheduler reviewed
- correlation/prop-firm reviewed
- paper/live labels clear
- rollback documented

Before LIVE_CANARY:
- paper-forward evidence accepted
- broker sandbox accepted
- reconciliation tested
- kill switch tested
- duplicate-submission test passed
- disconnect/reconnect test passed
- risk caps approved
- eligible instruments approved
- S2/protective-stop live policy decided

## 33. Phase-A engineering audit checklist

Return a matrix with:
```
Design Area | Actual Implementation | Match? | Risk | Required Change
```

Explicitly report:
1. anything in this document that is wrong about the repo
2. hidden shared tables that can cause cross-strategy mutation
3. any path that could accidentally send IPO to broker-execute
4. account-global modes that block SMC LIVE + IPO PAPER
5. correlation utilities that are informational rather than enforced
6. RLS/security weaknesses
7. scheduler paths that may double-process bars
8. UI assumptions that only SMC exists
9. metrics that would mix paper/live P&L
10. abstractions requiring risky SMC refactoring

## 34. Definition of seamless

For the user:
- one application
- one authentication
- one broker area
- one account
- one chart system
- one journal shell
- one strategy center
- one portfolio-risk view

For engineering:
- separate strategy engines
- separate strategy-owned trading state
- explicit ownership
- independent modes
- shared safety after signal generation
- broker-agnostic strategy intents
- independently disableable IPO runtime
- no SMC regression
- complete audit trail

**Target:** one platform, multiple strategies, shared infrastructure where safe, isolated strategy semantics where necessary.

## 35. Engineering-agent instruction

Use this document as an architecture proposal, not assumed truth.

First action: **audit the repository against it.**

Do not implement Phase B until the audit has been reviewed.

When current code contradicts the design:
1. document the contradiction
2. explain operational risk
3. propose the lowest-risk adjustment
4. do not silently fix legacy behavior
5. preserve SMC production behavior unless separately approved

Success is not "IPO code exists."

Success is:

> IPO can eventually progress from observation to paper to live through MetaAPI/OANDA without changing strategy semantics, without being accidentally managed by SMC, without bypassing correlation/prop-firm/account safety, and without breaking the existing bot.
