# Step 15 PR 1 — attribution schema + settlement support: effect report

**Status:** built and tested; PR open, **not merged**. The account stays **paused and entries-locked**.

**Behaviour-neutral:**
- no scanner, fill-path, cron, outcome-job or trading-config change;
- nothing writes a `signal_id` yet, so every settlement takes the legacy path.

## What the migration does (`20261008000000_step15_attribution_schema.sql`)

0. **Pre-check:** `public._paper_ledger_post`, `_paper_history_row`, `settle_paper_position` and `settle_paper_partial` must have either the exact `20261006010000` source or this migration's own (re-run). Otherwise it **raises and changes nothing**, rather than overwrite a production hand-edit.
1. `bot_configs.config_version text GENERATED ALWAYS AS (md5(config_json::text)) STORED`: the change log's `next_hash` expression.
2. **`trade_attribution`:** sections A–G, PK `signal_id`, plus:
   - **FKs:** self `superseded_by_signal_id`; `history_id` → `paper_trade_history`; `ledger_id` → `paper_account_ledger`;
   - **checks:**
     - `ta_fill_kind_matches_dry_run`
     - `ta_outcome_kind_matches_fill`
     - `ta_close_requires_fill`
     - `ta_fill_terminal`
     - `ta_superseded_link`
     - `ta_not_self_superseded`
     - `ta_real_close_has_ledger`
     - column CHECKs (direction, route, primary_engine, stop_source, terminal_status, fill_kind, outcome_kind, exit_reason, config_version 32-hex, positive prices, 0 < risk ≤ 5);
   - **indexes:**
     - `ta_by_user_time`
     - `ta_by_config`
     - `ta_by_symbol`
     - `ta_by_engine_route`
     - `ta_order_id` (unique)
     - `ta_unresolved_hypothetical` (partial).
3. **`trade_attribution_events`:** FK `signal_id`; indexes `tae_by_signal` and `tae_dedupe` (unique per signal + dedupe_key).
4. **`signal_id` columns** (FK → `trade_attribution`) on `smc_scan_decision`, `pending_orders`, `paper_positions`, `paper_trade_history`, `paper_account_ledger`:
   - unique on orders and positions;
   - unique on final-close history rows;
   - indexed on decisions and the ledger.

   Plus `pending_orders.fill_sizing jsonb`: unused until PR 2.
5. **Triggers:**
   - `trade_attribution_guard` (BEFORE UPDATE OR DELETE): immutable / write-once / no delete;
   - `trade_attribution_no_truncate`;
   - `tae_append_only` / `tae_no_truncate`;
   - `<table>_signal_id_immutable` (BEFORE UPDATE OF signal_id) on 4 lifecycle tables.
6. **Functions:**
   - new: `ta_event`, `ta_exit_reason`;
   - `_paper_ledger_post`: the 9-argument version is dropped; a 10-argument version takes `p_signal_id DEFAULT NULL`;
   - `_paper_history_row`: `signal_id` is forced from the position;
   - `settle_paper_position`: carries `signal_id` to the ledger and, in the same transaction, writes the attribution close (G) inside a savepoint;
   - `settle_paper_partial`: carries `signal_id` and records a `partial_close` event.
7. **Access:** RLS on both tables, owner SELECT only; INSERT / UPDATE / DELETE / TRUNCATE revoked from anon and authenticated.

**Not included** (deliberately; they belong to PR 2 / PR 3): the order and position lifecycle triggers, the resolver RPC, any code.

## Settlement-function diff vs `20261006010000` (only 7 lines replaced; everything else added)

```diff
--- 20261006010000/_paper_ledger_post
+++ 20261008000000/_paper_ledger_post
@@ -9,3 +9,4 @@
   p_source text,
-  p_detail jsonb
+  p_detail jsonb,
+  p_signal_id uuid DEFAULT NULL
 )
@@ -24,3 +25,3 @@
     amount, balance_before, balance_after,
-    position_row_id, position_id, history_id, source, detail
+    position_row_id, position_id, history_id, source, detail, signal_id
   ) VALUES (
@@ -28,3 +29,3 @@
     p_settlement_key, p_kind, p_amount, v_before, v_after,
-    p_position_row_id, p_position_id, p_history_id, COALESCE(p_source, 'unknown'), COALESCE(p_detail, '{}'::jsonb)
+    p_position_row_id, p_position_id, p_history_id, COALESCE(p_source, 'unknown'), COALESCE(p_detail, '{}'::jsonb), p_signal_id
   )

--- 20261006010000/_paper_history_row
+++ 20261008000000/_paper_history_row
@@ -37,3 +37,5 @@
       'bot_id', p_bot_id,
-      'position_id', p_position.position_id
+      'position_id', p_position.position_id,
+      -- Step 15: forced from the position, never taken from the caller.
+      'signal_id', p_position.signal_id
     )

--- 20261006010000/settle_paper_position
+++ 20261008000000/settle_paper_position
@@ -93,3 +93,4 @@
            size = COALESCE(size, v_row.size),
-           source_position_row_id = COALESCE(source_position_row_id, v_position.id)
+           source_position_row_id = COALESCE(source_position_row_id, v_position.id),
+           signal_id = COALESCE(signal_id, v_position.signal_id)
      WHERE id = v_existing.id;
@@ -126,4 +127,49 @@
       'reset_at', CASE WHEN v_pre_epoch THEN v_account.ledger_reset_at END
-    ))
+    )),
+    v_position.signal_id
   );
+
+  -- Step 15: attribution close, in this transaction. Only for an attributed
+  -- position (signal_id set) whose attribution has a real fill recorded; a
+  -- legacy position (signal_id NULL) settles exactly as before. Attribution
+  -- can never block a settlement: any failure in this block is rolled back to
+  -- its savepoint and recorded as an event, and the money still settles.
+  IF v_position.signal_id IS NOT NULL THEN
+    BEGIN
+      UPDATE public.trade_attribution SET
+        outcome_kind = 'real',
+        outcome_method = 'ledger_settlement.v1',
+        closed_at = now(),
+        exit_price = v_row.exit_price,
+        exit_reason = public.ta_exit_reason(p_source, v_row.close_reason),
+        close_source = p_source,
+        realized_pnl_usd = v_amount,
+        realized_r_gross = CASE WHEN fill_price IS NOT NULL AND fill_stop_price IS NOT NULL AND fill_price <> fill_stop_price
+          THEN (CASE direction WHEN 'long' THEN v_row.exit_price - fill_price ELSE fill_price - v_row.exit_price END)
+               / abs(fill_price - fill_stop_price) END,
+        realized_r_net = CASE WHEN fill_price IS NOT NULL AND fill_stop_price IS NOT NULL AND fill_price <> fill_stop_price
+          THEN ((CASE direction WHEN 'long' THEN v_row.exit_price - fill_price ELSE fill_price - v_row.exit_price END)
+                - COALESCE(cost_in_price, 0)) / abs(fill_price - fill_stop_price) END,
+        history_id = v_history_id,
+        ledger_id = v_entry.id
+      WHERE signal_id = v_position.signal_id
+        AND closed_at IS NULL AND filled_at IS NOT NULL AND fill_kind = 'real';
+      IF FOUND THEN
+        PERFORM public.ta_event(v_position.signal_id, 'closed', p_source, jsonb_build_object(
+          'history_id', v_history_id, 'ledger_id', v_entry.id, 'pnl', v_amount,
+          'exit_price', v_row.exit_price, 'close_reason', v_row.close_reason), 'closed');
+      ELSE
+        PERFORM public.ta_event(v_position.signal_id, 'closed', p_source, jsonb_build_object(
+          'history_id', v_history_id, 'ledger_id', v_entry.id, 'pnl', v_amount,
+          'note', 'attribution close fields not written: no real fill recorded or already closed'), 'closed');
+      END IF;
+    EXCEPTION WHEN OTHERS THEN
+      BEGIN
+        PERFORM public.ta_event(v_position.signal_id, 'closed', p_source, jsonb_build_object(
+          'history_id', v_history_id, 'ledger_id', v_entry.id,
+          'attribution_error', SQLERRM), 'closed_error');
+      EXCEPTION WHEN OTHERS THEN NULL;  -- the money path never fails on attribution
+      END;
+    END;
+  END IF;
 

--- 20261006010000/settle_paper_partial
+++ 20261008000000/settle_paper_partial
@@ -91,4 +91,14 @@
       'remaining_size', p_remaining_size, 'history_fallback_error', v_fallback_error
-    ))
+    )),
+    v_position.signal_id
   );
+
+  IF v_position.signal_id IS NOT NULL THEN
+    BEGIN
+      PERFORM public.ta_event(v_position.signal_id, 'partial_close', p_source, jsonb_build_object(
+        'history_id', v_history_id, 'ledger_id', v_entry.id, 'pnl', v_entry.amount,
+        'closed_size', v_row.size, 'remaining_size', p_remaining_size), 'partial:1');
+    EXCEPTION WHEN OTHERS THEN NULL;  -- an event can never block a settlement
+    END;
+  END IF;
 

```

## Proofs (real Postgres, PGlite 16; `paperSettlementLedger.test.ts`, 43 tests)

| Requirement | Test(s) | Result |
|---|---|---|
| Migration idempotent | "migration is idempotent": object inventory (tables, triggers, indexes, columns, functions) identical after a second run; only the 10-argument ledger post exists | pass |
| Pre-check protects production | first application passes against the 20261006010000 bodies; re-run passes against its own; a hand-edited `settle_paper_partial` → raises, nothing applied | pass |
| Canonical hash | `config_version` = the change log's `next_hash` after two updates (nested, unicode, big numbers) | pass |
| Legacy settlement unchanged (`signal_id` NULL) | **all 32 pre-existing settlement tests** run on the new functions (double settle, history-insert failure, backfills, partial TP, guard observe / enforce, epochs, permissions, invalid closes, legacy RPC); plus an explicit check: NULL `signal_id` on history and ledger, 0 attribution rows, 0 events | pass |
| Attributed settlement atomic | history and ledger carry the `signal_id`; attribution G = real / target / source / history_id / ledger_id / P/L / R gross 1.10 / R net; event `closed`. **A failure at the last statement (position delete) rolls back history, ledger AND the attribution close**; the position is kept and the balance unchanged | pass |
| Attribution never blocks money | no fill recorded → settles, G not written, event explains why; an attribution UPDATE that errors → rolled back to its savepoint, event records the error, settles | pass |
| Duplicate settlement impossible | a second settle → `already_settled`; 1 ledger close, 1 history row, balance once, attribution unchanged, 1 event | pass |
| Close sources | manual / prop_firm_emergency / kill_switch / reset_flatten / stop (exactly −1R at the fill stop) / target / reverse_signal; each ledger row carries the `signal_id` | pass |
| Partial TP | partial history and ledger rows carry the `signal_id`; event `partial_close`; not treated as the close | pass |
| No illegal mutation | UPDATE of immutable columns refused (5 cases); write-once: first and same value ok, a different value or NULL refused; self-supersede and close-without-fill refused; DELETE / TRUNCATE refused; events append-only; `signal_id` change on a position refused; unknown `signal_id` refused by FK; the authenticated role cannot insert | pass |

**Side effect on an existing test:** truncating the ledger is now refused earlier, by Postgres (`trade_attribution.ledger_id` references it), so the message differs. The assertion now accepts either refusal.

## Full test results

- **Deno:** supabase/tests 1,772 passed / 0 failed; supabase/functions 1,569 passed / 0 failed. **Total 3,341 / 0.**
- **Frontend:** 366 passed.
- **`deno check`:** no new type errors (the 20 in `paperSettlementLedger.test.ts` pre-exist on main).

## Deploy steps (after your approval of this report)

1. Apply in the SQL editor, one transaction: the migration + its `schema_migrations` row + `notify pgrst`. The pre-check aborts it if production differs.
2. Verify read-only:
   - `config_version` = the latest change-log hash (`3d5b8fb0…`);
   - the new tables are empty;
   - a settlement still works (the next real close is far off while locked, so verify via the functions' presence and signature).
3. Merge (CI green). This PR deploys no function code (only the migration and tests), so trading is unaffected.
