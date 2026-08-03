import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildConfirmationAuthorityObservation,
  confirmationLevelFromLegacySignal,
} from "./confirmationAuthority.ts";

Deno.test("confirmation observation is deterministic and non-authoritative", () => {
  const result = buildConfirmationAuthorityObservation({
    source: "legacy_tier",
    level: "wick_choch_supported",
    direction: "long",
    entryReadyUnderCurrentBehavior: true,
    supportingSignals: ["engulfing", "engulfing", "rejection_wick"],
    reasonCodes: ["legacy_tier_2", "legacy_tier_2"],
  });
  assertEquals(result.observationOnly, true);
  assertEquals(result.affectsAuthorization, false);
  assertEquals(result.supportingSignals, ["engulfing", "rejection_wick"]);
  assertEquals(result.reasonCodes, ["legacy_tier_2"]);
});

Deno.test("legacy paths map to explicit named levels", () => {
  assertEquals(confirmationLevelFromLegacySignal({ tier: 1, closeBased: true, supportingSignals: [] }), "close_choch");
  assertEquals(confirmationLevelFromLegacySignal({ tier: 2, closeBased: false, supportingSignals: ["engulfing"] }), "wick_choch_supported");
  assertEquals(confirmationLevelFromLegacySignal({ tier: 3, closeBased: false, supportingSignals: ["rejection_wick"] }), "reversal_pattern");
});
