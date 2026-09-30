-- ROUTE 2 ATOMIC FILL — claim the pending order and create the position in
-- ONE transaction.
--
-- THE RACE THIS CLOSES. Both Route 2 fill paths did:
--     1. INSERT paper_positions        (error discarded)
--     2. UPDATE pending_orders SET status='filled'
-- zone-confirmation-scanner guarded step 2 on status='awaiting_confirmation';
-- bot-scanner did not guard it at all. Proven on order a439f5bc (USD/JPY
-- short, 2026-09-29): the position opened 10:27:22 and closed on TP 10:49,
-- but bot-scanner had reset the order to 'pending' between steps 1 and 2, so
-- the guarded update matched zero rows, silently. The order stayed LIVE and
-- fillable for another 58 minutes, then "expired" with filled_at NULL.
--
-- And because step 1's error was discarded, the reverse also existed: a
-- failed insert followed by a successful step 2 left an order marked filled
-- with no position behind it.
--
-- NEW SEMANTICS. The claim and the insert commit together or not at all:
--   * claim: guarded UPDATE on the pending row's PRIMARY KEY, requiring
--     status='awaiting_confirmation' AND the confirmation_arm_count the
--     caller read. Exactly one row, or nothing happens. The arm-count guard
--     defeats a STALE confirmation: an order reset and re-armed since the
--     caller read it has a higher arm count, so the old confirmation loses.
--   * insert: only after a successful claim, with source_pending_order_id
--     FORCED to the claimed row's id — the caller cannot bind a position to
--     a different order.
--   * insert fails -> the exception rolls back the claim too. The order is
--     left awaiting_confirmation, untouched, and the next poll retries. A
--     persistent failure ends in ordinary TTL expiry. No false fill is
--     possible, so no transitional status (and no status-constraint change)
--     is needed.
--   * unique violation (a position already exists for this pending order)
--     -> both steps roll back and the call returns 'duplicate_position'.
--
-- Unknown or generated column names fail loudly instead of being dropped:
-- that failure is now harmless (nothing commits), whereas a silently dropped
-- column would lose data.
--
-- Callable by the service role ONLY. It inserts positions for any user_id,
-- so exposing it to anon/authenticated would be a privilege escalation.

create or replace function public.route2_claim_and_fill(
  p_pending_id          uuid,
  p_user_id             uuid,
  p_expected_arm_count  integer,
  p_pending_patch       jsonb,
  p_position            jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_patch        jsonb;
  v_pos          jsonb;
  v_patch_cols   text;
  v_pos_cols     text;
  v_bad          text;
  v_claimed      uuid;
  v_rows         int;
  v_position_id  uuid;
  v_status       text;
  v_arms         int;
begin
  if p_pending_id is null or p_user_id is null then
    raise exception 'route2_claim_and_fill: pending id and user id are required';
  end if;

  -- The caller may not move identity or the guarded state through the patch.
  v_patch := coalesce(p_pending_patch, '{}'::jsonb)
             - 'id' - 'order_id' - 'user_id' - 'bot_id' - 'status' - 'confirmation_arm_count'
             || jsonb_build_object('status', 'filled');

  select string_agg(k, ', ') into v_bad
  from jsonb_object_keys(v_patch) k
  where k not in (select column_name from information_schema.columns
                  where table_schema = 'public' and table_name = 'pending_orders'
                    and is_generated = 'NEVER');
  if v_bad is not null then
    raise exception 'route2_claim_and_fill: not writable pending_orders columns: %', v_bad;
  end if;

  select string_agg(k, ', ') into v_bad
  from jsonb_object_keys(coalesce(p_position, '{}'::jsonb)) k
  where k not in (select column_name from information_schema.columns
                  where table_schema = 'public' and table_name = 'paper_positions'
                    and is_generated = 'NEVER');
  if v_bad is not null then
    raise exception 'route2_claim_and_fill: not writable paper_positions columns: %', v_bad;
  end if;

  select string_agg(format('%I', k), ', ') into v_patch_cols from jsonb_object_keys(v_patch) k;

  begin
    -- ── 1. CLAIM: exactly one row, from exactly the state the caller saw ──
    execute format(
      'update public.pending_orders t
          set (%1$s) = (select %1$s from jsonb_populate_record(t, $1))
        where t.id = $2 and t.user_id = $3
          and t.status = %2$L
          and t.confirmation_arm_count is not distinct from $4
        returning t.id',
      v_patch_cols, 'awaiting_confirmation')
      into v_claimed
      using v_patch, p_pending_id, p_user_id, p_expected_arm_count;
    get diagnostics v_rows = row_count;

    if v_rows <> 1 or v_claimed is null then
      select status, confirmation_arm_count into v_status, v_arms
      from public.pending_orders where id = p_pending_id and user_id = p_user_id;
      return jsonb_build_object(
        'outcome', 'lost',
        'current_status', v_status,
        'current_arm_count', v_arms,
        'expected_arm_count', p_expected_arm_count);
    end if;

    -- ── 2. INSERT, bound to the row we own ──
    v_pos := coalesce(p_position, '{}'::jsonb)
             || jsonb_build_object('source_pending_order_id', v_claimed);
    select string_agg(format('%I', k), ', ') into v_pos_cols from jsonb_object_keys(v_pos) k;

    execute format(
      'insert into public.paper_positions (%1$s)
       select %1$s from jsonb_populate_record(null::public.paper_positions, $1)
       returning id',
      v_pos_cols)
      into v_position_id
      using v_pos;

    return jsonb_build_object(
      'outcome', 'filled',
      'pending_id', v_claimed,
      'position_row_id', v_position_id);

  exception when unique_violation then
    -- This block is a savepoint: the claim above is undone with the insert.
    return jsonb_build_object('outcome', 'duplicate_position', 'detail', sqlerrm);
  end;
  -- Any OTHER error propagates and aborts the whole call: nothing commits.
end $$;

comment on function public.route2_claim_and_fill(uuid, uuid, integer, jsonb, jsonb) is
  'Atomic Route 2 fill: claim awaiting_confirmation -> filled and insert the '
  'position in one transaction. Returns {outcome: filled|lost|duplicate_position}. '
  'Any other failure raises and commits nothing.';

revoke all on function public.route2_claim_and_fill(uuid, uuid, integer, jsonb, jsonb) from public;
revoke all on function public.route2_claim_and_fill(uuid, uuid, integer, jsonb, jsonb) from anon, authenticated;
grant execute on function public.route2_claim_and_fill(uuid, uuid, integer, jsonb, jsonb) to service_role;
