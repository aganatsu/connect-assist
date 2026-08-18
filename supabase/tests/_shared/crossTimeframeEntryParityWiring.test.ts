import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../../", import.meta.url);
const source = async (path: string) =>
  await Deno.readTextFile(new URL(path, root));

Deno.test("every live entry authorization requires Cross-TF authority", async () => {
  const scanner = await source("supabase/functions/bot-scanner/index.ts");
  const fast = await source(
    "supabase/functions/zone-confirmation-scanner/index.ts",
  );
  const scannerCalls = scanner.match(
    /evaluateFinalTradeAuthorization\(\{/g,
  ) || [];
  const scannerRequirements = scanner.match(
    /requireCrossTimeframeAuthority:\s*true/g,
  ) || [];
  const fastCalls = fast.match(/evaluateFinalTradeAuthorization\(\{/g) || [];
  const fastRequirements = fast.match(
    /requireCrossTimeframeAuthority:\s*true/g,
  ) || [];
  assert(scannerCalls.length >= 2);
  assert(scannerRequirements.length >= scannerCalls.length);
  assert(fastCalls.length >= 1);
  assert(fastRequirements.length >= fastCalls.length);
});

Deno.test("normal, unified, cascade, standalone and breaker paths share the authority", async () => {
  const scanner = await source("supabase/functions/bot-scanner/index.ts");
  for (
    const marker of [
      'signalSource = "unified"',
      'signalSource = "cascade"',
      'signalSource = "standalone"',
      "isPromotedFromStaging",
      'signalSource: "breaker"',
      "crossTimeframeEntryDecision",
    ]
  ) {
    assertStringIncludes(scanner, marker);
  }
});

Deno.test("backtest and replay use the same Cross-TF policy and decision", async () => {
  const backtest = await source(
    "supabase/functions/backtest-engine/index.ts",
  );
  const replay = await source(
    "supabase/functions/_shared/zoneReplayEvidence.ts",
  );
  assertStringIncludes(backtest, "resolveCrossTimeframeAuthority");
  assertStringIncludes(backtest, "evaluateCrossTimeframeEntryAuthority");
  assertStringIncludes(backtest, "crossTimeframeAuthority.policy");
  assertStringIncludes(replay, "crossTimeframePolicy");
});

Deno.test("manual Scan Now and cron share bot-scanner implementation", async () => {
  const scanner = await source("supabase/functions/bot-scanner/index.ts");
  assertStringIncludes(scanner, "runScanForUser(");
  assertStringIncludes(scanner, "Cross-TF authority");
});

Deno.test("database audit contract preserves authority through every lifecycle table", async () => {
  const migration = await source(
    "supabase/migrations/20260802040000_unify_cross_timeframe_entry_authority.sql",
  );
  for (
    const table of ["staged_setups", "pending_orders", "paper_positions"]
  ) {
    assertStringIncludes(migration, `ALTER TABLE public.${table}`);
  }
  assertStringIncludes(migration, "cross_tf_entry_authority");
  assertStringIncludes(migration, "cross_tf_effective_mode");
  assertStringIncludes(migration, "cross_tf_entry_allowed");
  assertStringIncludes(
    migration,
    "position_cross_tf_entry_authority_valid",
  );
  assertStringIncludes(
    migration,
    "cross_timeframe_entry_authority_audit",
  );
  assertStringIncludes(
    migration,
    "position.created_at AS observed_at",
  );
  assert(
    !migration.includes("position.open_time"),
    "the audit UNION must not mix text open_time with timestamptz lifecycle timestamps",
  );
});
