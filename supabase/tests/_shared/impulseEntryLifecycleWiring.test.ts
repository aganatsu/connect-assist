import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, root));

Deno.test("impulse entry lifecycle is frozen with every setup", async () => {
  const [scanner, context, mapper] = await Promise.all([
    read("supabase/functions/bot-scanner/index.ts"),
    read("supabase/functions/_shared/frozenCrossTimeframeContext.ts"),
    read("supabase/functions/_shared/configMapper.ts"),
  ]);
  assertStringIncludes(scanner, "impulseEntryLifecycleMode:");
  assertStringIncludes(scanner, "confirmationMethod: pairConfig.confirmationMethod");
  assertStringIncludes(context, "buildImpulseEntryLifecycle({");
  assertStringIncludes(context, "initialCandidateId:");
  assertStringIncludes(mapper, 'impulseEntryLifecycleMode: "observe"');
});

Deno.test("migration persists one lifecycle across all execution stages", async () => {
  const sql = await read(
    "supabase/migrations/20260805210000_add_impulse_owned_entry_lifecycle.sql",
  );
  for (const table of ["staged_setups", "pending_orders", "paper_positions"]) {
    assertStringIncludes(sql, `ALTER TABLE public.${table}`);
  }
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.advance_impulse_entry_lifecycle");
  assertStringIncludes(sql, "p_expected_revision INTEGER");
  assertStringIncludes(sql, "FOR UPDATE");
  assertStringIncludes(sql, "stale lifecycle revision");
  assertStringIncludes(sql, "impulse_entry_lifecycle_transitions");
  assert(!sql.includes("GRANT EXECUTE ON FUNCTION public.advance_impulse_entry_lifecycle") ||
    sql.includes("TO service_role"));
});
