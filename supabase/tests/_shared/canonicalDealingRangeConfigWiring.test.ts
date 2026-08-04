import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

async function source(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(`../../${path}`, import.meta.url));
}

Deno.test("Bot Config and backtest expose explicit dealing range modes", async () => {
  const scanTab = await source("../src/components/config/ScanTab.tsx");
  const backtest = await source("../src/pages/Backtest.tsx");
  for (const value of ["off", "avoid_wrong_side", "strict_value"]) {
    assertStringIncludes(scanTab, `value="${value}"`);
    assertStringIncludes(backtest, `value: "${value}"`);
  }
  assert(!scanTab.includes("Only Buy in Discount"));
  assert(!scanTab.includes("Only Sell in Premium"));
  assert(!backtest.includes("Only Buy in Discount"));
  assert(!backtest.includes("Only Sell in Premium"));
});

Deno.test("last-100 report queries both outcomes and exposes evidence coverage", async () => {
  const api = await source("functions/bot-config/index.ts");
  const rejectedSetups = await source("../src/pages/RejectedSetups.tsx");
  const scanTab = await source("../src/components/config/ScanTab.tsx");
  assertStringIncludes(api, 'action === "dealing_range.comparison"');
  assertStringIncludes(api, '.from("paper_trade_history")');
  assertStringIncludes(api, '.from("rejected_setups")');
  assertStringIncludes(api, ".limit(100)");
  assertStringIncludes(rejectedSetups, "Premium/Discount Range Comparison");
  assertStringIncludes(rejectedSetups, "Winners preserved");
  assertStringIncludes(rejectedSetups, "Poor entries rejected");
  assertStringIncludes(rejectedSetups, "Unavailable");
  assert(!scanTab.includes("Premium/Discount Range Comparison"));
});
