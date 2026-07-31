import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scanner = await Deno.readTextFile(
  "./supabase/functions/bot-scanner/index.ts",
);
const confirmationScanner = await Deno.readTextFile(
  "./supabase/functions/zone-confirmation-scanner/index.ts",
);
const refresh = await Deno.readTextFile(
  "./supabase/functions/game-plan-refresh/index.ts",
);
const configApi = await Deno.readTextFile(
  "./supabase/functions/bot-config/index.ts",
);
const configClient = await Deno.readTextFile("./src/lib/api.ts");
const configModal = await Deno.readTextFile(
  "./src/components/BotConfigModal.tsx",
);

Deno.test("all live decision surfaces use the fail-closed runtime config loader", () => {
  for (const source of [scanner, confirmationScanner, refresh, configApi]) {
    assertStringIncludes(source, "loadEffectiveRuntimeConfig");
  }
  assertFalse(
    confirmationScanner.includes(
      '.from("bot_configs").select("config_json")',
    ),
    "Fast confirmation must not use its former bot_id query/default fallback",
  );
});

Deno.test("every newly frozen scanner setup carries runtime configuration", () => {
  const builderCalls = scanner.split(
    "buildFrozenSetupStrategyContext({",
  ).slice(1);
  assertEquals(builderCalls.length, 5);
  for (const call of builderCalls) {
    assert(
      call.slice(0, 800).includes(
        "runtimeConfig: pairRuntimeConfigSnapshot",
      ),
      "Every entry path must freeze the pair-effective runtime configuration",
    );
  }
});

Deno.test("liquidity sweep enforcement state is persisted with the zone story", () => {
  for (
    const evidence of [
      "entryTriggerState: unifiedResult.liquidity?.entryTriggerState",
      "hasUnsweptEntryTrigger:",
      "requireLiquiditySweep:",
      "runtimeConfigProvenance",
      "criticalRuntimeSettings",
    ]
  ) {
    assertStringIncludes(scanner, evidence);
  }
});

Deno.test("Bot Config API exposes and verifies effective runtime configuration", () => {
  assertStringIncludes(configApi, 'if (action === "effective")');
  assertStringIncludes(configApi, "provenance: loaded.provenance");
  assertStringIncludes(
    configApi,
    "const verified = await loadEffectiveRuntimeConfig",
  );
  assertStringIncludes(configClient, "getEffective:");
  assertStringIncludes(configModal, "RUNTIME VERIFIED");
  assertStringIncludes(
    configModal,
    "criticalSettings.requireLiquiditySweep",
  );
});
