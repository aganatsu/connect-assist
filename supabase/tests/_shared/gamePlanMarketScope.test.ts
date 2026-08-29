import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  areNonCryptoMarketsClosed,
  gamePlanSymbolsMatchScope,
  isInstrumentMarketOpen,
  resolveGamePlanMarketScope,
} from "../../functions/_shared/gamePlanMarketScope.ts";

const enabled = ["EUR/USD", "US30", "XAU/USD", "BTC/USD", "ETH/USD"];

Deno.test("weekend Gameplan scope keeps crypto and excludes closed markets", () => {
  // Saturday, August 1, 2026 at 12:00 New York time (EDT).
  const scope = resolveGamePlanMarketScope(
    enabled,
    new Date("2026-08-01T16:00:00.000Z"),
  );

  assertEquals(scope.nonCryptoMarketsClosed, true);
  assertEquals(scope.reason, "weekend_crypto_only");
  assertEquals(scope.eligibleSymbols, ["BTC/USD", "ETH/USD"]);
  assertEquals(scope.excludedSymbols, ["EUR/USD", "US30", "XAU/USD"]);
});

Deno.test("Friday close and Sunday reopen use New York market boundary", () => {
  assertEquals(
    areNonCryptoMarketsClosed(new Date("2026-07-31T20:59:00.000Z")),
    false,
  );
  assertEquals(
    areNonCryptoMarketsClosed(new Date("2026-07-31T21:01:00.000Z")),
    true,
  );
  assertEquals(
    areNonCryptoMarketsClosed(new Date("2026-08-02T20:59:00.000Z")),
    true,
  );
  assertEquals(
    areNonCryptoMarketsClosed(new Date("2026-08-02T21:01:00.000Z")),
    false,
  );
});

Deno.test("weekday Gameplan scope requires every enabled instrument", () => {
  const scope = resolveGamePlanMarketScope(
    enabled,
    new Date("2026-08-03T14:00:00.000Z"),
  );

  assertEquals(scope.reason, "all_enabled_markets_open");
  assertEquals(scope.eligibleSymbols, enabled);
  assertEquals(scope.excludedSymbols, []);
});

Deno.test("configured non-trading day keeps crypto eligible without scanning closed-day instruments", () => {
  // Monday, but only Tuesday-Friday are enabled.
  const scope = resolveGamePlanMarketScope(
    enabled,
    new Date("2026-08-03T14:00:00.000Z"),
    [2, 3, 4, 5],
  );

  assertEquals(scope.nonCryptoMarketsClosed, false);
  assertEquals(scope.nonCryptoTradingDayEnabled, false);
  assertEquals(scope.reason, "configured_day_crypto_only");
  assertEquals(scope.eligibleSymbols, ["BTC/USD", "ETH/USD"]);
  assertEquals(scope.excludedSymbols, ["EUR/USD", "US30", "XAU/USD"]);
});

Deno.test("Sunday reopen uses Monday's configured trading-day permission", () => {
  const reopened = new Date("2026-08-02T21:01:00.000Z");

  assertEquals(
    resolveGamePlanMarketScope(enabled, reopened, [1, 2, 3, 4, 5])
      .eligibleSymbols,
    enabled,
  );
  assertEquals(
    resolveGamePlanMarketScope(enabled, reopened, [2, 3, 4, 5])
      .eligibleSymbols,
    ["BTC/USD", "ETH/USD"],
  );
});

Deno.test("instrument market availability exempts crypto from the weekend boundary", () => {
  const saturday = new Date("2026-08-01T16:00:00.000Z");
  assertEquals(isInstrumentMarketOpen("EUR/USD", saturday), false);
  assertEquals(isInstrumentMarketOpen("XAU/USD", saturday), false);
  assertEquals(isInstrumentMarketOpen("US30", saturday), false);
  assertEquals(isInstrumentMarketOpen("BTC/USD", saturday), true);
  assertEquals(isInstrumentMarketOpen("ETH/USD", saturday), true);
});

Deno.test("active plan must exactly match the current market scope", () => {
  const weekendScope = resolveGamePlanMarketScope(
    enabled,
    new Date("2026-08-01T16:00:00.000Z"),
  );

  assertEquals(
    gamePlanSymbolsMatchScope(["BTC/USD", "ETH/USD"], weekendScope),
    true,
  );
  assertEquals(
    gamePlanSymbolsMatchScope(["EUR/USD", "BTC/USD"], weekendScope),
    false,
  );
  assertEquals(
    gamePlanSymbolsMatchScope(["BTC/USD"], weekendScope),
    false,
  );
});
