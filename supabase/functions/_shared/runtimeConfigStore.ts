import type { RuntimeConfig } from "./configMapper.ts";
import {
  type EffectiveRuntimeConfigResolution,
  resolveEffectiveRuntimeConfig,
} from "./runtimeConfigResolver.ts";

export const RUNTIME_CONFIG_PROVENANCE_VERSION = "runtime-config.v1";

export type RuntimeConfigSource =
  | "saved_connection"
  | "saved_global"
  | "built_in_defaults";

export interface RuntimeConfigProvenance {
  contractVersion: typeof RUNTIME_CONFIG_PROVENANCE_VERSION;
  source: RuntimeConfigSource;
  configId: string | null;
  connectionId: string | null;
  updatedAt: string | null;
  rawConfigHash: string;
  effectiveConfigHash: string;
  loadedAt: string;
  criticalSettings: {
    tradingStyle: string;
    requireLiquiditySweep: boolean;
    requireUnifiedZone: boolean;
    impulseZoneGateMode: string;
    zoneLocalEnforcementMode: string;
    crossTfAuthorityMode: string;
    dealingRangeMode: string;
    minConfluence: number;
    minRiskReward: number;
    riskPerTrade: number;
    spreadFilterEnabled: boolean;
    maxSpreadPips: number;
  };
}

export interface LoadedRuntimeConfig extends EffectiveRuntimeConfigResolution {
  provenance: RuntimeConfigProvenance;
}

export interface FrozenRuntimeConfigSnapshot {
  provenance: RuntimeConfigProvenance;
  pairEffectiveConfigHash: string;
  effectiveConfig: RuntimeConfig;
}

interface RuntimeConfigClient {
  from(table: string): any;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${
    Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableSerialize(record[key])}`
    ).join(",")
  }}`;
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableSerialize(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function configReadError(scope: string, error: any): Error {
  const message = error?.message || String(error || "unknown database error");
  return new Error(
    `Runtime configuration unavailable (${scope}): ${message}`,
  );
}

async function readConfigRow(
  client: RuntimeConfigClient,
  userId: string,
  connectionId?: string,
): Promise<{ row: any; source: RuntimeConfigSource }> {
  if (connectionId) {
    const connectionResult = await client
      .from("bot_configs")
      .select("id, config_json, connection_id, updated_at")
      .eq("user_id", userId)
      .eq("connection_id", connectionId)
      .maybeSingle();
    if (connectionResult.error) {
      throw configReadError(
        `connection ${connectionId}`,
        connectionResult.error,
      );
    }
    if (connectionResult.data) {
      return { row: connectionResult.data, source: "saved_connection" };
    }
  }

  const globalResult = await client
    .from("bot_configs")
    .select("id, config_json, connection_id, updated_at")
    .eq("user_id", userId)
    .is("connection_id", null)
    .maybeSingle();
  if (globalResult.error) {
    throw configReadError("global", globalResult.error);
  }
  if (globalResult.data) {
    return { row: globalResult.data, source: "saved_global" };
  }
  return { row: null, source: "built_in_defaults" };
}

export async function loadEffectiveRuntimeConfig(
  client: RuntimeConfigClient,
  input: {
    userId: string;
    connectionId?: string;
    loadedAt?: string;
  },
): Promise<LoadedRuntimeConfig> {
  const { row, source } = await readConfigRow(
    client,
    input.userId,
    input.connectionId,
  );
  const rawConfig = row?.config_json ?? null;
  const resolution = resolveEffectiveRuntimeConfig(rawConfig);
  const effectiveConfig = resolution.config as RuntimeConfig;
  const loadedAt = input.loadedAt || new Date().toISOString();

  return {
    ...resolution,
    provenance: {
      contractVersion: RUNTIME_CONFIG_PROVENANCE_VERSION,
      source,
      configId: row?.id || null,
      connectionId: row?.connection_id || null,
      updatedAt: row?.updated_at || null,
      rawConfigHash: await sha256(rawConfig),
      effectiveConfigHash: await sha256(effectiveConfig),
      loadedAt,
      criticalSettings: {
        tradingStyle: String(resolution.style),
        requireLiquiditySweep: effectiveConfig.requireLiquiditySweep === true,
        requireUnifiedZone: effectiveConfig.requireUnifiedZone === true,
        impulseZoneGateMode: String(
          effectiveConfig.impulseZoneGateMode || "disabled",
        ),
        zoneLocalEnforcementMode: String(
          effectiveConfig.zoneLocalEnforcementMode || "observe",
        ),
        crossTfAuthorityMode: String(
          effectiveConfig.crossTfAuthorityMode || "observe",
        ),
        dealingRangeMode: String(
          effectiveConfig.dealingRangeMode || "avoid_wrong_side",
        ),
        minConfluence: Number(effectiveConfig.minConfluence),
        minRiskReward: Number(effectiveConfig.minRiskReward),
        riskPerTrade: Number(effectiveConfig.riskPerTrade),
        spreadFilterEnabled: effectiveConfig.spreadFilterEnabled === true,
        maxSpreadPips: Number(effectiveConfig.maxSpreadPips),
      },
    },
  };
}

function sanitizeRuntimeConfig(value: unknown): any {
  if (Array.isArray(value)) return value.map(sanitizeRuntimeConfig);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key, child]) =>
          !key.startsWith("_") &&
          child !== undefined &&
          typeof child !== "function"
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sanitizeRuntimeConfig(child)]),
    );
  }
  return value;
}

export async function buildFrozenRuntimeConfigSnapshot(
  loaded: LoadedRuntimeConfig,
  effectiveConfig: RuntimeConfig = loaded.config as RuntimeConfig,
): Promise<FrozenRuntimeConfigSnapshot> {
  const sanitized = sanitizeRuntimeConfig(effectiveConfig) as RuntimeConfig;
  return {
    provenance: loaded.provenance,
    pairEffectiveConfigHash: await sha256(sanitized),
    effectiveConfig: sanitized,
  };
}
