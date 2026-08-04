import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { generateGamePlansWithRetry } from "./gamePlanGeneration.ts";

Deno.test("retries missing symbols sequentially and preserves instrument order", async () => {
  const attempts = new Map<string, number>();
  const result = await generateGamePlansWithRetry({
    symbols: ["AUD/USD", "GBP/USD", "NZD/USD"],
    batchDelayMs: 0,
    retryDelayMs: 0,
    generate: (symbol) => {
      const count = (attempts.get(symbol) || 0) + 1;
      attempts.set(symbol, count);
      if (symbol === "GBP/USD" && count === 1) {
        return Promise.resolve(null);
      }
      return Promise.resolve({ symbol });
    },
  });

  assertEquals(result.complete, true);
  assertEquals(result.missingSymbols, []);
  assertEquals(result.plans.map((plan) => plan.symbol), [
    "AUD/USD",
    "GBP/USD",
    "NZD/USD",
  ]);
  assertEquals(attempts.get("GBP/USD"), 2);
});

Deno.test("reports an incomplete result when a retry still fails", async () => {
  const result = await generateGamePlansWithRetry({
    symbols: ["EUR/AUD", "XAU/USD"],
    batchDelayMs: 0,
    retryDelayMs: 0,
    generate: (symbol) =>
      Promise.resolve(symbol === "XAU/USD" ? null : { symbol }),
  });

  assertEquals(result.complete, false);
  assertEquals(result.missingSymbols, ["XAU/USD"]);
  assertEquals(result.plans, [{ symbol: "EUR/AUD" }]);
  assertEquals(
    result.failures.filter((failure) => failure.symbol === "XAU/USD").length,
    2,
  );
});
