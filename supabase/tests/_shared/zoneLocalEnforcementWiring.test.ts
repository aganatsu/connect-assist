import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scanner = await Deno.readTextFile(
  "./supabase/functions/bot-scanner/index.ts",
);
const backtest = await Deno.readTextFile(
  "./supabase/functions/backtest-engine/index.ts",
);
const mapper = await Deno.readTextFile(
  "./supabase/functions/_shared/configMapper.ts",
);
const configUi = await Deno.readTextFile(
  "./src/components/config/EnterTab.tsx",
);

Deno.test("live and backtest use the same evidence-capped policy helper", () => {
  for (const source of [scanner, backtest]) {
    assertStringIncludes(source, "evaluateZoneLocalEnforcement({");
    assertStringIncludes(source, "loadZoneLocalActivation");
    assertStringIncludes(source, "zoneLocalDecision.scoreAdjustment");
    assertStringIncludes(source, "if (!zoneLocalDecision.allowed)");
  }
  assertStringIncludes(
    scanner,
    'runtimeTarget: account.execution_mode === "live"',
  );
  assertStringIncludes(backtest, 'runtimeTarget: "paper"');
});

Deno.test("zone-local config is safe by default and visible in Bot Config", () => {
  assertStringIncludes(
    mapper,
    'zoneLocalEnforcementMode: "observe" as "observe" | "soft" | "hard"',
  );
  assertStringIncludes(configUi, 'value="observe"');
  assertStringIncludes(
    configUi,
    "Evidence approval caps the effective mode",
  );
  assert(
    configUi.indexOf("POI Confluence Mode") >
      configUi.indexOf("Require Valid POI"),
  );
});

Deno.test("frozen setup retains the effective zone-local decision", async () => {
  const lifecycle = await Deno.readTextFile(
    "./supabase/functions/_shared/setupLifecycle.ts",
  );
  assertStringIncludes(
    lifecycle,
    "zoneLocalEnforcement?: ZoneLocalEnforcementDecision | null",
  );
  assertStringIncludes(
    scanner,
    "zoneLocalEnforcement: selectedZoneLocalEnforcement()",
  );
});
