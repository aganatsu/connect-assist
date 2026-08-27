import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const backtest = await Deno.readTextFile(
  new URL("../../functions/backtest-engine/index.ts", import.meta.url),
);
const exitParity = await Deno.readTextFile(
  new URL("../../functions/_shared/exitParity.ts", import.meta.url),
);

Deno.test("backtest and shared partial exits apply round-trip commission once", () => {
  assertStringIncludes(backtest, "calculateRoundTripTradingCosts({");
  assertStringIncludes(exitParity, "calculateRoundTripTradingCosts({");
  assert(
    !backtest.includes("commissionPerLot * 2"),
    "backtest input is already round-trip and must not be doubled",
  );
  assert(
    !exitParity.includes("commissionPerLot ?? 0, 0) * 2"),
    "partial-close input is already round-trip and must not be doubled",
  );
});
