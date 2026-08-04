import { assertEquals, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  checkPortfolioConflict,
  computePearsonCorrelation,
  computeCurrencyExposure,
  decomposePair,
  getCorrelation,
  getDirectionalCorrelation,
  computeCorrelationMatrix,
  STATIC_CORRELATIONS,
  type OpenPosition,
  type CandidateTrade,
} from "./portfolioCorrelation.ts";

// ─── Pearson Correlation Tests ───────────────────────────────────────

Deno.test("computePearsonCorrelation returns ~1 for perfectly correlated series", () => {
  const pricesA = Array.from({ length: 50 }, (_, i) => 1.1000 + i * 0.0010);
  const pricesB = Array.from({ length: 50 }, (_, i) => 1.3000 + i * 0.0015);
  const corr = computePearsonCorrelation(pricesA, pricesB)!;
  assertAlmostEquals(corr, 1.0, 0.01);
});

Deno.test("computePearsonCorrelation returns ~-1 for inversely correlated series", () => {
  // Reciprocal series: B = 1/A gives perfect -1 correlation in log returns
  const pricesA = Array.from({ length: 50 }, (_, i) => 1.1000 + i * 0.0010);
  const pricesB = pricesA.map((p) => 1.0 / p);
  const corr = computePearsonCorrelation(pricesA, pricesB)!;
  assertAlmostEquals(corr, -1.0, 0.01);
});

Deno.test("computePearsonCorrelation returns null for insufficient data", () => {
  const pricesA = [1.1, 1.2, 1.3];
  const pricesB = [1.3, 1.4, 1.5];
  assertEquals(computePearsonCorrelation(pricesA, pricesB), null);
});

Deno.test("computePearsonCorrelation returns ~0 for uncorrelated series", () => {
  // Alternating up/down vs steady up
  const pricesA = Array.from({ length: 50 }, (_, i) => 1.1000 + (i % 2 === 0 ? 0.001 : -0.001) * (i + 1));
  const pricesB = Array.from({ length: 50 }, (_, i) => 1.1000 + i * 0.0010);
  const corr = computePearsonCorrelation(pricesA, pricesB)!;
  // Should be close to 0 (not perfectly 0 due to noise)
  assertEquals(Math.abs(corr) < 0.5, true, `Expected near 0, got ${corr}`);
});

// ─── Currency Decomposition Tests ────────────────────────────────────

Deno.test("decomposePair correctly decomposes long EUR/USD", () => {
  const result = decomposePair("EUR/USD", "long", 0.5);
  assertEquals(result["EUR"], 0.5);
  assertEquals(result["USD"], -0.5);
});

Deno.test("decomposePair correctly decomposes short GBP/JPY", () => {
  const result = decomposePair("GBP/JPY", "short", 1.0);
  assertEquals(result["GBP"], -1.0);
  assertEquals(result["JPY"], 1.0);
});

Deno.test("computeCurrencyExposure aggregates across positions", () => {
  const positions: OpenPosition[] = [
    { symbol: "EUR/USD", direction: "long", size: 1.0, entryPrice: 1.1000 },
    { symbol: "EUR/GBP", direction: "long", size: 0.5, entryPrice: 0.8500 },
    { symbol: "GBP/USD", direction: "short", size: 0.5, entryPrice: 1.2700 },
  ];
  const exposure = computeCurrencyExposure(positions);

  const eur = exposure.find((e) => e.currency === "EUR")!;
  const usd = exposure.find((e) => e.currency === "USD")!;
  const gbp = exposure.find((e) => e.currency === "GBP")!;

  // EUR: +1.0 (from EUR/USD long) + 0.5 (from EUR/GBP long) = +1.5
  assertAlmostEquals(eur.netExposure, 1.5, 0.001);
  // USD: -1.0 (from EUR/USD long) + 0.5 (from GBP/USD short) = -0.5
  assertAlmostEquals(usd.netExposure, -0.5, 0.001);
  // GBP: -0.5 (from EUR/GBP long) + (-(-0.5)) = -0.5 + 0.5 = 0
  // Wait: short GBP/USD = -GBP, +USD. So GBP = -0.5 (from EUR/GBP quote) + (-0.5) (from GBP/USD short) = -1.0
  // Actually: EUR/GBP long = +EUR, -GBP → GBP = -0.5
  // GBP/USD short = -GBP, +USD → GBP = -0.5
  // Total GBP = -0.5 + (-0.5) = -1.0
  assertAlmostEquals(gbp.netExposure, -1.0, 0.001);
});

// ─── Correlation Lookup Tests ────────────────────────────────────────

Deno.test("getCorrelation returns static correlation for known pairs", () => {
  const corr = getCorrelation("EUR/USD", "GBP/USD");
  assertEquals(corr, 0.85);
});

Deno.test("getCorrelation returns 0 for unknown pair combination", () => {
  const corr = getCorrelation("EUR/USD", "UNKNOWN/PAIR");
  assertEquals(corr, 0);
});

Deno.test("getCorrelation prefers dynamic over static", () => {
  const dynamic = { "EUR/USD": { "GBP/USD": 0.95 } };
  const corr = getCorrelation("EUR/USD", "GBP/USD", dynamic);
  assertEquals(corr, 0.95);
});

Deno.test("getDirectionalCorrelation same direction amplifies positive correlation", () => {
  const corr = getDirectionalCorrelation(
    { symbol: "EUR/USD", direction: "long" },
    { symbol: "GBP/USD", direction: "long" },
  );
  assertEquals(corr, 0.85); // Same direction, positive correlation = positive
});

Deno.test("getDirectionalCorrelation opposite direction on correlated pairs = hedging", () => {
  const corr = getDirectionalCorrelation(
    { symbol: "EUR/USD", direction: "long" },
    { symbol: "GBP/USD", direction: "short" },
  );
  assertEquals(corr, -0.85); // Opposite direction, positive correlation = negative (hedging)
});

Deno.test("getDirectionalCorrelation same direction on inverse pairs = hedging", () => {
  const corr = getDirectionalCorrelation(
    { symbol: "EUR/USD", direction: "long" },
    { symbol: "USD/CHF", direction: "long" },
  );
  assertEquals(corr, -0.90); // Same direction, negative correlation = hedging
});

// ─── Portfolio Conflict Check Tests ──────────────────────────────────

Deno.test("checkPortfolioConflict approves trade with no open positions", () => {
  const candidate: CandidateTrade = { symbol: "EUR/USD", direction: "long", size: 0.5 };
  const result = checkPortfolioConflict(candidate, []);
  assertEquals(result.approved, true);
  assertEquals(result.conflicts.length, 0);
});

Deno.test("checkPortfolioConflict blocks same-pair same-direction duplicate", () => {
  const candidate: CandidateTrade = { symbol: "EUR/USD", direction: "long", size: 0.5 };
  const positions: OpenPosition[] = [
    { symbol: "EUR/USD", direction: "long", size: 1.0, entryPrice: 1.1000 },
  ];
  const result = checkPortfolioConflict(candidate, positions);
  assertEquals(result.approved, false);
  const sameConflict = result.conflicts.find((c) => c.type === "same_pair_same_direction");
  assertEquals(sameConflict !== undefined, true);
});

Deno.test("checkPortfolioConflict blocks highly correlated same-direction trades", () => {
  const candidate: CandidateTrade = { symbol: "GBP/USD", direction: "long", size: 0.5 };
  const positions: OpenPosition[] = [
    { symbol: "EUR/USD", direction: "long", size: 1.0, entryPrice: 1.1000 },
  ];
  const result = checkPortfolioConflict(candidate, positions, { maxCorrelation: 0.75 });
  // EUR/USD long + GBP/USD long = 0.85 effective correlation > 0.75
  const highCorr = result.conflicts.find((c) => c.type === "high_correlation");
  assertEquals(highCorr !== undefined, true);
  assertEquals(highCorr!.severity > 0.75, true);
});

Deno.test("checkPortfolioConflict allows uncorrelated trades", () => {
  const candidate: CandidateTrade = { symbol: "EUR/USD", direction: "long", size: 0.5 };
  const positions: OpenPosition[] = [
    { symbol: "BTC/USD", direction: "short", size: 0.1, entryPrice: 60000 },
  ];
  const result = checkPortfolioConflict(candidate, positions);
  assertEquals(result.approved, true);
});

Deno.test("checkPortfolioConflict detects currency concentration", () => {
  const candidate: CandidateTrade = { symbol: "EUR/GBP", direction: "long", size: 1.5 };
  const positions: OpenPosition[] = [
    { symbol: "EUR/USD", direction: "long", size: 1.5, entryPrice: 1.1000 },
    { symbol: "EUR/JPY", direction: "long", size: 1.0, entryPrice: 160.00 },
  ];
  // EUR exposure: 1.5 + 1.0 + 1.5 = 4.0 (exceeds default max of 2.0)
  const result = checkPortfolioConflict(candidate, positions);
  const currConflict = result.conflicts.find((c) => c.type === "currency_concentration");
  assertEquals(currConflict !== undefined, true);
  assertEquals(currConflict!.detail.includes("EUR"), true);
});

Deno.test("checkPortfolioConflict notes inverse contradiction", () => {
  // Long EUR/USD and Long USD/CHF = contradictory (inverse correlation -0.90)
  const candidate: CandidateTrade = { symbol: "USD/CHF", direction: "long", size: 0.5 };
  const positions: OpenPosition[] = [
    { symbol: "EUR/USD", direction: "long", size: 1.0, entryPrice: 1.1000 },
  ];
  const result = checkPortfolioConflict(candidate, positions, { maxCorrelation: 0.75 });
  // EUR/USD long vs USD/CHF long: raw corr = -0.90, same direction → effective = -0.90
  // This is < -0.75, so it's an inverse contradiction
  const invConflict = result.conflicts.find((c) => c.type === "inverse_contradiction");
  assertEquals(invConflict !== undefined, true);
});

// ─── Correlation Matrix Tests ────────────────────────────────────────

Deno.test("computeCorrelationMatrix produces symmetric matrix with 1s on diagonal", () => {
  const symbols = ["EUR/USD", "GBP/USD", "USD/JPY"];
  const { matrix } = computeCorrelationMatrix(symbols);

  assertEquals(matrix.length, 3);
  assertEquals(matrix[0].length, 3);

  // Diagonal = 1.0
  assertEquals(matrix[0][0], 1.0);
  assertEquals(matrix[1][1], 1.0);
  assertEquals(matrix[2][2], 1.0);

  // Symmetric
  assertAlmostEquals(matrix[0][1], matrix[1][0], 0.001);
  assertAlmostEquals(matrix[0][2], matrix[2][0], 0.001);
});
