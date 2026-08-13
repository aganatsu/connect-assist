import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("pending lifecycle identity survives every paper trade close writer", () => {
  const files = [
    "supabase/functions/_shared/propFirmGate.ts",
    "supabase/functions/_shared/scannerManagement.ts",
    "supabase/functions/paper-trading/index.ts",
    "supabase/functions/bot-scanner/index.ts",
  ];
  const source = files.map((file) => Deno.readTextFileSync(file)).join("\n");
  const historyWrites = source.match(/from\("paper_trade_history"\)\.insert/g) || [];
  const identityWrites = source.match(/source_pending_order_id:/g) || [];
  assertEquals(historyWrites.length, 7);
  assertEquals(identityWrites.length, historyWrites.length);
});

Deno.test("pending lifecycle outcome migration adds an indexed history link", () => {
  const migration = Deno.readTextFileSync(
    "supabase/migrations/20260813000000_preserve_pending_lifecycle_trade_outcomes.sql",
  );
  assert(migration.includes("ADD COLUMN IF NOT EXISTS source_pending_order_id UUID"));
  assert(migration.includes("REFERENCES public.pending_orders(id) ON DELETE SET NULL"));
  assert(migration.includes("idx_paper_trade_history_pending_source"));
});
