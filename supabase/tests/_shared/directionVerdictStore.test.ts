import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  directionVerdictMatchesGamePlan,
  directionVerdictRowToDecision,
  loadActiveDirectionVerdicts,
  persistActiveDirectionVerdict,
} from "./directionVerdictStore.ts";

const row = {
  id: "33333333-3333-4333-8333-333333333333",
  verdict_version: "44444444-4444-4444-8444-444444444444",
  user_id: "55555555-5555-4555-8555-555555555555",
  bot_id: "smc",
  symbol: "GBP/CAD",
  game_plan_id: "22222222-2222-4222-8222-222222222222",
  game_plan_version: "11111111-1111-4111-8111-111111111111",
  verdict: "short" as const,
  confidence: "78",
  agreement: "0.8",
  should_block: false,
  block_reason: null,
  score_adjustment: "2.4",
  verdict_json: { summary: "SHORT" },
  source_candle_timestamp: "2026-07-29T10:00:00.000Z",
  evaluated_at: "2026-07-29T10:05:00.000Z",
  expires_at: "2026-07-29T10:25:00.000Z",
  scan_cycle_id: "scan-1",
  is_active: true,
};

Deno.test("stored Direction Verdict reconstructs its exact versions", () => {
  const result = directionVerdictRowToDecision(row);
  assertEquals(result.id, row.id);
  assertEquals(result.verdictVersion, row.verdict_version);
  assertEquals(result.gamePlanVersion, row.game_plan_version);
  assertEquals(result.confidence, 78);
});

Deno.test("Direction Verdict must reference the active Gameplan version", () => {
  const verdict = directionVerdictRowToDecision(row);
  const plan = {
    planVersion: row.game_plan_version,
    plans: [{
      symbol: row.symbol,
      planVersion: row.game_plan_version,
    }],
  } as any;
  assertEquals(
    directionVerdictMatchesGamePlan(verdict, plan, row.symbol),
    true,
  );
  plan.planVersion = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  plan.plans[0].planVersion = plan.planVersion;
  assertEquals(
    directionVerdictMatchesGamePlan(verdict, plan, row.symbol),
    false,
  );
});

Deno.test("active Direction Verdict loader returns a symbol map", async () => {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    gt: async () => ({ data: [row], error: null }),
  };
  const result = await loadActiveDirectionVerdicts(
    { from: () => builder },
    row.user_id,
    row.bot_id,
    new Date("2026-07-29T10:10:00.000Z"),
  );
  assertEquals(result.get(row.symbol)?.verdict, "short");
});

Deno.test("Direction Verdict persistence fails closed when RPC returns no row", async () => {
  await assertRejects(
    () =>
      persistActiveDirectionVerdict(
        {
          rpc: async () => ({
            data: { activated: true },
            error: null,
          }),
        },
        {
          userId: row.user_id,
          botId: row.bot_id,
          symbol: row.symbol,
          verdict: {
            verdict: "short",
            confidence: 78,
            agreement: 0.8,
            shouldBlock: false,
            blockReason: null,
            scoreAdjustment: 2.4,
            sources: [],
            summary: "SHORT",
          },
          gamePlan: null,
        },
      ),
    Error,
    "database returned no row",
  );
});
