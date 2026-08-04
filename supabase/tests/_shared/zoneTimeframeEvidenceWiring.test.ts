import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const repoRoot = new URL("../../../", import.meta.url);
const functionsRoot = new URL("../../functions/", import.meta.url);

function repoSource(relativePath: string): string {
  return Deno.readTextFileSync(new URL(relativePath, repoRoot));
}

function functionSource(relativePath: string): string {
  return Deno.readTextFileSync(new URL(relativePath, functionsRoot));
}

Deno.test("scanner enables exact-path evidence without feeding it into decisions", () => {
  const scanner = functionSource("bot-scanner/index.ts");
  assertStringIncludes(scanner, "collectEvidence: true");
  assertStringIncludes(scanner, "buildScanEvidenceRow(");
  assertStringIncludes(scanner, "timeframeEvidenceId:");
  assertStringIncludes(scanner, "(detail as any).timeframeEvidenceId");
  assertStringIncludes(scanner, "persistZoneTimeframeEvidence(");

  const collectorIndex = scanner.indexOf("collectEvidence: true");
  const rowBuildIndex = scanner.indexOf("buildScanEvidenceRow(");
  assert(collectorIndex >= 0 && rowBuildIndex > collectorIndex);
});

Deno.test("confirmation attempts use frozen parent identity and atomic allocation", () => {
  const confirmation = functionSource("zone-confirmation-scanner/index.ts");
  assertStringIncludes(confirmation, "readFrozenSetupStrategyContext(");
  assertStringIncludes(confirmation, "nextConfirmationAttempt(");
  assertStringIncludes(confirmation, "parentEvidenceId,");
  const allocatorStart = confirmation.indexOf("nextConfirmationAttempt(");
  const allocatorEnd = confirmation.indexOf(");", allocatorStart);
  assertEquals(
    confirmation.slice(allocatorStart, allocatorEnd).includes("scanCycleId"),
    false,
    "confirmation allocator must not be scoped to the per-invocation scan UUID",
  );
});

Deno.test("evidence migration protects payload immutability and service-only counters", () => {
  const migration = repoSource(
    "supabase/migrations/20260801213000_fix_zone_timeframe_evidence_contract.sql",
  );
  for (
    const protectedField of [
      "NEW.style_policy_snapshot::text",
      "NEW.slots::text",
      "NEW.engine_options::text",
      "NEW.parent_evidence_id",
      "NEW.confirmation_attempt",
    ]
  ) {
    assertStringIncludes(migration, protectedField);
  }
  assertStringIncludes(migration, "auth.role() <> 'service_role'");
  assertStringIncludes(
    migration,
    "allocate_zone_confirmation_evidence_attempt(uuid, text, uuid)",
  );
  assertStringIncludes(
    migration,
    "REVOKE ALL ON public.zone_confirmation_evidence_counters",
  );
});

Deno.test("canonical impulse metrics are persisted with immutable parity provenance", () => {
  const evidence = functionSource("_shared/zoneTimeframeEvidence.ts");
  const cleanup = functionSource("data-cleanup/index.ts");
  const migration = repoSource(
    "supabase/migrations/20260801220000_add_canonical_impulse_observability.sql",
  );

  assertStringIncludes(evidence, "canonical_detector_version:");
  assertStringIncludes(evidence, "canonical_parity:");
  assertStringIncludes(evidence, "displacementPercentile");
  assertStringIncludes(evidence, "bodyStrengthPercentile");
  assertStringIncludes(evidence, "bosSignificanceATR");
  assertStringIncludes(evidence, "sweepOrigin");
  assertStringIncludes(cleanup, "row.canonical_detector_version");
  assertStringIncludes(cleanup, "row.canonical_parity");
  assertStringIncludes(migration, "NEW.canonical_detector_version");
  assertStringIncludes(migration, "NEW.canonical_parity");
});

Deno.test("cleanup compacts linked evidence before deleting bounded raw batches", () => {
  const cleanup = functionSource("data-cleanup/index.ts");
  const summaryWrite = cleanup.indexOf('.from("zone_timeframe_evidence_summary")');
  const rawDelete = cleanup.indexOf('.from("zone_timeframe_evidence")', summaryWrite);
  assert(summaryWrite >= 0 && rawDelete > summaryWrite);
  assertStringIncludes(cleanup, "event_linked.eq.true");
  assertStringIncludes(cleanup, "const maxBatches = 20");
  assertStringIncludes(cleanup, "const batchSize = 500");
});
