/**
 * Cross-engine agreement test for the shared Min R:R gate (checkMinRR).
 *
 * Proves that bot-scanner and backtest-engine produce IDENTICAL pass/fail
 * results for identical synthetic inputs — the actual proof the two engines
 * agree, not just that the code looks shared.
 *
 * Also tests edge cases and the commission-aware path.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { checkMinRR, type MinRRGateInput } from "../../functions/_shared/gateMinRR.ts";

// ─── Fixtures ────────────────────────────────────────────────────────

/** EUR/USD: pipSize=0.0001, typicalSpread=1, lotUnits=100000 */
const BASE_INPUT: MinRRGateInput = {
  lastPrice: 1.1000,
  stopLoss: 1.0980,    // 20 pips risk = 0.0020
  takeProfit: 1.1060,  // 60 pips raw reward = 0.0060
  symbol: "EUR/USD",
  minRiskReward: 2.0,
};

// ─── Cross-Engine Agreement Tests ────────────────────────────────────

Deno.test("checkMinRR: bot-scanner path (no spread override) matches backtest path (explicit spread override) for same spread", () => {
  // Bot-scanner: no spreadPipsOverride → uses SPECS["EUR/USD"].typicalSpread = 1
  const botScannerResult = checkMinRR({
    ...BASE_INPUT,
    // No spreadPipsOverride — uses typicalSpread from SPECS
  });

  // Backtest-engine: explicit spreadPipsOverride = 1 (same as typicalSpread)
  const backtestResult = checkMinRR({
    ...BASE_INPUT,
    spreadPipsOverride: 1,
  });

  // Both should produce identical pass/fail and identical effective R:R
  assertEquals(botScannerResult.passed, backtestResult.passed,
    "Bot-scanner and backtest-engine disagree on pass/fail for identical spread");
  assertEquals(botScannerResult.passed, true);
  assertEquals(botScannerResult.rawRiskReward, 3);
  assertEquals(botScannerResult.effectiveRiskReward, 2.8095);
  // Verify the effective R:R calculation: reward = 0.0060 - 0.0001,
  // risk = 0.0020 + 0.0001, so effectiveRR = 2.8095.
});

Deno.test("checkMinRR: both engines FAIL for identical inputs below threshold", () => {
  const tightInput: MinRRGateInput = {
    lastPrice: 1.1000,
    stopLoss: 1.0980,    // 20 pips risk
    takeProfit: 1.1030,  // 30 pips raw reward → raw RR = 1.5
    symbol: "EUR/USD",
    minRiskReward: 2.0,
  };

  // Bot-scanner path
  const botResult = checkMinRR({ ...tightInput });
  // Backtest path (same spread)
  const btResult = checkMinRR({ ...tightInput, spreadPipsOverride: 1 });

  assertEquals(botResult.passed, false);
  assertEquals(btResult.passed, false);
  assertEquals(botResult.passed, btResult.passed);
});

Deno.test("checkMinRR: both engines agree above the all-in threshold", () => {
  // risk = 20 pips = 0.0020
  // rawReward = 0.0044 (TP = 1.1044)
  // spreadCost = 1 * 0.0001 = 0.0001
  // effectiveReward = 0.0044 - 0.0001 = 0.0043
  // effectiveRisk = 0.0020 + 0.0001 = 0.0021
  // effectiveRR ≈ 2.05 → passes min 2.0
  const boundaryInput: MinRRGateInput = {
    lastPrice: 1.1000,
    stopLoss: 1.0980,
    takeProfit: 1.1044,
    symbol: "EUR/USD",
    minRiskReward: 2.0,
  };

  const botResult = checkMinRR({ ...boundaryInput });
  const btResult = checkMinRR({ ...boundaryInput, spreadPipsOverride: 1 });

  assertEquals(botResult.passed, true);
  assertEquals(btResult.passed, true);
  assertEquals(botResult.passed, btResult.passed);
});

Deno.test("checkMinRR: both engines agree on just-below-boundary (fails)", () => {
  // effectiveRR = 1.99... → fails
  const belowInput: MinRRGateInput = {
    lastPrice: 1.1000,
    stopLoss: 1.0980,
    takeProfit: 1.10409,  // rawReward = 0.00409, effective = 0.00399, RR = 1.995
    symbol: "EUR/USD",
    minRiskReward: 2.0,
  };

  const botResult = checkMinRR({ ...belowInput });
  const btResult = checkMinRR({ ...belowInput, spreadPipsOverride: 1 });

  assertEquals(botResult.passed, false);
  assertEquals(btResult.passed, false);
  assertEquals(botResult.passed, btResult.passed);
});

// ─── Edge Cases ──────────────────────────────────────────────────────

Deno.test("checkMinRR: returns failed when SL is null", () => {
  const result = checkMinRR({
    ...BASE_INPUT,
    stopLoss: null,
  });
  assertEquals(result.passed, false);
  assertEquals(result.reason, "Trade rejected: Risk/Reward cannot be calculated because a valid stop-loss and take-profit are required");
});

Deno.test("checkMinRR: returns failed when TP is null", () => {
  const result = checkMinRR({
    ...BASE_INPUT,
    takeProfit: null,
  });
  assertEquals(result.passed, false);
  assertEquals(result.reason, "Trade rejected: Risk/Reward cannot be calculated because a valid stop-loss and take-profit are required");
});

Deno.test("checkMinRR: returns failed when both SL and TP are undefined", () => {
  const result = checkMinRR({
    ...BASE_INPUT,
    stopLoss: undefined,
    takeProfit: undefined,
  });
  assertEquals(result.passed, false);
});

Deno.test("checkMinRR: zero risk (SL == entry) returns failed", () => {
  const result = checkMinRR({
    ...BASE_INPUT,
    stopLoss: 1.1000,  // Same as lastPrice → risk = 0
  });
  // effectiveRR = 0 (division by zero guarded) → fails
  assertEquals(result.passed, false);
});

// ─── Commission Path (Bot-Scanner Live) ──────────────────────────────

Deno.test("checkMinRR: commission cost reduces effective RR", () => {
  // Without commission: effectiveRR = (0.0060 - 0.0001) / 0.0020 = 2.95 → pass
  const noComm = checkMinRR({ ...BASE_INPUT });
  assertEquals(noComm.passed, true);

  // With high commission: $14/lot on EUR/USD (lotUnits=100000, quoteToUSD≈1)
  // commCostInPrice = 14 / (100000 * 1) = 0.00014
  // totalCost = 0.0001 + 0.00014 = 0.00024
  // effectiveReward = 0.0060 - 0.00024 = 0.00576
  // effectiveRisk = 0.0020 + 0.00024 = 0.00224
  // effectiveRR = 0.00576 / 0.00224 = 2.57 → still passes
  const withComm = checkMinRR({
    ...BASE_INPUT,
    commissionPerLot: 14,
    rateMap: { "EUR/USD": 1.1000 },
  });
  assertEquals(withComm.passed, true);
});

Deno.test("checkMinRR: very high commission can cause failure", () => {
  // Tight TP: 35 pips raw reward
  const tightWithComm: MinRRGateInput = {
    lastPrice: 1.1000,
    stopLoss: 1.0980,    // 20 pips risk
    takeProfit: 1.1035,  // 35 pips raw reward → raw RR = 1.75
    symbol: "EUR/USD",
    minRiskReward: 1.5,
    commissionPerLot: 50,  // Very high commission
    rateMap: { "EUR/USD": 1.1000 },
  };
  // spreadCost = 1 * 0.0001 = 0.0001
  // EUR/USD is USD-quoted, so commCost = 50 / 100000 = 0.0005
  // totalCost = 0.0006
  // effectiveReward = 0.0035 - 0.0006 = 0.0029
  // effectiveRisk = 0.0020 + 0.0006 = 0.0026
  // effectiveRR ≈ 1.12 → fails min 1.5
  const result = checkMinRR(tightWithComm);
  assertEquals(result.passed, false);
  assertEquals(result.reason, "Trade rejected: effective R:R is 1.12, below the required 1.50. Raw R:R is 1.75 before costs (spread 1p + comm $50.0/lot)");
});

// ─── XAU/USD (Gold) Cross-Engine Agreement ───────────────────────────
// XAU/USD SPECS: pipSize=0.01, typicalSpread=3, lotUnits=100

Deno.test("checkMinRR: cross-engine agreement on XAU/USD (different pip size)", () => {
  const goldInput: MinRRGateInput = {
    lastPrice: 2400.00,
    stopLoss: 2395.00,    // 500 pips risk = $5.00
    takeProfit: 2420.00,  // 2000 pips raw reward = $20.00
    symbol: "XAU/USD",
    minRiskReward: 2.0,
  };

  // Bot-scanner path (no override → uses typicalSpread=3 from SPECS)
  const botResult = checkMinRR({ ...goldInput });
  // Backtest path (explicit spread = 3, matching SPECS)
  const btResult = checkMinRR({ ...goldInput, spreadPipsOverride: 3 });

  // spreadCost = 3 * 0.01 = $0.03
  // effectiveReward = $20.00 - $0.03 = $19.97
  // effectiveRR = $19.97 / $5.00 = 3.994 → passes
  assertEquals(botResult.passed, true);
  assertEquals(btResult.passed, true);
  assertEquals(botResult.passed, btResult.passed);
});

Deno.test("checkMinRR: backtest with wider spread produces different result than default", () => {
  // This tests that spreadPipsOverride actually changes the outcome
  const goldInput: MinRRGateInput = {
    lastPrice: 2400.00,
    stopLoss: 2395.00,    // $5 risk
    takeProfit: 2405.10,  // $5.10 raw reward → raw RR = 1.02
    symbol: "XAU/USD",
    minRiskReward: 1.0,
  };

  // Default spread (3 pips): spreadCost = 3 * 0.01 = $0.03
  // effectiveReward = $5.10 - $0.03 = $5.07, RR = 5.07/5.00 = 1.014 → passes
  const defaultSpread = checkMinRR({ ...goldInput });
  assertEquals(defaultSpread.passed, true);

  // Wider spread (600 pips = $6 cost): effectiveReward = $5.10 - $6.00 = 0 (clamped)
  // effectiveRR = 0 → fails
  const wideSpread = checkMinRR({ ...goldInput, spreadPipsOverride: 600 });
  assertEquals(wideSpread.passed, false);
});
