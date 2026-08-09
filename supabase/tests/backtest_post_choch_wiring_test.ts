import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, root));

Deno.test("backtest persists configured post-CHoCH retracement timing", async () => {
  const [engine, lifecycle] = await Promise.all([
    read("supabase/functions/backtest-engine/index.ts"),
    read("supabase/functions/_shared/backtestTradeLifecycle.ts"),
  ]);
  assertStringIncludes(engine, "prepareBacktestPostConfirmationEntry({");
  assertStringIncludes(engine, "pairConfig.afterChochMode");
  assertStringIncludes(engine, '"awaiting_retracement"');
  assertStringIncludes(engine, "skippedLifecycleWaiting");
  assertStringIncludes(lifecycle, "derivePostChochEntryPlan({");
  assertStringIncludes(lifecycle, "evaluatePostChochRetracement(");
  assertStringIncludes(lifecycle, 'plan.mode !== "wait_retracement"');
});
