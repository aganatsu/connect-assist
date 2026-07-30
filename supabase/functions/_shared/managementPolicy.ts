import type { ManagementDecisionConfig } from "./computeManagementDecision.ts";
import {
  extractGlobalExitConfig,
  parseTradeOverrides,
  type ResolvedTradeConfig,
  resolveTradeConfig,
} from "./resolveTradeConfig.ts";
import { readFrozenSetupStrategyContext } from "./setupLifecycle.ts";
import type { ResolvedStylePolicy } from "./stylePolicy.ts";

export const MANAGEMENT_POLICY_CONTRACT_VERSION = "management-policy.v1";

export type ManagementPolicySource =
  | "frozen_setup"
  | "position_snapshot"
  | "runtime_legacy";

export interface ResolvedManagementPolicy {
  contractVersion: typeof MANAGEMENT_POLICY_CONTRACT_VERSION;
  source: ManagementPolicySource;
  stylePolicyVersion: string | null;
  stylePolicyHash: string | null;
  basePolicyHash: string | null;
  tradingStyle: string;
  decision: ManagementDecisionConfig;
  partialTPPercent: number;
  partialTPLevel: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function parseSignalReason(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function intentValue(
  intent: Record<string, unknown>,
  preferred: string,
  legacy: string,
): unknown {
  return intent[preferred] ?? intent[legacy];
}

function buildExitConfig(
  runtimeConfig: Record<string, unknown>,
  stylePolicy: ResolvedStylePolicy | null,
  intent: Record<string, unknown>,
): ResolvedTradeConfig {
  const runtime = extractGlobalExitConfig(runtimeConfig);
  const management = asRecord(stylePolicy?.management);
  return {
    breakEvenEnabled: booleanValue(
      intentValue(intent, "breakEvenEnabled", "breakEven"),
      booleanValue(management.breakEvenEnabled, runtime.breakEvenEnabled),
    ),
    breakEvenPips: finiteNumber(
      intentValue(intent, "breakEvenPips", "breakEvenPips"),
      finiteNumber(management.breakEvenPips, runtime.breakEvenPips),
    ),
    breakEvenOffsetPips: Math.max(
      0,
      finiteNumber(
        intentValue(intent, "breakEvenOffsetPips", "breakEvenOffsetPips"),
        finiteNumber(
          management.breakEvenOffsetPips,
          runtime.breakEvenOffsetPips,
        ),
      ),
    ),
    trailingStopEnabled: booleanValue(
      intentValue(intent, "trailingStopEnabled", "trailingStop"),
      booleanValue(
        management.trailingStopEnabled,
        runtime.trailingStopEnabled,
      ),
    ),
    trailingStopPips: finiteNumber(
      intentValue(intent, "trailingStopPips", "trailingStopPips"),
      finiteNumber(management.trailingStopPips, runtime.trailingStopPips),
    ),
    trailingStopActivation: stringValue(
      intentValue(
        intent,
        "trailingStopActivation",
        "trailingStopActivation",
      ),
      stringValue(
        management.trailingStopActivation,
        runtime.trailingStopActivation,
      ),
    ),
    partialTPEnabled: booleanValue(
      intentValue(intent, "partialTPEnabled", "partialTP"),
      booleanValue(management.partialTPEnabled, runtime.partialTPEnabled),
    ),
    partialTPPercent: finiteNumber(
      intentValue(intent, "partialTPPercent", "partialTPPercent"),
      finiteNumber(management.partialTPPercent, runtime.partialTPPercent),
    ),
    partialTPLevel: finiteNumber(
      intentValue(intent, "partialTPLevel", "partialTPLevel"),
      finiteNumber(management.partialTPLevel, runtime.partialTPLevel),
    ),
    maxHoldEnabled: booleanValue(
      intentValue(intent, "maxHoldEnabled", "maxHoldEnabled"),
      booleanValue(management.maxHoldEnabled, runtime.maxHoldEnabled),
    ),
    maxHoldHours: finiteNumber(
      intentValue(intent, "maxHoldHours", "maxHoldHours"),
      finiteNumber(management.maxHoldHours, runtime.maxHoldHours),
    ),
  };
}

function resolveFromStylePolicy(
  stylePolicy: ResolvedStylePolicy | null,
  runtimeConfig: Record<string, unknown>,
  intent: Record<string, unknown>,
  overrides: unknown,
  source: ManagementPolicySource,
): ResolvedManagementPolicy {
  const management = asRecord(stylePolicy?.management);
  const runtimeStyle = asRecord(runtimeConfig.tradingStyle);
  const exit = resolveTradeConfig(
    buildExitConfig(runtimeConfig, stylePolicy, intent),
    parseTradeOverrides(overrides),
  );
  return {
    contractVersion: MANAGEMENT_POLICY_CONTRACT_VERSION,
    source,
    stylePolicyVersion: stylePolicy?.contractVersion || null,
    stylePolicyHash: stylePolicy?.policyHash || null,
    basePolicyHash: stylePolicy?.basePolicyHash || null,
    tradingStyle: stringValue(
      stylePolicy?.style,
      stringValue(runtimeStyle.mode, "day_trader"),
    ),
    decision: {
      breakEvenEnabled: exit.breakEvenEnabled,
      breakEvenPips: exit.breakEvenPips,
      breakEvenOffsetPips: exit.breakEvenOffsetPips,
      trailingStopEnabled: exit.trailingStopEnabled,
      trailingStopPips: exit.trailingStopPips,
      trailingStopActivation: exit.trailingStopActivation,
      partialTPEnabled: exit.partialTPEnabled,
      maxHoldEnabled: exit.maxHoldEnabled,
      maxHoldHours: exit.maxHoldHours,
      structureInvalidationEnabled: booleanValue(
        management.structureInvalidationEnabled,
        booleanValue(runtimeConfig.structureInvalidationEnabled, false),
      ),
      adaptiveTrailingEnabled: booleanValue(
        management.adaptiveTrailingEnabled,
        booleanValue(runtimeConfig.adaptiveTrailingEnabled, false),
      ),
      baseTrailATRMultiple: finiteNumber(
        management.baseTrailATRMultiple,
        finiteNumber(runtimeConfig.baseTrailATRMultiple, 1.5),
      ),
      momentumFadeThreshold: finiteNumber(
        management.momentumFadeThreshold,
        finiteNumber(runtimeConfig.momentumFadeThreshold, 0.4),
      ),
      trailTightenFactor: finiteNumber(
        management.trailTightenFactor,
        finiteNumber(runtimeConfig.trailTightenFactor, 0.6),
      ),
      trailWidenFactor: finiteNumber(
        management.trailWidenFactor,
        finiteNumber(runtimeConfig.trailWidenFactor, 1.3),
      ),
      tradingStyle: stringValue(
        stylePolicy?.style,
        stringValue(runtimeStyle.mode, "day_trader"),
      ),
    },
    partialTPPercent: exit.partialTPPercent,
    partialTPLevel: exit.partialTPLevel,
  };
}

/**
 * Resolves the management policy for an open live/paper position.
 *
 * New positions prefer the immutable setup snapshot. Legacy positions prefer
 * the entry-time exitFlags intent before falling back to today's Bot Config.
 * Per-trade overrides remain the only supported way to intentionally alter an
 * already-open position.
 */
export function resolvePositionManagementPolicy(
  position: Record<string, unknown>,
  runtimeConfig: Record<string, unknown>,
): ResolvedManagementPolicy {
  const signalReason = parseSignalReason(position.signal_reason);
  const frozen = readFrozenSetupStrategyContext(position);
  const intent = asRecord(
    position.exit_flags ||
      signalReason.exitFlags,
  );
  if (frozen) {
    return resolveFromStylePolicy(
      frozen.stylePolicy,
      runtimeConfig,
      intent,
      position.trade_overrides,
      "frozen_setup",
    );
  }
  if (Object.keys(intent).length > 0) {
    const decisionContext = asRecord(signalReason.decisionContext);
    const savedPolicy = asRecord(
      position.style_policy ||
        decisionContext.stylePolicy ||
        signalReason.stylePolicy,
    ) as unknown as ResolvedStylePolicy;
    return resolveFromStylePolicy(
      savedPolicy?.policyHash ? savedPolicy : null,
      runtimeConfig,
      intent,
      position.trade_overrides,
      "position_snapshot",
    );
  }
  return resolveFromStylePolicy(
    null,
    runtimeConfig,
    {},
    position.trade_overrides,
    "runtime_legacy",
  );
}

/**
 * Freezes the same management projection for a backtest position.
 */
export function resolveBacktestManagementPolicy(
  stylePolicy: ResolvedStylePolicy,
  runtimeConfig: Record<string, unknown>,
): ResolvedManagementPolicy {
  return resolveFromStylePolicy(
    stylePolicy,
    runtimeConfig,
    {},
    null,
    "frozen_setup",
  );
}
