import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const backtest = await Deno.readTextFile(
  new URL("../../functions/backtest-engine/index.ts", import.meta.url),
);
const page = await Deno.readTextFile(
  new URL("../../../src/pages/Backtest.tsx", import.meta.url),
);

Deno.test("backtest spread input reaches every simulated close path", () => {
  assertStringIncludes(backtest, "resolveEffectiveSpreadPips(");
  assertStringIncludes(backtest, "calculateRoundTripTradingCosts({");
  assertStringIncludes(backtest, "spreadPips: effectiveSpreadPips");
  assertStringIncludes(
    backtest,
    "allTrades, candleMs, peakBalance, effectiveSpreadPips",
  );
  assertStringIncludes(backtest, "spreadCost: tradingCosts.spreadCost");
  assertStringIncludes(backtest, "totalTradingCost: tradingCosts.totalCost");
  assertStringIncludes(backtest, "totalSpreadCost");
  assert(
    !backtest.includes("pnl: rawPnl - comm"),
    "full backtest closes must not omit simulated spread cost",
  );
  assert(
    !backtest.includes("balance += rawPnl - comm"),
    "end-of-test balance must include simulated spread cost",
  );
});

Deno.test("backtest results expose commission and spread separately", () => {
  assertStringIncludes(page, "spreadCost?: number");
  assertStringIncludes(page, "totalSpreadCost?: number");
  assertStringIncludes(page, 'label: "Total Spread Cost"');
});

Deno.test("backtest quote conversion map contains raw rates, not converted multipliers", () => {
  assertStringIncludes(
    backtest,
    "const btRateMap: Record<string, number> = { ...FALLBACK_RATES };",
  );
  assert(
    !backtest.includes("await getQuoteToUSDRate(symbol)"),
    "storing a quote-to-USD result under a raw pair-rate key causes double inversion",
  );
  assert(
    !backtest.includes("priorPartialState?.btRateMap"),
    "a resumed run must not restore a previously double-inverted rate map",
  );
});
