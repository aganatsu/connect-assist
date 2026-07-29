import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mapNestedToFlat } from "./configMapper.ts";
import { applyTradingStyleProfile } from "./tradingStyleConfig.ts";
import {
  buildResolvedStylePolicy,
  STYLE_POLICY_CONTRACT_VERSION,
  STYLE_TIMEFRAME_ROLES,
} from "./stylePolicy.ts";

Deno.test("style policy records the intended timeframe hierarchy for each style", () => {
  assertEquals(STYLE_TIMEFRAME_ROLES.scalper, {
    bias: "1h",
    structure: "15min",
    setup: "5min",
    confirmation: "5min",
    refinement: "1min",
  });
  assertEquals(STYLE_TIMEFRAME_ROLES.day_trader.bias, "1day");
  assertEquals(STYLE_TIMEFRAME_ROLES.swing_trader, {
    bias: "1week",
    structure: "1day",
    setup: "4h",
    confirmation: "1h",
    refinement: "15min",
  });
});

Deno.test("identical effective policy content produces a stable fingerprint", async () => {
  const resolution = applyTradingStyleProfile(
    mapNestedToFlat({
      tradingStyle: { mode: "scalper" },
      strategy: { confluenceThreshold: 64 },
    }),
  );
  const first = await buildResolvedStylePolicy({
    resolution,
    symbol: "GBP/USD",
    resolvedAt: "2026-07-29T12:00:00.000Z",
  });
  const second = await buildResolvedStylePolicy({
    resolution,
    symbol: "GBP/USD",
    resolvedAt: "2026-07-29T13:00:00.000Z",
  });

  assertEquals(first.contractVersion, STYLE_POLICY_CONTRACT_VERSION);
  assertEquals(first.enforcement, "observe_only");
  assertEquals(first.scope, "pair");
  assertEquals(first.provenance.profileAppliedToRuntime, true);
  assertEquals(first.policyHash, second.policyHash);
  assertEquals(first.basePolicyHash, second.basePolicyHash);
  assertNotEquals(first.resolvedAt, second.resolvedAt);
});

Deno.test("policy discloses when a surface observed but did not apply the profile", async () => {
  const resolution = applyTradingStyleProfile(
    mapNestedToFlat({ tradingStyle: { mode: "scalper" } }),
  );
  const policy = await buildResolvedStylePolicy({
    resolution,
    config: mapNestedToFlat({ tradingStyle: { mode: "scalper" } }),
    profileAppliedToRuntime: false,
  });

  assertEquals(policy.provenance.profileAppliedToRuntime, false);
  assertEquals(policy.timeframes.runtimeEntry, "15min");
  assertEquals(policy.timeframes.roles.confirmation, "5min");
});

Deno.test("policy fingerprint changes when an effective user override changes", async () => {
  const defaultResolution = applyTradingStyleProfile(
    mapNestedToFlat({ tradingStyle: { mode: "day_trader" } }),
  );
  const overrideResolution = applyTradingStyleProfile(
    mapNestedToFlat({
      tradingStyle: { mode: "day_trader" },
      risk: { riskPerTrade: 1.75 },
      exit: { trailingStopPips: 22 },
    }),
  );
  const baseline = await buildResolvedStylePolicy({
    resolution: defaultResolution,
  });
  const changed = await buildResolvedStylePolicy({
    resolution: overrideResolution,
  });

  assertNotEquals(baseline.policyHash, changed.policyHash);
  assertEquals(changed.risk.riskPerTrade, 1.75);
  assertStringIncludes(
    changed.provenance.userOverridesPreserved.join(" "),
    "trailingStopPips=22",
  );
});

Deno.test("pair policy records effective thresholds without mutating config", async () => {
  const resolution = applyTradingStyleProfile(
    mapNestedToFlat({ tradingStyle: { mode: "swing_trader" } }),
  );
  const original = resolution.config.minConfluence;
  const policy = await buildResolvedStylePolicy({
    resolution,
    config: { ...resolution.config, minConfluence: 48 },
    baseConfig: resolution.config,
    symbol: "GBP/CAD",
    effectiveMinConfluence: 52,
  });

  assertEquals(policy.symbol, "GBP/CAD");
  assertEquals(policy.qualification.minConfluence, 48);
  assertEquals(policy.qualification.effectiveMinConfluence, 52);
  assertEquals(resolution.config.minConfluence, original);
});

Deno.test("global and pair policies share a comparable base fingerprint", async () => {
  const resolution = applyTradingStyleProfile(
    mapNestedToFlat({ tradingStyle: { mode: "scalper" } }),
  );
  const globalPolicy = await buildResolvedStylePolicy({ resolution });
  const gbpPolicy = await buildResolvedStylePolicy({
    resolution,
    config: {
      ...resolution.config,
      slBufferPips: resolution.config.slBufferPips * 1.2,
    },
    baseConfig: resolution.config,
    symbol: "GBP/USD",
    effectiveMinConfluence: resolution.config.minConfluence + 2,
  });
  const goldPolicy = await buildResolvedStylePolicy({
    resolution,
    config: {
      ...resolution.config,
      slBufferPips: resolution.config.slBufferPips * 2,
    },
    baseConfig: resolution.config,
    symbol: "XAU/USD",
    effectiveMinConfluence: resolution.config.minConfluence + 5,
  });

  assertEquals(globalPolicy.scope, "global");
  assertEquals(globalPolicy.policyHash, globalPolicy.basePolicyHash);
  assertEquals(gbpPolicy.basePolicyHash, globalPolicy.basePolicyHash);
  assertEquals(goldPolicy.basePolicyHash, globalPolicy.basePolicyHash);
  assertNotEquals(gbpPolicy.policyHash, globalPolicy.policyHash);
  assertNotEquals(goldPolicy.policyHash, gbpPolicy.policyHash);
});
