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

Deno.test("live and backtest reject sizing before opening a position", () => {
  const liveSizingAt = liveScanner.indexOf("const finalSizing = applyFinalCandidateSizeAdjustments({");
  const liveRejectAt = liveScanner.indexOf("if (finalSizing.rejected)", liveSizingAt);
  const liveOpenAt = liveScanner.indexOf("const marketEntryPrice = analysis.lastPrice", liveRejectAt);
  assert(liveSizingAt > 0 && liveRejectAt > liveSizingAt && liveOpenAt > liveRejectAt);

  const backtestSizingAt = backtestEngine.indexOf("const finalSizing = applyFinalCandidateSizeAdjustments({");
  const backtestRejectAt = backtestEngine.indexOf("if (finalSizing.rejected)", backtestSizingAt);
  const backtestOpenAt = backtestEngine.indexOf("const posSize = finalSizing.lots", backtestRejectAt);
  assert(backtestSizingAt > 0 && backtestRejectAt > backtestSizingAt && backtestOpenAt > backtestRejectAt);
});

Deno.test("pending and breaker paths cannot restore the 0.01 lot floor", () => {
  const pendingSizingAt = liveScanner.indexOf("const finalLimitSizing = applyFinalCandidateSizeAdjustments({");
  const pendingRejectAt = liveScanner.indexOf("if (finalLimitSizing.rejected)", pendingSizingAt);
  const pendingUseAt = liveScanner.indexOf("const limitSize = finalLimitSizing.lots", pendingRejectAt);
  assert(pendingSizingAt > 0 && pendingRejectAt > pendingSizingAt && pendingUseAt > pendingRejectAt);

  const breakerSizingAt = liveScanner.indexOf("const finalBreakerSizing = applyFinalCandidateSizeAdjustments({");
  const breakerRejectAt = liveScanner.indexOf("if (finalBreakerSizing.rejected)", breakerSizingAt);
  const breakerUseAt = liveScanner.indexOf("const breakerSize = finalBreakerSizing.lots", breakerRejectAt);
  assert(breakerSizingAt > 0 && breakerRejectAt > breakerSizingAt && breakerUseAt > breakerRejectAt);
  assert(!liveScanner.includes("Math.max(breakerSizing.lots * propFirmSizeMultiplier, 0.01)"));
});

Deno.test("Meta broker sizing rejects before volume normalization and broker send", () => {
  const brokerSizingAt = liveScanner.indexOf("const brokerSizingResult = computePositionSize(");
  const brokerRejectAt = liveScanner.indexOf("if (brokerSizingResult.rejected", brokerSizingAt);
  const normalizeAt = liveScanner.indexOf("const normalizedVolume = normalizeBrokerVolumeDown({", brokerRejectAt);
  const brokerSendAt = liveScanner.indexOf("const mt5Body: any = {", normalizeAt);
  assert(
    brokerSizingAt > 0 &&
      brokerRejectAt > brokerSizingAt &&
      normalizeAt > brokerRejectAt &&
      brokerSendAt > normalizeAt,
  );
  assert(!liveScanner.includes("Math.max(brokerSpec.minVolume, Math.min(brokerSpec.maxVolume, brokerVolume))"));
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

  const liveSizing = computePositionSize(input, undefined, volatility);
  const live = applyFinalCandidateSizeAdjustments({
    sizingResult: liveSizing,
    correlationMultiplier: 0.75,
    signalSource: "standalone",
    standaloneMultiplier: 0.5,
  });
  const backtestSizing = computePositionSize(input, undefined, volatility);
  const backtest = applyFinalCandidateSizeAdjustments({
    sizingResult: backtestSizing,
    correlationMultiplier: 0.75,
    signalSource: "standalone",
    standaloneMultiplier: 0.5,
  });

  assertEquals(backtest, live);
  assertEquals(live.lots, 0.13);
});
