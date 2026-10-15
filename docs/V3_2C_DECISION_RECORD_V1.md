# V3.2c integration — decision record V1 (2026-10-14)

**Approver:** repository owner (user), in session, 2026-10-14. **Status:** design decisions only; nothing here is implemented.
**Companion documents:** `docs/V3_2C_PRODUCTION_INTEGRATION_DRAFT.md` (rev 3.2) and `docs/V3_2C_HISTORY_AUDIT_V1.md`.
**Evidence basis** (outside the repo, `~/strategy-v2/`):
- Test A (unseen 2024-04-16 → 2025-04-16 leg-ownership test): pre-registration `PREREG_UNSEEN_2024.md` (sha256 `da4ee0be8612da88…`), hashes `PREREG_HASHES.txt` (`a6badc19581cb098…`), results `RESULTS_UNSEEN.md` (`ddd9956ef2ae4564…`). Result: Δ 2R = +0.266R, 95% CI [+0.054, +0.477], **PASS**.
- H2 v1.0 (`SPEC_H2_v1.0.md`, `10c100947f121ac9…`) **FAILED** and is not integrated.

## Decisions D1–D28

| # | Decision |
|---|---|
| D1 | V3.2c is the single authoritative market-structure engine. |
| D2 | **Style mapping.**<br>• Scalper: V3.2c 1H tradable legs; 4H + Daily context; 5m tactical execution; 15m tactical / telemetry only.<br>• Day: 4H and 1H tradable legs; Daily context; 15m tactical execution.<br>• Swing: 4H tradable legs; Daily context; 1H tactical execution.<br>• Weekly = non-V3.2c context telemetry.<br>• No 15m, 5m, Daily or Weekly tradable legs without separate validation. |
| D3 | No hard veto of a valid lower V3.2c leg because higher V3.2c context disagrees. Alignment is recorded as telemetry; any future higher-TF veto needs separate evidence. |
| D4 | No Baseline B execution rule is selected. Shadow two arms (D14); do not tune either from shadow outcomes; Baseline B execution is pre-registered separately later. |
| D5 | Near-edge entry is the research reference (the validated rule). Midpoint and LTF-refined entry are telemetry / candidate hypotheses only. |
| D6 | DirectionVerdict, Game Plan, regime, ICT weekly/daily, FOTSI and similar context layers are confidence / telemetry only in Baseline B. They may not reverse V3.2c, hard-veto or cancel until separately validated. |
| D7 | Retire `analyzeMarketStructureCanonical` as a competing structure implementation after the V3.2c shadow reaches stability; reuse its telemetry pattern. |
| D8 | V3.2c uses a fixed epoch and a canonical append-only 1H store. Never recompute it from a rolling 300-bar window. |
| D9 | The first observed valid closed bar is canonical. Later provider changes go to revision telemetry and never rewrite canonical history. Valid = clock-closed, OHLC-consistent, on the 1H grid, inside FX hours. |
| D10 | Never execute Baseline A and Baseline B on the same account simultaneously. Baseline A stays frozen and reachable and may run as shadow / comparison. |
| D11 | Baseline B pending-order structural cancellation comes only from the V3.2c owning leg or canonical POI invalidation (D15). No second direction engine may cancel; context systems do not cancel initially. |
| D12 | A style-aware Baseline B backtest path using the exact shared V3.2c engine, timeframe policy, POI detector and eventual execution spec is mandatory before Baseline B paper activation. No separate reimplementation. |
| D13 | Prefer deterministic checkpoints for long-run replay. No refactor of frozen V3.2c semantics unless necessary; any performance refactor is separately versioned and proves exact parity first. |
| D14 | **Two execution shadow arms:**<br>• **(a) Research execution:** exact frozen validated near-edge execution.<br>• **(b) Route2-on-V3:** Route 2 mechanics preserved wherever possible. The Phase 1.1 POI is the zone; with no `refinedEntry`, Route 2's existing **midpoint fallback** is the limit. Only obsolete impulse-structure inputs are replaced by V3.2c owning-leg / POI equivalents.<br>A near-edge-modified Route 2 arm may not be called "Route 2". |
| D15 | **POI invalidation** = close beyond the POI far edge, OR the owning V3.2c leg ends by continuation, OR the owning leg ends by flip. |
| D16 | **Day style:** 4H and 1H simultaneous setups are shadowed independently and not ranked. The future execution pre-registration defaults to *first actionable setup wins the symbol slot*, unless evidence supports another rule. |
| D17 | Baseline A and Baseline B may execute simultaneously only on separate paper accounts. |
| D18 | Extraction of the Route 2 hunt into a pure function is approved only after exact decision-equivalence tests prove no behavioural change. |
| D19 | Proposed V3.2c production epoch = **2025-04-16 21:00Z**, from the existing clean local 1H history of all six pairs. No API backfill. The reserved 2026-10-12 → 10-23 window is not imported (D26). |
| D20 | `smtOppositeVeto` and `ictRiskEnabled` were verified from Baseline A's stored config: both **false** (also `useSMT` false). Their code defaults are **true**, so the stored false is load-bearing. Baseline B: the SMT veto becomes telemetry; ICT risk is a risk gate and stays off (it also reads a missing table). |
| D21 | A historical FX closure calendar for 2024/25 is added, so expected closures are not treated as data gaps. It is a monitoring classification (D27). |
| D22 | Recovery / performance checkpoint at each completed Daily close; measure before optimizing (refined by D28). |
| D23 | Daily tradable-leg and 15m V3.2c validation remain future research and do not block PR0 / PR1. |
| D24 | **Route2-on-V3 confirmation timeframe** = the style mapping (scalper 5m, day 15m, swing 1H; `STYLE_CONFIRMATION_TIMEFRAME`). Everything else = frozen Baseline A Route 2 values where applicable. |
| D25 | **Baseline B uses a separate auth user / paper account.** Global env flag = V3.2c shadow infrastructure only. Activation = per-account `structure.owner` in the Baseline B account's config. |
| D26 | **The reserved 2026-10-12 → 10-23 V2.1.1 OOS window is preserved.** After the OOS run completes, those bars are filled from `smc_scan_bars` (0 API calls). V3.2c must ultimately have continuous state. |
| D27 | **Frozen aggregation semantics are unchanged.** If the frozen research engine skipped a D/4H bucket, production skips it too. Holiday closures are cross-checked against an external published schedule before PR2 freezes the calendar. |
| D28 | **Checkpoints and live snapshots are separate concepts** (see below). |

## Explicit notes required by the approver

- **D24, the Route2-on-V3 confirmation-timeframe deviation.**
  - Baseline A stores `simplification.styleOverridesMode = "off"` and `strategy.confirmationTimeframe = "5m"`. Under `resolveConfirmationTimeframe` (`supabase/functions/_shared/styleTimeframes.ts:76-81`), that resolves **5m for every style**.
  - Route2-on-V3 deliberately uses the style table instead: 5m / 15m / 1H.
  - For scalper this coincides with Baseline A; for day and swing it is a **deliberate deviation**.
  - The arm must be named **Route2-on-V3** (or equivalent), never "exact Route 2". The deviation must be restated in the eventual Baseline B execution pre-registration.
- **D25, the separate user / account; `structure.owner` only in that account's raw config.**
  - Production allows one paper account per user (`paper_accounts_user_id_key UNIQUE (user_id)`, baseline schema) and hard-codes `BOT_ID = "smc"`, so the separate account is a separate auth user.
  - `structure.owner` exists **only** in the Baseline B account's raw `config_json`, and is read from the raw config (the mapper ignores unknown keys; precedent `resolveSimplification(__rawConfigJson)`).
  - It is **never** added to Baseline A's config: Baseline A's exact `config_json` and `config_version` `1037e6170289f865e4d6618dcf28b94d` stay unchanged.
- **D26, the reserved window stays untouched.** Until the V2.1.1 OOS run completes (after 2026-10-23 21:00Z), 2026-10-12 → 10-23 data is not imported into the V3.2c store, not analysed for V3.2c, and not inspected for strategy decisions. Afterwards it is filled from existing `smc_scan_bars`; V3.2c may not permanently jump across the window.
- **D27, monitoring classifications only.** The recurring 2024/25 provider absence (Sunday 17:00–19:00 NY in DST weeks) and the holiday closures are **classifications for data-quality monitoring only**. None of the following:
  - synthesized candles;
  - forward-fill;
  - a change to bucket completeness;
  - a 22/24-hour Daily bucket made valid;
  - a partial 4H bar.
- **D28, checkpoints ≠ live snapshots.**
  - **Checkpoint:** recovery / performance artefact written at each completed Daily close.
  - **Snapshot:** live structure state, written at every completed bar of its own timeframe (1H each 1H bar, 4H each NY-aligned 4H bar, D each NY-aligned Daily bar).
  - Consumers read the freshest valid snapshot of their timeframe and never use a checkpoint as live structure state.

## Non-blocking activation risk (recorded, not solved here)

- A second (Baseline B) account increases scan duration. The cron scans accounts sequentially in one invocation, with a 1.5 s per-pair throttle.
- It may increase TwelveData usage on a key that is already budget-constrained.
- The current in-memory candle cache is **isolate-local and short-lived** (90 s intraday TTL).
- Day / swing may require intervals that the scalper profile does not already fetch.
- **This must be measured during shadow, before Baseline B activation.** It does not block PR0 / PR1 and is not addressed in PR0.
