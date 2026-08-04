import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  checkExecutionMode,
  checkMarketFreshness,
  checkPortfolioHeatAtExecution,
  checkSessionAtExecution,
} from "../../functions/_shared/finalRuntimeGates.ts";

Deno.test("execution mode must be explicitly paper or live", () => {
  assertEquals(checkExecutionMode("paper").passed, true);
  assertEquals(checkExecutionMode("live").passed, true);
  assertEquals(checkExecutionMode(null).passed, false);
  assertEquals(checkExecutionMode("unknown").passed, false);
});

Deno.test("portfolio heat converts quote currency risk into account currency", () => {
  const result = checkPortfolioHeatAtExecution({
    balance: 10_000,
    maximumPercent: 2,
    riskPerTradeFallback: 1,
    rateMap: { "USD/CAD": 1.25 },
    openPositions: [{
      symbol: "GBP/CAD",
      direction: "short",
      entry_price: 1.88,
      stop_loss: 1.89,
      size: 0.25,
    }],
  });
  assertEquals(result.passed, false);
  assertStringIncludes(result.reason, "2.0%");
});

Deno.test("session gate blocks disabled sessions", () => {
  const result = checkSessionAtExecution({
    symbol: "GBP/CAD",
    enabledSessions: ["london"],
    enabledDays: [1, 2, 3, 4, 5],
    killZoneOnly: false,
    now: new Date("2026-07-28T22:00:00.000Z"),
  });
  assertEquals(result.passed, false);
  assertStringIncludes(result.reason, "not enabled");
});

Deno.test("freshness gate blocks stale candles", () => {
  const result = checkMarketFreshness({
    currentPrice: 1.88,
    interval: "5m",
    now: new Date("2026-07-28T17:00:00.000Z"),
    candles: [{
      datetime: "2026-07-28T16:30:00.000Z",
      open: 1.87,
      high: 1.89,
      low: 1.86,
      close: 1.88,
    }],
  });
  assertEquals(result.passed, false);
  assertStringIncludes(result.reason, "stale");
});
