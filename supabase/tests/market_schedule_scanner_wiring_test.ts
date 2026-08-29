import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scanner = await Deno.readTextFile(
  "supabase/functions/bot-scanner/index.ts",
);
const confirmationScanner = await Deno.readTextFile(
  "supabase/functions/zone-confirmation-scanner/index.ts",
);
const paperTrading = await Deno.readTextFile(
  "supabase/functions/paper-trading/index.ts",
);
const gamePlanRefresh = await Deno.readTextFile(
  "supabase/functions/game-plan-refresh/index.ts",
);
const finalRuntimeGates = await Deno.readTextFile(
  "supabase/functions/_shared/finalRuntimeGates.ts",
);
const candleSource = await Deno.readTextFile(
  "supabase/functions/_shared/candleSource.ts",
);
const outcomeTracker = await Deno.readTextFile(
  "supabase/functions/outcome-tracker/index.ts",
);

Deno.test("discovery scanning consumes the shared market schedule before rotation and candle work", () => {
  assertStringIncludes(scanner, "marketScheduleScope.eligibleSymbols");
  assertStringIncludes(scanner, "marketScheduleScope.excludedSymbols");
  assertStringIncludes(scanner, "marketSchedule: {");
  assertStringIncludes(scanner, "No eligible FX, commodity, or index instruments are open");
  assertStringIncludes(scanner, "marketScheduleEligibleSet.has(setup.symbol)");
  assertStringIncludes(scanner, "hasEligibleForexInstrument");
});

Deno.test("weekend lifecycle and status loops skip closed non-crypto market-data calls", () => {
  assertStringIncludes(scanner, "isInstrumentMarketOpen(pending.symbol, now)");
  assertStringIncludes(confirmationScanner, "isInstrumentMarketOpen(pending.symbol, marketNow)");
  assertStringIncludes(paperTrading, "isInstrumentMarketOpen(sym, marketNow)");
  assertStringIncludes(paperTrading, "areNonCryptoMarketsClosed(marketNow)");
});

Deno.test("Gameplan generation uses the same configured-day market scope", () => {
  assertStringIncludes(
    gamePlanRefresh,
    "config.enabledDays",
  );
  assertStringIncludes(
    gamePlanRefresh,
    "resolveGamePlanMarketScope(",
  );
  assertStringIncludes(
    gamePlanRefresh,
    'details: { reason: "no_open_instruments", marketScope }',
  );
});

Deno.test("execution and candle hygiene delegate to the same market-day owner", () => {
  assertStringIncludes(finalRuntimeGates, "resolveGamePlanMarketScope(");
  assertStringIncludes(candleSource, "areNonCryptoMarketsClosed(new Date(timestamp))");
  assertStringIncludes(outcomeTracker, "isInstrumentMarketOpen(setup.symbol, marketNow)");
  assertStringIncludes(outcomeTracker, "isInstrumentMarketOpen(row.symbol, marketNow)");
});
