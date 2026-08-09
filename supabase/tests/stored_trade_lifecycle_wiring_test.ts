import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
const store = await Deno.readTextFile(new URL("../functions/_shared/impulseEntryLifecycleStore.ts", import.meta.url));
const scanner = await Deno.readTextFile(new URL("../functions/zone-confirmation-scanner/index.ts", import.meta.url));
Deno.test("live zone confirmation persists shared lifecycle authority events", () => {
  assertStringIncludes(store, "advanceTradeLifecycle({ lifecycle, candle, completedCandles })");
  assertStringIncludes(scanner, "advanceStoredTradeLifecycle(");
  if (scanner.includes("observeImpulseEntryPrice(")) throw new Error("legacy price transition path remains");
  if (scanner.includes("observeImpulseConfirmationLock(")) throw new Error("legacy confirmation transition path remains");
});
