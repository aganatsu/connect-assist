import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { formatGamePlanAuthoritySummary, type SessionGamePlan } from "../functions/_shared/gamePlan.ts";

Deno.test("Gameplan Telegram summary presents current authority instead of legacy diagnostics", () => {
  const plan = {
    session: "New York", generatedAt: "2026-08-07T14:00:00Z", planVersion: "gp-v2",
    validityPolicy: { contractVersion: "gameplan-validity.v1", style: "day_trader", durationMinutes: 240, validFrom: "2026-08-07T14:00:00Z", expiresAt: "2026-08-07T18:00:00Z" },
    focusPairs: ["EUR/USD"], newsEvents: [], summary: "old",
    plans: [{
      symbol: "EUR/USD", session: "New York", bias: "bearish", biasConfidence: 72,
      biasReasoning: [], dol: { price: 1.15, type: "sell-side", description: "Previous Day Low", distancePips: 12, strength: 2 },
      keyLevels: [], scenarios: [], regime: "strong_trend", amdPhase: "distribution", zone: "premium", zonePercent: 64,
      htfTrend: "bearish", h4Trend: "bearish", atr: 0.01, tradeable: true, state: "tradeable",
      stateReason: "Direction, location, regime, and liquidity target are coherent", lastPrice: 1.16,
      generatedAt: "2026-08-07T14:00:00Z", decisionEvidence: {
        labels: { bias: "Daily", structure: "4H", setup: "1H" },
        layers: {
          bias: { label: "Daily", trend: "bearish" }, structure: { label: "4H", trend: "bearish" }, setup: { label: "1H", trend: "bearish" },
        },
      },
    }],
  } as unknown as SessionGamePlan;
  const message = formatGamePlanAuthoritySummary(plan);
  assertStringIncludes(message, "Authority:</b> gp-v2");
  assertStringIncludes(message, "EUR/USD</b> — TRADEABLE");
  assertStringIncludes(message, "Daily bearish → 4H bearish → 1H bearish");
  assertStringIncludes(message, "Entries still require the frozen zone");
  assert(!message.includes("IPDA 60d"));
});
