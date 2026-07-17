# Task: Fix Pending Order Cycling Bug

## Branch: manus/fix-pending-order-cycling

## Behavior changes

1. **Standalone signals with `confirmation.type = "none"` no longer place pending orders.** Previously, a standalone signal with zero confirmation (the unified engine literally returning "No confirmation — watchlist only") would still place a pending limit order and start hunting for 5m CHoCH. Now these are blocked at the execution routing stage with status `skipped_no_confirmation`. The setup is logged and skipped — no Telegram notification, no pending order, no cycling.

2. **Post-expiry cooldown prevents immediate re-placement.** When a pending order expires (TTL reached), the same symbol+direction cannot place a new pending order until the cooldown period elapses. Previously there was zero dedup on expired orders — the stale-pending check only looked at `status='pending'`, so expired orders were invisible.

3. **Cooldown is now separately configurable.** New config field `pendingOrderCooldownMinutes` (default: 0). When 0, falls back to `limitOrderExpiryMinutes` as the cooldown (previous behavior). When set >0, uses that value as the cooldown regardless of TTL. This allows shorter cooldowns than the order TTL (e.g., 30min cooldown with 60min TTL).

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/bot-scanner/index.ts` | Added 2 anti-cycling guards + `pendingOrderCooldownMinutes` to DEFAULTS and loadConfig mapping. Cooldown now uses configurable field with fallback to TTL. |
| `supabase/functions/_shared/configMapper.ts` | Added `pendingOrderCooldownMinutes` to RUNTIME_DEFAULTS (default: 0) and mapNestedToFlat mapping (reads from `entry` section). |
| `supabase/functions/_shared/pendingOrderCyclingFix.test.ts` | NEW: 17 tests covering both parts + configurable cooldown + regression tests |
| `REPORT.md` | This file |

## Tests added

| Test | Assertion |
|------|-----------|
| Part 2: Standalone + type='none' → BLOCKED | Pending order is blocked |
| Part 2: Standalone + type='inducement' → NOT blocked | Inducement is valid confirmation |
| Part 2: Standalone + type='displacement' → NOT blocked | Displacement is valid confirmation |
| Part 2: Unified + type='none' → NOT blocked | Unified signals bypass this check |
| Part 2: Standalone + no unifiedZoneData → NOT blocked | Defensive: no data = no block |
| Part 2: Standalone + no confirmation field → NOT blocked | Defensive: missing field = no block |
| Part 1: Expired 30min ago (within 60min cooldown) → BLOCKED | Cooldown active |
| Part 1: Expired 90min ago (outside 60min cooldown) → NOT blocked | Cooldown elapsed |
| Part 1: Different direction expired → NOT blocked | Direction-specific |
| Part 1: Different symbol expired → NOT blocked | Symbol-specific |
| Part 1: No expired orders → NOT blocked | Clean slate |
| Part 1: Swing trader 480min TTL → BLOCKED at 200min | TTL-proportional cooldown |
| Config: pendingOrderCooldownMinutes > 0 overrides TTL | Custom cooldown takes priority |
| Config: pendingOrderCooldownMinutes = 0 falls back to TTL | Default behavior preserved |
| Regression: Unified + none NOT blocked | Key regression: unified bypasses |
| Regression: Standalone + inducement NOT blocked | Inducement is valid |
| Regression: Cooldown uses TTL (not hardcoded) | Verifies dynamic cooldown |

## Tests run

```
$ deno test --allow-all --no-check supabase/functions/_shared/pendingOrderCyclingFix.test.ts
ok | 17 passed | 0 failed (25ms)

$ deno test --allow-all --no-check supabase/functions/_shared/configMapper.test.ts
ok | 51 passed | 0 failed (26ms)

$ deno test --allow-all --no-check supabase/functions/_shared/indicatorConfirmation.test.ts \
    supabase/functions/_shared/tpNextLevelAndStandalone.test.ts \
    supabase/functions/_shared/pendingOrderReplaceStale.test.ts
ok | 30 passed | 0 failed
```

## Regression check

- Verified that unified/cascade signals are completely unaffected by Part 2 (the `isStandaloneSignal` guard ensures only standalone signals are checked)
- Verified that inducement-type confirmation (score=1.0) is NOT blocked — only type="none" (score=0) is blocked
- Verified that `pendingOrderCooldownMinutes: 0` (default) preserves existing behavior (uses TTL as cooldown)
- Verified configMapper test suite passes with the new field (51 tests)
- All 30 existing related tests pass (indicatorConfirmation, tpNextLevel, pendingOrderReplaceStale)

## Open questions

None — all questions resolved during implementation.

## Suggested PR title and description

**Title:** fix: prevent pending order cycling + add configurable cooldown

**Description:**
Fixes the critical bug where standalone signals with no confirmation keep placing and expiring pending orders indefinitely (every 60 minutes).

**Root cause:** Two gaps in the pending order lifecycle:
1. No dedup on expired orders — stale-pending check only looked at `status='pending'`
2. Standalone signals with `confirmation.type="none"` still placed pending orders despite the engine saying "watchlist only"

**Fix:**
- **Part 1:** Post-expiry cooldown — query for recently expired orders before placement
- **Part 2:** Block pending orders when standalone + confirmation.type="none"
- **Config:** New `pendingOrderCooldownMinutes` field (default 0 = use TTL, set >0 to override)

**Impact:** Reduces Telegram spam, eliminates infinite cycling. No change to behavior for setups that DO have valid confirmation signals (inducement, displacement, CHoCH).

**Config location:** `entry.pendingOrderCooldownMinutes` in bot_configs JSON.
