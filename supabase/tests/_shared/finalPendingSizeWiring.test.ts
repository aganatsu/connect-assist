import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
const bot = await Deno.readTextFile(new URL("../../functions/bot-scanner/index.ts", import.meta.url));
const fast = await Deno.readTextFile(new URL("../../functions/zone-confirmation-scanner/index.ts", import.meta.url));
for (const [name, source] of [["bot", bot], ["fast", fast]] as const) {
  Deno.test(`${name} scanner sizes immediately before atomic pending fill`, () => {
    const sizeAt = source.indexOf("calculateFinalPendingSize({");
    const fillAt = source.indexOf('rpc("finalize_pending_order_fill"', sizeAt);
    assert(sizeAt > 0 && fillAt > sizeAt);
    assert(source.slice(sizeAt, fillAt).includes("size: finalPendingSize"));
  });
}
