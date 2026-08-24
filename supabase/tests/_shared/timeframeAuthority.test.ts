import {
  assertEquals,
  assertNotStrictEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  bindTimeframeCandles,
  buildTimeframeCandleMap,
  directionTimeframeLabels,
  normalizeAnalysisTimeframe,
  normalizeAnalysisTimeframeOrNull,
  resolveTimeframeAuthority,
  zoneTimeframeLabels,
} from "../../functions/_shared/timeframeAuthority.ts";
import type { ResolvedStylePolicy } from "../../functions/_shared/stylePolicy.ts";

function policy(
  style: ResolvedStylePolicy["style"],
  roles: ResolvedStylePolicy["timeframes"]["roles"],
  runtimeEntry: string,
  runtimeHTF: string,
): Pick<ResolvedStylePolicy, "style" | "timeframes"> {
  return {
    style,
    timeframes: { roles, runtimeEntry, runtimeHTF },
  };
}

Deno.test("timeframe authority normalizes policy roles without a duplicate style map", () => {
  const authority = resolveTimeframeAuthority(policy(
    "scalper",
    {
      bias: "1h",
      structure: "15min",
      setup: "5min",
      confirmation: "5min",
      refinement: "1min",
    },
    "5m",
    "1h",
  ));

  assertEquals(authority.roles, {
    bias: "1h",
    structure: "15m",
    setup: "5m",
    confirmation: "5m",
    refinement: "1m",
  });
  assertEquals(authority.direction, {
    bias: "1h",
    structure: "15m",
    confirmation: "5m",
  });
  assertEquals(directionTimeframeLabels(authority), {
    biasTFLabel: "1H",
    structureTFLabel: "15m",
    confirmTFLabel: "5m",
  });
  assertEquals(zoneTimeframeLabels(authority), {
    top: "1H",
    mid: "15m",
    low: "5m",
  });
});

Deno.test("timeframe authority preserves day and swing structural ladders", () => {
  const day = resolveTimeframeAuthority(policy(
    "day_trader",
    {
      bias: "1day",
      structure: "4h",
      setup: "1h",
      confirmation: "15min",
      refinement: "5min",
    },
    "15min",
    "1day",
  ));
  const swing = resolveTimeframeAuthority(policy(
    "swing_trader",
    {
      bias: "1week",
      structure: "1day",
      setup: "4h",
      confirmation: "1h",
      refinement: "15min",
    },
    "1h",
    "1week",
  ));

  assertEquals(directionTimeframeLabels(day), {
    biasTFLabel: "Daily",
    structureTFLabel: "4H",
    confirmTFLabel: "1H",
  });
  assertEquals(zoneTimeframeLabels(swing), {
    top: "W",
    mid: "D",
    low: "4H",
  });
});

Deno.test("candle binding returns the exact policy role arrays", () => {
  const authority = resolveTimeframeAuthority(policy(
    "scalper",
    {
      bias: "1h",
      structure: "15min",
      setup: "5min",
      confirmation: "5min",
      refinement: "1min",
    },
    "5m",
    "1h",
  ));
  const oneHour = [{ tf: "1h" }];
  const fifteenMinute = [{ tf: "15m" }];
  const fiveMinute = [{ tf: "5m" }];
  const map = buildTimeframeCandleMap([
    { timeframe: "1H", candles: oneHour },
    { timeframe: "15min", candles: fifteenMinute },
    { timeframe: "5m", candles: fiveMinute },
  ]);
  const bound = bindTimeframeCandles(authority, map);

  assertEquals(bound.bias, oneHour);
  assertEquals(bound.structure, fifteenMinute);
  assertEquals(bound.setup, fiveMinute);
  assertNotStrictEquals(bound.structure, bound.bias);
});

Deno.test("normalization accepts provider and display aliases", () => {
  assertEquals(normalizeAnalysisTimeframe("1day"), "1d");
  assertEquals(normalizeAnalysisTimeframe("Weekly"), "1w");
  assertEquals(normalizeAnalysisTimeframe("15min"), "15m");
  assertEquals(normalizeAnalysisTimeframe("1M"), "1M");
  assertEquals(normalizeAnalysisTimeframe("1m"), "1m");
  assertEquals(normalizeAnalysisTimeframe("unknown", "4h"), "4h");
  assertEquals(normalizeAnalysisTimeframeOrNull("15min"), "15m");
  assertEquals(normalizeAnalysisTimeframeOrNull("unknown"), null);
});
