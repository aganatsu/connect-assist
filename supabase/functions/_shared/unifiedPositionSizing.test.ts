import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computePositionSize,
  calculatePositionRisk,
  canOpenNewTrade,
  type SizingInput,
  type PortfolioContext,
  type VolatilityContext,
  type PropFirmContext,
  type OpenPositionRisk,
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

// ─── Portfolio Heat Tests ────────────────────────────────────────────

Deno.test("computePositionSize rejects when portfolio heat exceeds limit", () => {
  const portfolio: PortfolioContext = {
    openPositions: [
      { symbol: "GBP/JPY", direction: "long", riskUSD: 300, lots: 0.3 },
      { symbol: "AUD/CAD", direction: "short", riskUSD: 350, lots: 0.4 },
    ],
    maxPortfolioHeat: 6.0, // 6% of $10k = $600
  };

  const result = computePositionSize(baseInput, portfolio);
  assertEquals(result.rejected, true);
  assertEquals(result.lots, 0);
  assertEquals(result.rejectionReason?.includes("Portfolio heat"), true);
});

Deno.test("computePositionSize reduces size when approaching heat limit", () => {
  const portfolio: PortfolioContext = {
    openPositions: [
      { symbol: "GBP/JPY", direction: "long", riskUSD: 400, lots: 0.3 },
    ],
    maxPortfolioHeat: 6.0, // 6% = $600, remaining = $200 = 2% of balance
  };

  // Requesting 1% risk ($100) with only 2% remaining → should still fit
  const result = computePositionSize(baseInput, portfolio);
  assertEquals(result.rejected, false);
  assertEquals(result.lots > 0, true);
});

Deno.test("computePositionSize reduces size when trade exceeds remaining heat", () => {
  const portfolio: PortfolioContext = {
    openPositions: [
      { symbol: "GBP/JPY", direction: "long", riskUSD: 550, lots: 0.3 },
    ],
    maxPortfolioHeat: 6.0, // 6% = $600, remaining = $50 = 0.5% of balance
  };

  // Requesting 1% risk but only 0.5% remaining → should be halved
  const result = computePositionSize(baseInput, portfolio);
  assertEquals(result.rejected, false);
  assertEquals(result.lots < 0.5, true); // Less than base 0.5 lots
  assertEquals(result.adjustments.some(a => a.type === "portfolio_heat"), true);
});

// ─── Correlation Tests ───────────────────────────────────────────────

Deno.test("computePositionSize rejects when correlated exposure exceeds limit", () => {
  const portfolio: PortfolioContext = {
    openPositions: [
      { symbol: "GBP/USD", direction: "long", riskUSD: 200, lots: 0.2 },
      { symbol: "AUD/USD", direction: "long", riskUSD: 150, lots: 0.15 },
    ],
    maxPortfolioHeat: 10.0,
    maxCorrelatedExposure: 3.0, // 3% = $300, current correlated = $350
  };

  // EUR/USD is in same group as GBP/USD and AUD/USD (USD_STRENGTH)
  const result = computePositionSize(baseInput, portfolio);
  assertEquals(result.rejected, true);
  assertEquals(result.rejectionReason?.includes("Correlated"), true);
});

Deno.test("computePositionSize allows uncorrelated pairs", () => {
  const portfolio: PortfolioContext = {
    openPositions: [
      { symbol: "USD/JPY", direction: "long", riskUSD: 200, lots: 0.2 },
    ],
    maxPortfolioHeat: 10.0,
    maxCorrelatedExposure: 3.0,
  };

  // EUR/USD is in USD_STRENGTH group, USD/JPY is in JPY_WEAKNESS group
  // They share no group (EUR/USD is not in JPY_WEAKNESS)
  const input: SizingInput = { ...baseInput, symbol: "AUD/CAD" };
  const result = computePositionSize(input, portfolio);
  assertEquals(result.rejected, false);
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
  const portfolio: PortfolioContext = {
    openPositions: [
      { symbol: "GBP/JPY", direction: "long", riskUSD: 400, lots: 0.3 },
    ],
    maxPortfolioHeat: 6.0,
  };
  const volatility: VolatilityContext = { regime: "high", atrPercentile: 80 };
  const propFirm: PropFirmContext = { enabled: true, sizeMultiplier: 0.8 };

  const result = computePositionSize(baseInput, portfolio, volatility, propFirm);
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

// ─── canOpenNewTrade Tests ───────────────────────────────────────────

Deno.test("canOpenNewTrade allows when under limits", () => {
  const positions: OpenPositionRisk[] = [
    { symbol: "GBP/JPY", direction: "long", riskUSD: 100, lots: 0.1 },
  ];
  const result = canOpenNewTrade(10000, 1.0, positions, "EUR/USD");
  assertEquals(result.allowed, true);
});

Deno.test("canOpenNewTrade rejects when heat exceeded", () => {
  const positions: OpenPositionRisk[] = [
    { symbol: "GBP/JPY", direction: "long", riskUSD: 300, lots: 0.3 },
    { symbol: "AUD/CAD", direction: "short", riskUSD: 350, lots: 0.4 },
  ];
  const result = canOpenNewTrade(10000, 1.0, positions, "EUR/USD", 6.0);
  assertEquals(result.allowed, false);
  assertEquals(result.reason?.includes("Portfolio heat"), true);
});

Deno.test("canOpenNewTrade rejects when correlated exposure exceeded", () => {
  const positions: OpenPositionRisk[] = [
    { symbol: "GBP/USD", direction: "long", riskUSD: 200, lots: 0.2 },
    { symbol: "AUD/USD", direction: "long", riskUSD: 150, lots: 0.15 },
  ];
  const result = canOpenNewTrade(10000, 1.0, positions, "EUR/USD", 10.0, 3.0);
  assertEquals(result.allowed, false);
  assertEquals(result.reason?.includes("Correlated"), true);
});
