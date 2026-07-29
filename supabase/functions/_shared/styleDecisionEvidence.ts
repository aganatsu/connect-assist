import {
  confirmedTrend,
  determineDirectionStyleAware,
  type DirectionResult,
} from "./directionEngine.ts";
import {
  analyzeMarketStructure,
  type Candle,
  classifyInstrumentRegime,
} from "./smcAnalysis.ts";
import {
  type BoundTimeframeCandles,
  directionTimeframeLabels,
  formatAnalysisTimeframe,
  type TimeframeAuthority,
} from "./timeframeAuthority.ts";

export const STYLE_DECISION_EVIDENCE_VERSION = "style-decision-evidence.v1";

export interface DecisionLayerEvidence {
  role: "bias" | "structure" | "setup";
  timeframe: string;
  label: string;
  trend: "bullish" | "bearish" | "ranging";
  candleCount: number;
  sourceCandleTimestamp: string | null;
  available: boolean;
}

export interface DecisionRegimeEvidence {
  role: "bias" | "structure";
  timeframe: string;
  label: string;
  regime: string;
  confidence: number;
  directionalBias: string;
}

export interface StyleDecisionEvidence {
  version: typeof STYLE_DECISION_EVIDENCE_VERSION;
  style: TimeframeAuthority["style"];
  roles: TimeframeAuthority["roles"];
  labels: {
    bias: string;
    structure: string;
    setup: string;
    confirmation: string;
    refinement: string;
  };
  layers: {
    bias: DecisionLayerEvidence;
    structure: DecisionLayerEvidence;
    setup: DecisionLayerEvidence;
  };
  confirmedTrend: ReturnType<typeof confirmedTrend> | null;
  simpleDirection: DirectionResult;
  biasRegime: DecisionRegimeEvidence | null;
  structureRegime: DecisionRegimeEvidence | null;
}

export interface StyleDecisionEvidenceConfig {
  h4ChochLookback?: number;
  h1BosLookback?: number;
  h4MinBosForFallback?: number;
  confirmedTrendFibFactor?: number;
  confirmedTrendSwingLookback?: number;
  useConfirmedTrend?: boolean;
}

function lastTimestamp(candles: Candle[]): string | null {
  return candles.length > 0 ? candles[candles.length - 1].datetime : null;
}

function buildLayer(
  role: DecisionLayerEvidence["role"],
  timeframe: string,
  label: string,
  candles: Candle[],
): DecisionLayerEvidence {
  const available = candles.length >= 20;
  return {
    role,
    timeframe,
    label,
    trend: available ? analyzeMarketStructure(candles).trend : "ranging",
    candleCount: candles.length,
    sourceCandleTimestamp: lastTimestamp(candles),
    available,
  };
}

function buildRegime(
  role: DecisionRegimeEvidence["role"],
  timeframe: string,
  label: string,
  candles: Candle[],
): DecisionRegimeEvidence | null {
  if (candles.length < 20) return null;
  const regime = classifyInstrumentRegime(candles);
  return {
    role,
    timeframe,
    label,
    regime: regime.regime,
    confidence: regime.confidence,
    directionalBias: regime.directionalBias,
  };
}

/**
 * Produces the one structural evidence snapshot consumed by Gameplan,
 * Direction Verdict, thesis validation and thesis conviction.
 */
export function buildStyleDecisionEvidence(
  authority: TimeframeAuthority,
  candles: BoundTimeframeCandles<Candle>,
  config: StyleDecisionEvidenceConfig = {},
): StyleDecisionEvidence {
  const tfLabels = directionTimeframeLabels(authority);
  const labels = {
    bias: tfLabels.biasTFLabel,
    structure: tfLabels.structureTFLabel,
    setup: tfLabels.confirmTFLabel,
    confirmation: formatAnalysisTimeframe(authority.roles.confirmation),
    refinement: formatAnalysisTimeframe(authority.roles.refinement),
  };
  const simple = determineDirectionStyleAware(
    candles.bias.length >= 20 ? candles.bias : null,
    candles.structure.length >= 20 ? candles.structure : null,
    candles.setup.length >= 20 ? candles.setup : null,
    {
      h4ChochLookback: config.h4ChochLookback,
      h1BosLookback: config.h1BosLookback,
      h4MinBosForFallback: config.h4MinBosForFallback,
      fibFactor: config.confirmedTrendFibFactor,
      trendSwingLookback: config.confirmedTrendSwingLookback,
      useConfirmedTrend: config.useConfirmedTrend,
      ...tfLabels,
    },
  );
  const simpleDirection: DirectionResult = {
    direction: simple.direction,
    bias: simple.bias,
    biasSource: simple.biasSource,
    h4Retrace: simple.structureRetrace,
    h4ChochAgainst: simple.structureChochAgainst,
    h1Confirmed: simple.confirmBOS,
    reason: `[${authority.style}] ${simple.reason}`,
  };

  return {
    version: STYLE_DECISION_EVIDENCE_VERSION,
    style: authority.style,
    roles: authority.roles,
    labels,
    layers: {
      bias: buildLayer(
        "bias",
        authority.roles.bias,
        labels.bias,
        candles.bias,
      ),
      structure: buildLayer(
        "structure",
        authority.roles.structure,
        labels.structure,
        candles.structure,
      ),
      setup: buildLayer(
        "setup",
        authority.roles.setup,
        labels.setup,
        candles.setup,
      ),
    },
    confirmedTrend: candles.bias.length >= 20
      ? confirmedTrend(
        candles.bias,
        config.confirmedTrendFibFactor ?? 0.25,
        config.confirmedTrendSwingLookback ?? 5,
      )
      : null,
    simpleDirection,
    biasRegime: buildRegime(
      "bias",
      authority.roles.bias,
      labels.bias,
      candles.bias,
    ),
    structureRegime: buildRegime(
      "structure",
      authority.roles.structure,
      labels.structure,
      candles.structure,
    ),
  };
}

export function decisionEvidenceMatchesDirection(
  evidence: StyleDecisionEvidence,
  direction: "long" | "short",
): boolean | null {
  const evidenceDirection = evidence.simpleDirection?.direction;
  if (!evidenceDirection) return null;
  return evidenceDirection === direction;
}
