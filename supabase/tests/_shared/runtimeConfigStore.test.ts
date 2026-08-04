import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildFrozenRuntimeConfigSnapshot,
  loadEffectiveRuntimeConfig,
} from "../../functions/_shared/runtimeConfigStore.ts";

type ConfigRow = {
  id: string;
  config_json: Record<string, unknown>;
  connection_id: string | null;
  updated_at: string;
};

function makeClient(input: {
  global?: ConfigRow | null;
  connection?: ConfigRow | null;
  globalError?: string;
  connectionError?: string;
}) {
  return {
    from(table: string) {
      if (table !== "bot_configs") throw new Error(`Unexpected table ${table}`);
      const filters = new Map<string, unknown>();
      const query = {
        select() {
          return query;
        },
        eq(column: string, value: unknown) {
          filters.set(column, value);
          return query;
        },
        is(column: string, value: unknown) {
          filters.set(column, value);
          return query;
        },
        async maybeSingle() {
          const connectionId = filters.get("connection_id");
          if (connectionId === null) {
            return {
              data: input.global || null,
              error: input.globalError ? { message: input.globalError } : null,
            };
          }
          return {
            data: input.connection || null,
            error: input.connectionError
              ? { message: input.connectionError }
              : null,
          };
        },
      };
      return query;
    },
  };
}

const savedGlobal: ConfigRow = {
  id: "global-config",
  connection_id: null,
  updated_at: "2026-07-31T12:00:00.000Z",
  config_json: {
    strategy: {
      requireLiquiditySweep: true,
      requireUnifiedZone: true,
      confluenceThreshold: 42,
    },
    risk: { riskPerTrade: 0.5 },
    entry: { impulseZoneGateMode: "hard" },
    tradingStyle: { mode: "scalper" },
  },
};

Deno.test("saved liquidity-sweep requirement reaches effective config and frozen provenance", async () => {
  const loaded = await loadEffectiveRuntimeConfig(
    makeClient({ global: savedGlobal }),
    {
      userId: "user-1",
      loadedAt: "2026-07-31T12:05:00.000Z",
    },
  );

  assertEquals(loaded.config.requireLiquiditySweep, true);
  assertEquals(loaded.provenance.source, "saved_global");
  assertEquals(loaded.provenance.configId, "global-config");
  assertEquals(
    loaded.provenance.criticalSettings.requireLiquiditySweep,
    true,
  );
  assertEquals(
    loaded.provenance.criticalSettings.zoneLocalEnforcementMode,
    "observe",
  );
  const frozen = await buildFrozenRuntimeConfigSnapshot(loaded);
  assertEquals(frozen.effectiveConfig.requireLiquiditySweep, true);
  assertEquals(frozen.pairEffectiveConfigHash.length, 64);
});

Deno.test("connection config takes priority and records its source", async () => {
  const connection = {
    ...savedGlobal,
    id: "connection-config",
    connection_id: "connection-1",
    config_json: {
      ...savedGlobal.config_json,
      strategy: {
        requireLiquiditySweep: false,
        requireUnifiedZone: false,
      },
    },
  };
  const loaded = await loadEffectiveRuntimeConfig(
    makeClient({ global: savedGlobal, connection }),
    { userId: "user-1", connectionId: "connection-1" },
  );

  assertEquals(loaded.provenance.source, "saved_connection");
  assertEquals(loaded.provenance.connectionId, "connection-1");
  assertEquals(loaded.config.requireLiquiditySweep, false);
});

Deno.test("missing connection config falls back to the saved global config", async () => {
  const loaded = await loadEffectiveRuntimeConfig(
    makeClient({ global: savedGlobal, connection: null }),
    { userId: "user-1", connectionId: "connection-1" },
  );

  assertEquals(loaded.provenance.source, "saved_global");
  assertEquals(loaded.config.requireLiquiditySweep, true);
});

Deno.test("database read errors fail closed instead of resolving defaults", async () => {
  await assertRejects(
    () =>
      loadEffectiveRuntimeConfig(
        makeClient({ globalError: "database unavailable" }),
        { userId: "user-1" },
      ),
    Error,
    "Runtime configuration unavailable (global): database unavailable",
  );
});

Deno.test("missing saved config uses explicit, fingerprinted built-in defaults", async () => {
  const loaded = await loadEffectiveRuntimeConfig(
    makeClient({ global: null }),
    { userId: "new-user" },
  );

  assertEquals(loaded.provenance.source, "built_in_defaults");
  assertEquals(loaded.provenance.configId, null);
  assertEquals(loaded.config.requireLiquiditySweep, false);
  assertEquals(loaded.provenance.rawConfigHash.length, 64);
  assertEquals(loaded.provenance.effectiveConfigHash.length, 64);
});
