/**
 * gpHardGate.test.ts — GP Hard Gate Stopgap Behavior Tests
 * ─────────────────────────────────────────────────────────
 * Tests the conditional hard block on counter-bias trades when
 * GP bias confidence >= gpHardBlockThreshold.
 *
 * These tests verify the gate logic in isolation by simulating
 * the gate decision that bot-scanner/index.ts makes at line ~5621.
 *
 * Run: deno test --no-check --allow-all supabase/functions/bot-scanner/gpHardGate.test.ts
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateGamePlanGate } from "../_shared/gamePlanGate.ts";

// ─── Test fixtures ──────────────────────────────────────────────────
const gamePlanBearish82 = {
  plans: [
    { symbol: "GBP/USD", bias: "bearish", biasConfidence: 82, tradeable: true },
    { symbol: "EUR/USD", bias: "bullish", biasConfidence: 70, tradeable: true },
    { symbol: "XAU/USD", bias: "bearish", biasConfidence: 60, tradeable: true },
  ],
};

function evaluate(pair: string, direction: string, threshold = 75, mode: "off" | "soft" | "hard" = "hard") {
  return evaluateGamePlanGate(gamePlanBearish82 as any, pair, direction, mode, threshold);
}

// ─── Tests ──────────────────────────────────────────────────────────

Deno.test("GP hard gate: blocks counter-bias trade when confidence >= threshold (82% >= 75%)", () => {
  const result = evaluate("GBP/USD", "long");
  assertEquals(result.passed, false);
  assert(result.reason.includes("hard block"));
  assert(result.reason.includes("82%"));
});

Deno.test("GP hard gate: allows counter-bias trade when confidence < threshold (60% < 75%)", () => {
  const result = evaluate("XAU/USD", "long");
  assertEquals(result.passed, true);
  assert(result.reason.includes("soft"));
  assert(result.reason.includes("60%"));
});

Deno.test("GP hard gate: allows aligned trade regardless of confidence", () => {
  // EUR/USD is bullish 70%, going long = aligned
  const result = evaluate("EUR/USD", "long");
  assertEquals(result.passed, true);
  assert(result.reason.includes("aligns"));
});

Deno.test("GP hard gate: threshold=0 disables the gate entirely (allows all)", () => {
  const result = evaluate("GBP/USD", "long", 0);
  assertEquals(result.passed, true);
  assert(result.reason.includes("below threshold"));
});

Deno.test("GP hard gate: exact threshold boundary (70% >= 70% → blocks)", () => {
  // EUR/USD bearish direction would be "short" against bullish 70%
  const result = evaluate("EUR/USD", "short", 70);
  assertEquals(result.passed, false);
  assert(result.reason.includes("hard block"));
  assert(result.reason.includes("70%"));
});

Deno.test("GP hard gate: just below threshold (70% < 71% → allows)", () => {
  const result = evaluate("EUR/USD", "short", 71);
  assertEquals(result.passed, true);
  assert(result.reason.includes("soft"));
});

Deno.test("GP hard gate: pair not in game plan → always passes", () => {
  const result = evaluate("AUD/JPY", "long");
  assertEquals(result.passed, true);
  assert(result.reason.includes("No game plan for AUD/JPY"));
});

Deno.test("GP hard gate: null game plan → always passes", () => {
  const result = evaluateGamePlanGate(null, "GBP/USD", "long", "hard", 75);
  // filterTradeByGamePlan returns allowed:true when gamePlan is null
  assertEquals(result.passed, true);
});

Deno.test("GP hard gate: regression — today's GBP/USD trade would have been blocked", () => {
  // Exact scenario from Jul 27 2026: GBP/USD long against 82% bearish bias
  const todayPlan = {
    plans: [
      { symbol: "GBP/USD", bias: "bearish", biasConfidence: 82, tradeable: true },
    ],
  };
  const result = evaluateGamePlanGate(todayPlan as any, "GBP/USD", "long", "hard", 75);
  assertEquals(result.passed, false);
  assert(result.reason.includes("hard block"));
  assert(result.reason.includes("82%"));
  assert(result.reason.includes("75%"));
});

Deno.test("GP enforcement off: logs an 82% conflict without blocking", () => {
  const result = evaluate("GBP/USD", "long", 75, "off");
  assertEquals(result.passed, true);
  assertEquals(result.mode, "off");
  assert(result.reason.includes("log only"));
});

Deno.test("GP enforcement soft: scores an 82% conflict without blocking", () => {
  const result = evaluate("GBP/USD", "long", 75, "soft");
  assertEquals(result.passed, true);
  assertEquals(result.mode, "soft");
  assert(result.reason.includes("soft"));
});

Deno.test("GP enforcement hard: blocks a pair explicitly marked skip", () => {
  const skipPlan = {
    plans: [
      {
        symbol: "GBP/USD",
        bias: "bearish",
        biasConfidence: 40,
        tradeable: false,
        skipReason: "High-impact news",
      },
    ],
  };
  const result = evaluateGamePlanGate(skipPlan as any, "GBP/USD", "long", "hard", 75);
  assertEquals(result.passed, false);
  assert(result.reason.includes("marked skip"));
});
