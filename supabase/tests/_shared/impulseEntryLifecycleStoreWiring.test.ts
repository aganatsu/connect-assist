import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, root));

Deno.test("zone confirmation observes candidate failure before legacy cancellation", async () => {
  const scanner = await read("supabase/functions/zone-confirmation-scanner/index.ts");
  assertStringIncludes(scanner, "observeImpulseEntryPrice(");
  assertStringIncludes(scanner, "impulse_entry_lifecycle_id");
  const store = await read("supabase/functions/_shared/impulseEntryLifecycleStore.ts");
  assertStringIncludes(store, "advanceTradeLifecycle");
  assertStringIncludes(store, "impulse_invalidated");
});
