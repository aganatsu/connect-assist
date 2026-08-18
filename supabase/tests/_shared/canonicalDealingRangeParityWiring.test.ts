import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

async function source(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(`../../${path}`, import.meta.url));
}

Deno.test("live market and pending fills evaluate their actual entry prices", async () => {
  const scanner = await source("functions/bot-scanner/index.ts");
  const pending = await source("functions/zone-confirmation-scanner/index.ts");
  assertStringIncludes(pending, "price: actualFillPrice");
  assertStringIncludes(
    pending,
    "canonicalDealingRange: pendingCanonicalDealingRange",
  );
  assertStringIncludes(scanner, "price: marketEntryPrice");
  assertStringIncludes(
    scanner,
    "canonicalDealingRange: directCanonicalDealingRange",
  );
});

Deno.test("backtest uses the shared evaluator as a non-blocking observation", async () => {
  const backtest = await source("functions/backtest-engine/index.ts");
  assertStringIncludes(backtest, "resolveCanonicalDealingRange({");
  assertStringIncludes(backtest, "evaluateCanonicalDealingRange({");
  assertStringIncludes(backtest, "passed: true");
  assertStringIncludes(backtest, "[observe:canonical-dealing-range]");
});
