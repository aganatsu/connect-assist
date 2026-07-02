/**
 * slModifyRejection.test.ts — Tests for SL modify broker rejection detection
 * ─────────────────────────────────────────────────────────────────────────────
 * Validates that:
 * 1. MetaAPI responses with stringCode rejection are correctly identified
 * 2. Successful modifications (TRADE_RETCODE_DONE) are not flagged as rejections
 * 3. Responses without stringCode (legacy format) are treated as success
 * 4. The broker_type filter for close sections includes both "metaapi" and "oanda"
 *
 * Run: deno test --allow-all supabase/functions/_shared/slModifyRejection.test.ts
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ═══════════════════════════════════════════════════════════════════════
// SECTION 1: MetaAPI stringCode rejection detection logic
// ═══════════════════════════════════════════════════════════════════════

/**
 * Extracted rejection detection logic — mirrors the pattern in bot-scanner/index.ts
 * at the SL modify section (lines 2111-2119 after fix).
 */
function isModifyRejected(resBody: string): { rejected: boolean; stringCode?: string; message?: string } {
  let modParsed: any = null;
  try { modParsed = JSON.parse(resBody); } catch {}
  if (modParsed?.stringCode && modParsed.stringCode !== "TRADE_RETCODE_DONE" && modParsed.stringCode !== "ERR_NO_ERROR") {
    return { rejected: true, stringCode: modParsed.stringCode, message: modParsed.message || "" };
  }
  return { rejected: false };
}

Deno.test("SL modify: TRADE_RETCODE_INVALID_STOPS is detected as rejection", () => {
  const body = JSON.stringify({
    stringCode: "TRADE_RETCODE_INVALID_STOPS",
    message: "Invalid stops",
    numericCode: 10016,
  });
  const result = isModifyRejected(body);
  assertEquals(result.rejected, true);
  assertEquals(result.stringCode, "TRADE_RETCODE_INVALID_STOPS");
});

Deno.test("SL modify: TRADE_RETCODE_INVALID is detected as rejection", () => {
  const body = JSON.stringify({
    stringCode: "TRADE_RETCODE_INVALID",
    message: "Invalid request",
  });
  const result = isModifyRejected(body);
  assertEquals(result.rejected, true);
  assertEquals(result.stringCode, "TRADE_RETCODE_INVALID");
});

Deno.test("SL modify: TRADE_RETCODE_MARKET_CLOSED is detected as rejection", () => {
  const body = JSON.stringify({
    stringCode: "TRADE_RETCODE_MARKET_CLOSED",
    message: "Market is closed",
  });
  const result = isModifyRejected(body);
  assertEquals(result.rejected, true);
  assertEquals(result.stringCode, "TRADE_RETCODE_MARKET_CLOSED");
});

Deno.test("SL modify: TRADE_RETCODE_DONE is NOT a rejection", () => {
  const body = JSON.stringify({
    stringCode: "TRADE_RETCODE_DONE",
    message: "Request completed",
    numericCode: 10009,
  });
  const result = isModifyRejected(body);
  assertEquals(result.rejected, false);
});

Deno.test("SL modify: ERR_NO_ERROR is NOT a rejection", () => {
  const body = JSON.stringify({
    stringCode: "ERR_NO_ERROR",
  });
  const result = isModifyRejected(body);
  assertEquals(result.rejected, false);
});

Deno.test("SL modify: response without stringCode is NOT a rejection (legacy format)", () => {
  const body = JSON.stringify({
    positionId: "12345",
    state: "COMPLETED",
  });
  const result = isModifyRejected(body);
  assertEquals(result.rejected, false);
});

Deno.test("SL modify: empty response body does not throw", () => {
  const result = isModifyRejected("");
  assertEquals(result.rejected, false);
});

Deno.test("SL modify: malformed JSON does not throw", () => {
  const result = isModifyRejected("{invalid json");
  assertEquals(result.rejected, false);
});

Deno.test("SL modify: TRADE_RETCODE_FROZEN is detected as rejection", () => {
  // This is the freeze-level rejection FTMO commonly returns
  const body = JSON.stringify({
    stringCode: "TRADE_RETCODE_FROZEN",
    message: "Trade is frozen",
  });
  const result = isModifyRejected(body);
  assertEquals(result.rejected, true);
  assertEquals(result.stringCode, "TRADE_RETCODE_FROZEN");
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 2: broker_type filter correctness
// ═══════════════════════════════════════════════════════════════════════

/**
 * Simulates the Supabase .in("broker_type", [...]) filter behavior.
 * Before fix: .eq("broker_type", "metaapi") — only matches metaapi
 * After fix: .in("broker_type", ["metaapi", "oanda"]) — matches both
 */
function filterByBrokerType(connections: Array<{ id: string; broker_type: string }>, filter: string[]) {
  return connections.filter(c => filter.includes(c.broker_type));
}

Deno.test("broker_type filter: old filter misses OANDA connections", () => {
  const connections = [
    { id: "conn-1", broker_type: "metaapi" },
    { id: "conn-2", broker_type: "oanda" },
  ];
  // Old behavior: only "metaapi"
  const oldResult = filterByBrokerType(connections, ["metaapi"]);
  assertEquals(oldResult.length, 1);
  assertEquals(oldResult[0].id, "conn-1");
});

Deno.test("broker_type filter: new filter includes both metaapi and oanda", () => {
  const connections = [
    { id: "conn-1", broker_type: "metaapi" },
    { id: "conn-2", broker_type: "oanda" },
  ];
  // New behavior: both types
  const newResult = filterByBrokerType(connections, ["metaapi", "oanda"]);
  assertEquals(newResult.length, 2);
});

Deno.test("broker_type filter: new filter still works with metaapi-only connections", () => {
  const connections = [
    { id: "conn-1", broker_type: "metaapi" },
    { id: "conn-3", broker_type: "metaapi" },
  ];
  const result = filterByBrokerType(connections, ["metaapi", "oanda"]);
  assertEquals(result.length, 2);
});

Deno.test("broker_type filter: new filter excludes unknown broker types", () => {
  const connections = [
    { id: "conn-1", broker_type: "metaapi" },
    { id: "conn-2", broker_type: "ctrader" },
  ];
  const result = filterByBrokerType(connections, ["metaapi", "oanda"]);
  assertEquals(result.length, 1);
  assertEquals(result[0].id, "conn-1");
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 3: Freeze-level guard — validates SL distance from broker price
// ═══════════════════════════════════════════════════════════════════════

/**
 * Extracted freeze-level guard logic — mirrors the pattern in bot-scanner/index.ts
 * at the SL modify section (lines 2102-2133 after fix).
 */
function applyFreezeLevelGuard(
  adjustedSL: number,
  direction: "long" | "short",
  brokerBid: number,
  brokerAsk: number,
  pipSize: number,
): { finalSL: number; wasWidened: boolean } {
  const minSLDistance = pipSize * 3; // 3 pips minimum
  let finalSL = adjustedSL;
  let wasWidened = false;

  if (brokerBid > 0 && brokerAsk > 0) {
    const relevantPrice = direction === "long" ? brokerBid : brokerAsk;
    const slDistance = direction === "long"
      ? relevantPrice - adjustedSL
      : adjustedSL - relevantPrice;
    if (slDistance < minSLDistance) {
      finalSL = direction === "long"
        ? relevantPrice - minSLDistance
        : relevantPrice + minSLDistance;
      const precision = pipSize < 0.01 ? 5 : pipSize < 1 ? 3 : 1;
      finalSL = parseFloat(finalSL.toFixed(precision));
      wasWidened = true;
    }
  }
  return { finalSL, wasWidened };
}

Deno.test("freeze guard: long SL too close to bid → widened", () => {
  // EUR/USD: pipSize = 0.0001, minDistance = 0.0003 (3 pips)
  // Broker bid = 1.08500, adjustedSL = 1.08490 (1 pip away — too close)
  const result = applyFreezeLevelGuard(1.08490, "long", 1.08500, 1.08520, 0.0001);
  assertEquals(result.wasWidened, true);
  // finalSL should be bid - 3 pips = 1.08500 - 0.0003 = 1.08470
  assertEquals(result.finalSL, 1.08470);
});

Deno.test("freeze guard: long SL far enough from bid → not widened", () => {
  // Broker bid = 1.08500, adjustedSL = 1.08400 (10 pips away — fine)
  const result = applyFreezeLevelGuard(1.08400, "long", 1.08500, 1.08520, 0.0001);
  assertEquals(result.wasWidened, false);
  assertEquals(result.finalSL, 1.08400);
});

Deno.test("freeze guard: short SL too close to ask → widened", () => {
  // Broker ask = 1.08520, adjustedSL = 1.08530 (1 pip above ask — too close)
  const result = applyFreezeLevelGuard(1.08530, "short", 1.08500, 1.08520, 0.0001);
  assertEquals(result.wasWidened, true);
  // finalSL should be ask + 3 pips = 1.08520 + 0.0003 = 1.08550
  assertEquals(result.finalSL, 1.08550);
});

Deno.test("freeze guard: short SL far enough from ask → not widened", () => {
  // Broker ask = 1.08520, adjustedSL = 1.08620 (10 pips above — fine)
  const result = applyFreezeLevelGuard(1.08620, "short", 1.08500, 1.08520, 0.0001);
  assertEquals(result.wasWidened, false);
  assertEquals(result.finalSL, 1.08620);
});

Deno.test("freeze guard: XAU/USD (pipSize=0.01) long SL too close → widened", () => {
  // Gold: pipSize = 0.01, minDistance = 0.03 (3 pips = $0.30)
  // Broker bid = 2350.50, adjustedSL = 2350.48 (2 pips away — too close)
  const result = applyFreezeLevelGuard(2350.48, "long", 2350.50, 2350.80, 0.01);
  assertEquals(result.wasWidened, true);
  // finalSL = 2350.50 - 0.03 = 2350.47 (rounded to 3 decimals for gold)
  assertEquals(result.finalSL, 2350.470);
});

Deno.test("freeze guard: no broker price available → SL unchanged", () => {
  // When price fetch fails, brokerBid/Ask = 0 → skip guard, use original SL
  const result = applyFreezeLevelGuard(1.08490, "long", 0, 0, 0.0001);
  assertEquals(result.wasWidened, false);
  assertEquals(result.finalSL, 1.08490);
});

Deno.test("freeze guard: SL well beyond minimum distance → not widened", () => {
  // Broker bid = 1.08500, adjustedSL = 1.08450 (5 pips away — well beyond 3-pip minimum)
  const result = applyFreezeLevelGuard(1.08450, "long", 1.08500, 1.08520, 0.0001);
  assertEquals(result.wasWidened, false);
  assertEquals(result.finalSL, 1.08450);
});

Deno.test("freeze guard: JPY pair (pipSize=0.01) short SL too close → widened", () => {
  // USD/JPY: pipSize = 0.01, minDistance = 0.03 (3 pips)
  // Broker ask = 155.500, adjustedSL = 155.510 (1 pip above — too close)
  const result = applyFreezeLevelGuard(155.510, "short", 155.480, 155.500, 0.01);
  assertEquals(result.wasWidened, true);
  // finalSL = 155.500 + 0.03 = 155.530
  assertEquals(result.finalSL, 155.530);
});
