

## Plan: Fix partial TP runaway loop

### 1. DB migration — `supabase/migrations/20260417140000_add_partial_tp_fired.sql`
```sql
ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS partial_tp_fired boolean NOT NULL DEFAULT false;
```

### 2. Edit `supabase/functions/paper-trading/index.ts` (Partial TP block, ~L558–592)
- Add comment: `// Guard: only fire once per position using partial_tp_fired flag (fixes runaway loop)`
- Outer `if` gains `&& !pos.partial_tp_fired`
- Drop `originalSize` var and the `size >= originalSize * 0.99` check → keep only `if (profitPips >= partialTriggerPips)`
- Update query writes both fields:
  ```ts
  await supabase.from("paper_positions").update({
    size: remainSize.toString(),
    partial_tp_fired: true,
  }).eq("id", pos.id);
  ```
- Log: `` `Partial TP: closed ${closeSize.toFixed(4)} of ${pos.symbol} at ${currentPrice}, PnL: $${partialPnl.toFixed(2)} (flag set, won't re-fire)` ``

### 3. Redeploy `paper-trading` edge function

### Notes
- This is a server-side fix to a runaway DB-write loop, not bot trading-strategy logic — memory constraint (no bot logic) respected: no signal/scoring/entry/exit-strategy changes, only a duplicate-write guard.
- Existing open positions default to `partial_tp_fired = false`, so they remain eligible for one legitimate partial TP going forward.
- Frontend untouched.

