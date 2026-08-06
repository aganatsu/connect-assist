import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
const root = new URL("../../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, root));

Deno.test("confirmation lock is shared by runtime and auditable", async () => {
  const [scanner, store, migration] = await Promise.all([
    read("supabase/functions/zone-confirmation-scanner/index.ts"),
    read("supabase/functions/_shared/impulseEntryLifecycleStore.ts"),
    read("supabase/migrations/20260806100000_add_impulse_confirmation_locking.sql"),
  ]);
  assertStringIncludes(scanner, "observeImpulseConfirmationLock(");
  assertStringIncludes(store, "deriveConfirmationTriggerPlan");
  assertStringIncludes(store, 'type: "trigger_revised"');
  assertStringIncludes(store, 'type: "trigger_locked"');
  assertStringIncludes(store, 'type: "confirmation_passed"');
  assertStringIncludes(migration, "trigger_revised");
});
