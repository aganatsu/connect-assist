import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { calculateFinalPendingSize } from "../../functions/_shared/finalPendingSize.ts";
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
  const sizingBlock = fast.slice(sizeAt, fillAt);
  assert(sizingBlock.includes("if (finalPendingSizing.rejected)"));
  assert(sizingBlock.indexOf("if (finalPendingSizing.rejected)") < sizingBlock.indexOf('from("pending_orders").update'));
  assert(fast.slice(sizeAt, fillAt).includes("size: finalPendingSize"));
  assert(fast.slice(sizeAt, fillAt).includes("pending.size = finalPendingSize"));
  assert(fast.slice(sizeAt, fillAt).includes("propFirmSizeMultiplier"));
  assert(fast.slice(sizeAt, fillAt).includes("signalSource"));
});

Deno.test("fast scanner loads cached FX conversion and resolves approved-connection commission", () => {
  const sizeAt = fast.indexOf("calculateFinalPendingSize({");
  const rateMapAt = fast.indexOf(
    "const sizingRateMap = await loadCachedSizingRateMap(supabase)",
  );
  const block = fast.slice(sizeAt, sizeAt + 1400);
  assert(rateMapAt > 0 && rateMapAt < sizeAt);
  assert(block.includes("rateMap: sizingRateMap"));
  assert(fast.includes("averageRoundTripCommission(approvedBrokerConnections)"));
  assert(block.includes("commissionPerLot: executionCommissionPerLot"));
});

Deno.test("pending final sizing returns a rejection instead of reviving zero lots", () => {
  const result = calculateFinalPendingSize({
    balance: 10_000,
    riskPercent: 1,
    fillPrice: 1.1,
    stopLoss: 1.1,
    symbol: "EUR/USD",
    signalSource: "standalone",
    standaloneMultiplier: 0.5,
  });
  assert(result.rejected);
  assert(result.lots === 0);
});
