/**
 * gpHardGate.test.ts — Game Plan + Direction Verdict alignment tests
 * ───────────────────────────────────────────────────────────────────
 * Hard mode is an authorization gate:
 *   1. A current per-pair Game Plan must exist.
 *   2. The pair must be tradeable and directionally biased.
 *   3. The Direction Verdict must match the Game Plan bias.
 *   4. The aligned Game Plan must meet the minimum confidence.
 *
 * Run: deno test --no-check --allow-all supabase/functions/bot-scanner/gpHardGate.test.ts
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateGamePlanGate } from "../../functions/_shared/gamePlanGate.ts";
import type { SessionGamePlan } from "../../functions/_shared/gamePlan.ts";

const gamePlan = {
  plans: [
    { symbol: "GBP/USD", bias: "bearish", biasConfidence: 82, tradeable: true, state: "tradeable" },
    { symbol: "EUR/USD", bias: "bullish", biasConfidence: 70, tradeable: true, state: "tradeable" },
    { symbol: "XAU/USD", bias: "bearish", biasConfidence: 60, tradeable: true, state: "tradeable" },
    {
      symbol: "AUD/USD",
      bias: "neutral",
      biasConfidence: 90,
      tradeable: true,
      state: "tradeable",
      regime: "trending",
    },
    {
      symbol: "USD/CAD",
      bias: "bearish",
      biasConfidence: 85,
      tradeable: true,
      state: "wait",
      stateReason: "Waiting for price to reach the planned zone",
      regime: "transitional",
    },
    { symbol: "NZD/USD", bias: "bullish", biasConfidence: 85, tradeable: true, state: "tradeable", regime: "transitional" },
  ],
};

function evaluate(
  pair: string,
  direction: string,
  threshold = 75,
  mode: "off" | "soft" | "hard" = "hard",
) {
  return evaluateGamePlanGate(gamePlan as unknown as SessionGamePlan, pair, direction, mode, threshold);
}

Deno.test("GP hard alignment: blocks an opposing direction above the confidence minimum", () => {
  const result = evaluate("GBP/USD", "long");
  assertEquals(result.passed, false);
  assert(result.reason.includes("authorizes SHORT"));
  assert(result.reason.includes("Direction Verdict is LONG"));
});

Deno.test("GP hard alignment: blocks an opposing direction below the confidence minimum", () => {
  const result = evaluate("XAU/USD", "long");
  assertEquals(result.passed, false);
  assert(result.reason.includes("authorizes SHORT"));
  assert(result.reason.includes("60%"));
});

Deno.test("GP hard alignment: waits when directions align but plan confidence is below minimum", () => {
  const result = evaluate("XAU/USD", "short");
  assertEquals(result.passed, false);
  assert(result.reason.includes("directions agree on SHORT"));
  assert(result.reason.includes("below the 75% minimum"));
});

Deno.test("GP hard alignment: allows aligned direction above the confidence minimum", () => {
  const result = evaluate("GBP/USD", "short");
  assertEquals(result.passed, true);
  assert(result.reason.includes("PASSED"));
  assert(result.reason.includes("agree on SHORT"));
});

Deno.test("GP hard alignment: allows aligned direction at exact confidence boundary", () => {
  const result = evaluate("EUR/USD", "long", 70);
  assertEquals(result.passed, true);
  assert(result.reason.includes("minimum 70%"));
});

Deno.test("GP hard alignment: threshold zero removes only the confidence floor, not direction alignment", () => {
  const aligned = evaluate("XAU/USD", "short", 0);
  const opposing = evaluate("XAU/USD", "long", 0);
  assertEquals(aligned.passed, true);
  assertEquals(opposing.passed, false);
});

Deno.test("GP hard alignment: missing pair plan fails closed", () => {
  const result = evaluate("AUD/JPY", "long");
  assertEquals(result.passed, false);
  assert(result.reason.includes("no active plan exists for AUD/JPY"));
});

Deno.test("GP hard alignment: missing active Game Plan fails closed", () => {
  const result = evaluateGamePlanGate(null, "GBP/USD", "long", "hard", 75);
  assertEquals(result.passed, false);
  assert(result.reason.includes("no active Game Plan"));
});

Deno.test("GP hard alignment: neutral plan waits because no direction is authorized", () => {
  const result = evaluate("AUD/USD", "long");
  assertEquals(result.passed, false);
  assert(result.reason.includes("neutral"));
  assert(result.reason.includes("no direction is authorized"));
});

Deno.test("GP hard alignment: V2 wait state remains blocked even when direction and confidence align", () => {
  const result = evaluate("USD/CAD", "short");
  assertEquals(result.passed, false);
  assert(result.reason.includes("WAIT"));
  assert(result.reason.includes("Waiting for price"));
});

Deno.test("GP hard alignment: transitional regime waits even if a stale plan says tradeable", () => {
  const result = evaluate("NZD/USD", "long");
  assertEquals(result.passed, false);
  assert(result.reason.includes("regime is transitional"));
});

Deno.test("GP hard alignment: pair explicitly marked skip remains blocked", () => {
  const skipPlan = {
    plans: [
      {
        symbol: "GBP/USD",
        bias: "bearish",
        biasConfidence: 80,
        tradeable: false,
        state: "skip",
        skipReason: "High-impact news",
      },
    ],
  };
  const result = evaluateGamePlanGate(skipPlan as unknown as SessionGamePlan, "GBP/USD", "short", "hard", 75);
  assertEquals(result.passed, false);
  assert(result.reason.includes("marked skip"));
});

Deno.test("GP enforcement off: logs conflict without blocking", () => {
  const result = evaluate("GBP/USD", "long", 75, "off");
  assertEquals(result.passed, true);
  assertEquals(result.mode, "off");
  assert(result.reason.includes("log only"));
});

Deno.test("GP enforcement soft: scores conflict without blocking", () => {
  const result = evaluate("GBP/USD", "long", 75, "soft");
  assertEquals(result.passed, true);
  assertEquals(result.mode, "soft");
  assert(result.reason.includes("soft"));
});

Deno.test("GP hard alignment regression: GBP/CAD 64% bearish plan blocks 77% LONG verdict", () => {
  const gbpCadPlan = {
    plans: [
      {
        symbol: "GBP/CAD",
        bias: "bearish",
        biasConfidence: 64,
        tradeable: true,
        state: "tradeable",
      },
    ],
  };
  const result = evaluateGamePlanGate(gbpCadPlan as unknown as SessionGamePlan, "GBP/CAD", "long", "hard", 75);
  assertEquals(result.passed, false);
  assert(result.reason.includes("authorizes SHORT"));
  assert(result.reason.includes("Direction Verdict is LONG"));
});
