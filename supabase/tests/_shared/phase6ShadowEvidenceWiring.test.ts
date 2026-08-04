import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scannerSource = await Deno.readTextFile(
  "./supabase/functions/bot-scanner/index.ts",
);

Deno.test("gate-blocked rejections persist Phase 6 comparison evidence", () => {
  const start = scannerSource.indexOf(
    "Rejected Setup Logging: gate-blocked setup",
  );
  const end = scannerSource.indexOf(
    "Breaker Block Entry Signal",
    start,
  );
  const section = scannerSource.slice(start, end);

  assertStringIncludes(section, "gamePlanShadowAudit:");
  assertStringIncludes(section, "thesisConviction:");
  assertStringIncludes(section, "decisionContext:");
  assertStringIncludes(section, "stylePolicy:");
  assertStringIncludes(section, "shadowEvaluation:");
  assertStringIncludes(section, "effectiveScore,");
  assertStringIncludes(section, "threshold: conflictAdjustedMinConfluence");
});

Deno.test("below-threshold rejections persist Phase 6 comparison evidence", () => {
  const start = scannerSource.indexOf(
    "Rejected Setup Logging: below-threshold with strong T1",
  );
  const end = scannerSource.indexOf(
    "Setup Staging: Stage below-threshold setups",
    start,
  );
  const section = scannerSource.slice(start, end);

  assertStringIncludes(section, "gamePlanShadowAudit:");
  assertStringIncludes(section, "thesisConviction:");
  assertStringIncludes(section, "decisionContext:");
  assertStringIncludes(section, "stylePolicy:");
  assertStringIncludes(section, "shadowEvaluation:");
  assertStringIncludes(section, "baseScore: analysis.score");
  assertStringIncludes(section, "threshold: conflictAdjustedMinConfluence");
});
