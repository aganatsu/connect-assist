import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SessionGamePlan } from "./gamePlan.ts";
import {
  type ActiveGamePlanRow,
  applyGamePlanValidityWindow,
  buildGamePlanConfigSnapshot,
  evaluateGamePlanReuse,
  gamePlanToScanLogDetails,
  persistActiveGamePlan,
  rowsToSessionGamePlan,
} from "./gamePlanStore.ts";

function makePlan(): SessionGamePlan {
  return {
    session: "London",
    generatedAt: "2026-07-29T10:00:00.000Z",
    focusPairs: ["GBP/CAD"],
    newsEvents: [],
    summary: "London plan",
    plans: [{
      symbol: "GBP/CAD",
      session: "London",
      bias: "bearish",
      biasConfidence: 64,
      biasReasoning: ["D1 bearish"],
      dol: null,
      keyLevels: [],
      scenarios: [{
        condition: "Rally",
        action: "Wait for rejection",
        direction: "short",
        invalidation: "Close above resistance",
      }],
      regime: "strong_trend",
      amdPhase: "distribution",
      zone: "premium",
      zonePercent: 70,
      htfTrend: "bearish",
      h4Trend: "bearish",
      atr: 0.01,
      tradeable: true,
      state: "tradeable",
      stateReason: "Coherent",
      conviction: {
        directionalStrength: 80,
        evidenceCoverage: 90,
        planQuality: 85,
        confidence: 61,
      },
      evidence: [],
      supportingEvidence: [],
      conflictingEvidence: [],
      lastPrice: 1.88,
      generatedAt: "2026-07-29T10:00:00.000Z",
      expiresAt: "2026-07-29T14:00:00.000Z",
      invalidationConditions: ["Close above resistance"],
      sourceCandleTimestamps: {
        daily: "2026-07-29T00:00:00.000Z",
        h4: "2026-07-29T08:00:00.000Z",
        entry: "2026-07-29T09:45:00.000Z",
        hourly: "2026-07-29T09:00:00.000Z",
      },
    }],
  };
}

Deno.test("active Gameplan rows reconstruct one exact immutable version", () => {
  const plan = makePlan();
  const row: ActiveGamePlanRow = {
    id: "row-gbp-cad",
    user_id: "user",
    bot_id: "smc",
    plan_version: "version-1",
    symbol: "GBP/CAD",
    session: "London",
    bias: "bearish",
    bias_confidence: "64",
    v2_conviction: plan.plans[0].conviction!,
    state: "tradeable",
    state_reason: "Coherent",
    generated_at: plan.generatedAt,
    expires_at: plan.plans[0].expiresAt!,
    invalidation_conditions: ["Close above resistance"],
    source_candle_timestamps: plan.plans[0].sourceCandleTimestamps!,
    plan_json: plan.plans[0],
    focus_pairs: plan.focusPairs,
    news_events: [],
    news_impacts: [],
    summary: plan.summary,
    generation_source: "automatic_scan",
    config_snapshot: {},
    market_data_snapshot: {},
    is_active: true,
  };

  const restored = rowsToSessionGamePlan([row]);
  assertEquals(restored?.planVersion, "version-1");
  assertEquals(restored?.source, "automatic_scan");
  assertEquals(restored?.plans[0].gamePlanId, "row-gbp-cad");
  assertEquals(restored?.plans[0].planVersion, "version-1");
  assertEquals(
    restored?.plans[0].sourceCandleTimestamps?.entry,
    "2026-07-29T09:45:00.000Z",
  );
  assertEquals(
    restored?.plans[0].invalidationConditions,
    ["Close above resistance"],
  );
});

Deno.test("style validity window and scan log event retain the same version", () => {
  const plan = applyGamePlanValidityWindow(makePlan(), {
    style: "scalper",
    lifecycle: {
      gamePlanValidityMinutes: 120,
      stagingTTLMinutes: 120,
      limitOrderExpiryMinutes: 60,
      maxConfirmationAttempts: 3,
    },
  });
  assertEquals(plan.plans[0].expiresAt, "2026-07-29T12:00:00.000Z");
  assertEquals(plan.validityPolicy?.style, "scalper");
  assertEquals(plan.validityPolicy?.durationMinutes, 120);
  assertEquals(
    plan.plans[0].validityPolicy,
    plan.validityPolicy,
  );
  plan.planVersion = "version-2";
  const event = gamePlanToScanLogDetails(plan, "manual_refresh");
  assertEquals(event.plan_version, "version-2");
  assertEquals(event.source, "manual_refresh");
  assertEquals((event.plans as any[])[0].expiresAt, plan.plans[0].expiresAt);
});

Deno.test("Gameplan reuse requires matching style, session and unexpired policy", () => {
  const plan = applyGamePlanValidityWindow(makePlan(), {
    style: "day_trader",
    lifecycle: {
      gamePlanValidityMinutes: 240,
      stagingTTLMinutes: 240,
      limitOrderExpiryMinutes: 60,
      maxConfirmationAttempts: 3,
    },
  });
  assertEquals(
    evaluateGamePlanReuse(plan, {
      session: "London",
      style: "day_trader",
      now: new Date("2026-07-29T11:00:00.000Z"),
    }).reusable,
    true,
  );
  assertEquals(
    evaluateGamePlanReuse(plan, {
      session: "London",
      style: "scalper",
      now: new Date("2026-07-29T11:00:00.000Z"),
    }).reason,
    "style changed (day_trader → scalper)",
  );
  assertEquals(
    evaluateGamePlanReuse(plan, {
      session: "New York",
      style: "day_trader",
      now: new Date("2026-07-29T11:00:00.000Z"),
    }).reason,
    "session changed (London → New York)",
  );
  assertEquals(
    evaluateGamePlanReuse(plan, {
      session: "London",
      style: "day_trader",
      now: new Date("2026-07-29T14:00:00.000Z"),
    }).reason,
    "plan expired",
  );
});

Deno.test("persistence assigns one version and durable row IDs", async () => {
  const calls: any[] = [];
  const client = {
    rpc: (_name: string, params: any) => {
      calls.push(params);
      return Promise.resolve({
        data: { rows: [{ id: "durable-row", symbol: "GBP/CAD" }] },
        error: null,
      });
    },
  };
  const saved = await persistActiveGamePlan(client, makePlan(), {
    userId: "user",
    botId: "smc",
    source: "automatic_scan",
    configSnapshot: buildGamePlanConfigSnapshot({
      instruments: ["GBP/CAD"],
      entryTimeframe: "15m",
    }),
  });

  assertEquals(calls.length, 1);
  assertEquals(calls[0].p_plan_version, saved.planVersion);
  assertEquals(saved.plans[0].planVersion, saved.planVersion);
  assertEquals(saved.plans[0].gamePlanId, "durable-row");
});

Deno.test("persistence fails closed when activation RPC fails", async () => {
  const client = {
    rpc: () =>
      Promise.resolve({
        data: null,
        error: { message: "migration missing" },
      }),
  };
  await assertRejects(
    () =>
      persistActiveGamePlan(client, makePlan(), {
        userId: "user",
        botId: "smc",
        source: "manual_refresh",
        configSnapshot: {},
      }),
    Error,
    "Could not activate Gameplan version",
  );
});
