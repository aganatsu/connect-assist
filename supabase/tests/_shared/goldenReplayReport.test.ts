// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildGoldenReplaySnapshot,
  finalizeGoldenReplaySnapshot,
  type GoldenReplayInput,
} from "../../functions/_shared/goldenReplay.ts";
import {
  buildGoldenReplayInputFingerprint,
  buildGoldenReplayReport,
  buildGoldenReplayRuntimeInputFingerprint,
  runGoldenReplayDecisionFixture,
} from "../../functions/_shared/goldenReplayReport.ts";
import { RUNTIME_DEFAULTS } from "../../functions/_shared/configMapper.ts";
import { buildResolvedStylePolicy } from "../../functions/_shared/stylePolicy.ts";
import { applyTradingStyleProfile } from "../../functions/_shared/tradingStyleConfig.ts";

function candidate(): Omit<GoldenReplayInput, "surface" | "provenance"> {
  return {
    symbol: "GBP/USD",
    evaluatedAt: "2026-07-30T14:00:00Z",
    stylePolicy: {
      contractVersion: "style-policy.v1.3",
      basePolicyHash: "base-policy",
      policyHash: "pair-policy",
      style: "scalper",
    },
    direction: "long",
    directionVerdict: {
      verdict: "long",
      confidence: 80,
      shouldBlock: false,
    },
    gamePlan: {
      state: "tradeable",
      bias: "bullish",
      confidence: 78,
    },
    zone: {
      source: "unified",
      state: "confirmed",
      hasZone: true,
      entryReady: true,
      score: 9,
      timeframe: "5m",
      low: 1.284,
      high: 1.285,
      entry: 1.2845,
    },
    scenario: {
      enforcement: "observe_only",
      selectedScenarioIndex: null,
      candidates: [],
    },
    scoring: {
      raw: 68,
      effective: 72,
      threshold: 55,
      passed: true,
    },
    gates: [
      { passed: true, reason: "Direction aligned" },
    ],
    execution: {
      eligible: true,
      entryPrice: 1.2845,
      stopLoss: 1.281,
      takeProfit: 1.292,
      riskReward: 2.142857,
      positionSize: 0.2,
      orderType: "market",
    },
    lifecycle: {
      route: "market",
      stage: "position",
      outcome: "opened",
    },
    managementContractVersion: "management-policy.v1",
  };
}

const canonicalFingerprint = await buildGoldenReplayInputFingerprint({
  symbol: "GBP/USD",
  evaluatedAt: "2026-07-30T14:00:00Z",
  policyBaseHash: "base-policy",
  timeframeRoles: {
    bias: "1h",
    structure: "15m",
    setup: "5m",
  },
  candlesByRole: {
    setup: [{
      datetime: "2026-07-30T14:00:00Z",
      open: 1.284,
      high: 1.285,
      low: 1.2835,
      close: 1.2845,
      volume: 100,
    }],
  },
  config: {
    tradingStyle: "scalper",
    riskPerTrade: 0.5,
  },
});

const runtimeConfig = {
  ...RUNTIME_DEFAULTS,
  instruments: [...RUNTIME_DEFAULTS.instruments],
  enabledSessions: [...RUNTIME_DEFAULTS.enabledSessions],
  enabledDays: [...RUNTIME_DEFAULTS.enabledDays],
  _currentSymbol: "GBP/USD",
};
const runtimeResolution = applyTradingStyleProfile(runtimeConfig, "scalper");
const runtimeStylePolicy = await buildResolvedStylePolicy({
  resolution: runtimeResolution,
  config: runtimeResolution.config,
  baseConfig: runtimeResolution.config,
  symbol: "GBP/USD",
  resolvedAt: "2026-07-30T14:00:00Z",
});
const runtimeRoleCandles = {
  bias: [{
    datetime: "2026-07-30T13:00:00Z",
    open: 1.28,
    high: 1.29,
    low: 1.27,
    close: 1.285,
    volume: 1000,
  }],
  structure: [{
    datetime: "2026-07-30T13:45:00Z",
    open: 1.283,
    high: 1.286,
    low: 1.282,
    close: 1.285,
    volume: 500,
  }],
  setup: [{
    datetime: "2026-07-30T14:00:00Z",
    open: 1.284,
    high: 1.285,
    low: 1.2835,
    close: 1.2845,
    volume: 100,
  }],
  confirmation: [],
  refinement: [],
  runtimeEntry: [],
  runtimeHTF: [],
};

Deno.test("input fingerprint canonicalizes object keys and timestamps", async () => {
  const reordered = await buildGoldenReplayInputFingerprint({
    symbol: "GBP/USD",
    evaluatedAt: "2026-07-30T10:00:00-04:00",
    policyBaseHash: "base-policy",
    timeframeRoles: {
      setup: "5m",
      structure: "15m",
      bias: "1h",
    },
    candlesByRole: {
      setup: [{
        datetime: "2026-07-30T10:00:00-04:00",
        open: 1.284,
        high: 1.285,
        low: 1.2835,
        close: 1.2845,
        volume: 100,
      }],
    },
    config: {
      riskPerTrade: 0.5,
      tradingStyle: "scalper",
    },
  });

  assertEquals(reordered, canonicalFingerprint);
  assert(canonicalFingerprint.startsWith("golden-replay-input.v1:"));
});

Deno.test("runtime adapter fingerprints exact role candles and stable config", async () => {
  const first = await buildGoldenReplayRuntimeInputFingerprint({
    symbol: "GBP/USD",
    evaluatedAt: "2026-07-30T14:00:00Z",
    stylePolicy: runtimeStylePolicy,
    roleCandles: runtimeRoleCandles,
    runtimeConfig: {
      ...runtimeResolution.config,
      _currentSymbol: "GBP/USD",
      _smtResult: { transient: "live-derived" },
    },
  });
  const transientlyDifferent = await buildGoldenReplayRuntimeInputFingerprint({
    symbol: "GBP/USD",
    evaluatedAt: "2026-07-30T10:00:00-04:00",
    stylePolicy: {
      ...runtimeStylePolicy,
      resolvedAt: "2026-07-30T14:05:00Z",
    },
    roleCandles: runtimeRoleCandles,
    runtimeConfig: {
      ...runtimeResolution.config,
      _currentSymbol: "GBPUSD",
      _smtResult: { transient: "backtest-derived" },
    },
  });

  assertEquals(transientlyDifferent, first);
});

Deno.test("runtime adapter changes fingerprint for a consumed config or candle", async () => {
  const baseline = await buildGoldenReplayRuntimeInputFingerprint({
    symbol: "GBP/USD",
    evaluatedAt: "2026-07-30T14:00:00Z",
    stylePolicy: runtimeStylePolicy,
    roleCandles: runtimeRoleCandles,
    runtimeConfig: runtimeResolution.config,
  });
  const configChanged = await buildGoldenReplayRuntimeInputFingerprint({
    symbol: "GBP/USD",
    evaluatedAt: "2026-07-30T14:00:00Z",
    stylePolicy: runtimeStylePolicy,
    roleCandles: runtimeRoleCandles,
    runtimeConfig: {
      ...runtimeResolution.config,
      minRiskReward: runtimeResolution.config.minRiskReward + 0.25,
    },
  });
  const candleChanged = await buildGoldenReplayRuntimeInputFingerprint({
    symbol: "GBP/USD",
    evaluatedAt: "2026-07-30T14:00:00Z",
    stylePolicy: runtimeStylePolicy,
    roleCandles: {
      ...runtimeRoleCandles,
      setup: [{
        ...runtimeRoleCandles.setup[0],
        close: runtimeRoleCandles.setup[0].close + 0.0001,
      }],
    },
    runtimeConfig: runtimeResolution.config,
  });

  assert(baseline !== configChanged);
  assert(baseline !== candleChanged);
});

Deno.test("identical fingerprinted decision fixture is deterministic proof", async () => {
  const result = await runGoldenReplayDecisionFixture({
    id: "gbpusd-long",
    inputFingerprint: canonicalFingerprint,
    candidate: candidate(),
  });

  assertEquals(result.report.deterministicPass, true);
  assertEquals(result.report.summary.matches, 1);
  assertEquals(result.report.pairs[0].status, "match");
  assertEquals(result.report.pairs[0].inputVerified, true);
});

Deno.test("position-size drift is an unexpected exact-path mismatch", async () => {
  const base = candidate();
  const result = await runGoldenReplayDecisionFixture({
    id: "size-drift",
    inputFingerprint: canonicalFingerprint,
    candidate: base,
    liveFinalization: {
      execution: { ...base.execution, positionSize: 0.2 },
      lifecycle: base.lifecycle!,
    },
    backtestFinalization: {
      execution: { ...base.execution, positionSize: 0.35 },
      lifecycle: base.lifecycle!,
    },
  });

  assertEquals(result.report.deterministicPass, false);
  assertEquals(result.report.summary.unexpectedMismatches, 1);
  assertEquals(
    result.report.pairs[0].mismatches[0].path,
    "decision.execution.positionSize",
  );
  assertEquals(
    result.report.mismatchPathCounts["decision.execution.positionSize"],
    1,
  );
});

Deno.test("documented intentional difference stays visible and can pass", async () => {
  const base = candidate();
  const result = await runGoldenReplayDecisionFixture({
    id: "documented-fill-model",
    inputFingerprint: canonicalFingerprint,
    candidate: base,
    liveFinalization: {
      execution: { ...base.execution, entryPrice: 1.2846 },
      lifecycle: base.lifecycle!,
    },
    backtestFinalization: {
      execution: { ...base.execution, entryPrice: 1.2845 },
      lifecycle: base.lifecycle!,
    },
    intentionalDifferences: [{
      path: "decision.execution.entryPrice",
      reason:
        "Live uses observed broker fill; candle replay uses trigger price",
    }],
  });

  assertEquals(result.report.deterministicPass, true);
  assertEquals(result.report.summary.intentionalDifferences, 1);
  assertEquals(result.report.pairs[0].status, "intentional_difference");
  assertEquals(
    result.report.pairs[0].mismatches[0].reason,
    "Live uses observed broker fill; candle replay uses trigger price",
  );
});

Deno.test("matching decisions without input fingerprints are not deterministic proof", async () => {
  const live = await buildGoldenReplaySnapshot({
    ...candidate(),
    surface: "live",
  });
  const backtest = await buildGoldenReplaySnapshot({
    ...candidate(),
    surface: "backtest",
  });
  const report = buildGoldenReplayReport([live], [backtest]);

  assertEquals(report.deterministicPass, false);
  assertEquals(report.summary.inputUnverified, 1);
  assertEquals(report.pairs[0].status, "input_unverified");
});

Deno.test("different input fingerprints are reported before decision parity", async () => {
  const live = await buildGoldenReplaySnapshot({
    ...candidate(),
    surface: "live",
    provenance: {
      inputFingerprint: await buildGoldenReplayInputFingerprint({
        symbol: "GBP/USD",
        evaluatedAt: "2026-07-30T14:00:00Z",
        policyBaseHash: "base-policy",
        timeframeRoles: { setup: "5m" },
        candlesByRole: {
          setup: [{
            datetime: "2026-07-30T14:00:00Z",
            open: 1,
            high: 2,
            low: 0.5,
            close: 1.5,
          }],
        },
        config: {},
      }),
    },
  });
  const backtest = await buildGoldenReplaySnapshot({
    ...candidate(),
    surface: "backtest",
    provenance: {
      inputFingerprint: await buildGoldenReplayInputFingerprint({
        symbol: "GBP/USD",
        evaluatedAt: "2026-07-30T14:00:00Z",
        policyBaseHash: "base-policy",
        timeframeRoles: { setup: "5m" },
        candlesByRole: {
          setup: [{
            datetime: "2026-07-30T14:00:00Z",
            open: 1,
            high: 2,
            low: 0.5,
            close: 1.6,
          }],
        },
        config: {},
      }),
    },
  });
  const report = buildGoldenReplayReport([live], [backtest]);

  assertEquals(report.deterministicPass, false);
  assertEquals(report.summary.inputMismatches, 1);
  assertEquals(report.pairs[0].status, "input_mismatch");
});

Deno.test("missing and incomplete surfaces cannot pass", async () => {
  const complete = await buildGoldenReplaySnapshot({
    ...candidate(),
    surface: "live",
    provenance: { inputFingerprint: canonicalFingerprint },
  });
  const missingBacktest = buildGoldenReplayReport([complete], []);
  assertEquals(missingBacktest.summary.missingBacktest, 1);
  assertEquals(missingBacktest.deterministicPass, false);

  const incompleteInput = candidate();
  incompleteInput.zone = null;
  const incomplete = await buildGoldenReplaySnapshot({
    ...incompleteInput,
    surface: "backtest",
    provenance: { inputFingerprint: canonicalFingerprint },
  });
  const incompleteReport = buildGoldenReplayReport([complete], [incomplete]);
  assertEquals(incompleteReport.summary.incomplete, 1);
  assertEquals(incompleteReport.deterministicPass, false);
});

Deno.test("multiple observations pair exact hashes before lifecycle fallbacks", async () => {
  const base = candidate();
  const firstLive = await buildGoldenReplaySnapshot({
    ...base,
    surface: "live",
    provenance: { inputFingerprint: canonicalFingerprint },
  });
  const secondLive = await finalizeGoldenReplaySnapshot(firstLive, {
    execution: base.execution,
    lifecycle: {
      route: "market",
      stage: "authorization",
      outcome: "authorized",
    },
  });
  const firstBacktest = await buildGoldenReplaySnapshot({
    ...base,
    surface: "backtest",
    provenance: { inputFingerprint: canonicalFingerprint },
  });
  const secondBacktest = await finalizeGoldenReplaySnapshot(firstBacktest, {
    execution: base.execution,
    lifecycle: {
      route: "market",
      stage: "authorization",
      outcome: "authorized",
    },
  });

  const report = buildGoldenReplayReport(
    [firstLive, secondLive],
    [secondBacktest, firstBacktest],
  );

  assertEquals(report.deterministicPass, true);
  assertEquals(report.summary.matches, 2);
  assert(report.pairs.every((pair) => pair.liveHash === pair.backtestHash));
});
