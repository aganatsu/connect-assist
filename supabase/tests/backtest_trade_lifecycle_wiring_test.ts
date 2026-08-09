import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, root));

Deno.test("backtest persists and enforces the shared trade lifecycle", async () => {
  const engine = await read("supabase/functions/backtest-engine/index.ts");
  assertStringIncludes(engine, "tradeLifecycleState: BacktestTradeLifecycleState");
  assertStringIncludes(engine, "advanceBacktestTradeLifecycle({");
  assertStringIncludes(engine, "discoverBacktestTradeLifecycle({");
  assertStringIncludes(engine, 'lifecycleMode === "enforce"');
  assertStringIncludes(engine, "consumeBacktestTradeLifecycleEntry(");
  assertStringIncludes(engine, "symbolRuntimeState[symbol] = {");
});
