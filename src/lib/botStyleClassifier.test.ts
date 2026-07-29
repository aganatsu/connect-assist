import { describe, expect, it } from "vitest";
import {
  getScanLogMeta,
  readRuntimeStylePolicy,
  selectTradingStyle,
} from "./botStyleClassifier";

const runtimePolicy = {
  contractVersion: "style-policy.v1.1",
  basePolicyHash: "base-hash",
  policyHash: "exact-hash",
  enforcement: "observe_only",
  scope: "global",
  style: "scalper",
  symbol: null,
  resolvedAt: "2026-07-29T17:17:00.000Z",
  timeframes: {
    roles: {
      bias: "1h",
      structure: "15min",
      setup: "5min",
      confirmation: "5min",
      refinement: "1min",
    },
    runtimeEntry: "5m",
    runtimeHTF: "1h",
  },
  cadence: { scanIntervalMinutes: 5 },
  qualification: {
    minConfluence: 20,
    effectiveMinConfluence: 20,
    minRiskReward: 1.5,
    minTier1Factors: 2,
    impulseZoneGateMode: "hard",
    minZoneScore: 60,
  },
  risk: { riskPerTrade: 0.5, tpRatio: 2 },
  management: {
    breakEvenEnabled: false,
    trailingStopEnabled: true,
    partialTPEnabled: false,
    maxHoldEnabled: true,
    maxHoldHours: 4,
  },
  provenance: {
    profileAppliedToRuntime: true,
    styleApplied: ["scanIntervalMinutes=5"],
    userOverridesPreserved: ["minConfluence=20 (style wanted 40)"],
  },
};

describe("style-only UI selection", () => {
  it("changes only the selected style and preserves explicit overrides", () => {
    const original = {
      tradingStyle: { mode: "day_trader", note: "keep" },
      strategy: { confluenceThreshold: 20 },
      risk: { riskPerTrade: 0.25 },
      exit: { trailingStopEnabled: true },
    };

    const selected = selectTradingStyle(original, "scalper");

    expect(selected).toEqual({
      ...original,
      tradingStyle: { mode: "scalper", note: "keep" },
    });
    expect(original.tradingStyle.mode).toBe("day_trader");
  });
});

describe("runtime style-policy evidence", () => {
  it("reads the persisted scanner policy instead of recreating profile values", () => {
    expect(readRuntimeStylePolicy(runtimePolicy)).toMatchObject({
      style: "scalper",
      policyHash: "exact-hash",
      qualification: { effectiveMinConfluence: 20 },
    });
  });

  it("rejects incomplete or unknown policy snapshots", () => {
    expect(readRuntimeStylePolicy({ style: "scalper" })).toBeNull();
    expect(readRuntimeStylePolicy({
      ...runtimePolicy,
      style: "position_trader",
    })).toBeNull();
  });

  it("extracts meta from serialized scan details", () => {
    const meta = getScanLogMeta({
      details_json: JSON.stringify([
        { __meta: true, stylePolicy: runtimePolicy },
        { pair: "GBP/USD" },
      ]),
    });

    expect(readRuntimeStylePolicy(meta?.stylePolicy)?.style).toBe("scalper");
  });
});
