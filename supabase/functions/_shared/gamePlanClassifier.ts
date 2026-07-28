export type GamePlanState = "tradeable" | "wait" | "skip";

export interface BiasEvidence {
  id: string;
  label: string;
  direction: "bullish" | "bearish" | "neutral";
  weight: number;
  available: boolean;
  contribution: number;
  reason: string;
}

export interface GamePlanConviction {
  directionalStrength: number;
  evidenceCoverage: number;
  planQuality: number;
  confidence: number;
}

export interface GamePlanClassificationInput {
  bias: "bullish" | "bearish" | "neutral";
  legacyConfidence: number;
  dailyTrend: string;
  h4Trend: string;
  zone: string;
  regime: string;
  hasDOL: boolean;
  legacyTradeable: boolean;
  legacySkipReason?: string;
  evidence: BiasEvidence[];
}

export interface GamePlanClassification {
  state: GamePlanState;
  stateReason: string;
  conviction: GamePlanConviction;
  supportingEvidence: BiasEvidence[];
  conflictingEvidence: BiasEvidence[];
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

export function classifyGamePlan(input: GamePlanClassificationInput): GamePlanClassification {
  const availableEvidence = input.evidence.filter((item) => item.available);
  const availableWeight = availableEvidence.reduce((sum, item) => sum + item.weight, 0);
  const maximumWeight = input.evidence.reduce((sum, item) => sum + item.weight, 0) || 1;
  const bullishSupport = availableEvidence
    .filter((item) => item.direction === "bullish")
    .reduce((sum, item) => sum + Math.abs(item.contribution), 0);
  const bearishSupport = availableEvidence
    .filter((item) => item.direction === "bearish")
    .reduce((sum, item) => sum + Math.abs(item.contribution), 0);
  const directionalStrength = availableWeight > 0
    ? clamp((Math.abs(bullishSupport - bearishSupport) / availableWeight) * 100)
    : 0;
  const evidenceCoverage = clamp((availableWeight / maximumWeight) * 100);

  const trendsConflict =
    input.dailyTrend !== "ranging"
    && input.h4Trend !== "ranging"
    && input.dailyTrend !== input.h4Trend;
  const locationConflicts =
    (input.bias === "bullish" && input.zone === "premium")
    || (input.bias === "bearish" && input.zone === "discount");
  const uncertainRegime = ["transitional", "ranging", "volatile", "unknown"].includes(input.regime);

  let planQuality = 100;
  if (trendsConflict) planQuality -= 25;
  if (locationConflicts) planQuality -= 25;
  if (uncertainRegime) planQuality -= 15;
  if (!input.hasDOL) planQuality -= 15;
  if (input.legacyConfidence < 55) planQuality -= 20;
  planQuality = clamp(planQuality);

  const confidence = Math.round(
    directionalStrength
    * (evidenceCoverage / 100)
    * (0.5 + (planQuality / 200)),
  );

  const supportingEvidence = availableEvidence.filter((item) => item.direction === input.bias);
  const conflictingEvidence = availableEvidence.filter(
    (item) => item.direction !== "neutral" && item.direction !== input.bias,
  );

  if (!input.legacyTradeable || input.bias === "neutral") {
    return {
      state: "skip",
      stateReason: input.legacySkipReason || "No clear directional thesis",
      conviction: { directionalStrength, evidenceCoverage, planQuality, confidence },
      supportingEvidence,
      conflictingEvidence,
    };
  }

  if (input.legacyConfidence < 40 || evidenceCoverage < 45) {
    return {
      state: "skip",
      stateReason: input.legacyConfidence < 40
        ? `Directional support ${input.legacyConfidence}% is below the 40% planning floor`
        : `Evidence coverage ${evidenceCoverage.toFixed(0)}% is below the 45% planning floor`,
      conviction: { directionalStrength, evidenceCoverage, planQuality, confidence },
      supportingEvidence,
      conflictingEvidence,
    };
  }

  const waitReasons: string[] = [];
  if (trendsConflict) waitReasons.push("D1 and 4H structure disagree");
  if (locationConflicts) waitReasons.push(`${input.bias} bias has poor ${input.zone} location`);
  if (uncertainRegime) waitReasons.push(`${input.regime} regime requires confirmation`);
  if (!input.hasDOL) waitReasons.push("no validated draw on liquidity");
  if (evidenceCoverage < 60) waitReasons.push("insufficient evidence coverage");
  if (input.legacyConfidence < 55) waitReasons.push("directional support is below 55%");

  if (waitReasons.length > 0) {
    return {
      state: "wait",
      stateReason: waitReasons.join("; "),
      conviction: { directionalStrength, evidenceCoverage, planQuality, confidence },
      supportingEvidence,
      conflictingEvidence,
    };
  }

  return {
    state: "tradeable",
    stateReason: "Direction, location, regime, and liquidity target are coherent",
    conviction: { directionalStrength, evidenceCoverage, planQuality, confidence },
    supportingEvidence,
    conflictingEvidence,
  };
}
