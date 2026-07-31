import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const sql = await Deno.readTextFile(
  "./supabase/migrations/20260731120000_add_bot_config_integrity_audit.sql",
);

Deno.test("Bot Config audit migration preserves before/after values and hashes", () => {
  for (
    const required of [
      "CREATE TABLE IF NOT EXISTS public.bot_config_change_log",
      "previous_config JSONB",
      "next_config JSONB",
      "previous_hash TEXT",
      "next_hash TEXT",
      "CREATE OR REPLACE FUNCTION public.audit_bot_config_change()",
      "CREATE TRIGGER audit_bot_config_change",
      "AFTER INSERT OR UPDATE OR DELETE",
    ]
  ) {
    assertStringIncludes(sql, required);
  }
});

Deno.test("Bot Config history is private to its owner", () => {
  assertStringIncludes(
    sql,
    "USING (auth.uid() = user_id)",
  );
  assertStringIncludes(
    sql,
    "REVOKE ALL ON public.bot_config_change_log FROM anon",
  );
});
