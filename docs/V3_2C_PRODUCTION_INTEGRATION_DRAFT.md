# V3.2c production integration — DECISION-LOCKED DRAFT (rev 3.2, 2026-10-14)

**Status: AUDIT / DESIGN ONLY. DO NOT MERGE.** No production code, no migration, no backfill, no import, no config change, no activation,
no H2, no change to Baseline A. Audited against `origin/main` @ `2db7f89e` (2026-10-10), extracted read-only. `bs` = `supabase/functions/bot-scanner/index.ts`;
`sh/` = `supabase/functions/_shared/`. Research artefacts live under `~/strategy-v2/` (outside the repo).

**Revisions.**
- **Rev 1:** audit.
- **Rev 2:** style-aware reframe.
- **Rev 3:** user decisions D1–D13, push-backs P1–P8.
- **Rev 3.2:** user approved P9–P13 as D24–D28; all push-backs closed; a second-account load note added (§2, N1).
- **Rev 3.1:**
  - user decisions D14–D23 resolve P1, P3, P5, P6, U4–U9 and U10;
  - smtOppositeVeto / ictRiskEnabled verified from Baseline A's stored config;
  - 2024/25 closure calendar derived from data;
  - new push-backs P9–P13 (§2).

---

## 1. Decision record

| # | Decision (user, 2026-10-14) | Status |
|---|---|---|
| D1 | V3.2c is the single authoritative structure engine | LOCKED |
| D2 | Scalper: 1H legs; 4H + D context; 5m tactical execution; 15m tactical / telemetry only. Day: 4H and 1H legs; D context; 15m. Swing: 4H legs; D context; 1H. Weekly = non-V3.2c telemetry. No 15m / 5m / D / W tradable legs without separate validation | LOCKED |
| D3 | No hard veto of a valid lower leg by disagreeing higher V3.2c context; alignment = telemetry; any future HTF veto needs evidence | LOCKED |
| D4 | No Baseline B execution chosen; shadow two arms; no tuning from shadow; Baseline B execution pre-registered later | LOCKED; arms defined in D14 |
| D5 | Near edge = research reference; midpoint / LTF-refined = telemetry / candidate hypotheses | LOCKED. The Route2-on-V3 arm's midpoint is that arm's own mechanics, not a change of reference (D14) |
| D6 | Context systems (DirectionVerdict, Game Plan, regime, ICT weekly/daily, FOTSI, similar) = confidence / telemetry; no reversal, hard veto or cancel until separately validated | LOCKED |
| D7 | Retire `analyzeMarketStructureCanonical` after V3.2c shadow stability; reuse its telemetry pattern | LOCKED |
| D8 | Fixed epoch, canonical append-only 1H store, never a rolling 300-bar recompute | LOCKED; epoch in D19 |
| D9 | Freeze the first observed valid closed bar; revisions → telemetry | LOCKED; "valid" per P7 |
| D10 | Never both baselines on one account; Baseline A frozen / reachable; may run as shadow / comparison | LOCKED; refined by D17 |
| D11 | Baseline B structural cancellation only via the V3.2c owning leg or canonical POI invalidation; no second direction engine; context does not cancel | LOCKED; invalidation defined in D15 |
| D12 | Style-aware Baseline B backtest on the exact shared engine / policy / detector / execution spec, mandatory before paper activation; no reimplementation | LOCKED |
| D13 | Deterministic checkpoints first; no refactor of frozen semantics unless necessary; any refactor separately versioned with exact parity | LOCKED; policy in D22 |
| **D14** | **Two execution shadow arms** (§5):<br>**(a) Research execution:** exact frozen validated near-edge execution.<br>**(b) Route2-on-V3:** Route 2 mechanics preserved exactly where possible. The Phase 1.1 POI is the zone; with no refinedEntry, Route 2's existing **midpoint fallback** is the limit. Only obsolete impulse-structure inputs are replaced by V3.2c owning-leg / POI equivalents. A near-edge-modified Route 2 arm may not be called "Route 2" | LOCKED |
| **D15** | **POI invalidation** = close beyond the POI far edge **OR** the owning V3.2c leg ends by continuation **OR** the owning leg ends by flip | LOCKED. Matches the frozen detector (`obfvg-harness/detect.ts:67-70`; invariant `touchAfterLegEnd = 0`, `run.ts:57`) ✔ |
| **D16** | **Day style 4H + 1H simultaneous setups:** shadow both independently, no ranking yet. Future execution pre-registration defaults to **first actionable setup wins the symbol slot** unless evidence supports another rule | LOCKED |
| **D17** | **Baseline A and Baseline B may execute simultaneously only on separate paper accounts** | LOCKED; feasibility P10 |
| **D18** | Route 2 hunt extraction into a pure function is approved **only after** exact decision-equivalence tests prove no behavioural change | LOCKED |
| **D19** | Proposed V3.2c production **epoch = 2025-04-16 21:00Z**, from the existing clean local 1H history of all six pairs; no API backfill; the reserved 2026-10-12 → 10-23 window is **not imported** | LOCKED; continuity caveat P11 |
| **D20** | Verify `smtOppositeVeto` and `ictRiskEnabled` from the actual Baseline A config / source before assigning their treatment | **DONE** (§6.3): both stored **false** in Baseline A; code defaults **true** (load-bearing) |
| **D21** | Add a historical FX closure calendar for 2024/25, so expected closures are not data gaps | LOCKED; data-derived calendar §8.2, with caveat P12 |
| **D22** | Initial checkpoint policy: checkpoint at each completed Daily close, persisting current D / 4H / 1H snapshots; measure before optimizing | LOCKED; snapshot cadence P13 |
| **D23** | Daily tradable-leg and 15m V3.2c validation remain future research and do not block PR0 / PR1 | LOCKED |
| **D24** (P9) | **Route2-on-V3 uses the style-specific tactical confirmation mapping** (scalper 5m, day 15m, swing 1H, = `STYLE_CONFIRMATION_TIMEFRAME`); every other parameter = frozen Baseline A Route 2 values where applicable. The arm is named **Route2-on-V3**, never "exact Route 2". The confirmation-TF behaviour is a **deliberate deviation** from Baseline A (whose config resolves 5m for every style), recorded for the execution pre-registration. For scalper the TF coincides with Baseline A (5m); the deviation bites for day and swing only | LOCKED |
| **D25** (P10) | Baseline B may use a **separate auth user / paper account**. Global env flag = V3.2c **shadow infrastructure only**; activation = per-account `structure.owner` in the **Baseline B account's** config. `structure.owner` is **never** added to Baseline A's config; Baseline A's exact `config_json` and hash `1037e617…` stay unchanged | LOCKED |
| **D26** (P11) | Preserve the V2.1.1 reserved window 2026-10-12 → 10-23. Until its OOS run is complete: no import into the V3.2c store, no V3.2c analysis, no inspection for strategy decisions. After it completes: fill those bars into the canonical store from existing `smc_scan_bars` (0 API calls). V3.2c must end with **continuous state** and may not permanently jump across the window | LOCKED |
| **D27** (P12) | Frozen aggregation semantics stay exactly unchanged. The recurring 2024/25 Sunday missing hours are an expected provider absence **for data-quality monitoring only**. No synthesized candles, no forward-fill, no change to bucket completeness, no 22/24-h Daily bucket made valid, no partial 4H bar: **if the frozen research engine skipped a D/4H bucket, production skips it too**. Holiday closures are cross-checked against an external published schedule before PR2 freezes the calendar | LOCKED |
| **D28** (P13) | **Checkpoint ≠ snapshot.** A recovery / performance checkpoint at each completed Daily close; the V3.2c snapshot is written / updated at every completed bar of its own TF (1H every 1H bar; 4H every NY-aligned 4H bar; D every NY-aligned Daily bar). Consumers read the freshest valid snapshot of their TF and never use the Daily checkpoint as live structure state | LOCKED |

## 2. Push-back

**Resolved by D14–D23:**
- **P1:** arm definitions → D14.
- **P2:** live shadow hunt → D18.
- **P3:** continuation → D15.
- **P5:** day precedence → D16.
- **P6:** Baseline A comparison → D17.
- **P7:** "valid" bar → §8.1.
- **P8:** reserved window → D19 / P11.

**Rev 3.1 push-backs P9–P13: all APPROVED → D24–D28 (rev 3.2).** Kept below for the record.

**Rev 3.2 note (not a push-back): N1 — second-account load.** A Baseline B user is scanned by the same cron invocation after Baseline A's (`bs:2219-2241`, sequential, 1.5 s per-pair throttle). The candle cache is in-memory per isolate with a 90 s intraday TTL (`sh/candleSource.ts:157`, `:164`), and day / swing need intervals scalper does not fetch. Scan time and TwelveData demand grow, on a key already budget-constrained (shared `reserve_api_credit` budget, which refuses requests and fails open: `docs/MARKET_DATA_ARCHITECTURE_AUDIT.md` §4.5). Measure in shadow before PR9; this does not affect PR0 / PR1. `structure.owner` survives storage (`bot-config/index.ts:219` validation does not strip unknown keys; the UI deep-copies and spreads, `src/components/BotConfigModal.tsx:449`, `:501`). The mapper ignores unknown keys, so the activation read must use the raw config, as `resolveSimplification(__rawConfigJson)` does (`bs:2380`).

**Rev 3.1 push-back table (resolved):**

| # | Issue | Evidence | Proposal |
|---|---|---|---|
| **P9** | **"Preserve Route 2 mechanics exactly" cannot also give D2's 15m / 1h tactical TFs** under Baseline A's config. With `styleOverridesMode "off"` and an explicit valid `confirmationTimeframe` (Baseline A stores `"5m"`), Route 2 confirms on **5m for every style**. The per-style 5m / 15m / 1h table only applies in legacy-overrides mode. | `sh/styleTimeframes.ts:76-81`; Baseline A stored config `strategy.confirmationTimeframe = "5m"`, `simplification.styleOverridesMode = "off"` (`docs/step16/step16e_config_before.json`) | In Route2-on-V3, take the confirmation TF from Route 2's **own style table** (`STYLE_CONFIRMATION_TIMEFRAME`: scalper 5m, day 15m, swing 1h), which equals D2. Every other Route 2 parameter comes from Baseline A's frozen values (TP 1.1R, floors, R:R gate 1.0, distance cap 1.5 × H1 ATR, TTL 480, Tier-1 rule). Recorded as the single deliberate deviation from "Baseline A's Route 2 config". |
| **P10** | **"Separate paper accounts" (D17) is not possible under one user today, and the env flag is global.** `paper_accounts_user_id_key UNIQUE (user_id)` allows one account per user, and `BOT_ID = "smc"` is hard-coded. The cron runs `runScanForUser` over all running accounts with one code path, so an env `STRUCTURE_OWNER` would switch every account at once. | `supabase/migrations/20260914000000_baseline_schema.sql:1582`; `bs:165`; `bs:2219-2241` | (i) Simultaneous A / B = a **second auth user** with its own paper account and `bot_configs` row. No schema change; settlement / locks are already per account.<br>(ii) Split the flag: **env `STRUCTURE_OWNER_SHADOW`** (global, shadow only, never executes) + a **per-account activation key in that account's `config_json`** (`structure.owner = "v3_2c"`; absent ⇒ legacy). The key is absent from Baseline A's config, so its hash `1037e617…` is unchanged (C7). The code default must be legacy. |
| **P11** | **Not importing the reserved window conflicts with state continuity.** V3.2c must step through every bar from the epoch to now. A store with a 2026-10-12 → 10-23 hole would make the frozen aggregation skip those buckets, and the state would jump across a two-week gap, unlike the real structure. | C4 (path dependence); frozen `timeframes.aggregate` skips incomplete buckets | Read D19 as: **we** import nothing and analyse nothing from that window **before the V2.1.1 OOS run completes (after 2026-10-23 21:00Z)**. Production's live scanner already writes those bars to `smc_scan_bars`; that is normal operation. The canonical-store fill for 2026-10-09 → go-live happens after the V2.1.1 run, from `smc_scan_bars` (0 API calls). No shadow state is computed across the window until then. |
| **P12** | **The 2024/25 data has a weekly provider gap that a calendar cannot repair.** In most DST weeks of 2024 and 2025, the provider has no bars for **Sunday 17:00–19:00 NY**, so under the frozen "complete buckets only" rule each week's **Monday Daily bucket (22/24 h) and Sunday 17:00–21:00 4H bucket are skipped** (2025 set: 33–37 Daily and 4H buckets per pair). 2026 data has no such gap. | `~/strategy-v2/v32c-integration-evidence/CLOSURES.txt`; aggregate check on the epoch dataset (EUR/USD D skipped 2025-04-21 22h, 2025-04-28 11h, …) | Calendar the hours as "provider-absent, expected" (no gap alarms, no warm-up block). **Keep the frozen aggregation unchanged:** the research used the same skips, so production replay from the 2025 epoch stays research-equivalent. Daily is context-only (D2); on tradable 4H the Sunday-evening bucket is simply absent, exactly as validated. Changing it would be a new engine version (D13). |
| **P13** | **A Daily-close checkpoint ≠ live snapshot cadence.** Tradable 1H legs need a current snapshot at every 1H close. Checkpointing only at the Daily close is fine for restart, but consumers must not read a snapshot up to 23 h old. | D22; warm-up rule `known_at` = last closed bar | Checkpoint (full state minus bars) at each completed **Daily close** per D22. Additionally write the **current snapshot row at each completed bar of its own TF** (1H / 4H / D: small rows, needed for staleness checks and the repaint audit). Restart = checkpoint + replay of ≤ 24 1H bars. Measure, then revisit. |

## 3. Production-source conflicts (rev 2; still valid)

- **C1:** structure is owned per style and per module by different engines.
- **C2:** Baseline A's strategy is the impulse leg.
- **C3:** validated execution ≠ Route 2.
- **C4:** V3.2c is path-dependent.
- **C5:** provider D/4H are UTC-aligned.
- **C6:** 300-bar depth; only `smc_scan_bars` persisted.
- **C7:** `config_version = md5(config_json)` (`20261008000000:38-43`).
- **C8:** research files need byte-identical vendoring and a pinned seed.
- **C9:** competing canonical shadow.
- **C10:** three P/D implementations.
- **C11:** the thesis direction-flip uses D/4H/1H (`sh/thesisValidator.ts:124-126`, `:337-346`).
- **C12:** four style tables.
- **C13:** the backtester is not style-aware.
- **C14:** the swing cascade is a third structure owner.

## 4. Target architecture

```
trading style ─► timeframe policy (one table, Baseline B path; legacy tables untouched for Baseline A)
canonical 1H store (first-observed valid closed bars; revisions → telemetry; 2024/25 calendar) ─► NY aggregation (frozen)
   ─► V3.2c state per (pair, D/4H/1H), epoch 2025-04-16 21:00Z, Daily-close checkpoints, per-bar snapshot rows
   ─► tradable legs per style (D2) + HTF alignment telemetry (D3)
   ─► POI layer: frozen Phase 1.1 on the leg TF; POI ends on far-edge close | leg continuation | leg flip (D15)
   ─► quality / context telemetry (impulse events, Fib, S/R, OB∩FVG, production fib fields, D6 context systems)
   ─► tactical interface (confirm / veto / wait) — telemetry-first (§6)
   ─► execution shadow arms: (a) research execution | (b) Route2-on-V3 (D14, P9)
```

- **Flags (D25):** env `STRUCTURE_OWNER_SHADOW` (global, shadow infrastructure only) + per-account `structure.owner` in the Baseline B account's `config_json` (absent ⇒ legacy; never added to Baseline A).
- **Simultaneous A / B:** only on separate accounts, i.e. separate users (D17, P10).

## 5. Execution shadow arms (D14)

| Element | (a) Research execution | (b) Route2-on-V3 |
|---|---|---|
| Zone | Phase 1.1 POI | Phase 1.1 POI |
| Limit | POI **near edge** | Route 2 rule: `refinedEntry` else **zone midpoint**. No refinedEntry exists for Phase 1.1 POIs → **midpoint** (`bs:7843-7859`) |
| Stop | far edge ∓ 1 pip | Route 2 stop chain from the limit (`sh/route2StopGeometry.ts`, `stopAnchor "limit"`): swing stop (entry-TF swings, unchanged) → per-pair floor 20/25 pips → impulse-origin override within cap. **Replaced inputs:** `impulseSL` := V3.2c owning-leg origin ∓ Route 2's buffer rule; `impulseCapPips` := `max(floor × 1.5, leg range × 1.2)` with leg range = \|origin − leg extreme at POI eligibility\| |
| Target | 1R / 2R / 3R (gross) | Route 2: limit ± stop × 1.1 (`exit.tpRRRatio 1.1`) |
| Confirmation | none | Route 2 hunt: touch → awaiting confirmation → `detectZoneConfirmation` on the **style TF (D24: 5m / 15m / 1H; a deliberate deviation from Baseline A's 5m-for-all-styles)**; Tier-1 required without a refined zone (hard-coded `bs:4265`, preserved) |
| Gates | none | R:R gate (order geometry, net of cost) ≥ 1.0; distance cap 1.5 × H1 ATR; `skipped_tp_too_small`; fill floor (as in Baseline A dry run) |
| Lifetime | until first touch (POI lifetime per D15) | TTL 480 min fixed; zone exit resets the hunt (direction-aware); **structural cancel only per D11 / D15** (replaces `CANCELLED_IMPULSE_BROKEN` `bs:4193` and thesis `direction_flip`); FOTSI / Game Plan thesis cancels → telemetry (D6) |
| Resolution | stored 5m bars (frozen resolver) | **live shadow hunt** (Route 2 confirmation is not replayable from bars: `docs/BASELINE_A_REPORT_SPEC_V1.md:70`, `docs/SMC_IMPULSE_ZONE_PRODUCTION_SPEC.md:497`), own table, never `pending_orders` (unique index `baseline_schema.sql:2149`) |
| Multi-TF (day) | both shadowed (D16) | both shadowed (D16) |
| Tuning | none | none |

## 6. Tactical layer, vetoes, disposition of live blocks

- **6.1 Architecture.** Tactical modules return `{verdict: confirm | veto | wait, reason}` with no direction field. They cannot change direction, protected swing, leg or P/D, and never cancel on structural grounds. An architecture test enforces this.
- **6.2 Initial Baseline B research / shadow stage.**
  - **Telemetry only:** all legacy context vetoes and legacy hard blocks.
  - **Enforcing:** only the logic that belongs to the execution arm being measured (arm (b)'s Route 2 confirmation, Tier-1 rule, R:R, distance cap, TTL), plus account / risk limits at activation.
  - **No legacy hard block carries over silently.** A telemetry veto becomes enforcing only through a separate pre-registered test.
- **6.3 Disposition** (A = status in Baseline A from the stored config / source).

| Live block / cancel | Where | Baseline A | Baseline B (initial) |
|---|---|---|---|
| Impulse hard gate | `bs:6762` | enforcing | removed |
| Gate 1 DirectionVerdict BLOCKED / CONFLICT | `bs:1433-1456` | enforcing | telemetry |
| Gate 1 legacy HTF fallback | `bs:1459-1470` | fallback | not used |
| Direction-engine nulls (structure-TF CHoCH against, HTF opposes) | `sh/directionEngine.ts` | enforcing | not used (LTF CHoCH = tactical telemetry) |
| Gate 3 structural conviction | `bs:1544` | off (stored false) | telemetry |
| Gate 3b reaction; score; news | STEP16 §2 | log only | telemetry |
| **Gate 9b SMT opposite veto** | `bs:1709-1716` (runs when `smtOppositeVeto !== false`) | **off: `strategy.smtOppositeVeto = false` stored; `strategy.useSMT = false`** (`step16e_config_before.json`); code default **true** (`sh/configMapper.ts:51`, `:484`; `bs:278`, `:1149`) | telemetry. **Load-bearing:** Baseline B's config must store `false` (or the code must treat it as telemetry), otherwise the default turns it on |
| **ICT risk gate** | assessment `bs:6519-6524`; hard block `bs:7310-7314` | **off: `strategy.ictRiskEnabled = false` stored**; code default **true** (`sh/configMapper.ts:322`, `:741`; `bs:368`, `:1393`) | category = **account / risk**, not context. Remains off (stored false; load-bearing). Known defect: it reads a `trade_history` table (`bs:6534`) that no migration in `supabase/migrations/` creates, so it must not be enabled without a fix |
| Gate 19 Tier-1 minimum | `bs:2045-2065` | off | telemetry |
| Gate 20 regime / falling knife | `bs:2067-2079` | regime off | telemetry |
| Game Plan gate | soft | soft | telemetry / confidence |
| ICT HTF / kill-zone / Judas / displacement-MSS gates | STEP16 §11 | off | telemetry |
| Thesis `direction_flip` | `sh/thesisValidator.ts`; `bs:3916-3935` | enforcing | removed → owning-leg flip (D11 / D15) |
| Thesis `fotsi_veto`, `gp_bias_reversal` | same | enforcing | telemetry |
| `CANCELLED_IMPULSE_BROKEN` | `bs:4193-4205` | enforcing | removed → D15 POI invalidation |
| Route 2 Tier-1 without refined zone | `bs:4265` | enforcing | arm (b) only (preserved) |
| Route 2 R:R, distance cap, TTL, tp-too-small, fill floor | STEP16 §5–§6 | enforcing | arm (b) only |
| Caps, correlation, Step 13 equity, Gate 15, Gate 14, cooldown | STEP16 §8–§9 | enforcing | account / risk at activation; recorded in shadow |

## 7. Per-style table (rev 3.1)

| Style | V3.2c context (telemetry) | V3.2c tradable legs | POI TF | Tactical TF (arm (b) confirmation, P9) | Entry TF | Non-V3.2c context | Multi-TF |
|---|---|---|---|---|---|---|---|
| Scalper | 4H, D | 1H | 1H | 5m (15m tactical / telemetry only) | 5m | Weekly | — |
| Day | D | 4H and 1H | leg TF | 15m | 15m | Weekly | both shadowed; future default "first actionable setup wins the symbol slot" (D16) |
| Swing | D | 4H | 4H | 1h | 1h | Weekly | — |

- **Expected, recorded and not tuned:** arm (b)'s 1.5 × H1-ATR distance cap will reject many swing 4H POIs; scalper frequency falls to about the 1H-leg rate.
- **Future research (D23):** Daily tradable legs and 15m V3.2c. They do not block PR0 / PR1.

## 8. Data: epoch, bar validity, closure calendar, checkpoints

**8.1 Bar validity (D9, P7).** A canonical bar is the first observation that is all of:
- clock-closed (`t + 1h ≤ observed_at`, as `sh/smcScanSnapshot.ts:113-127` already does);
- OHLC-consistent (o, c ∈ [l, h]; h ≥ l);
- on the 1H grid;
- inside FX hours (frozen `fxOpen`).

An invalid bar is MISSING: logged, and its D/4H bucket is skipped by the frozen aggregation. Revisions go to `structure_bar_revisions`. **Price grid:** the 2025 epoch data holds float32 artefacts (e.g. 0.82209003). Canonicalise by rounding to the pair's price grid (5 decimals; 3 for JPY), symmetric in sign, as H2's IMPLEMENTATION_LOG #1 did. This is recorded in the store's provenance.

**8.2 Historical FX closure calendar 2024/25 (D21), data-derived** (`CLOSURES.txt`: hours inside nominal FX hours where **all six** pairs lack a 1H bar):

| Closure | NY time | UTC | Type |
|---|---|---|---|
| Christmas 2024 | Dec 24 08:00 → Dec 25 08:00 | 2024-12-24 13:00 → 2024-12-25 13:00 | holiday (24 h) |
| New Year 2025 | Dec 31 08:00 → Jan 1 12:00 | 2024-12-31 13:00 → 2025-01-01 17:00 | holiday (28 h) |
| Christmas 2025 | Dec 24 08:00 → Dec 25 08:00 | 2025-12-24 13:00 → 2025-12-25 13:00 | holiday (24 h) |
| New Year 2026 | Dec 31 08:00 → Jan 1 08:00 | 2025-12-31 13:00 → 2026-01-01 13:00 | holiday (24 h) |
| Weekly open, DST weeks | Sunday 17:00 → 19:00 | 21:00 → 23:00 | expected provider absence, **data-quality monitoring only** (D27): affected D/4H buckets remain skipped exactly as in the frozen research engine; nothing synthesized, filled or made valid. Observed weekly 2024-04-21 → 2024-09-29 and 2025-04-06 → 2025-09-28; **not** in 2024-10 DST weeks, nor in 2026 |

- **Pair-specific missing hours** (EUR/USD 35, USD/JPY 25, CHF/JPY 21, NZD/CHF 20, NZD/CAD 18, GBP/USD 10 over 2.5 years) are **data gaps**, not closures. Example: EUR/USD 2025-04-28 10h.
- **Pre-epoch rows** (before 2025-04-16) are informational only. The calendar's operative scope is the epoch onward.
- **Confirmation needed:** this calendar is empirical (the provider's observed behaviour). It should be cross-checked against a published FX holiday schedule before being frozen in PR2.

**8.3 Epoch (D19).**
- **Epoch:** 2025-04-16 21:00Z, from the local manifested datasets `c5655420…` (2025-04-16 → 2026-04-16), `f9ac3466…` (→ 2026-09-07) and `2cc0c4b3…` (→ 2026-10-09). 0 API calls. All six pairs have no invalid OHLC in this span.
- **From 2026-10-09 to go-live:** fill from production `smc_scan_bars` after the V2.1.1 OOS run completes (D26). Until then, nothing from 2026-10-12 → 10-23 is imported, analysed or inspected, and no V3.2c state is computed across it. The final state must be continuous.
- **Overlap 2026-09-25 → 10-09:** parity check, local vs `smc_scan_bars`, in PR2.
- **Not used:** the EUR/USD 2024 defect window, which lies before the epoch.

**8.4 Checkpoints and snapshots (D22, P13).**
- **Checkpoint** (recovery / performance only) at each completed Daily close (17:00 NY): state minus bars, last bar time, engine hash, state hash, plus the D/4H/1H snapshots at that instant.
- **Snapshots** (live structure state, D28): 1H at every completed 1H bar; 4H at every completed NY-aligned 4H bar; D at every completed NY-aligned Daily bar.
- **Consumers** read the freshest valid snapshot of their TF (`known_at` = last closed bar, else no trade) and never read a checkpoint as live state.
- **Restart:** load bars from the epoch + checkpoint + replay ≤ 24 1H bars.
- **Periodic verification:** full replay == checkpoint chain.
- **Measure** CPU and storage before any optimisation (D13).

## 9. Flags, parity, performance

- **Flags:** as P10. **Parity:** byte-identical vendoring + hash tests + pinned seed; one shared implementation for live / shadow / backtest / research (D12).
- **Performance** (frozen engine, 1 year, EUR/USD): full replay D 2 ms, 4H 5 ms, 1H 55 ms per pair; incremental negligible; no new TwelveData calls.

## 10. Rollout gates

| PR | Content | Production effect | Gate to next |
|---|---|---|---|
| **PR0** | docs (§11) | none | user approves rev 3.1 + P9–P13 |
| **PR1** | vendored V3.2c, unused (§11) | none | parity / causality / mirror / DST / isolation green; `deno check` clean |
| PR1b | vendored Phase 1.1 (byte-identical) + parity, unused | none | parity green |
| PR2 | canonical 1H store + closure calendar (holidays cross-checked against an external published schedule) + validity / rounding canonicalisation + import tool (local datasets from the epoch) + writer from the scanner's existing 1H fetch; migration applied by hand **before** merge; **reserved window not imported until the V2.1.1 OOS run completes; then filled from `smc_scan_bars`** (D26) | additive writes | overlap parity vs `phase3`; ≥ 1 week of clean bars; calendar frozen; continuity through the reserved window after the OOS run |
| PR3 | V3.2c shadow runner (separate function / cron on 1H close); snapshots per bar of each TF; checkpoints at Daily close (D28); runs only on continuous state (D26) | none for the scanner | replay == checkpoint == live for 2 weeks; no repaint; aggregation parity incl. the 2025 Sunday-gap skips (D27) |
| PR4 | timeframe policy + per-style comparison + §6.3 telemetry + read-only dashboard; env `STRUCTURE_OWNER_SHADOW` | telemetry | comparisons reviewed |
| PR5 | arm (a) shadow (stored 5m bars) | telemetry | arm (a) report; no tuning |
| PR6 | Route 2 hunt extracted into a pure function: **exact decision-equivalence tests first (D18)**, then the arm (b) live shadow hunt with its own table | telemetry; Baseline A byte-identical | equivalence proven; arm (b) report; no tuning |
| PR7 | style-aware Baseline B backtest on shared code (D12) | none | backtest == shadow on overlap |
| PR8 | Baseline B execution pre-registration (arm choice; D16 default precedence; D15 cancellation) | none | hashed |
| PR9 | Baseline B paper activation on a **separate auth user / paper account** (D17, D25), or with Baseline A off; `structure.owner` in the Baseline B account only; new config version; new `primary_engine` value (migration); N1 load measured | new strategy (paper) | forward sample |
| PR10 | retire `analyzeMarketStructureCanonical` (D7); deprecate legacy owners; delete only after Baseline A retirement | none | sign-off |

**Rollback:** env shadow off; per-account `structure.owner` removed (or that account's exact prior config restored); `entries_locked` is the hard stop; never destructive.

## 11. PR0 / PR1 scope (unchanged except docs)

**PR0 (docs only, fresh branch from `origin/main`, repo-local git identity):**
- `docs/V3_2C_PRODUCTION_INTEGRATION_DRAFT.md` (rev 3.1);
- `docs/V3_2C_DECISION_RECORD_V1.md` (D1–D28, approver, date; includes the D24 execution deviation for the pre-registration);
- `docs/V3_2C_HISTORY_AUDIT_V1.md` (history, closure calendar, epoch, script hashes).

No code, tests, config or data.

**PR1 (unused code):**
- `_shared/structure/v32c/engine.ts` + `timeframes.ts` (byte-identical to frozen; engine `66957645…`; frozen MANIFEST `dd0bd1ae…`);
- `MANIFEST.txt`;
- `config.ts` (frozen CONFIG factory);
- tests: hashes; seed-dependency golden for `detectSwingPoints(·, 5, 0.4)`; research-parity digests on small fixtures; prefix causality; mirror; DST (2025-03-09, 2025-11-02); Daily 17:00 / 4H keys; isolation / deep-freeze; no production import of the module;
- `deno check`.

## 12. Still unresolved (none block PR0 / PR1)

- **Warm-up gap rule N** and the checkpoint-verification interval: set in PR3 after measurement.
- **External holiday-schedule cross-check:** a PR2 gate (D27).
- **N1 second-account load / credit demand:** measure before PR9.
- **Schedule dependency:** PR2's reserved-window fill and PR3's continuous shadow state wait for the V2.1.1 OOS run (after 2026-10-23 21:00Z).

## 13. Conclusion

**DO NOT MERGE YET** (documentation of a locked design).
- **Locked:** D1–D28. No push-back is open.
- **Ready to begin:** PR0 (docs) and PR1 (vendored engine, unused).
- **Not started:** nothing has been executed, imported, backfilled or inspected from the reserved window.
