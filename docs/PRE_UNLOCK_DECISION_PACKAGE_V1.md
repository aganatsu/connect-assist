# Pre-unlock decision package (V1) — three decisions before entries can be unlocked

**Prepared:** 2026-10-08 ~04:00 UTC, after Step 16 (A–E) is complete and verified.

**State:**
- account $100,000, **paused and entries-locked**; 0 positions;
- config `1037e617…` live (behaviour-equivalent to `3d5b8fb0…`);
- Route 2 running as a dry run.

**Nothing in this package is implemented.** Each item needs your decision. Any option other than "keep" changes which trades happen. So each is a deliberate strategy / plumbing change under the freeze: implement in the dry run, observe, then decide on unlock.

**Evidence base:**
- 8 dry-run fills since the 10-06 reset (4 with attribution);
- **0 resolved outcomes among the attributed fills**;
- 540 decisions since Step 14.

The sample is thin. Two of the three decisions rest on rule consistency, not measured edge.

---

## 1. Fill-floor policy

**What happens today:**
- The Route 2 stop is anchored to the **limit** with `|limit − stop| ≥ floor` (25 pips GBP/USD, USD/JPY, CHF/JPY; 20 pips EUR/USD, NZD/CAD, NZD/CHF).
- The hunt fills at the **confirmation price**, and the stop does not move.
- A better-than-limit fill therefore sits **inside the floor**.
- Fill-time sizing keeps risk at 0.5% (measured 0.4977–0.4992%), so the dollar risk is right. What is breached is the floor's *noise* purpose.

**Evidence** (all dry-run fills since the reset; every fill so far is on a 25-pip pair):

| Order | Pair | Limit → stop | Fill → stop | Inside the floor by |
|---|---|---|---|---|
| 2dee2910 | USD/JPY short | 25.00 | 24.28 | 0.72 |
| 77134ab8 | CHF/JPY long | 25.00 | 27.14 | — |
| 02eb7948 | CHF/JPY long | 25.00 | 35.85 | — |
| bcf0216f | CHF/JPY short | 36.51 | 35.62 | — |
| 4d8eab45 | GBP/USD long | 25.00 | 20.05 | **4.95** |
| 896572f4 | GBP/USD long | 25.00 | 23.15 | 1.85 |
| 3758fd3a | GBP/USD long | 25.00 | 18.55 | **6.45** |
| 68a11a83 | GBP/USD long | 25.75 | 23.40 | 1.60 |

- **5 of 8 fills inside** (62%), by 0.72–6.45 pips; median breach 1.85 pips.
- **Outcome evidence: none.** The only resolved inside-floor fill is 2dee2910, a −1R stop with a margin of 1.34 pips: widening by 0.72 would not have saved it. The 4 attributed GBP/USD fills are all open.

**Options:**

| Option | Mechanism | Effect on the 8 fills | Notes |
|---|---|---|---|
| **1. Keep (accept)** | the floor applies at placement; size compensates at the fill | none | simplest; the stop can sit up to ~6.5 pips inside the floor |
| 2. Skip inside fills | re-check at fill, refuse if inside the floor | **refuses 5 of 8** | throws away the fills where the entry was *better*; heavy |
| **3. Re-anchor at fill** | if the fill is inside the floor: stop = fill ∓ floor; target = fill ± floor × 1.1; size 0.5% on the new distance | 5 stops widened by 0.72–6.45 pips; targets recomputed; risk still 0.5% | the floor rule becomes true at the **real** entry; changes the stop the order was placed with; attribution records both (plan section B vs fill section F) |
| 4. Tolerance | accept up to *X* pips inside, else option 2 or 3 | at *X* = 1: 4 re-anchored / refused | adds a tunable |

**Recommendation: Option 3, re-anchor only when the fill is inside the floor.** Never tighten; recompute the target at 1.1R from the fill; keep 0.5% sizing.

- **Why:** it keeps the floor's stated purpose (noise room) at the price actually entered, without losing the better fills, and dollar risk is unchanged.
- **Confidence:** this is a rule-consistency argument; there is no outcome evidence either way yet.
- **If chosen:** implement on the dry-run path first and observe re-anchored fills before unlock. It changes order geometry.

---

## 2. `skipped_tp_too_small` (`MIN_TP_PIPS`)

**What happens today:**
- bs:7641-7658 refuses a setup when the distance from the current price to `tp` is below a hard-coded per-pair minimum: GBP/USD and USD/JPY 20, EUR/USD 15, the others 12.
- That `tp` is the **legacy market-entry target**, computed before any Route 2 geometry. In practice it is smcAnalysis's own `takeProfit`, because the ratio path always yields ≥ 22 pips.
- Measured from the order's entry, a Route 2 order's own target is always ≥ 27.5 pips (25-pip pairs) or ≥ 22 pips (20-pip pairs), above every minimum.
- The gate's stated purpose (TP too small relative to spread) is already enforced, correctly, by the **order-geometry R:R gate net of estimated cost** (effective R:R ≥ 1.0).

**Evidence** (since Step 14, 2026-10-07 13:00 → 2026-10-08 03:53):

| | |
|---|---|
| Decisions | 540 |
| `skipped_tp_too_small` | **92 (17%)** |
| Distinct setups | **18** (same symbol + direction, refusals ≤ 30 min apart merged): USD/JPY 6, NZD/CAD 6, GBP/USD 4, NZD/CHF 2 |
| Later placed anyway | 5 of 18 got a Route 2 order for the same symbol and direction within 2 h, from a later scan that passed |
| **Never placed** | **13 of 18** |
| Outcome of the refused setups | **unmeasured** (no order exists to resolve) |

**Options:**

| Option | Mechanism | Effect |
|---|---|---|
| a. Keep | as today; documented mis-measurement | about 13 setups per 15 h stay refused |
| **b. Log-only measurement** | the gate is evaluated but does not block; it becomes part of the existing log-only gate family with a new `simplification` switch, recorded as `would_block` | refused setups flow into Route 2 **dry-run** orders, tagged; the Step 15 resolver and the 16-B cap-book measure their outcomes |
| c. Re-point to the order's own target | measure from the limit to the Route 2 target | never binds (≥ 22 > 20), so effectively (d) |
| d. Remove | rely on the order-geometry R:R gate | same as (c) |

**Recommendation: (b) log-only during the dry run, then decide (a) or (d) before unlock** from the measured outcomes of the would-have-been-refused setups.
- It costs no real-money risk while locked.
- It produces exactly the missing evidence.
- It uses the established log-only pattern (score / news / reaction).
- About 13 extra setups per ~15 h (roughly one every 70 min; these are the never-placed ones) would enter the dry run. The cap-book keeps overlapping exposure out of strategy totals.

---

## 3. Atomic reset / exposure race (from Step 16-D) — mandatory

**What happens today:**
- Step 16-D added a **caller-level** guard. paper-trading's `set_balance`, `reset_balance_only` and `reset_account` refuse while any position or active real order exists (merged `45fb9a2a`).
- The guard's live behaviour is not yet verified (that needs a real reset attempt).
- The check and `reset_paper_account` are separate statements.

**Additional finding (2026-10-08) — a lock alone is NOT enough:**
- A settlement is classed pre-epoch (credited **$0**) when `position.created_at < account.ledger_reset_at` (settle function, step 15 migration lines 111–112).
- `ledger_reset_at` is set with `clock_timestamp()` (wall clock, ledger migration line 719).
- A position's `created_at` defaults to `now()`, the **transaction start** time.
- `route2_claim_and_fill` takes **no lock** on the account row.

So even if reset and fill shared a lock:
1. a fill transaction that **started** before the reset but **committed** after it would stamp `created_at` earlier than `ledger_reset_at`;
2. the position, opened after the reset, would settle as pre-epoch with **$0**.

The fix must serialise **and** order consistently.

**Smallest atomic design (recommended; one migration plus a small paper-trading change):**

1. **Position insert serialises on the account and stamps commit-order time.** A `BEFORE INSERT` trigger on `paper_positions`:
   - takes `SELECT … FROM paper_accounts WHERE user_id = NEW.user_id AND bot_id = NEW.bot_id FOR SHARE`;
   - sets `NEW.created_at := clock_timestamp()` *after* acquiring that lock.

   This covers **every** insert path: `route2_claim_and_fill`, the disabled market path, paper-trading's manual order, the disabled second poller. No production path sets `created_at` explicitly (verified); test fixtures that backdate positions need a test-only escape (e.g. only override when `NEW.created_at IS NULL` or not older than the transaction start).
2. **A guarded reset function** for the UI actions, `reset_paper_account_if_flat(p_user_id, p_bot_id, p_new_balance, p_reason)`:
   - `SELECT … FROM paper_accounts … FOR UPDATE` (waits for any in-flight position insert, and blocks new ones);
   - checks `paper_positions` and active real `pending_orders` (`status IN ('pending','awaiting_confirmation') AND dry_run IS NOT TRUE`);
   - refuses with the exposure breakdown, or runs the existing reset logic in the same transaction.

   paper-trading's three actions switch to it; the caller-level guard stays as a second layer.
3. **`reset_paper_account` is unchanged**, so system-reset (which resets *before* clearing active state) keeps working. With (1), its resets also serialise against fills.

**Why this ordering is then correct:**

| Who takes the lock first | What happens |
|---|---|
| the fill | the reset waits, then sees the position and **refuses** |
| the reset | the fill waits, then stamps a `created_at` **later** than `ledger_reset_at`, so the position belongs to the new epoch and its close is **credited** |

**Alternative (more invasive):** stamp `paper_positions.ledger_epoch_id` under the lock and classify pre-epoch by epoch-id mismatch instead of timestamps. More robust long-term, but it changes the settle function (step 15 surface) and needs a backfill rule for legacy rows.

**Not recommended:** extending `reset_paper_account` with a trusted bypass for system-reset. It moves authorisation logic into a function clients can call, and does not fix the timestamp ordering.

**Tests the implementation must carry:**
- real-Postgres harness: refusal paths; flat path unchanged; `created_at` stamped after the lock;
- system-reset end-to-end unchanged;
- an explicit check that a position inserted after a reset settles as `close` (credited), not `pre_epoch_close`.

True concurrency cannot be exercised in the single-connection PGlite harness. It needs a two-session test on real Postgres, or a careful lock-order argument plus production observation.

**Recommendation:**
- Implement the trigger + guarded function before unlock. **Unlock must stay blocked until it is merged, applied and verified.**
- Also verify the 16-D caller guard live, with a refused reset attempt while a dry-run order is live, by your action.

---

## Other open items (not decisions; tracked)

| Item | Status |
|---|---|
| First order / attribution carrying `1037e617…` | test-proven; awaiting the first post-PATCH order (opportunistic) |
| 16-C float-noise same-level case observed live | the same-level refresh path was seen live (d2031803, 02:50); the specific noise case is test-proven only |
| 16-D caller guard live behaviour | pending a refused-reset check |
| `sbp_` token rotation | pending (security) |
| Correlation at fill time, Gate 15 vs Step 13 day basis, `pending_id` naming, `bot_config_history` table comment | documented in the Step 16 audit; not blockers |

## Decision requested

| # | Decision | Recommended |
|---|---|---|
| 1 | Fill floor | **Option 3:** re-anchor inside-floor fills (dry-run first) |
| 2 | `skipped_tp_too_small` | **(b):** log-only measurement in the dry run, decide before unlock |
| 3 | Atomic reset race | **implement trigger + guarded reset function**; unlock blocked until verified |

Each approved option gets its own PR, with an effect report and tests, one at a time, while trading stays locked.
