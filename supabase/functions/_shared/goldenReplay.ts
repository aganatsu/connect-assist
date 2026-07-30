import { normalizeRejectedGate } from "./rejectedSetupLogger.ts";

export const GOLDEN_REPLAY_CONTRACT_VERSION = "golden-replay.v1";

export type GoldenReplaySurface = "live" | "backtest";
export type GoldenReplayDirection = "long" | "short" | null;

export interface GoldenReplayGateInput {
  passed: boolean;
  reason: string;
  code?: string | null;
}

export interface GoldenReplayInput {
  surface: GoldenReplaySurface;
  symbol: string;
  evaluatedAt: string;
  stylePolicy?: {
    contractVersion?: string | null;
    basePolicyHash?: string | null;
    policyHash?: string | null;
    style?: string | null;
  } | null;
  direction: GoldenReplayDirection;
  directionVerdict?: {
    verdict?: string | null;
    confidence?: number | null;
    shouldBlock?: boolean | null;
    version?: string | null;
    gamePlanVersion?: string | null;
  } | null;
  gamePlan?: {
    id?: string | null;
    version?: string | null;
    state?: string | null;
    bias?: string | null;
    confidence?: number | null;
  } | null;
  zone?: {
    source?: string | null;
    state?: string | null;
    hasZone?: boolean | null;
    entryReady?: boolean | null;
    score?: number | null;
    timeframe?: string | null;
    low?: number | null;
    high?: number | null;
    entry?: number | null;
  } | null;
  scenario?: {
    enforcement?: string | null;
    selectedScenarioIndex?: number | null;
    candidates?: Array<{
      index?: number | null;
      direction?: string | null;
      condition?: string | null;
      action?: string | null;
      target?: number | null;
      invalidation?: string | null;
    }>;
  } | null;
  scoring: {
    raw: number | null;
    effective: number | null;
    threshold: number | null;
    passed: boolean;
  };
  gates: GoldenReplayGateInput[];
  execution: {
    eligible: boolean;
    entryPrice?: number | null;
    stopLoss?: number | null;
    takeProfit?: number | null;
    riskReward?: number | null;
    positionSize?: number | null;
    orderType?: string | null;
  };
  managementContractVersion?: string | null;
}

export interface GoldenReplaySnapshot {
  contractVersion: typeof GOLDEN_REPLAY_CONTRACT_VERSION;
  surface: GoldenReplaySurface;
  symbol: string;
  evaluatedAt: string;
  decisionHash: string;
  provenance: {
    gamePlanId: string | null;
    gamePlanVersion: string | null;
    verdictVersion: string | null;
    verdictGamePlanVersion: string | null;
  };
  decision: {
    policy: {
      contractVersion: string | null;
      basePolicyHash: string | null;
      policyHash: string | null;
      style: string | null;
    };
    direction: {
      candidate: GoldenReplayDirection;
      verdict: string | null;
      confidence: number | null;
      shouldBlock: boolean | null;
    };
    gamePlan: {
      state: string | null;
      bias: string | null;
      confidence: number | null;
    };
    zone: {
      source: string | null;
      state: string | null;
      hasZone: boolean | null;
      entryReady: boolean | null;
      score: number | null;
      timeframe: string | null;
      low: number | null;
      high: number | null;
      entry: number | null;
    };
    scenario: {
      enforcement: string;
      selectedScenarioIndex: number | null;
      candidates: Array<{
        index: number | null;
        direction: string | null;
        condition: string | null;
        action: string | null;
        target: number | null;
        invalidation: string | null;
      }>;
    };
    scoring: {
      raw: number | null;
      effective: number | null;
      threshold: number | null;
      passed: boolean;
    };
    gates: {
      allPassed: boolean;
      passedCodes: string[];
      failedCodes: string[];
    };
    execution: {
      eligible: boolean;
      entryPrice: number | null;
      stopLoss: number | null;
      takeProfit: number | null;
      riskReward: number | null;
      positionSize: number | null;
      orderType: string | null;
    };
    managementContractVersion: string | null;
  };
  gateEvidence: Array<{
    code: string;
    passed: boolean;
    reason: string;
  }>;
  coverage: {
    complete: boolean;
    missing: string[];
  };
}

export interface GoldenReplayMismatch {
  path: string;
  live: unknown;
  backtest: unknown;
}

export interface GoldenReplayComparison {
  contractVersion: typeof GOLDEN_REPLAY_CONTRACT_VERSION;
  matches: boolean;
  liveHash: string;
  backtestHash: string;
  mismatches: GoldenReplayMismatch[];
}

function finiteOrNull(value: unknown, precision = 8): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const factor = 10 ** precision;
  return Math.round(parsed * factor) / factor;
}

function normalizeTimestamp(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toISOString();
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${
    Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(",")
  }}`;
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableSerialize(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeScenario(
  scenario: GoldenReplayInput["scenario"],
): GoldenReplaySnapshot["decision"]["scenario"] {
  return {
    enforcement: scenario?.enforcement || "observe_only",
    selectedScenarioIndex: Number.isInteger(scenario?.selectedScenarioIndex)
      ? Number(scenario?.selectedScenarioIndex)
      : null,
    candidates: (scenario?.candidates || []).map((candidate) => ({
      index: Number.isInteger(candidate.index) ? Number(candidate.index) : null,
      direction: candidate.direction || null,
      condition: candidate.condition || null,
      action: candidate.action || null,
      target: finiteOrNull(candidate.target),
      invalidation: candidate.invalidation || null,
    })),
  };
}

/**
 * Produces the canonical, timestamped candidate decision used by Golden Replay.
 * Surface-specific text is retained as evidence, while the hash contains the
 * symbol, normalized candle timestamp and normalized decision values.
 */
export async function buildGoldenReplaySnapshot(
  input: GoldenReplayInput,
): Promise<GoldenReplaySnapshot> {
  const gateEvidence = input.gates.map((gate) => ({
    code: gate.code || normalizeRejectedGate(gate.reason),
    passed: gate.passed,
    reason: gate.reason,
  }));
  const passedCodes = [
    ...new Set(
      gateEvidence.filter((gate) => gate.passed).map((gate) => gate.code),
    ),
  ].sort();
  const failedCodes = [
    ...new Set(
      gateEvidence.filter((gate) => !gate.passed).map((gate) => gate.code),
    ),
  ].sort();
  const decision: GoldenReplaySnapshot["decision"] = {
    policy: {
      contractVersion: input.stylePolicy?.contractVersion || null,
      basePolicyHash: input.stylePolicy?.basePolicyHash || null,
      policyHash: input.stylePolicy?.policyHash || null,
      style: input.stylePolicy?.style || null,
    },
    direction: {
      candidate: input.direction,
      verdict: input.directionVerdict?.verdict || null,
      confidence: finiteOrNull(input.directionVerdict?.confidence, 4),
      shouldBlock: typeof input.directionVerdict?.shouldBlock === "boolean"
        ? input.directionVerdict.shouldBlock
        : null,
    },
    gamePlan: {
      state: input.gamePlan?.state || null,
      bias: input.gamePlan?.bias || null,
      confidence: finiteOrNull(input.gamePlan?.confidence, 4),
    },
    zone: {
      source: input.zone?.source || null,
      state: input.zone?.state || null,
      hasZone: typeof input.zone?.hasZone === "boolean"
        ? input.zone.hasZone
        : null,
      entryReady: typeof input.zone?.entryReady === "boolean"
        ? input.zone.entryReady
        : null,
      score: finiteOrNull(input.zone?.score, 4),
      timeframe: input.zone?.timeframe || null,
      low: finiteOrNull(input.zone?.low),
      high: finiteOrNull(input.zone?.high),
      entry: finiteOrNull(input.zone?.entry),
    },
    scenario: normalizeScenario(input.scenario),
    scoring: {
      raw: finiteOrNull(input.scoring.raw, 4),
      effective: finiteOrNull(input.scoring.effective, 4),
      threshold: finiteOrNull(input.scoring.threshold, 4),
      passed: input.scoring.passed,
    },
    gates: {
      allPassed: failedCodes.length === 0,
      passedCodes,
      failedCodes,
    },
    execution: {
      eligible: input.execution.eligible,
      entryPrice: finiteOrNull(input.execution.entryPrice),
      stopLoss: finiteOrNull(input.execution.stopLoss),
      takeProfit: finiteOrNull(input.execution.takeProfit),
      riskReward: finiteOrNull(input.execution.riskReward, 4),
      positionSize: finiteOrNull(input.execution.positionSize, 4),
      orderType: input.execution.orderType || null,
    },
    managementContractVersion: input.managementContractVersion || null,
  };
  const missing = [
    ["policy.basePolicyHash", decision.policy.basePolicyHash],
    ["direction.candidate", decision.direction.candidate],
    ["gamePlan.state", decision.gamePlan.state],
    ["gamePlan.bias", decision.gamePlan.bias],
    ["zone.state", decision.zone.state],
    ["scoring.effective", decision.scoring.effective],
    ["execution.stopLoss", decision.execution.stopLoss],
    ["execution.takeProfit", decision.execution.takeProfit],
    ["execution.positionSize", decision.execution.positionSize],
  ].filter(([, value]) => value === null).map(([path]) => String(path));
  const evaluatedAt = normalizeTimestamp(input.evaluatedAt);
  const parityEnvelope = {
    symbol: input.symbol,
    evaluatedAt,
    decision,
  };

  return {
    contractVersion: GOLDEN_REPLAY_CONTRACT_VERSION,
    surface: input.surface,
    symbol: input.symbol,
    evaluatedAt,
    decisionHash: await sha256(parityEnvelope),
    provenance: {
      gamePlanId: input.gamePlan?.id || null,
      gamePlanVersion: input.gamePlan?.version || null,
      verdictVersion: input.directionVerdict?.version || null,
      verdictGamePlanVersion: input.directionVerdict?.gamePlanVersion || null,
    },
    decision,
    gateEvidence,
    coverage: {
      complete: missing.length === 0,
      missing,
    },
  };
}

function collectMismatches(
  live: unknown,
  backtest: unknown,
  path: string,
  output: GoldenReplayMismatch[],
) {
  if (Object.is(live, backtest)) return;
  if (
    live && backtest &&
    typeof live === "object" &&
    typeof backtest === "object"
  ) {
    const liveRecord = live as Record<string, unknown>;
    const backtestRecord = backtest as Record<string, unknown>;
    const keys = [
      ...new Set([
        ...Object.keys(liveRecord),
        ...Object.keys(backtestRecord),
      ]),
    ].sort();
    for (const key of keys) {
      collectMismatches(
        liveRecord[key],
        backtestRecord[key],
        path ? `${path}.${key}` : key,
        output,
      );
    }
    return;
  }
  output.push({ path, live, backtest });
}

export function compareGoldenReplaySnapshots(
  live: GoldenReplaySnapshot,
  backtest: GoldenReplaySnapshot,
): GoldenReplayComparison {
  const mismatches: GoldenReplayMismatch[] = [];
  collectMismatches(live.symbol, backtest.symbol, "symbol", mismatches);
  collectMismatches(
    live.evaluatedAt,
    backtest.evaluatedAt,
    "evaluatedAt",
    mismatches,
  );
  collectMismatches(live.decision, backtest.decision, "decision", mismatches);
  return {
    contractVersion: GOLDEN_REPLAY_CONTRACT_VERSION,
    matches: mismatches.length === 0,
    liveHash: live.decisionHash,
    backtestHash: backtest.decisionHash,
    mismatches,
  };
}
