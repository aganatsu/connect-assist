// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { RUNTIME_DEFAULTS } from "../../functions/_shared/configMapper.ts";
import { runConfluenceAnalysis } from "../../functions/_shared/confluenceScoring.ts";
import {
  buildGoldenReplayRuntimeInputFingerprint,
  runGoldenReplayDecisionFixture,
} from "../../functions/_shared/goldenReplayReport.ts";
import { buildResolvedStylePolicy } from "../../functions/_shared/stylePolicy.ts";
import { applyTradingStyleProfile } from "../../functions/_shared/tradingStyleConfig.ts";
import {
  applyFinalCandidateSizeAdjustments,
  computePositionSize,
  resolveSizingVolatilityContext,
} from "../../functions/_shared/unifiedPositionSizing.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const SYMBOL = "EUR/USD";
const EVALUATED_AT = "2026-07-22T09:45:00.000Z";
const EXPECTED_INPUT_FINGERPRINT =
  "golden-replay-input.v1:0127e3a1ee87f00d52ddf704479ef3132fa71609db4babd59df4af64b0635c22";
const EXPECTED_DECISION_HASH =
  "3e07d8887e7fa21209a7af099f2cf86f9aa2de3615fed97ea6cd6019631327f8";

function makeCandles(
  count: number,
  start: string,
  stepMinutes: number,
  startPrice: number,
  drift: number,
): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  const startMs = Date.parse(start);
  for (let index = 0; index < count; index++) {
    price += drift + Math.sin(index * 0.3) * drift * 0.75;
    const range = Math.max(0.0004, Math.abs(drift) * 12);
    const open = price - range * 0.2;
    const close = price + range * 0.3;
    candles.push({
      datetime: new Date(startMs + index * stepMinutes * 60_000)
        .toISOString(),
      open: Number(open.toFixed(6)),
      high: Number((close + range * 0.3).toFixed(6)),
      low: Number((open - range * 0.3).toFixed(6)),
      close: Number(close.toFixed(6)),
      volume: 1_000 + index,
    });
  }
  return candles;
}

const runtimeEntry = makeCandles(
  200,
  "2026-07-20T08:00:00Z",
  15,
  1.075,
  0.00004,
);
const daily = makeCandles(
  40,
  "2026-06-13T00:00:00Z",
  1_440,
  1.06,
  0.001,
);
const structure = makeCandles(
  80,
  "2026-07-09T05:45:00Z",
  240,
  1.066,
  0.0002,
);
const setup = makeCandles(
  120,
  "2026-07-17T10:45:00Z",
  60,
  1.07,
  0.00008,
);
const refinement = makeCandles(
  180,
  "2026-07-21T18:50:00Z",
  5,
  1.078,
  0.000015,
);

const configured = {
  ...RUNTIME_DEFAULTS,
  instruments: [SYMBOL],
  enabledSessions: ["london", "newyork"],
  enabledDays: [1, 2, 3, 4, 5],
  htfBiasRequired: false,
  minConfluence: 10,
  riskPerTrade: 1,
  standaloneMultiplier: 0.5,
  _currentSymbol: SYMBOL,
  _overrideDirection: "long",
};
const styleResolution = applyTradingStyleProfile(configured, "day_trader");
const runtimeConfig = {
  ...styleResolution.config,
  _currentSymbol: SYMBOL,
  _overrideDirection: "long",
};
const stylePolicy = await buildResolvedStylePolicy({
  resolution: styleResolution,
  config: runtimeConfig,
  baseConfig: styleResolution.config,
  symbol: SYMBOL,
  effectiveMinConfluence: runtimeConfig.minConfluence,
  resolvedAt: EVALUATED_AT,
});
const roleCandles = {
  bias: daily,
  structure,
  setup,
  confirmation: runtimeEntry,
  refinement,
  runtimeEntry,
  runtimeHTF: daily,
};

const analysis = runConfluenceAnalysis(
  runtimeEntry,
  daily,
  runtimeConfig,
  setup,
  Date.parse(EVALUATED_AT),
);
if (
  analysis.direction !== "long" || analysis.stopLoss == null ||
  analysis.takeProfit == null
) {
  throw new Error("Golden Replay fixture did not produce an executable long");
}

const sizing = computePositionSize(
  {
    balance: 10_000,
    riskPercent: runtimeConfig.riskPerTrade,
    entryPrice: analysis.lastPrice,
    stopLoss: analysis.stopLoss,
    symbol: SYMBOL,
    method: runtimeConfig.positionSizingMethod,
    fixedLotSize: runtimeConfig.fixedLotSize,
    atrValue: (analysis as { atrValue?: number }).atrValue,
    atrVolatilityMultiplier: runtimeConfig.atrVolatilityMultiplier,
    rateMap: { [SYMBOL]: 1 },
    commissionPerLot: 7,
  },
  undefined,
  resolveSizingVolatilityContext(analysis.regimeInfo),
  undefined,
);
const finalSize = applyFinalCandidateSizeAdjustments({
  lots: sizing.lots,
  correlationMultiplier: 0.75,
  signalSource: "unified",
  standaloneMultiplier: runtimeConfig.standaloneMultiplier,
});

const liveFingerprint = await buildGoldenReplayRuntimeInputFingerprint({
  symbol: SYMBOL,
  evaluatedAt: EVALUATED_AT,
  stylePolicy,
  roleCandles,
  runtimeConfig,
});
const backtestFingerprint = await buildGoldenReplayRuntimeInputFingerprint({
  symbol: SYMBOL,
  evaluatedAt: EVALUATED_AT,
  stylePolicy: {
    ...stylePolicy,
    resolvedAt: "2026-07-30T21:45:00Z",
  },
  roleCandles,
  runtimeConfig: {
    ...runtimeConfig,
    _currentSymbol: "EURUSD",
  },
});

const finalExecution = {
  eligible: true,
  entryPrice: analysis.lastPrice,
  stopLoss: analysis.stopLoss,
  takeProfit: analysis.takeProfit,
  riskReward: Math.abs(analysis.takeProfit - analysis.lastPrice) /
    Math.abs(analysis.lastPrice - analysis.stopLoss),
  positionSize: finalSize.lots,
  orderType: "market",
};
const result = await runGoldenReplayDecisionFixture({
  id: "phase7-final-eurusd",
  inputFingerprint: liveFingerprint,
  candidate: {
    symbol: SYMBOL,
    evaluatedAt: EVALUATED_AT,
    stylePolicy,
    direction: analysis.direction,
    directionVerdict: {
      verdict: "long",
      confidence: 88,
      shouldBlock: false,
    },
    gamePlan: {
      state: "tradeable",
      bias: "bullish",
      confidence: 82,
    },
    zone: {
      source: "unified",
      state: "confirmed",
      hasZone: true,
      entryReady: true,
      score: 11,
      timeframe: "1h",
      low: analysis.lastPrice - 0.0008,
      high: analysis.lastPrice + 0.0002,
      entry: analysis.lastPrice,
    },
    scenario: {
      enforcement: "observe_only",
      selectedScenarioIndex: null,
      candidates: [{
        index: 0,
        direction: "long",
        condition: "Price confirms the unified bullish zone",
        action: "Enter after confirmation",
        target: analysis.takeProfit,
        invalidation: "Close below the unified zone",
      }],
    },
    scoring: {
      raw: analysis.score,
      effective: analysis.score,
      threshold: runtimeConfig.minConfluence,
      passed: analysis.score >= runtimeConfig.minConfluence,
    },
    gates: [
      {
        code: "direction_alignment",
        passed: true,
        reason: "Direction aligned",
      },
      { code: "gameplan_alignment", passed: true, reason: "Gameplan aligned" },
      { code: "zone_confirmation", passed: true, reason: "Zone confirmed" },
      { code: "risk_reward", passed: true, reason: "Risk reward passed" },
    ],
    execution: {
      ...finalExecution,
      positionSize: null,
      orderType: null,
    },
    lifecycle: {
      route: "candidate",
      stage: "authorization",
      outcome: "approved",
    },
    managementContractVersion: "management-policy.v1",
  },
  liveFinalization: {
    execution: finalExecution,
    lifecycle: {
      route: "market",
      stage: "position",
      outcome: "opened",
      reason: "Controlled live adapter finalization",
    },
    provenance: {
      candidateId: "fixture-live",
      positionId: "fixture-live-position",
    },
  },
  backtestFinalization: {
    execution: finalExecution,
    lifecycle: {
      route: "market",
      stage: "position",
      outcome: "opened",
      reason: "Controlled backtest adapter finalization",
    },
    provenance: {
      candidateId: "fixture-backtest",
      positionId: "fixture-backtest-position",
    },
  },
});

Deno.test("Phase 7 final fixture uses identical canonical runtime inputs", () => {
  assertEquals(backtestFingerprint, liveFingerprint);
  assertEquals(liveFingerprint, EXPECTED_INPUT_FINGERPRINT);
});

Deno.test("Phase 7 final fixture produces complete matching decisions", () => {
  assertEquals(result.live.coverage, { complete: true, missing: [] });
  assertEquals(result.backtest.coverage, { complete: true, missing: [] });
  assertEquals(result.live.decisionHash, result.backtest.decisionHash);
  assertEquals(result.live.decisionHash, EXPECTED_DECISION_HASH);
  assertEquals(result.live.decision.execution.positionSize, 0.29);
  assertEquals(analysis.score, 10.2);
});

Deno.test("Phase 7 final Golden Replay report passes deterministically", () => {
  assertEquals(result.report.deterministicPass, true);
  assertEquals(result.report.summary, {
    liveSnapshots: 1,
    backtestSnapshots: 1,
    paired: 1,
    matches: 1,
    intentionalDifferences: 0,
    unexpectedMismatches: 0,
    incomplete: 0,
    inputMismatches: 0,
    inputUnverified: 0,
    missingLive: 0,
    missingBacktest: 0,
  });
  assertEquals(result.report.pairs[0].status, "match");
  assert(result.report.pairs[0].inputVerified);
});
