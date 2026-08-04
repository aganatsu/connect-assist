import {
  assertMatch,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(
  "./supabase/functions/strategy-evidence-certifier/index.ts",
);

Deno.test("Phase 8B certifier derives user identity from the JWT", () => {
  assertMatch(source, /userClient\.auth\s*\.getClaims\(token\)/);
  assertStringIncludes(source, "claimsData?.claims?.sub");
  if (source.includes("body.user_id")) {
    throw new Error("Certifier must never trust a caller-supplied user_id");
  }
});

Deno.test("Phase 8B certifier reads both rejected and taken outcomes", () => {
  assertStringIncludes(source, '.from("rejected_setups")');
  assertStringIncludes(source, '.from("paper_trade_history")');
  assertStringIncludes(source, "buildStrategyEvidenceSource");
  assertStringIncludes(source, "buildStrategyEvidenceCertificate");
});

Deno.test("Phase 8B certifier publishes evidence but never activates it", () => {
  assertStringIncludes(source, '"publish_strategy_evidence_certificate"');
  assertStringIncludes(source, "runtimeEnforced: false");
  if (source.includes("transition_strategy_activation")) {
    throw new Error("Evidence generation must not transition activation");
  }
});
