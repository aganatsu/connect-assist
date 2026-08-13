import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
const root = new URL("../../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, root));
Deno.test("runtime, exact snapshot replay and backtest use the same lifecycle replay", async () => {
  const [backtest, replayFunction, migration] = await Promise.all([
    read("supabase/functions/backtest-engine/index.ts"),
    read("supabase/functions/impulse-lifecycle-replay/index.ts"),
    read("supabase/migrations/20260806110000_add_impulse_lifecycle_replay.sql"),
  ]);
  assertStringIncludes(backtest, "replayImpulseEntryLifecycle({");
  assertStringIncludes(backtest, 'action === "impulse_lifecycle_replay"');
  assertStringIncludes(replayFunction, '.from("scan_candle_snapshots")');
  assertStringIncludes(replayFunction, "normalizeAnalysisTimeframe(");
  assertStringIncludes(replayFunction, "missingInitialLifecycle");
  assertStringIncludes(replayFunction, "missingCandleSnapshot");
  assertStringIncludes(replayFunction, "initial.confirmation?.startedAt");
  assertStringIncludes(replayFunction, "candleTime >= activationTime");
  assertStringIncludes(replayFunction, "insufficientPostActivationCandles");
  assertStringIncludes(replayFunction, "monitorOrphanedLifecycles");
  assertStringIncludes(migration, "impulse-lifecycle-shadow-monitor-5min");
  assertStringIncludes(migration, "winners_retained");
  assertStringIncludes(migration, "rescued_winners");
  assertStringIncludes(migration, "added_losses");
});
