import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  averageRoundTripCommission,
  calculateRoundTripCommission,
  calculateRoundTripTradingCosts,
  resolveEffectiveSpreadPips,
  resolveRoundTripCommission,
} from "../../functions/_shared/tradingCosts.ts";

Deno.test("commission mode: auto doubles the detected per-side charge", () => {
  assertEquals(
    resolveRoundTripCommission({
      commission_mode: "auto",
      commission_per_lot: 0,
      detected_commission_per_lot: 2.5,
    }),
    {
      mode: "auto",
      source: "detected_per_side",
      detectedPerSide: 2.5,
      roundTripPerLot: 5,
    },
  );
});

Deno.test("commission mode: none overrides a previously detected charge", () => {
  assertEquals(
    resolveRoundTripCommission({
      commission_mode: "none",
      commission_per_lot: 0,
      detected_commission_per_lot: 2.5,
    }).roundTripPerLot,
    0,
  );
});

Deno.test("commission mode: manual uses the configured round-trip amount", () => {
  assertEquals(
    resolveRoundTripCommission({
      commission_mode: "manual",
      commission_per_lot: 7,
      detected_commission_per_lot: 2.5,
    }).roundTripPerLot,
    7,
  );
});

Deno.test("commission mode: legacy rows preserve the previous fallback behavior", () => {
  assertEquals(
    resolveRoundTripCommission({
      commission_per_lot: 0,
      detected_commission_per_lot: 2.5,
    }).roundTripPerLot,
    5,
  );
  assertEquals(
    resolveRoundTripCommission({
      commission_per_lot: 7,
      detected_commission_per_lot: 2.5,
    }).roundTripPerLot,
    7,
  );
});

Deno.test("average commission uses each connection's explicit mode", () => {
  assertEquals(
    averageRoundTripCommission([
      {
        commission_mode: "auto",
        commission_per_lot: 0,
        detected_commission_per_lot: 2.5,
      },
      {
        commission_mode: "none",
        commission_per_lot: 0,
        detected_commission_per_lot: 9,
      },
      {
        commission_mode: "manual",
        commission_per_lot: 7,
        detected_commission_per_lot: 1,
      },
    ]),
    6,
  );
});

Deno.test("round-trip commission is applied exactly once to closed lots", () => {
  assertEquals(calculateRoundTripCommission(0.5, 7), 3.5);
  assertEquals(calculateRoundTripCommission(2, 5), 10);
  assertEquals(calculateRoundTripCommission(0, 7), 0);
  assertEquals(calculateRoundTripCommission(1, -7), 0);
});

Deno.test("effective spread uses an explicit override or the instrument default", () => {
  assertEquals(resolveEffectiveSpreadPips(2, 1), 2);
  assertEquals(resolveEffectiveSpreadPips(0, 1.5), 1.5);
  assertEquals(resolveEffectiveSpreadPips(undefined, 3), 3);
  assertEquals(resolveEffectiveSpreadPips(-1, Number.NaN), 0);
});

Deno.test("round-trip trading costs charge one full spread plus commission", () => {
  assertEquals(
    calculateRoundTripTradingCosts({
      lots: 0.5,
      spreadPips: 2,
      pipSize: 0.0001,
      lotUnits: 100_000,
      quoteToUSD: 1,
      roundTripCommissionPerLot: 7,
    }),
    {
      spreadCost: 10,
      commission: 3.5,
      totalCost: 13.5,
    },
  );
});

Deno.test("spread cost converts non-USD quote currency and composes across partials", () => {
  const input = {
    spreadPips: 2,
    pipSize: 0.01,
    lotUnits: 100_000,
    quoteToUSD: 1 / 150,
    roundTripCommissionPerLot: 6,
  };
  const partial = calculateRoundTripTradingCosts({ ...input, lots: 0.4 });
  const remainder = calculateRoundTripTradingCosts({ ...input, lots: 0.6 });
  const full = calculateRoundTripTradingCosts({ ...input, lots: 1 });

  assertEquals(partial.spreadCost + remainder.spreadCost, full.spreadCost);
  assertEquals(partial.commission + remainder.commission, full.commission);
  assertEquals(partial.totalCost + remainder.totalCost, full.totalCost);
});
