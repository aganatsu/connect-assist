import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const functionsRoot = new URL("../../functions/", import.meta.url);
const repoRoot = new URL("../../../", import.meta.url);

function functionSource(relativePath: string): string {
  return Deno.readTextFileSync(new URL(relativePath, functionsRoot));
}

function repoSource(relativePath: string): string {
  return Deno.readTextFileSync(new URL(relativePath, repoRoot));
}

Deno.test("backtest replay is explicit, persisted, and reported", () => {
  const engine = functionSource("backtest-engine/index.ts");
  assertStringIncludes(engine, "zoneLocalReplayEvidence = false");
  assertStringIncludes(engine, "persistZoneReplayEvidence(db");
  assertStringIncludes(engine, "outcomeCandlesAfter(");
  assertStringIncludes(engine, "MAX_SCAN_SLICE_MS = 650");
  assertStringIncludes(engine, "__resumeAt: candle.datetime");
  assertStringIncludes(
    engine,
    "chunkIndex === 0 && !Number.isFinite(requestedResumeAt)",
  );
  assertStringIncludes(engine, "chunkResumeProgress");
  assertStringIncludes(engine, "symbolRuntimeState");
  assertStringIncludes(engine, "position.entryBarIndex = rebasedIndex");
  assertStringIncludes(engine, "cleanupZoneReplayEvidence(db, runId)");
  assertStringIncludes(engine, "ZONE_LOCAL_REPLAY_CONTRACT_VERSION");
  assertStringIncludes(engine, 'evidenceSource: "retrospective_replay"');
  assertStringIncludes(engine, "activationEligible: false");
});

Deno.test("only completed retrospective runs are published as evidence", () => {
  const migration = repoSource(
    "supabase/migrations/20260731190000_publish_completed_zone_replay_only.sql",
  );
  assertStringIncludes(
    migration,
    "replay.status = 'completed'",
  );
  assertStringIncludes(
    migration,
    "observation.evidence_source = 'forward_observation'",
  );
});

Deno.test("retrospective replay is source-separated and never activation eligible", () => {
  const migration = repoSource(
    "supabase/migrations/20260731180000_add_zone_local_retrospective_replay.sql",
  );
  assertStringIncludes(
    migration,
    "evidence_source IN ('forward_observation', 'retrospective_replay')",
  );
  assertStringIncludes(
    migration,
    "evidence_source <> 'retrospective_replay'",
  );
  assertStringIncludes(migration, "OR activation_eligible = false");
  assertStringIncludes(
    migration,
    "evidence_source = 'forward_observation'",
  );
});

Deno.test("outcome tracker owns forward observations only", () => {
  const tracker = functionSource("outcome-tracker/index.ts");
  const forwardFilters = tracker.match(
    /\.eq\("evidence_source", "forward_observation"\)/g,
  ) ?? [];
  assertEquals(forwardFilters.length >= 2, true);
});

Deno.test("UI labels replay evidence as research only", () => {
  const rejected = repoSource("src/pages/RejectedSetups.tsx");
  const backtest = repoSource("src/pages/Backtest.tsx");
  assertStringIncludes(rejected, "Run Historical Replay");
  assertStringIncludes(rejected, "RESEARCH ONLY");
  assertStringIncludes(rejected, "ACTIVATION EVIDENCE");
  assertStringIncludes(backtest, "Collect zone-local replay evidence");
  assertStringIncludes(backtest, "cannot");
  assertStringIncludes(backtest, "activate Soft or Hard enforcement");
});
