import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
const scanner = await Deno.readTextFile(new URL("../../functions/bot-scanner/index.ts", import.meta.url));

Deno.test("pre-arm expiry is anchored to Watchlist staging time", () => {
  assert(scanner.includes("stagedAt + Number(frozenZoneWatch.ttl_minutes"));
  assert(!scanner.includes("Date.now() + Number(frozenZoneWatch.ttl_minutes"));
});

Deno.test("market fill conditionally cancels the same lifecycle candidate", () => {
  const start = scanner.indexOf("Candidate claimed by Market Fill route");
  const claim = scanner.slice(start - 1400, start + 800);
  assert(claim.includes("existingStaged.candidate_id"));
  assert(claim.includes('.in("status", ["pending", "awaiting_confirmation"])'));
  assert(claim.includes("useMarketFillAtZone = false"));
});
