import {
  assert,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scannerSource = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("scan detail direction is synchronized after Direction Verdict resolution", () => {
  const syncStart = scannerSource.indexOf("// ── DIRECTION SYNC:");
  const stopTpStart = scannerSource.indexOf(
    "// ── SL/TP Recalculation:",
    syncStart,
  );
  assert(syncStart >= 0 && stopTpStart > syncStart);

  const syncBlock = scannerSource.slice(syncStart, stopTpStart);
  assertMatch(
    syncBlock,
    /detail\.direction\s*=\s*effectiveDirection\s*\?\?\s*["']neutral["']/,
  );
  assertMatch(syncBlock, /detail\.directionSource\s*=\s*directionSource/);
});

Deno.test("scan detail exposes existing setup identities for dashboard linkage", () => {
  const identityStart = scannerSource.indexOf("detail.setupIdentity = {");
  const identityEnd = scannerSource.indexOf("};", identityStart);
  assert(identityStart >= 0 && identityEnd > identityStart);

  const identityBlock = scannerSource.slice(identityStart, identityEnd);
  assertMatch(identityBlock, /orderId:\s*currentPendingCandidate\?\.order_id/);
  assertMatch(
    identityBlock,
    /stagedSetupId:[\s\S]*currentPendingCandidate\?\.staged_setup_id/,
  );
  assertMatch(
    identityBlock,
    /candidateId:[\s\S]*currentPendingCandidate\?\.candidate_id/,
  );
  assertMatch(
    identityBlock,
    /impulseEntryLifecycleId:[\s\S]*currentPendingCandidate\?\.impulse_entry_lifecycle_id/,
  );
  assertMatch(
    scannerSource.slice(identityEnd),
    /detail\.setupIdentity\s*=\s*\{[\s\S]*?orderId:\s*pendingOrderId,[\s\S]*?impulseEntryLifecycleId:/,
  );
});
