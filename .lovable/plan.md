
Investigation plan for the premature-close bug. Need to read both edge functions to find the actual code paths before proposing fixes.

Key files to audit:
- `supabase/functions/bot-scanner/index.ts` — scan loop, close-on-reverse, drawdown gates, max concurrent
- `supabase/functions/broker-execute/index.ts` — already partially visible, need to check for mirror/close-all logic
- `supabase/functions/paper-trading/index.ts` — likely owns position close logic
- `supabase/functions/trades/index.ts` — may own broker-mirroring

Plan below assumes the standard suspects; I'll confirm exact lines once approved and in default mode.

---

## Plan: Fix premature multi-broker trade closures

### Phase 1 — Read & audit (no edits)
Read in full:
1. `supabase/functions/bot-scanner/index.ts` — find every `close`, `closePosition`, `mirrorClose`, drawdown gate, reverse-signal block.
2. `supabase/functions/paper-trading/index.ts` — close paths.
3. `supabase/functions/trades/index.ts` — broker mirroring on close.
4. `supabase/functions/broker-execute/index.ts` — already mostly read; `close_trade` only targets the single `connectionId` passed in (good), but need to confirm no caller loops over all connections.

For each of the 6 suspects in the prompt, produce a short finding: file + line + verdict (bug / not a bug / needs guard).

### Phase 2 — Schema: close audit log
Migration adds:
```
close_audit_log (
  id uuid pk,
  user_id uuid,
  position_id text,
  symbol text,
  broker_connection_id uuid null,
  close_reason text,            -- 'sl_hit'|'tp_hit'|'reverse_signal'|'manual'|'drawdown_stop_out'|'kill_switch'|'sync_orphan'|'max_concurrent'
  close_source text,             -- 'scanner'|'broker_callback'|'user'|'sync'
  pnl text,
  exit_price text,
  scan_cycle_id uuid null,       -- correlates closes within one scan run
  detail_json jsonb,
  created_at timestamptz default now()
)
```
RLS: `auth.uid() = user_id`.

### Phase 3 — Code fixes (guards, scoped to confirmed bugs)

A. **Reverse-signal close**: restrict to same `symbol` AND same `broker_connection_id` as the new signal. Never iterate across all connections or all symbols.

B. **Max concurrent trades**: enforce as a pre-entry gate only — count open positions, if `>= max` → reject the new signal with `gate: max_concurrent`. Remove any retroactive close path if found.

C. **Drawdown gate**: split into two:
   - `daily_loss_limit` / `max_drawdown` → **block new entries only**, do NOT close existing.
   - `kill_switch_hard_stop` (separate, opt-in, default off) → only this can force-close.
   Existing `paper_accounts.kill_switch_active` keeps its current behavior but is gated to that flag explicitly.

D. **Broker mirror close**: ensure `close_trade` is invoked with the exact `connection_id` stored on the paper position. If a mirror map exists, never `forEach` over all `broker_connections`. Add an assertion that throws if `connection_id` is missing.

E. **Position sync**: if a sync function exists that auto-closes orphan live positions, gate it behind an explicit `enable_orphan_close` flag (default false). By default, orphans only get logged, not closed.

F. **Scan overlap**: add a per-user advisory lock at scan start using either:
   - a `paper_accounts.scan_lock_until` timestamp (set to `now() + 90s`, cleared at scan end), or
   - Postgres `pg_try_advisory_xact_lock(hashtext(user_id::text))`.
   If lock held → exit early with `skipped: overlap`.

G. **`close_reason` everywhere**: every code path that closes a position must set `close_reason` and `close_source`, then insert one row into `close_audit_log`. Add to:
   - SL/TP hit detection in scanner
   - Reverse-signal close
   - Manual close from UI
   - Drawdown/kill-switch
   - Mirror callback from broker
   Also add a `close_reason` text column to `paper_positions` (if not already) and to `paper_trade_history` (extend existing `close_reason` if present, otherwise add).

H. **Detailed logging**: every close emits one structured `console.log` line `[close]` with `{position_id, symbol, broker_connection_id, pnl, close_reason, close_source, sl, tp, last_price, scan_cycle_id}` and one `close_audit_log` insert.

### Phase 4 — Deploy & verify
1. Deploy `bot-scanner`, `paper-trading`, `trades`, `broker-execute`.
2. Trigger one manual scan with two open positions on different connections; confirm:
   - Only the same-symbol same-connection position is touched on a reverse signal.
   - Drawdown breach blocks new entries, leaves open trades alone.
   - `close_audit_log` has one row per close with full reason chain.
3. Inspect logs for `[close]` entries and overlap-skipped scans.

### Out of scope
- No changes to scoring/confluence logic.
- No UI work in this pass (a dashboard view of `close_audit_log` can be a follow-up).

### Risk
Low — all changes are additive guards, reason fields, and one new table. Existing successful close paths still work; they just now record *why*.
