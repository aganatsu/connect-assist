// deno-lint-ignore-file no-import-prefix
import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const liveScanner = await Deno.readTextFile(
  new URL("../bot-scanner/index.ts", import.meta.url),
);
const backtestEngine = await Deno.readTextFile(
  new URL("../backtest-engine/index.ts", import.meta.url),
);

Deno.test("live scanner captures the canonical Golden Replay snapshot", () => {
  assertStringIncludes(
    liveScanner,
    "goldenReplaySnapshot = await buildGoldenReplaySnapshot({",
  );
  assertStringIncludes(liveScanner, 'surface: "live"');
  assertStringIncludes(liveScanner, 'enforcement: "observe_only"');
  assertStringIncludes(liveScanner, "positionSize: null");
});

Deno.test("backtest captures and retains the same snapshot contract", () => {
  assertStringIncludes(
    backtestEngine,
    "const replaySnapshot = await buildGoldenReplaySnapshot({",
  );
  assertStringIncludes(backtestEngine, 'surface: "backtest"');
  assertStringIncludes(backtestEngine, "goldenReplaySnapshots.push");
  assertStringIncludes(backtestEngine, "goldenReplaySnapshot: replaySnapshot");
  assertStringIncludes(
    backtestEngine,
    "goldenReplaySnapshot: pos.goldenReplaySnapshot",
  );
});

Deno.test("backtest result exposes bounded replay evidence", () => {
  assertStringIncludes(
    backtestEngine,
    "if (goldenReplaySnapshots.length > 500)",
  );
  assertStringIncludes(backtestEngine, 'contractVersion: "golden-replay.v1"');
  assertStringIncludes(backtestEngine, "snapshots: goldenReplaySnapshots");
});
