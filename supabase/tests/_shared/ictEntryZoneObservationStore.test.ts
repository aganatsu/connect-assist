import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildICTEntryZoneObservationRow } from "../../functions/_shared/ictEntryZoneObservationStore.ts";

Deno.test("ICT entry zone observation persists the authority counterfactual", () => {
  const row = buildICTEntryZoneObservationRow({
    userId: "user",
    botId: "smc",
    scanCycleId: "scan",
    symbol: "EUR/USD",
    tradingStyle: "day_trader",
    observedAt: "2026-08-05T12:00:00.000Z",
    legacyBestZone: {
      zone: {
        poi: { type: "ob", low: 1.1, high: 1.101 },
        localConfluence: { candidateId: "legacy-ob" },
      },
    } as any,
    authority: {
      contractVersion: "ict-entry-zone-authority.v1",
      enforcement: "observe_only",
      selected: {
        id: "ob+fvg",
        type: "ob_fvg",
        direction: "bullish",
        low: 1.1005,
        high: 1.101,
        score: 9,
        componentIds: ["ob", "fvg"],
        validationTrade: {
          entryPrice: 1.1005,
          stopLoss: 1.099,
          takeProfit: 1.11,
        },
      },
      ranked: [],
      explanation: "test",
    } as any,
  });
  assertEquals(row?.legacy_candidate_id, "legacy-ob");
  assertEquals(row?.authority_zone_type, "ob_fvg");
  assertEquals(row?.disagreed, true);
  assertEquals(row?.entry_price, 1.1005);
  assertEquals(row?.setup_family, "impulse");
});

Deno.test("structure POI forward evidence freezes comparable geometry and provenance", () => {
  const row = buildICTEntryZoneObservationRow({
    setupFamily: "structure_poi",
    userId: "user", botId: "smc", scanCycleId: "scan",
    symbol: "EUR/USD", tradingStyle: "scalper",
    observedAt: "2026-08-30T12:00:00.000Z",
    stylePolicyVersion: "style-policy.v1",
    styleBasePolicyHash: "base-hash", stylePolicyHash: "policy-hash",
    authority: {
      contractVersion: "ict-entry-zone-authority.v1", enforcement: "observe_only",
      affectsAuthorization: false, mode: "structure_poi", setupFamily: "structure_poi",
      contextId: "structure:EUR/USD:bullish:15m:closed-bar",
      timeframes: { setup: "5m", structure: "15m", confirmation: "5m" },
      selected: {
        contractVersion: "ict-entry-zone-authority.v1", enforcement: "observe_only",
        affectsAuthorization: false, mode: "structure_poi", setupFamily: "structure_poi",
        id: "structure_poi:ob:one", contextId: "structure:EUR/USD:bullish:15m:closed-bar",
        type: "ob", direction: "bullish", low: 1.1, high: 1.101,
        entryPrice: 1.101, structuralInvalidation: 1.1, timeframe: "15m",
        timeframeRoles: ["structure"], componentIds: ["ob:one"],
        sourceEvidenceIds: ["evidence:one"],
        sourceWindow: { start: "2026-08-30T10:00:00.000Z", end: "2026-08-30T10:15:00.000Z" },
        components: ["ob"], eligible: true, score: 7,
        priceInsideZone: false, distanceToZone: 0.002,
        reasons: ["closed-bar source evidence only"],
      },
      ranked: [], explanation: "test", componentCounts: { received: 1, accepted: 1 },
    },
    validationTrade: { entryPrice: 1.101, stopLoss: 1.098, takeProfit: 1.107 },
    geometryFailureReason: null, minimumRiskReward: 1.5,
    spreadPips: 1, spreadSource: "instrument_typical", commissionPerLot: 0,
    rateMap: {},
    currentImpulseDecision: { hasExecutableZone: false, reason: "No accepted impulse-owned entry zone" },
    decisionObservations: {
      location: { available: true, allowed: true }, liquidity: { sequenceCount: 0 },
      confirmation: { evaluated: false, reason: "zone_touch_pending" },
      thesis: { valid: true }, safety: { evaluated: false, reason: "observation_only" },
    },
    timeframeEvidenceId: "timeframe-evidence-id",
    candleSnapshotRefs: [
      { scanCycleId: "scan", symbol: "EUR/USD", timeframe: "5m" },
      { scanCycleId: "scan", symbol: "EUR/USD", timeframe: "15m" },
    ],
  } as any);

  assertExists(row);
  assertEquals(row.setup_family, "structure_poi");
  assertEquals(
    row.opportunity_key,
    "structure_poi:EUR/USD:structure_poi:ob:one:policy-hash:1.101:1.098:1.107",
  );
  assertEquals(row.comparison_status, "comparable");
  assertEquals(row.authority_candidate_id, "structure_poi:ob:one");
  assertEquals(row.source_evidence_ids, ["evidence:one"]);
  assertEquals(row.style_policy_hash, "policy-hash");
  assertEquals(row.gross_risk_reward, 2);
  assertEquals(row.effective_risk_reward, 1.9032);
  assertEquals(row.risk_reward_passed, true);
  assertEquals(row.timeframe_evidence_id, "timeframe-evidence-id");
  assertEquals(row.outcome_status, "pending");
});

Deno.test("structure POI evidence records unavailable geometry without inventing an outcome", () => {
  const row = buildICTEntryZoneObservationRow({
    setupFamily: "structure_poi",
    userId: "user", botId: "smc", scanCycleId: "scan",
    symbol: "EUR/USD", tradingStyle: "scalper",
    observedAt: "2026-08-30T12:00:00.000Z",
    stylePolicyVersion: null, styleBasePolicyHash: null, stylePolicyHash: null,
    authority: {
      selected: {
        id: "structure_poi:fvg:one", type: "fvg", direction: "bearish",
        low: 1.1, high: 1.101, score: 5, componentIds: ["fvg:one"],
        sourceEvidenceIds: ["evidence:one"],
        sourceWindow: { start: "2026-08-30T10:00:00.000Z", end: "2026-08-30T10:15:00.000Z" },
        timeframeRoles: ["setup"],
      },
      timeframes: { setup: "5m", structure: "15m", confirmation: "5m" },
    },
    validationTrade: null, geometryFailureReason: "No viable take-profit target",
    minimumRiskReward: 1.5, spreadPips: 1,
    spreadSource: "instrument_typical", commissionPerLot: 0, rateMap: {},
    currentImpulseDecision: { hasExecutableZone: false },
    decisionObservations: {}, timeframeEvidenceId: null, candleSnapshotRefs: [],
  } as any);

  assertExists(row);
  assertEquals(row.comparison_status, "geometry_unavailable");
  assertEquals(row.geometry_failure_reason, "No viable take-profit target");
  assertEquals(row.entry_price, null);
  assertEquals(row.outcome_status, "unavailable");
});
