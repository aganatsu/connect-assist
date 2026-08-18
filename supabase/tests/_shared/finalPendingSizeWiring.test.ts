import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
const fast = await Deno.readTextFile(
  new URL(
    "../../functions/zone-confirmation-scanner/index.ts",
    import.meta.url,
  ),
);

Deno.test("the sole pending scanner sizes immediately before atomic fill", () => {
  const sizeAt = fast.indexOf("calculateFinalPendingSize({");
  const fillAt = fast.indexOf('rpc("finalize_pending_order_fill"', sizeAt);
  assert(sizeAt > 0 && fillAt > sizeAt);
  assert(fast.slice(sizeAt, fillAt).includes("size: finalPendingSize"));
  assert(
    fast.slice(sizeAt, fillAt).includes("pending.size = finalPendingSize"),
  );
  assert(fast.slice(sizeAt, fillAt).includes("propFirmSizeMultiplier"));
  assert(fast.slice(sizeAt, fillAt).includes("signalSource"));
});

Deno.test("fast scanner loads cached FX conversion and live commission", () => {
  const sizeAt = fast.indexOf("calculateFinalPendingSize({");
  const block = fast.slice(sizeAt, sizeAt + 1400);
  assert(block.includes("loadCachedSizingRateMap(supabase)"));
  assert(block.includes("loadAverageRoundTripCommission("));
});
