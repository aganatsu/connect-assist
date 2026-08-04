import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

async function source(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(`../../${path}`, import.meta.url));
}

Deno.test("canonical range is frozen from the exact timeframe evidence row", async () => {
  const frozen = await source("functions/_shared/frozenCrossTimeframeContext.ts");
  const scanner = await source("functions/bot-scanner/index.ts");

  assertStringIncludes(frozen, "canonicalDealingRange: CanonicalDealingRangeSelection");
  assertStringIncludes(frozen, "resolveCanonicalDealingRange({");
  assertStringIncludes(frozen, "slots: input.timeframeEvidence.slots");
  assertStringIncludes(scanner, "timeframeEvidence: zoneEvidenceRows.find");
});

Deno.test("canonical range lifecycle migration covers every persisted setup stage", async () => {
  const migration = await source(
    "migrations/20260803090000_freeze_canonical_dealing_range.sql",
  );

  for (const table of ["staged_setups", "pending_orders", "paper_positions"]) {
    assertStringIncludes(migration, `'${table}'`);
  }
  assertStringIncludes(migration, "canonical_dealing_range_impulse_id");
  assertStringIncludes(migration, "canonical_dealing_range_timeframe");
  assertStringIncludes(migration, "canonical-dealing-range.v1");
  assertStringIncludes(migration, "frozen-cross-tf-context.v2");
  assertStringIncludes(migration, "_canonical_dealing_range_valid");
});
