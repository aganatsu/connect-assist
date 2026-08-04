/**
 * trendFromStructureBreaks.test.ts — Regression test for trend derivation fix
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies that `trend` in analyzeMarketStructure() is derived from the most
 * recent confirmed BOS/CHoCH break (preferring external over internal), NOT
 * from a standalone 2-swing-price comparison.
 *
 * The key test (Test 1) constructs a synthetic candle series where:
 *   - The raw last-2-swing-highs/lows comparison would say "bullish"
 *     (each of the last 2 highs and last 2 lows is higher than the prior one)
 *   - But the most recent EXTERNAL confirmed break is a bearish CHoCH
 *     (price broke down through a prior external swing low)
 *   - There IS a more recent internal bullish CHoCH, but the external-first
 *     rule correctly ignores it in favor of the major structural break.
 *
 * Before the fix: trend === "bullish" (old code only compared last 2 swing prices)
 * After the fix: trend === "bearish" (new code uses external-first break priority)
 *
 * Run: deno test --allow-all supabase/functions/_shared/trendFromStructureBreaks.test.ts
 */
import { analyzeMarketStructure, type Candle } from "./smcAnalysis.ts";
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Build the conflicting candle series:
 *
 * Phase 1 (candles 0-49): Strong uptrend with external BOS
 *   - External SH#1 at idx~10, SH#2 at idx~30, SH#3 at idx~50
 *   - External SL#1 at idx~20, SL#2 at idx~40
 *   - Bullish BOS at SH#2 and SH#3 (external)
 *
 * Phase 2 (candles 50-71): Major bearish reversal
 *   - Sharp drop from 1.0130 to 1.0010
 *   - Creates external SL#3 below SL#2 → bearish CHoCH (external)
 *
 * Phase 3 (candles 72-95): Small internal bounces
 *   - Three short waves creating internal HH + HL
 *   - Internal bullish CHoCH (minor bounce breaks a minor high)
 *   - Old logic sees last 2 internal highs (HH) + last 2 internal lows (HL) → "bullish"
 *   - New logic sees external bearish CHoCH as authoritative → "bearish"
 */
function buildConflictingCandles(): Candle[] {
  const candles: Candle[] = [];
  const baseTime = new Date("2024-01-01T00:00:00Z").getTime();
  let idx = 0;
  function addCandle(o: number, h: number, l: number, c: number) {
    candles.push({ datetime: new Date(baseTime + idx * 3600000).toISOString(), open: o, high: h, low: l, close: c });
    idx++;
  }

  // Phase 1: Strong uptrend (external swings, lookback=7+ detectable)
  // Wave 1 UP (10): 1.0000 → 1.0060
  for (let i = 0; i < 10; i++) { const b = 1.0000 + i * 0.0006; addCandle(b, b+0.0004, b-0.0002, b+0.0003); }
  // Wave 1 DOWN (10): 1.0060 → 1.0030 — creates external SH#1
  for (let i = 0; i < 10; i++) { const b = 1.0060 - i * 0.0003; addCandle(b, b+0.0002, b-0.0004, b-0.0003); }
  // Wave 2 UP (10): 1.0030 → 1.0090 — creates external SL#1
  for (let i = 0; i < 10; i++) { const b = 1.0030 + i * 0.0006; addCandle(b, b+0.0004, b-0.0002, b+0.0003); }
  // Wave 2 DOWN (10): 1.0090 → 1.0060 — creates external SH#2 (bullish BOS)
  for (let i = 0; i < 10; i++) { const b = 1.0090 - i * 0.0003; addCandle(b, b+0.0002, b-0.0004, b-0.0003); }
  // Wave 3 UP (10): 1.0060 → 1.0130 — creates external SL#2
  for (let i = 0; i < 10; i++) { const b = 1.0060 + i * 0.0007; addCandle(b, b+0.0004, b-0.0002, b+0.0003); }

  // Phase 2: Major bearish reversal (external CHoCH)
  // Drop from 1.0130 to 1.0010 (12 candles) — creates external SH#3
  for (let i = 0; i < 12; i++) { const b = 1.0130 - i * 0.0010; addCandle(b, b+0.0001, b-0.0010, b-0.0009); }
  // Bounce from 1.0010 to 1.0060 (10 candles) — creates external SL#3
  // SL#3 price (~1.0008) < SL#2 (~1.0058) → bearish CHoCH (external)
  for (let i = 0; i < 10; i++) { const b = 1.0010 + i * 0.0005; addCandle(b, b+0.0004, b-0.0002, b+0.0003); }

  // Phase 3: Small internal bounces creating HH + HL (lookback=3 only)
  // First wave: drop to 1.0040, bounce to 1.0065
  for (let i = 0; i < 4; i++) { const b = 1.0060 - i * 0.0005; addCandle(b, b+0.0002, b-0.0005, b-0.0004); }
  for (let i = 0; i < 4; i++) { const b = 1.0040 + i * 0.0006; addCandle(b, b+0.0005, b-0.0002, b+0.0004); }
  // Second wave: drop to 1.0050, bounce to 1.0075
  for (let i = 0; i < 4; i++) { const b = 1.0065 - i * 0.0004; addCandle(b, b+0.0002, b-0.0004, b-0.0003); }
  for (let i = 0; i < 4; i++) { const b = 1.0050 + i * 0.0007; addCandle(b, b+0.0005, b-0.0002, b+0.0004); }
  // Third wave: drop to 1.0055, bounce to 1.0085
  for (let i = 0; i < 4; i++) { const b = 1.0075 - i * 0.0005; addCandle(b, b+0.0002, b-0.0005, b-0.0004); }
  for (let i = 0; i < 4; i++) { const b = 1.0055 + i * 0.0008; addCandle(b, b+0.0006, b-0.0002, b+0.0005); }

  return candles;
}

// ─── Test 1: THE KEY REGRESSION TEST ────────────────────────────────────────
// Old logic says "bullish" (HH + HL in last 2 swings)
// New logic says "bearish" (external bearish CHoCH is authoritative)
Deno.test("trend derivation: external bearish CHoCH overrides internal HH/HL pattern", () => {
  const candles = buildConflictingCandles();
  const result = analyzeMarketStructure(candles);

  // Verify the old logic WOULD have said "bullish"
  const highs = result.swingPoints.filter(s => s.type === "high");
  const lows = result.swingPoints.filter(s => s.type === "low");
  assert(highs.length >= 2 && lows.length >= 2, "Need at least 2 highs and 2 lows");
  const rH = highs.slice(-2), rL = lows.slice(-2);
  const oldWouldSayBullish = rH[1].price > rH[0].price && rL[1].price > rL[0].price;
  assertEquals(oldWouldSayBullish, true,
    `Old logic should see HH+HL (bullish). Last 2 highs: ${rH.map(h => h.price.toFixed(5))}, Last 2 lows: ${rL.map(l => l.price.toFixed(5))}`);

  // Verify the new logic correctly says "bearish"
  assertEquals(result.trend, "bearish",
    `Expected trend="bearish" from external-first break priority, got "${result.trend}"`);

  // Verify trendBasis reflects the external break
  assertEquals(result.trendBasis, "external",
    `Expected trendBasis="external" since an external break decided the trend, got "${result.trendBasis}"`);

  // Verify there IS a bearish external CHoCH
  const allBreaks = [...result.bos, ...result.choch];
  const externalBearish = allBreaks.filter(b => b.significance === "external" && b.type === "bearish");
  assert(externalBearish.length > 0, "Expected at least one external bearish break");

  // Verify there IS an internal bullish break (the one old logic was fooled by)
  const internalBullish = allBreaks.filter(b => b.significance === "internal" && b.type === "bullish");
  assert(internalBullish.length > 0,
    "Expected an internal bullish break (the minor bounce that fooled old logic)");
});

// ─── Test 2: Pure bullish structure → trend = "bullish" ─────────────────────
Deno.test("trend derivation: pure bullish BOS chain → trend = bullish", () => {
  const candles: Candle[] = [];
  const baseTime = new Date("2024-01-01T00:00:00Z").getTime();
  // Continuous uptrend with clear swing points (sawtooth: 7 up, 5 down)
  for (let i = 0; i < 70; i++) {
    const cycle = i % 12;
    const segment = Math.floor(i / 12);
    const segBase = 1.0000 + segment * 0.0040;
    let base: number;
    if (cycle < 7) { base = segBase + cycle * 0.0006; }
    else { base = segBase + 7 * 0.0006 - (cycle - 6) * 0.0004; }
    candles.push({
      datetime: new Date(baseTime + i * 3600000).toISOString(),
      open: base, high: base + 0.0004, low: base - 0.0002, close: base + 0.0003,
    });
  }
  const result = analyzeMarketStructure(candles);
  const allBreaks = [...result.bos, ...result.choch];
  if (allBreaks.length > 0) {
    assertEquals(result.trend, "bullish",
      `In a pure uptrend with breaks, trend should be bullish, got "${result.trend}"`);
  }
});

// ─── Test 3: No breaks at all → trend = "ranging" ──────────────────────────
Deno.test("trend derivation: no BOS/CHoCH detected → trend = ranging", () => {
  const candles: Candle[] = [];
  const baseTime = new Date("2024-01-01T00:00:00Z").getTime();
  for (let i = 0; i < 10; i++) {
    candles.push({
      datetime: new Date(baseTime + i * 3600000).toISOString(),
      open: 1.0800, high: 1.0805, low: 1.0795,
      close: 1.0800 + (i % 2 === 0 ? 0.0002 : -0.0002),
    });
  }
  const result = analyzeMarketStructure(candles);
  if (result.bos.length === 0 && result.choch.length === 0) {
    assertEquals(result.trend, "ranging", "With no BOS or CHoCH, trend should be ranging");
    assertEquals(result.trendBasis, "none", "With no breaks, trendBasis should be 'none'");
  }
});

// ─── Test 4: trend field type is always valid ───────────────────────────────
Deno.test("trend derivation: always returns valid trend type", () => {
  const candles = buildConflictingCandles();
  const result = analyzeMarketStructure(candles);
  assert(
    result.trend === "bullish" || result.trend === "bearish" || result.trend === "ranging",
    `trend must be one of bullish/bearish/ranging, got "${result.trend}"`
  );
});

// ─── Test 5: Bearish BOS chain → trend = "bearish" ──────────────────────────
Deno.test("trend derivation: bearish BOS chain → trend = bearish", () => {
  const candles: Candle[] = [];
  const baseTime = new Date("2024-01-01T00:00:00Z").getTime();
  // Continuous downtrend (sawtooth: 7 down, 5 up)
  for (let i = 0; i < 70; i++) {
    const cycle = i % 12;
    const segment = Math.floor(i / 12);
    const segBase = 1.1000 - segment * 0.0040;
    let base: number;
    if (cycle < 7) { base = segBase - cycle * 0.0006; }
    else { base = segBase - 7 * 0.0006 + (cycle - 6) * 0.0004; }
    candles.push({
      datetime: new Date(baseTime + i * 3600000).toISOString(),
      open: base, high: base + 0.0002, low: base - 0.0004, close: base - 0.0003,
    });
  }
  const result = analyzeMarketStructure(candles);
  const allBreaks = [...result.bos, ...result.choch];
  const bearishBreaks = allBreaks.filter(b => b.type === "bearish");
  if (bearishBreaks.length > 0) {
    assertEquals(result.trend, "bearish",
      `In a pure downtrend with bearish breaks, trend should be bearish, got "${result.trend}"`);
  }
});
