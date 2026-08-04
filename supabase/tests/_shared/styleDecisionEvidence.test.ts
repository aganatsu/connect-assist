import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { generateInstrumentGamePlan } from "../../functions/_shared/gamePlan.ts";
import {
  bindTimeframeCandles,
  buildTimeframeCandleMap,
  resolveTimeframeAuthority,
} from "../../functions/_shared/timeframeAuthority.ts";
import { buildStyleDecisionEvidence } from "../../functions/_shared/styleDecisionEvidence.ts";
import { STYLE_TIMEFRAME_ROLES } from "../../functions/_shared/stylePolicy.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

function candles(
  count: number,
  step: number,
  intervalMinutes: number,
): Candle[] {
  let price = 1;
  return Array.from({ length: count }, (_, index) => {
    const open = price;
    const close = open + step;
    price = close;
    return {
      datetime: new Date(
        Date.UTC(2026, 0, 1) + index * intervalMinutes * 60_000,
      ).toISOString(),
      open,
      high: Math.max(open, close) + Math.abs(step),
      low: Math.min(open, close) - Math.abs(step),
      close,
      volume: 100,
    };
  });
}

Deno.test("one Scalper evidence snapshot labels and binds 1H/15m/5m", () => {
  const roles = STYLE_TIMEFRAME_ROLES.scalper;
  const authority = resolveTimeframeAuthority({
    style: "scalper",
    timeframes: {
      roles,
      runtimeEntry: "5m",
      runtimeHTF: "1h",
    },
  });
  const bound = bindTimeframeCandles(
    authority,
    buildTimeframeCandleMap([
      { timeframe: "1h", candles: candles(40, 0.01, 60) },
      { timeframe: "15m", candles: candles(50, 0.004, 15) },
      { timeframe: "5m", candles: candles(60, 0.002, 5) },
    ]),
  );
  const evidence = buildStyleDecisionEvidence(authority, bound);

  assertEquals(evidence.labels, {
    bias: "1H",
    structure: "15m",
    setup: "5m",
    confirmation: "5m",
    refinement: "1m",
  });
  assertEquals(evidence.layers.bias.candleCount, 40);
  assertEquals(evidence.layers.structure.candleCount, 50);
  assertEquals(evidence.layers.setup.candleCount, 60);
  assertStringIncludes(evidence.simpleDirection?.reason || "", "[scalper]");
});

Deno.test("decision evidence exposes style-aware bias and structure regimes", () => {
  const roles = STYLE_TIMEFRAME_ROLES.swing_trader;
  const authority = resolveTimeframeAuthority({
    style: "swing_trader",
    timeframes: {
      roles,
      runtimeEntry: "1h",
      runtimeHTF: "1week",
    },
  });
  const bound = bindTimeframeCandles(
    authority,
    buildTimeframeCandleMap([
      { timeframe: "1w", candles: candles(30, 0.02, 10_080) },
      { timeframe: "1d", candles: candles(60, 0.01, 1_440) },
      { timeframe: "4h", candles: candles(80, 0.005, 240) },
    ]),
  );
  const evidence = buildStyleDecisionEvidence(authority, bound);

  assertEquals(evidence.biasRegime?.label, "Weekly");
  assertEquals(evidence.structureRegime?.label, "Daily");
  assertEquals(evidence.roles.setup, "4h");
});

Deno.test("Gameplan consumes the snapshot's trends and bias regime", () => {
  const roles = STYLE_TIMEFRAME_ROLES.scalper;
  const authority = resolveTimeframeAuthority({
    style: "scalper",
    timeframes: {
      roles,
      runtimeEntry: "5m",
      runtimeHTF: "1h",
    },
  });
  const oneHour = candles(40, 0.01, 60);
  const fifteenMinute = candles(50, 0.004, 15);
  const fiveMinute = candles(60, 0.002, 5);
  const evidence = buildStyleDecisionEvidence(
    authority,
    bindTimeframeCandles(
      authority,
      buildTimeframeCandleMap([
        { timeframe: "1h", candles: oneHour },
        { timeframe: "15m", candles: fifteenMinute },
        { timeframe: "5m", candles: fiveMinute },
      ]),
    ),
  );
  evidence.layers.bias.trend = "bullish";
  evidence.layers.structure.trend = "bearish";
  evidence.biasRegime = {
    role: "bias",
    timeframe: "1h",
    label: "1H",
    regime: "style_regime",
    confidence: 0.8,
    directionalBias: "bullish",
  };

  const plan = generateInstrumentGamePlan(
    "EUR/USD",
    candles(60, -0.01, 1_440),
    candles(60, 0.01, 240),
    fiveMinute,
    oneHour,
    "London",
    { decisionEvidence: evidence },
  );

  assertEquals(plan.htfTrend, "bullish");
  assertEquals(plan.h4Trend, "bearish");
  assertEquals(plan.regime, "style_regime");
  assertEquals(plan.decisionEvidence?.version, "style-decision-evidence.v1");
});
