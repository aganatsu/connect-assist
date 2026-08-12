import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
const bot = await Deno.readTextFile(new URL("../../functions/bot-scanner/index.ts", import.meta.url));
const fast = await Deno.readTextFile(new URL("../../functions/zone-confirmation-scanner/index.ts", import.meta.url));
for (const [name, source] of [["bot", bot], ["fast", fast]] as const) {
  Deno.test(`${name} scanner sizes immediately before atomic pending fill`, () => {
    const sizeAt = source.indexOf("calculateFinalPendingSize({");
    const fillAt = source.indexOf('rpc("finalize_pending_order_fill"', sizeAt);
    assert(sizeAt > 0 && fillAt > sizeAt);
    assert(source.slice(sizeAt, fillAt).includes("size: finalPendingSize"));
    assert(source.slice(sizeAt, fillAt).includes("pending.size = finalPendingSize"));
    assert(source.slice(sizeAt, fillAt).includes("propFirmSizeMultiplier"));
    assert(source.slice(sizeAt, fillAt).includes("signalSource"));
  });
}

Deno.test("fast scanner loads cached FX conversion and live commission", () => {
  const sizeAt = fast.indexOf("calculateFinalPendingSize({");
  const block = fast.slice(sizeAt, sizeAt + 1400);
  assert(block.includes("loadCachedSizingRateMap(supabase)"));
  assert(block.includes("loadAverageRoundTripCommission("));
});
