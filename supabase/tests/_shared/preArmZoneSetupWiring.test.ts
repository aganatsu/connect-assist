import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

const scanner = await Deno.readTextFile(new URL("../../functions/bot-scanner/index.ts", import.meta.url));
const mapper = await Deno.readTextFile(new URL("../../functions/_shared/configMapper.ts", import.meta.url));

Deno.test("generic pre-arming is disabled by default while enforced nested routes retain a monitor", () => {
  assert(mapper.includes("preArmZoneSetups: false"));
  assert(scanner.includes("const shouldPreArmZoneSetup = effectiveNestedPoiActivation.enforced"));
  assert(scanner.includes("pairConfig.preArmZoneSetups === true"));
  assert(scanner.includes("config.limitOrderEnabled && !config.marketFillAtZone"));
});

Deno.test("visible zone setup expiry owns staging and pending lifecycle clocks", () => {
  assert(mapper.includes("stagingTTLMinutes: entry.zoneWatchExpiry !== undefined"));
  assert(mapper.includes("limitOrderExpiryMinutes: entry.zoneWatchExpiry !== undefined"));
});

Deno.test("pre-armed setup inherits lifecycle identity and has no frozen size", () => {
  const start = scanner.indexOf(
    'const { error: preArmError } = await supabase.from("pending_orders").insert({',
  );
  const end = scanner.indexOf("if (preArmError", start);
  const insert = scanner.slice(start, end);
  assert(start >= 0 && end > start);
  assert(insert.includes("candidate_id: frozenZoneWatch.candidate_id"));
  assert(insert.includes("staged_setup_id: frozenZoneWatch.id"));
  assert(insert.includes("frozen_strategy_context: frozenZoneWatch.frozen_strategy_context"));
  assert(insert.includes("size: null"));
});

Deno.test("both pre-arm routes persist observation-only reachability evidence", () => {
  assert(scanner.includes("observePreArmReachability"));
  assert(scanner.match(/const preArmReachability = observePreArmReachability/g)?.length === 2);
  assert(scanner.match(/preArmReachability,/g)?.length === 2);
  assert(scanner.match(/referenceMaxDistancePips: Number\(config\.limitOrderMaxDistancePips \?\? 30\)/g)?.length === 2);
});

Deno.test("at-zone canonical waits remain in the pre-armed lifecycle", () => {
  assert(scanner.includes("!izData.bestZone?.priceAtZone || shouldPreArmZoneSetup"));
  assert(scanner.includes("canonicalScannerEnforcement?.disposition === \"wait\""));
  assert(scanner.includes("detail.rejectionReasons = []"));
});

Deno.test("frozen executable entry owns planned location evidence", () => {
  assert(scanner.includes("frozenExecutablePlan"));
  assert(scanner.includes("price: plan.plan.entryPrice"));
  assert(scanner.includes("evaluatedPriceOwner: \"frozen_executable_entry\""));
});

Deno.test("visible zone setup expiry is not overridden by trading style", () => {
  assert(!scanner.includes("Math.min(stagingTTLMinutes, 120)"));
  assert(!scanner.includes("Math.max(stagingTTLMinutes, 480)"));
  assert(scanner.match(/const styleTTL = stagingTTLMinutes;/g)?.length === 4);
  assert(scanner.includes("ttlMinutes: stagingTTLMinutes"));
});

Deno.test("pre-arm reachability sources a real ATR, not the non-existent analysis.atrValue", () => {
  // `atrValue` is declared on SLTPInput (smcAnalysis.ts), an INPUT type for the
  // SL/TP calculator. It is not a field on the analysis result, and the
  // `as any` cast meant the mistake type-checked. Number(undefined) is NaN and
  // `NaN || null` is null, so every pre-armed row recorded distanceAtr: null —
  // verified in production 2026-08-25 across all five pre-armed orders.
  //
  // That matters because a pip bound cannot normalise across instruments:
  // XAU/USD has pipSize 0.01, so the 30-pip reference is $0.30 on a metal that
  // moves $20+ a day. ATR is the only usable normaliser, and it was never
  // recorded.
  assert(
    !scanner.includes("atrValue: Number((analysis as any).atrValue) || null"),
    "pre-arm reachability is reading analysis.atrValue, which does not exist — " +
      "distanceAtr will be null on every armed row",
  );
  assert(
    scanner.match(/atrValue: zoneStopPolicyConfirmationAtr > 0/g)?.length === 2,
    "both pre-arm routes must source ATR from the per-pair confirmation ATR " +
      "the stop policy already computes",
  );
});

Deno.test("pre-arm ATR reuses the stop policy's per-pair value rather than recomputing", () => {
  // Four calculateATR call sites already exist in bot-scanner. A fifth for the
  // same per-pair value is how this repo grew its drift problem, so the
  // reachability observation deliberately borrows the stop policy's.
  assert(scanner.includes("const zoneStopPolicyConfirmationAtr = calculateATR("));
  const atrDecl = scanner.indexOf("const zoneStopPolicyConfirmationAtr = calculateATR(");
  const firstUse = scanner.indexOf("atrValue: zoneStopPolicyConfirmationAtr > 0");
  assert(
    atrDecl >= 0 && firstUse > atrDecl,
    "the confirmation ATR must be declared before the pre-arm sites that read it",
  );
});
