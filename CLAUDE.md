# connect-assist — agent instructions

Read this before writing code. It exists because this repo has been built by
several different AI systems (Manus, Codex, Lovable, Claude) across 300+
branches, none sharing context. The failure mode below is the single largest
source of bugs in this codebase.

---

## The one rule

**Before adding any detector, engine, gate, scoring function, or exit rule —
search for an existing one and modify it. Do not add a parallel implementation.**

Every agent that arrives here faces the same choice: understand 3,000 lines of
existing detection logic well enough to change it safely, or write a clean new
function that definitely works. Writing new always wins locally — it is faster,
lower-risk for that one task, and it always passes review because the new thing
does work.

Nobody ever makes a bad decision. The aggregate of 300 locally-correct decisions
was four exit-fill models, two premium/discount functions, two SMT detectors and
two breaker detectors, all of which drifted apart. Every production bug found in
the 2026-08-10 audit was a **drift bug**, not a logic bug. Nobody misunderstood
SMC; the copies just aged apart.

If the existing implementation is wrong, **fix it or delete it**. Do not leave
both.

### Do not "consolidate" by adding an arbiter

Nine previous branches tried to fix duplication by adding a module that
reconciles the two copies. That converts 2 implementations into 3, and the new
referee is itself a concept that can be duplicated. This is where the
`*Authority` / `canonical*` / `streamlined*` modules came from.

Consolidation means **deleting**. New `*Authority`, `*Canonical`, or `*Unified`
reconciliation modules require explicit approval.

### The enforcement is automated

`supabase/tests/_shared/singleConceptOwnership.test.ts` fails the build if a
locked concept gains a second implementation. If it fails:

- **Do not** add an arbiter module to reconcile the two.
- **Do not** add the name to `DELIBERATELY_DISTINCT` to make the test pass.
- Modify the existing owner, or delete it and replace it.

When you consolidate a concept down to one owner, add its name to `SINGLE_OWNER`
so it can never be duplicated again.

### The correct way to expose a shared function locally

A one-line delegating alias is fine and is not counted as a duplicate:

```ts
function detectSession(_config?: any): SessionResult { return sharedDetectSession(); }
```

Copying the body into a local function is not.

---

## Orientation

- `docs/CONCEPT_INVENTORY.md` — every trading concept, every implementation,
  which one is live. **Read this before touching detection or exit logic.**
- `docs/SYSTEM_OVERVIEW.md` — architecture. Note it has drifted from the code;
  trust the source over the doc.
- `supabase/functions/_shared/` — all shared logic. New shared code goes here,
  not inside an edge function.
- `supabase/functions/bot-scanner/index.ts` — the scan pipeline. `runScanForUser`
  is ~9,800 lines; use the `// ── Section ──` banners to navigate.

### Runtime shape

Cron-driven poller, not tick-driven. `bot-scanner` wakes on an interval (default
5 min) and loops the watchlist serially. `zone-confirmation-scanner` runs a
1-min loop watching armed zones. `paper-trading` polls open positions every 5s.

---

## Trading-specific invariants

**Detectors must only ever see closed bars.** `fetchCandlesWithFallback` drops
the in-progress bar. Never pass `keepFormingBar: true` to anything that feeds
detection, scoring, or backtest — an unclosed bar's high/low/close keep moving,
so signals flicker within a bar and backtest cannot reproduce live behaviour.

**Exit decisions go through `_shared/exitEvaluation.ts`.** Do not write another
`price <= stopLoss` check. Callers with a real OHLC bar pass it; poll-based
callers pass `priceAsBar(price)`.

**Live and backtest must stay in parity.** `bot-scanner` and `backtest-engine`
are two orchestrators over the same shared modules. Any change to scoring, gates,
zones or exits must land in the shared module, not in one orchestrator.

**Behavioural changes need evidence.** Anything that changes which trades the bot
takes should be isolated in its own PR and tested against historical winners and
losers. The repo has a shadow/observation-only convention for staging risky
changes — prefer it over flipping behaviour directly.

---

## Working practice

- **Branch, never commit to `main`.** All merges go through a PR.
- **Tests:** `deno test --no-check --allow-read --allow-net --allow-env supabase/tests/`
  (~2,990 tests, ~20s). The whole suite must pass.
- **A regression test must fail without your fix.** Verify that explicitly —
  revert the fix, watch it fail, restore it. A test that passes either way is
  worth nothing.
- **Type errors:** the repo has 22 pre-existing `deno check` errors on
  `bot-scanner/index.ts`, which is why tests run with `--no-check`. Do not add to
  them — diff the error set against `main` rather than trusting the count.
- **`.env` is committed** and this repo is public. Only the Supabase publishable
  (anon) key is in it, which is designed to be public — but the actual security
  boundary is Row Level Security. Never add a service-role key or private
  credential to it.

---

## Known open items

See `docs/CONCEPT_INVENTORY.md` for the full list. Currently outstanding:

- **Gate 9** (`bot-scanner/index.ts`) tests the raw score against the base
  threshold, while eligibility tests the adjusted score against the adjusted
  threshold. Unresolved whether this is a bug or a deliberate raw quality floor.
- **Premium/Discount gate** uses a rolling entry-TF swing envelope rather than
  the frozen impulse dealing range — Priority 1 in
  `docs/UNRESOLVED_SYSTEM_AUDIT_2026-08-03.md`.
- **Cascade signal source** is the top-priority strategy for `swing_trader` on
  the strength of an 8-trade backtest. Not a validated edge.
- **`detectBreakerBlocks` / `detectJudasSwing`** are name collisions on genuinely
  distinct concepts. They need renaming, not merging.
