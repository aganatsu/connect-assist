import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computePositionSize,
  calculatePositionRisk,
  type SizingInput,
  type VolatilityContext,
  type PropFirmContext,
} from "./unifiedPositionSizing.ts";

// ─── Base Sizing Tests ───────────────────────────────────────────────

const baseInput: SizingInput = {
  balance: 10000,
  riskPercent: 1.0,
  entryPrice: 1.10000,
  stopLoss: 1.09800,
  symbol: "EUR/USD",
};

Deno.test("computePositionSize calculates correct base size for EUR/USD", () => {
  const result = computePositionSize(baseInput);
  // Risk = $100 (1% of $10k)
  // SL distance = 20 pips = 0.00200
  // Lot value per pip = $10 (100000 * 0.0001)
  // Lots = $100 / (20 pips * $10/pip) = 0.50
  assertEquals(result.lots, 0.5);
  assertEquals(result.rejected, false);
  assertEquals(result.baseLots, 0.5);
  assertEquals(result.adjustments.length, 0);
});

Deno.test("computePositionSize handles fixed_lot method", () => {
  const input: SizingInput = { ...baseInput, method: "fixed_lot", fixedLotSize: 0.25 };
  const result = computePositionSize(input);
  assertEquals(result.lots, 0.25);
  assertEquals(result.baseLots, 0.25);
});

Deno.test("computePositionSize handles zero SL distance gracefully", () => {
  const input: SizingInput = { ...baseInput, stopLoss: 1.10000 }; // Same as entry
  const result = computePositionSize(input);
  assertEquals(result.lots, 0.01); // Minimum lot
});

Deno.test("computePositionSize respects minimum lot of 0.01", () => {
  const input: SizingInput = {
    ...baseInput,
    balance: 100, // Tiny account
    riskPercent: 0.5,
    stopLoss: 1.09000, // 100 pips SL
  };
  const result = computePositionSize(input);
  assertEquals(result.lots >= 0.01, true);
});

// ─── Volatility Regime Tests ─────────────────────────────────────────

Deno.test("computePositionSize reduces size in high volatility", () => {
  const volatility: VolatilityContext = { regime: "high", atrPercentile: 85 };
  const result = computePositionSize(baseInput, undefined, volatility);

  assertEquals(result.lots, 0.38); // 0.5 * 0.75 = 0.375 → Math.round(0.375*100)/100 = 0.38
  assertEquals(result.adjustments.some(a => a.type === "volatility"), true);
});

Deno.test("computePositionSize halves size in extreme volatility", () => {
  const volatility: VolatilityContext = { regime: "extreme", atrPercentile: 95 };
  const result = computePositionSize(baseInput, undefined, volatility);

  assertEquals(result.lots, 0.25); // 0.5 * 0.5 = 0.25
});

Deno.test("computePositionSize does not adjust in normal volatility", () => {
  const volatility: VolatilityContext = { regime: "normal", atrPercentile: 50 };
  const result = computePositionSize(baseInput, undefined, volatility);

  assertEquals(result.lots, 0.5); // No change
  assertEquals(result.adjustments.length, 0);
});

// ─── Prop Firm Tests ─────────────────────────────────────────────────

Deno.test("computePositionSize applies prop firm size multiplier", () => {
  const propFirm: PropFirmContext = {
    enabled: true,
    sizeMultiplier: 0.5,
  };

  const result = computePositionSize(baseInput, undefined, undefined, propFirm);
  assertEquals(result.lots, 0.25); // 0.5 * 0.5
  assertEquals(result.adjustments.some(a => a.type === "prop_firm"), true);
});

Deno.test("computePositionSize caps to daily loss remaining", () => {
  const propFirm: PropFirmContext = {
    enabled: true,
    dailyLossRemaining: 50, // Only $50 left
  };

  // Base would be 0.5 lots risking $100, but only $50 allowed
  const result = computePositionSize(baseInput, undefined, undefined, propFirm);
  assertEquals(result.lots, 0.25); // Halved to fit $50 limit
});

Deno.test("computePositionSize does nothing when prop firm disabled", () => {
  const propFirm: PropFirmContext = {
    enabled: false,
    sizeMultiplier: 0.1, // Should be ignored
  };

  const result = computePositionSize(baseInput, undefined, undefined, propFirm);
  assertEquals(result.lots, 0.5); // Unchanged
});

// ─── Combined Adjustments Tests ──────────────────────────────────────

Deno.test("computePositionSize applies multiple adjustments in sequence", () => {
  const volatility: VolatilityContext = { regime: "high", atrPercentile: 80 };
  const propFirm: PropFirmContext = { enabled: true, sizeMultiplier: 0.8 };

  const result = computePositionSize(baseInput, undefined, volatility, propFirm);
  // Multiple adjustments should stack
  assertEquals(result.adjustments.length >= 2, true);
  assertEquals(result.lots < 0.5, true); // Definitely reduced from base
  assertEquals(result.rejected, false);
});

// ─── calculatePositionRisk Tests ─────────────────────────────────────

Deno.test("calculatePositionRisk computes correct risk for EUR/USD", () => {
  const risk = calculatePositionRisk("EUR/USD", 1.10000, 1.09800, 0.5);
  // Risk = 0.00200 * 100000 * 0.5 * 1.0 (quoteToUSD for EUR/USD ≈ 1)
  assertAlmostEquals(risk, 100, 5); // ~$100
});

Deno.test("calculatePositionRisk handles short positions", () => {
  const risk = calculatePositionRisk("EUR/USD", 1.10000, 1.10200, 0.5);
  // Same distance, same risk regardless of direction
  assertAlmostEquals(risk, 100, 5);
});

// ─── Min-Lot Floor Budget Guard Tests ────────────────────────────────

Deno.test("min-lot floor rejects when 0.01 lots would exceed prop-firm daily loss budget", () => {
  // XAU/USD with very tight prop firm budget:
  // dailyLossRemaining = $5
  // XAU/USD: lotUnits=100, entry 2000, SL 1950 → distance=50
  // Risk at 0.01 lots = 50 * 100 * 0.01 * 1.0 = $50
  // hardCapUSD from prop firm = $5
  // $50 > $5 → REJECTED
  const propFirm: PropFirmContext = {
    enabled: true,
    dailyLossRemaining: 5,
  };

  const input: SizingInput = {
    balance: 10000,
    riskPercent: 0.1,
    entryPrice: 2000.00,
    stopLoss: 1950.00,
    symbol: "XAU/USD",
  };

  const result = computePositionSize(input, undefined, undefined, propFirm);
  assertEquals(result.rejected, true);
  assertEquals(result.rejectionReason?.includes("remaining risk budget"), true);
  assertEquals(result.adjustments.some(a => a.type === "min_lot_floor"), true);
});
