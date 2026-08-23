import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migrationUrl = new URL(
  "../../migrations/20260823143000_add_broker_first_close_context.sql",
  import.meta.url,
);

Deno.test("broker-first close context returns one locked service-only snapshot", async () => {
  const sql = await Deno.readTextFile(migrationUrl.pathname);

  assertStringIncludes(
    sql,
    "CREATE OR REPLACE FUNCTION public.load_paper_position_close_context",
  );
  assertStringIncludes(sql, "FROM public.paper_positions position");
  assertStringIncludes(sql, "FROM public.paper_accounts account");
  assertEquals(sql.split("FOR UPDATE").length - 1, 2);
  assertStringIncludes(
    sql,
    "FROM public.paper_position_broker_close_requirements(",
  );
  for (
    const field of [
      "position_status",
      "broker_execution_state",
      "execution_mode",
      "required_connection_ids",
      "missing_close_connection_ids",
      "unknown_identity_connection_ids",
      "broker_position_ids",
    ]
  ) {
    assertStringIncludes(sql, `'${field}'`);
  }
  assertStringIncludes(
    sql.replaceAll(/\s+/g, " "),
    "REVOKE ALL ON FUNCTION public.load_paper_position_close_context( UUID, TEXT, TEXT ) FROM PUBLIC, authenticated, anon;",
  );
  assertStringIncludes(
    sql.replaceAll(/\s+/g, " "),
    "GRANT EXECUTE ON FUNCTION public.load_paper_position_close_context( UUID, TEXT, TEXT ) TO service_role;",
  );
});

Deno.test("broker-first close context migration stays within Phase 2 scope", async () => {
  const sql = await Deno.readTextFile(migrationUrl.pathname);
  assert(!sql.includes("CREATE TRIGGER"));
  assert(!sql.includes("ALTER TABLE"));
  assert(
    !/REVOKE\s+(?:ALL|INSERT|UPDATE|DELETE)[^;]*\sON\s+(?:TABLE\s+)?public\./i
      .test(sql),
    "Phase 2 must not change table privileges",
  );
  assertEquals(sql.includes("finalize_paper_position_close"), false);
});
