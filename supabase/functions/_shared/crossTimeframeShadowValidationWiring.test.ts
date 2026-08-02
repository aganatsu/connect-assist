import {
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const store = await Deno.readTextFile(
  "./supabase/functions/_shared/zoneShadowObservationStore.ts",
);
const replay = await Deno.readTextFile(
  "./supabase/functions/backtest-engine/index.ts",
);
const migration = await Deno.readTextFile(
  "./supabase/migrations/20260802020000_add_cross_timeframe_shadow_validation.sql",
);
const ui = await Deno.readTextFile("./src/pages/RejectedSetups.tsx");

Deno.test("forward and replay observations share one cross-TF evaluation", () => {
  assertStringIncludes(store, "evaluateCrossTimeframeShadowCandidate");
  assertStringIncludes(store, "cross_tf_shadow_decision");
  assertStringIncludes(store, "cross_tf_reason_codes");
  assertStringIncludes(
    replay,
    "collectEvidence: zoneLocalReplayEvidence === true",
  );
});

Deno.test("validation view reports decision quality and remains observe-only", () => {
  for (
    const field of [
      "winners_retained",
      "losers_avoided",
      "missed_opportunities",
      "false_positives",
      "cross_tf_expectancy_delta_r",
      "cross_tf_avg_mfe_pips",
      "cross_tf_avg_mae_pips",
    ]
  ) {
    assertStringIncludes(migration, field);
    assertStringIncludes(ui, field);
  }
  assertStringIncludes(
    migration,
    "'observe_only'::TEXT AS cross_tf_enforcement",
  );
  assertStringIncludes(
    migration,
    "observation.evidence_source = 'forward_observation'",
  );
  assertStringIncludes(migration, "replay.status = 'completed'");
});
