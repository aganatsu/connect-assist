import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
const engine = await Deno.readTextFile(new URL("../functions/backtest-engine/index.ts", import.meta.url));
Deno.test("MT5 backtests use imported candles without provider fallback", () => {
  assertStringIncludes(engine, 'historySource === "mt5"');
  assertStringIncludes(engine, "loadImportedMT5History");
  assertStringIncludes(engine, "importedHistory.candles[symbol]");
  assertStringIncludes(engine, 'mode: historySource');
  assertStringIncludes(engine, 'action === "mt5_register"');
});
