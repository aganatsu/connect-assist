import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const main = await Deno.readTextFile("./supabase/functions/bot-scanner/index.ts");
const fast = await Deno.readTextFile("./supabase/functions/zone-confirmation-scanner/index.ts");
const confirmation = await Deno.readTextFile("./supabase/functions/_shared/zoneConfirmation.ts");
const backtest = await Deno.readTextFile("./supabase/functions/backtest-engine/index.ts");

Deno.test("both confirmation scanners use frozen route candlestick profiles", () => {
  for (const source of [main, fast]) {
    assertStringIncludes(source, 'candlestickProfile: "unified" | "standalone" | "cascade"');
    assertStringIncludes(source, 'sr?.signalSource === "cascade"');
    assertStringIncludes(source, 'sr?.signalSource === "unified"');
    assertStringIncludes(source, "candlestickProfile,");
  }
});

Deno.test("backtest uses the same route-aware Confirmation Authority", () => {
  assertStringIncludes(backtest, "detectZoneConfirmation(");
  assertStringIncludes(backtest, "backtestConfirmationProfile");
  assertStringIncludes(backtest, "Confirmation Authority");
  assertStringIncludes(backtest, "backtestConfirmationSignal?.authority");
});

Deno.test("candlestick evidence is owned by the existing Confirmation Authority", () => {
  assertStringIncludes(confirmation, "evaluateCandlestickConfirmation({");
  assertStringIncludes(confirmation, '"pattern:" + pattern.pattern');
  assertStringIncludes(confirmation, '"reversal_pattern"');
});
