import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migrationUrl = new URL(
  "../../migrations/20260728190000_add_broker_execution_ledger.sql",
  import.meta.url,
);

Deno.test("broker execution ledger enforces one action per position and connection", async () => {
  const sql = await Deno.readTextFile(migrationUrl.pathname);
  assertStringIncludes(sql, "broker_execution_ledger_unique");
  assertStringIncludes(
    sql,
    "UNIQUE (user_id, bot_id, position_id, broker_connection_id, action)",
  );
  assertStringIncludes(sql, "ON CONFLICT ON CONSTRAINT");
});

Deno.test("broker execution claims do not automatically retry existing states", async () => {
  const sql = await Deno.readTextFile(migrationUrl.pathname);
  assertStringIncludes(
    sql,
    "'Existing execution state must be reconciled before another broker request'",
  );
  assertStringIncludes(sql, "already_succeeded");
  assertStringIncludes(sql, "already_claimed");
});

Deno.test("broker execution ledger is service-role write only", async () => {
  const sql = await Deno.readTextFile(migrationUrl.pathname);
  assertStringIncludes(sql, "ENABLE ROW LEVEL SECURITY");
  assertStringIncludes(sql, "GRANT SELECT ON TABLE");
  assertStringIncludes(sql, "TO service_role");
  assertStringIncludes(sql, "SECURITY DEFINER");
});
