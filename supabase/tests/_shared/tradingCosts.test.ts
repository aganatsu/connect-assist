import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  averageRoundTripCommission,
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
