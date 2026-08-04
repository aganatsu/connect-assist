import {
  assert,
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveEffectiveRuntimeConfig,
  resolveEffectiveTradingStyle,
} from "../../functions/_shared/runtimeConfigResolver.ts";

Deno.test("canonical resolver maps fields before applying the selected style", () => {
  const result = resolveEffectiveRuntimeConfig({
    tradingStyle: { mode: "scalper" },
    strategy: { confluenceThreshold: 68 },
    exit: { trailingStopPips: 22 },
    entry: { scanIntervalMinutes: 30 },
  });

  assertEquals(result.style, "scalper");
  assertEquals(result.mappedConfig.scanIntervalMinutes, 30);
  assertEquals(result.config.scanIntervalMinutes, 5);
  assertEquals(result.config.entryTimeframe, "5m");
  assertEquals(result.config.minConfluence, 68);
  assertEquals(result.config.trailingStopPips, 22);
});

Deno.test("explicit runtime style and stored style use identical precedence everywhere", () => {
  const raw = {
    tradingStyle: { mode: "swing_trader" },
    strategy: { confluenceThreshold: 61 },
  };

  const stored = resolveEffectiveRuntimeConfig(raw);
  const explicitSame = resolveEffectiveRuntimeConfig(raw, "swing_trader");
  const explicitOverride = resolveEffectiveRuntimeConfig(raw, "scalper");

  assertEquals(stored, explicitSame);
  assertEquals(stored.style, "swing_trader");
  assertEquals(explicitOverride.style, "scalper");
  assertEquals(resolveEffectiveTradingStyle(raw, "scalper"), "scalper");
});

Deno.test("canonical resolver keeps mapped and effective snapshots separate", () => {
  const result = resolveEffectiveRuntimeConfig({
    tradingStyle: { mode: "scalper" },
  });

  assertNotEquals(result.mappedConfig, result.config);
  assertEquals(result.mappedConfig.entryTimeframe, "15min");
  assertEquals(result.config.entryTimeframe, "5m");
});

Deno.test("runtime surfaces resolve before consuming configuration", async () => {
  const [scanner, fastScanner, manualGamePlan, backtest] = await Promise.all([
    Deno.readTextFile("./supabase/functions/bot-scanner/index.ts"),
    Deno.readTextFile(
      "./supabase/functions/zone-confirmation-scanner/index.ts",
    ),
    Deno.readTextFile("./supabase/functions/game-plan-refresh/index.ts"),
    Deno.readTextFile("./supabase/functions/backtest-engine/index.ts"),
  ]);

  for (
    const [name, source] of [
      ["automatic scanner", scanner],
      ["fast confirmation scanner", fastScanner],
      ["manual Gameplan refresh", manualGamePlan],
    ] as const
  ) {
    assert(
      source.includes("loadEffectiveRuntimeConfig"),
      `${name} bypasses the fail-closed runtime-config store`,
    );
  }
  assert(
    backtest.includes("resolveEffectiveRuntimeConfig"),
    "backtest bypasses the canonical runtime-config resolver",
  );

  assert(
    scanner.indexOf("const config = styleResolution.config") <
      scanner.indexOf("const intervalMinutes = config.scanIntervalMinutes"),
    "automatic scanner must resolve style before the scan-interval gate",
  );
  assert(
    scanner.indexOf("const config = styleResolution.config") <
      scanner.indexOf("managementActions = await manageOpenPositions("),
    "position management must receive the effective configuration",
  );
});
