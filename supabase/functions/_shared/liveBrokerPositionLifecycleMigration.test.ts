import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const sql = await Deno.readTextFile(new URL(
  "../../migrations/20260804030000_finalize_live_broker_position_lifecycle.sql",
  import.meta.url,
));

Deno.test("live positions begin non-open and are finalized from the durable ledger", () => {
  assertStringIncludes(sql, "CREATE TRIGGER initialize_live_broker_position");
  assertStringIncludes(sql, "NEW.position_status := $s$pending$s$");
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.finalize_live_broker_position");
  assertStringIncludes(sql, "status = $s$succeeded$s$");
  assertStringIncludes(sql, "status IN ($s$attempting$s$, $s$uncertain$s$)");
  assertStringIncludes(sql, "position_status = $s$open$s$");
  assertStringIncludes(sql, "broker_execution_state = v_state");
  assertStringIncludes(sql, "broker_close_state IN");
});

Deno.test("only service role can finalize live broker position state", () => {
  assertStringIncludes(sql, "REVOKE ALL ON FUNCTION public.finalize_live_broker_position");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION public.finalize_live_broker_position");
});
