import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migrationUrl = new URL(
  "../../migrations/20260728160000_add_atomic_pending_fill_authority.sql",
  import.meta.url,
);

Deno.test("atomic pending fill migration locks and rechecks execution state", async () => {
  const sql = await Deno.readTextFile(migrationUrl.pathname);
  assertStringIncludes(sql, "FOR UPDATE");
  assertStringIncludes(sql, "v_account.kill_switch_active");
  assertStringIncludes(sql, "NOT v_account.is_running");
  assertStringIncludes(sql, "v_account.is_paused");
});

Deno.test("atomic pending fill migration prevents duplicate source-order positions", async () => {
  const sql = await Deno.readTextFile(migrationUrl.pathname);
  assertStringIncludes(sql, "idx_paper_positions_pending_source");
  assertStringIncludes(sql, "source_pending_order_id");
  assertStringIncludes(sql, "WHEN unique_violation");
  assertStringIncludes(sql, "v_same_direction_count");
  assertStringIncludes(sql, "p_max_open_positions");
});

Deno.test("atomic pending fill migration commits position and order resolution together", async () => {
  const sql = await Deno.readTextFile(migrationUrl.pathname);
  assertStringIncludes(sql, "INSERT INTO public.paper_positions");
  assertStringIncludes(sql, "UPDATE public.pending_orders");
  assertStringIncludes(sql, "final_authorization = p_authorization");
});
