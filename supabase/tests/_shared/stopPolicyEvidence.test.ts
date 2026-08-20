import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildStopPolicyEvidenceRow,
  persistStopPolicyEvidence,
  STOP_POLICY_EVIDENCE_CONTRACT_VERSION,
  STOP_POLICY_EVIDENCE_RETENTION_DAYS,
} from "../../functions/_shared/stopPolicyEvidence.ts";

const input = {
  userId: "user-1",
  botId: "smc",
  scanCycleId: "scan-1",
  candidateId: "fvg:entity-1",
  symbol: "GBP/USD",
  direction: "long" as const,
  tradingStyle: "scalper",
  setupSource: "standalone",
  confirmationTimeframe: "5m",
  observedAt: "2026-08-19T12:00:00.000Z",
  entryPrice: 1.3525,
  structuralInvalidation: 1.35225,
  confirmationAtr: 0.00041,
  pipSize: 0.0001,
  spreadPips: 1.5,
  spreadSource: "spec_proxy" as const,
  spreadSafetyMultiplier: 1.5,
  executionFloorQuoteDistance: 0.000225,
  executionFloorSource: "spread_proxy" as const,
  currentPlan: {
    valid: true,
    stopLoss: 1.35,
    takeProfit: 1.355,
    riskReward: 1,
    takeProfitSource: "next_level",
    takeProfitFallbackReason: null,
    reason: null,
  },
  shadowPlan: {
    valid: true,
    stopLoss: 1.351885,
    takeProfit: 1.353935,
    riskReward: 1.14,
    takeProfitSource: "next_level",
    takeProfitFallbackReason: null,
    reason: null,
  },
  shadow: {
    contractVersion: "stop-policy-shadow.v1" as const,
    observationOnly: true as const,
    valid: true,
    reason: null,
    structuralDistance: 0.00025,
    noiseFloorDistance: 0.000615,
    executionFloorDistance: 0.000225,
    finalStopDistance: 0.000615,
    riskCapDistance: 0.00164,
    riskCapBreached: false,
    executionFloorSource: "spread_proxy" as const,
  },
};

Deno.test("stop-policy evidence freezes current and shadow plans side by side", () => {
  const row = buildStopPolicyEvidenceRow(input);
  assertEquals(row.contract_version, STOP_POLICY_EVIDENCE_CONTRACT_VERSION);
  assertEquals(row.candidate_id, input.candidateId);
  assertEquals(row.current_stop_loss, input.currentPlan.stopLoss);
  assertEquals(row.shadow_stop_loss, input.shadowPlan.stopLoss);
  assertEquals(row.observation_only, true);
  assertEquals(STOP_POLICY_EVIDENCE_RETENTION_DAYS, 90);
});

Deno.test("stop-policy evidence persistence ignores repeat candidate scans", async () => {
  let table = "";
  let conflict = "";
  let ignoreDuplicates = false;
  const client = {
    from(name: string) {
      table = name;
      return {
        upsert(_row: unknown, options: {
          onConflict: string;
          ignoreDuplicates: boolean;
        }) {
          conflict = options.onConflict;
          ignoreDuplicates = options.ignoreDuplicates;
          return {
            select() {
              return Promise.resolve({ data: [], error: null });
            },
          };
        },
      };
    },
  };

  const inserted = await persistStopPolicyEvidence(client, input);
  assertEquals(inserted, false);
  assertEquals(table, "stop_policy_observations");
  assertEquals(
    conflict,
    "user_id,bot_id,candidate_id,contract_version",
  );
  assertEquals(ignoreDuplicates, true);
});

Deno.test("stop-policy evidence schema is immutable and unique per candidate", () => {
  const migration = Deno.readTextFileSync(
    "supabase/migrations/20260819203000_add_stop_policy_observations.sql",
  );
  assertStringIncludes(
    migration,
    "UNIQUE (user_id, bot_id, candidate_id, contract_version)",
  );
  assertStringIncludes(
    migration,
    "RAISE EXCEPTION 'stop policy observations are immutable'",
  );

  const scanner = Deno.readTextFileSync(
    "supabase/functions/bot-scanner/index.ts",
  );
  assertStringIncludes(scanner, "await persistStopPolicyEvidence");
  assertEquals(
    scanner.includes("analysis.stopLoss = shadowResult.stopLoss"),
    false,
  );
});
