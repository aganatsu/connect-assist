import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

const scanner = await Deno.readTextFile(new URL("../../functions/bot-scanner/index.ts", import.meta.url));
const mapper = await Deno.readTextFile(new URL("../../functions/_shared/configMapper.ts", import.meta.url));

Deno.test("pre-arming is disabled by default and requires pending route without market fill", () => {
  assert(mapper.includes("preArmZoneSetups: false"));
  assert(scanner.includes("pairConfig.preArmZoneSetups === true"));
  assert(scanner.includes("config.limitOrderEnabled && !config.marketFillAtZone"));
});

Deno.test("visible zone setup expiry owns staging and pending lifecycle clocks", () => {
  assert(mapper.includes("stagingTTLMinutes: entry.zoneWatchExpiry !== undefined"));
  assert(mapper.includes("limitOrderExpiryMinutes: entry.zoneWatchExpiry !== undefined"));
});

Deno.test("pre-armed setup inherits lifecycle identity and has no frozen size", () => {
  const start = scanner.indexOf("signal_reason: { preArmed: true");
  const insert = scanner.slice(start - 900, start + 1200);
  assert(insert.includes("candidate_id: frozenZoneWatch.candidate_id"));
  assert(insert.includes("staged_setup_id: frozenZoneWatch.id"));
  assert(insert.includes("frozen_strategy_context: frozenZoneWatch.frozen_strategy_context"));
  assert(insert.includes("size: null"));
});

Deno.test("at-zone canonical waits remain in the pre-armed lifecycle", () => {
  assert(scanner.includes("!izData.bestZone?.priceAtZone || preparePreArmLifecycle"));
  assert(scanner.includes("canonicalScannerEnforcement?.disposition === \"wait\""));
  assert(scanner.includes("detail.rejectionReasons = []"));
});

Deno.test("frozen executable entry owns planned location evidence", () => {
  assert(scanner.includes("frozenExecutablePlan"));
  assert(scanner.includes("price: plan.plan.entryPrice"));
  assert(scanner.includes("evaluatedPriceOwner: \"frozen_executable_entry\""));
});
