import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mapNestedToFlat, RUNTIME_DEFAULTS } from "./configMapper.ts";
import {
  applyTradingStyleProfile,
  resolveTradingStyle,
  TRADING_STYLE_PROFILES,
} from "./tradingStyleConfig.ts";

Deno.test("trading style profiles retain validated execution values", () => {
  assertEquals(TRADING_STYLE_PROFILES.scalper.tpRatio, 2);
  assertEquals(TRADING_STYLE_PROFILES.scalper.riskPerTrade, 0.5);
  assertEquals(TRADING_STYLE_PROFILES.scalper.impulseSlCapMultiplier, 1.5);
  assertEquals(TRADING_STYLE_PROFILES.scalper.gamePlanValidityMinutes, 120);
  assertEquals(TRADING_STYLE_PROFILES.day_trader.minConfluence, 55);
  assertEquals(TRADING_STYLE_PROFILES.day_trader.gamePlanValidityMinutes, 240);
  assertEquals(TRADING_STYLE_PROFILES.day_trader.breakEvenEnabled, true);
  assertEquals(TRADING_STYLE_PROFILES.swing_trader.tpRatio, 3);
  assertEquals(TRADING_STYLE_PROFILES.swing_trader.minConfluence, 40);
  assertEquals(TRADING_STYLE_PROFILES.swing_trader.riskPerTrade, 1.5);
  assertEquals(TRADING_STYLE_PROFILES.swing_trader.impulseSlCapMultiplier, 6);
  assertEquals(
    TRADING_STYLE_PROFILES.swing_trader.gamePlanValidityMinutes,
    1440,
  );
});

Deno.test("resolveTradingStyle prefers request, then config, then day trader", () => {
  const swingConfig = mapNestedToFlat({
    tradingStyle: { mode: "swing_trader" },
  });
  assertEquals(resolveTradingStyle("scalper", swingConfig), "scalper");
  assertEquals(resolveTradingStyle(undefined, swingConfig), "swing_trader");
  assertEquals(resolveTradingStyle("invalid", swingConfig), "swing_trader");
  assertEquals(resolveTradingStyle(undefined), "day_trader");
});

Deno.test("style application preserves user-tunable protected values", () => {
  const mapped = mapNestedToFlat({
    exit: {
      tpRRRatio: 2.6,
      breakEven: false,
      trailingStopPips: 22,
      timeExitHours: 12,
    },
    strategy: { confluenceThreshold: 68 },
  });
  const result = applyTradingStyleProfile(mapped, "day_trader");

  assertEquals(result.config.tpRatio, 2.6);
  assertEquals(result.config.minConfluence, 68);
  assertEquals(result.config.breakEvenEnabled, false);
  assertEquals(result.config.trailingStopPips, 22);
  assertEquals(result.config.maxHoldHours, 12);
  assertEquals(result.config.entryTimeframe, "15min");
  assertNotEquals(result.preserved.length, 0);
});

Deno.test("style application always applies non-protected execution fields", () => {
  const mapped = mapNestedToFlat({
    entry: { scanIntervalMinutes: 30, slBufferPips: 9 },
    risk: { riskPerTrade: 2 },
  });
  const result = applyTradingStyleProfile(mapped, "scalper");

  assertEquals(result.config.scanIntervalMinutes, 5);
  assertEquals(result.config.entryTimeframe, "5m");
  assertEquals(result.config.htfTimeframe, "1h");
  assertEquals(result.config.slBufferPips, 1);
  assertEquals(result.config.riskPerTrade, 0.5);
  assertEquals(result.config.maxHoldEnabled, true);
});

Deno.test("day trader does not silently enable partial TP for existing configs", () => {
  const result = applyTradingStyleProfile(mapNestedToFlat({}), "day_trader");
  assertEquals(RUNTIME_DEFAULTS.partialTPEnabled, false);
  assertEquals(result.config.partialTPEnabled, false);
});

Deno.test("identical canonical input produces identical live and backtest style config", () => {
  const raw = {
    tradingStyle: { mode: "swing_trader" },
    strategy: { confluenceThreshold: 62 },
    exit: { tpRRRatio: 2.8, breakEven: true },
  };
  const live = applyTradingStyleProfile(mapNestedToFlat(raw));
  const backtest = applyTradingStyleProfile(
    mapNestedToFlat(raw),
    raw.tradingStyle.mode,
  );
  assertEquals(backtest, live);
});

Deno.test("live and backtest engines both use the shared runtime-config authority", async () => {
  const [scanner, backtest, analysis] = await Promise.all([
    Deno.readTextFile("./supabase/functions/bot-scanner/index.ts"),
    Deno.readTextFile("./supabase/functions/backtest-engine/index.ts"),
    Deno.readTextFile("./supabase/functions/_shared/smcAnalysis.ts"),
  ]);

  assertEquals(
    scanner.includes('from "../_shared/runtimeConfigResolver.ts"'),
    true,
  );
  assertEquals(
    backtest.includes('from "../_shared/runtimeConfigResolver.ts"'),
    true,
  );
  assertEquals(analysis.includes("export const STYLE_OVERRIDES"), false);
  assertEquals(analysis.includes("export const DEFAULTS"), false);
});
