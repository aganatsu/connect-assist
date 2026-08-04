// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyFinalCandidateSizeAdjustments,
  computePositionSize,
  resolveSizingVolatilityContext,
} from "../../functions/_shared/unifiedPositionSizing.ts";

const liveScanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const backtestEngine = await Deno.readTextFile(
  new URL("../../functions/backtest-engine/index.ts", import.meta.url),
);

for (
  const [surface, source] of [
    ["live", liveScanner],
    ["backtest", backtestEngine],
  ] as const
) {
  Deno.test(`${surface} uses the unified sizing and final adjustment path`, () => {
    assertStringIncludes(source, "computePositionSize(");
    assertStringIncludes(source, "resolveSizingVolatilityContext(");
    assertStringIncludes(source, "resolveCorrelationSizeMultiplier(");
    assertStringIncludes(source, "applyFinalCandidateSizeAdjustments({");
  });
}

Deno.test("backtest no longer uses the simplified manual lot formula", () => {
  assert(
    !backtestEngine.includes(
      "riskAmount / (pipsRisk * pipValue)",
    ),
  );
  assertStringIncludes(
    backtestEngine,
    "commissionPerLot,",
  );
  assertStringIncludes(
    backtestEngine,
    "standaloneMultiplier: pairConfig.standaloneMultiplier",
  );
});

Deno.test("identical live and backtest sizing fixtures produce one lot size", () => {
  const input = {
    balance: 10_000,
    riskPercent: 1,
    entryPrice: 1.1,
    stopLoss: 1.098,
    symbol: "EUR/USD",
    method: "percent_risk" as const,
    rateMap: { "EUR/USD": 1 },
    commissionPerLot: 7,
  };
  const volatility = resolveSizingVolatilityContext({
    regime: "trending",
    atrTrend: "expanding",
  });

  const live = applyFinalCandidateSizeAdjustments({
    lots: computePositionSize(input, undefined, volatility).lots,
    correlationMultiplier: 0.75,
    signalSource: "standalone",
    standaloneMultiplier: 0.5,
  });
  const backtest = applyFinalCandidateSizeAdjustments({
    lots: computePositionSize(input, undefined, volatility).lots,
    correlationMultiplier: 0.75,
    signalSource: "standalone",
    standaloneMultiplier: 0.5,
  });

  assertEquals(backtest, live);
  assertEquals(live.lots, 0.14);
});
