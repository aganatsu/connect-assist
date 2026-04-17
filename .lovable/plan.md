
User explicitly overrides the constraint and wants the full fix. I'll remove the memory file in default mode and execute the previously-approved plan.

## Plan: Remove constraint + execute premature-close fix

### Phase 0 — Memory
- Delete `mem://constraints/no-bot-logic`
- Update `mem://index.md` to drop the bot constraint line and reference

### Phase 1 — Audit (read-only)
Read in full and produce per-suspect findings (file + line + verdict):
- `supabase/functions/bot-scanner/index.ts`
- `supabase/functions/paper-trading/index.ts`
- `supabase/functions/trades/index.ts`
- `supabase/functions/broker-execute/index.ts` (already mostly read)

### Phase 2 — Schema migration
New table `close_audit_log`:
- `id uuid pk`, `user_id uuid`, `position_id text`, `symbol text`
- `broker_connection_id uuid null`, `close_reason text`, `close_source text`
- `pnl text`, `exit_price text`, `scan_cycle_id uuid null`, `detail_json jsonb`
- `created_at timestamptz default now()`
- RLS: `auth.uid() = user_id`
- Index on `(user_id, created_at desc)`

Add `close_reason text` to `paper_positions` if missing (paper_trade_history already has it).

### Phase 3 — Code fixes (only where audit confirms a bug)

A. **Reverse-signal close** → restrict to same `symbol` AND same `broker_connection_id` (or paper-only if no connection). Never cross-symbol, never cross-connection.

B. **Max concurrent** → enforce as pre-entry gate; reject signal with `gate: max_concurrent`. Remove any retroactive close.

C. **Drawdown** → split:
- `daily_loss_limit` / `max_drawdown` → block new entries only.
- Existing `kill_switch_active` flag remains the only path that force-closes.

D. **Broker mirror close** → use the exact `connection_id` stored on the position. Assert non-null. Never iterate all `broker_connections` on close.

E. **Position sync** → if orphan-close exists, gate behind `enable_orphan_close` flag (default false). Default = log only.

F. **Scan overlap** → per-user lock via `paper_accounts.scan_lock_until` (set `now() + 90s` at scan start, clear at end). If held → exit with `skipped: overlap`.

G. **`close_reason` everywhere** → every close path sets `close_reason` + `close_source`, inserts one `close_audit_log` row. Paths covered: SL/TP, reverse-signal, manual, kill-switch, mirror callback.

H. **Structured logging** → `console.log("[close]", {...})` on every close with full context.

### Phase 4 — Deploy & verify
- Deploy `bot-scanner`, `paper-trading`, `trades`, `broker-execute`
- Inspect edge logs for `[close]` entries and `skipped: overlap`
- Confirm `close_audit_log` rows appear with reason chain

### Risk
Low — additive guards + one new table. No scoring/analysis logic changes.
