import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const scan = await Deno.readTextFile("./src/components/config/ScanTab.tsx");
const enter = await Deno.readTextFile("./src/components/config/EnterTab.tsx");
const zone = await Deno.readTextFile("./src/components/ZoneStoryPanel.tsx");
const diagnostics = await Deno.readTextFile("./src/components/LegacyDiagnosticsPanel.tsx");
const rejected = await Deno.readTextFile("./src/pages/RejectedSetups.tsx");
const backtest = await Deno.readTextFile("./src/pages/Backtest.tsx");

Deno.test("Bot Config uses familiar ICT and SMC workflow terminology", () => {
  for (const label of [
    "Trade Decision Mode",
    "Premium/Discount Entry Rule",
    "Block Wrong-Side Entries",
    "Require Discount Buys / Premium Sells",
    "HTF Bias",
    "BSL/SSL Liquidity Levels",
  ]) assertStringIncludes(scan, label);

  for (const label of [
    "POI & Entry Model",
    "HTF-to-LTF POI Alignment",
    "Require BSL/SSL Sweep Before Displacement",
    "POI Mitigation State",
    "Entry Confirmation",
    "MSS / CHoCH / Reversal Candle",
  ]) assertStringIncludes(enter, label);
});

Deno.test("trading details and research views use the same terminology", () => {
  assertStringIncludes(zone, "ICT Setup Model");
  assertStringIncludes(diagnostics, "Legacy Scores and Filters");
  assertStringIncludes(rejected, "Trade Decision Comparison");
  assertStringIncludes(rejected, "Premium/Discount Range Comparison");
  assertStringIncludes(backtest, "Premium/Discount Entry Rule");
});
