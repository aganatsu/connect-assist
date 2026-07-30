// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildGoldenReplaySnapshot,
  finalizeGoldenReplaySnapshot,
  type GoldenReplayInput,
} from "./goldenReplay.ts";
import {
  buildGoldenReplayInputFingerprint,
  buildGoldenReplayReport,
  runGoldenReplayDecisionFixture,
} from "./goldenReplayReport.ts";

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
