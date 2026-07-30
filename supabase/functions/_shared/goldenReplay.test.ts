// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildGoldenReplaySnapshot,
  compareGoldenReplaySnapshots,
  type GoldenReplayInput,
} from "./goldenReplay.ts";

function fixture(
  surface: GoldenReplayInput["surface"],
): GoldenReplayInput {
  return {
    surface,
    symbol: "GBP/USD",
    evaluatedAt: "2026-07-30T14:00:00Z",
    stylePolicy: {
      contractVersion: "style-policy.v1.3",
      basePolicyHash: "base-hash",
      policyHash: "pair-hash",
      style: "scalper",
    },
    direction: "long",
    directionVerdict: {
      verdict: "long",
      confidence: 80,
      shouldBlock: false,
      version: "verdict-1",
      gamePlanVersion: "plan-1",
    },
    gamePlan: {
      id: "gp-1",
      version: "plan-1",
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
      candidates: [{
        index: 0,
        direction: "long",
        condition: "Price sweeps the Asian low",
        action: "Wait for bullish displacement",
        target: 1.292,
        invalidation: "Close below 1.2810",
      }],
    },
    scoring: {
      raw: 68,
      effective: 72,
      threshold: 55,
      passed: true,
    },
    gates: [
      { passed: true, reason: "Direction OK: LONG (conf: 80%)" },
      { passed: true, reason: "Gameplan aligned: bullish" },
    ],
    execution: {
      eligible: true,
      entryPrice: 1.2845,
      stopLoss: 1.281,
      takeProfit: 1.292,
      riskReward: 2.142857,
      positionSize: 0.25,
      orderType: "market",
    },
    managementContractVersion: "management-policy.v1",
  };
}

Deno.test("identical live and backtest decisions produce one hash", async () => {
  const live = await buildGoldenReplaySnapshot(fixture("live"));
  const backtest = await buildGoldenReplaySnapshot(fixture("backtest"));
  const comparison = compareGoldenReplaySnapshots(live, backtest);

  assertEquals(live.decisionHash, backtest.decisionHash);
  assertEquals(comparison.matches, true);
  assertEquals(comparison.mismatches, []);
  assertEquals(live.coverage.complete, true);
});

Deno.test("record identities remain provenance without causing false drift", async () => {
  const liveInput = fixture("live");
  const backtestInput = fixture("backtest");
  backtestInput.gamePlan = {
    ...backtestInput.gamePlan,
    id: "in-memory-plan",
    version: "in-memory-version",
  };
  backtestInput.directionVerdict = {
    ...backtestInput.directionVerdict,
    version: null,
    gamePlanVersion: "in-memory-version",
  };

  const live = await buildGoldenReplaySnapshot(liveInput);
  const backtest = await buildGoldenReplaySnapshot(backtestInput);
  const comparison = compareGoldenReplaySnapshots(live, backtest);

  assertEquals(comparison.matches, true);
  assertEquals(live.decisionHash, backtest.decisionHash);
  assertEquals(live.provenance.gamePlanVersion, "plan-1");
  assertEquals(backtest.provenance.gamePlanVersion, "in-memory-version");
});

Deno.test("symbol and candle timestamp identify the replay observation", async () => {
  const liveInput = fixture("live");
  const backtestInput = fixture("backtest");
  backtestInput.symbol = "EUR/USD";
  backtestInput.evaluatedAt = "2026-07-30T14:05:00Z";

  const live = await buildGoldenReplaySnapshot(liveInput);
  const backtest = await buildGoldenReplaySnapshot(backtestInput);
  const comparison = compareGoldenReplaySnapshots(live, backtest);

  assertEquals(comparison.matches, false);
  assertEquals(
    comparison.mismatches.map((mismatch) => mismatch.path),
    ["symbol", "evaluatedAt"],
  );
  assert(live.decisionHash !== backtest.decisionHash);
});

Deno.test("gate wording is evidence while normalized codes drive parity", async () => {
  const liveInput = fixture("live");
  const backtestInput = fixture("backtest");
  liveInput.gates = [{ passed: false, reason: "Max positions reached: 4/4" }];
  backtestInput.gates = [{
    passed: false,
    reason: "Max Positions: currently 4, allowed 4",
  }];

  const live = await buildGoldenReplaySnapshot(liveInput);
  const backtest = await buildGoldenReplaySnapshot(backtestInput);

  assertEquals(live.decision.gates.failedCodes, ["max_positions"]);
  assertEquals(backtest.decision.gates.failedCodes, ["max_positions"]);
  assertEquals(live.decisionHash, backtest.decisionHash);
  assert(live.gateEvidence[0].reason !== backtest.gateEvidence[0].reason);
});

Deno.test("comparison pinpoints an execution mismatch", async () => {
  const live = await buildGoldenReplaySnapshot(fixture("live"));
  const changed = fixture("backtest");
  changed.execution.stopLoss = 1.282;
  const backtest = await buildGoldenReplaySnapshot(changed);
  const comparison = compareGoldenReplaySnapshots(live, backtest);

  assertEquals(comparison.matches, false);
  assertEquals(comparison.mismatches[0].path, "decision.execution.stopLoss");
  assertEquals(comparison.mismatches[0].live, 1.281);
  assertEquals(comparison.mismatches[0].backtest, 1.282);
});

Deno.test("snapshot reports missing evidence instead of claiming parity", async () => {
  const incomplete = fixture("live");
  incomplete.gamePlan = null;
  incomplete.zone = null;
  const snapshot = await buildGoldenReplaySnapshot(incomplete);

  assertEquals(snapshot.coverage.complete, false);
  assert(snapshot.coverage.missing.includes("gamePlan.state"));
  assert(snapshot.coverage.missing.includes("gamePlan.bias"));
  assert(snapshot.coverage.missing.includes("zone.state"));
});
