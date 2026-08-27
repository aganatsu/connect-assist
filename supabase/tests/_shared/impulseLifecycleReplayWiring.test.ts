import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
const root = new URL("../../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, root));
Deno.test("runtime, exact snapshot replay and backtest use the same lifecycle replay", async () => {
  const [backtest, replayFunction, migration] = await Promise.all([
    read("supabase/functions/backtest-engine/index.ts"),
    read("supabase/functions/impulse-lifecycle-replay/index.ts"),
    read("supabase/migrations/20260806110000_add_impulse_lifecycle_replay.sql"),
  ]);
  assertStringIncludes(
    backtest,
    'import { replayImpulseEntryLifecycle } from "../_shared/impulseLifecycleReplay.ts";',
  );
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

Deno.test("observation monitor reuses scanner snapshots without external candle requests", async () => {
  const replayFunction = await read(
    "supabase/functions/impulse-lifecycle-replay/index.ts",
  );
  const monitorStart = replayFunction.indexOf(
    "async function monitorOrphanedLifecycles",
  );
  const replayStart = replayFunction.indexOf(
    "async function replayUserLifecycles",
  );
  const monitor = replayFunction.slice(monitorStart, replayStart);

  assertEquals(
    replayFunction.includes('from "../_shared/candleSource.ts"'),
    false,
  );
  assertEquals(monitor.includes("fetchCandlesWithFallback"), false);
  assertStringIncludes(replayFunction, '.from("scan_candle_snapshots")');
  assertStringIncludes(replayFunction, '.eq("user_id", input.userId)');
  assertStringIncludes(replayFunction, '.eq("bot_id", BOT_ID)');
  assertStringIncludes(replayFunction, '.eq("symbol", input.symbol)');
  assertStringIncludes(replayFunction, '.eq("timeframe", input.timeframe)');
  assertStringIncludes(
    replayFunction,
    '.gt("observed_at", input.observedAfter)',
  );
  assertStringIncludes(monitor, "lifecycle?.confirmation?.startedAt");
  assertStringIncludes(monitor, "observedAfter: snapshotObservedAfter");
  assertStringIncludes(monitor, "completedCandleTime < activationTime");
  assertStringIncludes(monitor, '.limit(100)');
  assertStringIncludes(monitor, "activeOrderLifecycleIds.has(row.id)");
  assertStringIncludes(
    monitor,
    "observeImpulseConfirmationLock(client, row.id, snapshot.candles)",
  );
});
