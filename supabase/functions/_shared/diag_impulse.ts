/**
 * Diagnostic: Test findImpulseLeg with the scan data from the last scan.
 * We'll check what analyzeMarketStructure finds on Daily for a typical pair
 * using synthetic data that mimics a clear impulse.
 */
import { findImpulseLeg } from "./impulseZoneEngine.ts";
import { analyzeMarketStructure } from "./smcAnalysis.ts";

// Create a clear bullish impulse on Daily (mimicking EUR/USD recent move)
// Scenario: price consolidates, then makes a strong move up with a BOS
function generateBullishImpulseCandles(): any[] {
  const candles: any[] = [];
  let price = 1.0800;
  const baseTime = Date.now() / 1000 - 120 * 86400; // 120 days ago
  
  // Phase 1: Consolidation (30 bars, range 1.0700-1.0900)
  for (let i = 0; i < 30; i++) {
    const noise = (Math.random() - 0.5) * 0.0050;
    const open = price + noise;
    const close = open + (Math.random() - 0.5) * 0.0040;
    const high = Math.max(open, close) + Math.random() * 0.0020;
    const low = Math.min(open, close) - Math.random() * 0.0020;
    candles.push({ open, high, low, close, volume: 1000, time: baseTime + i * 86400 });
    price = close;
  }
  
  // Phase 2: Swing low formation (price dips to 1.0700)
  price = 1.0720;
  for (let i = 30; i < 35; i++) {
    const close = price - (i - 30) * 0.0015;
    candles.push({ 
      open: price, high: price + 0.0010, low: close - 0.0010, close, 
      volume: 1000, time: baseTime + i * 86400 
    });
    price = close;
  }
  // The swing low candle
  candles.push({ open: 1.0660, high: 1.0670, low: 1.0640, close: 1.0655, volume: 1000, time: baseTime + 35 * 86400 });
  
  // Phase 3: Impulse UP (strong move from 1.0650 to 1.1100 with BOS)
  price = 1.0670;
  for (let i = 36; i < 50; i++) {
    const close = price + 0.0035;
    const high = close + 0.0010;
    const low = price - 0.0005;
    candles.push({ open: price, high, low, close, volume: 2000, time: baseTime + i * 86400 });
    price = close;
  }
  
  // Phase 4: Retracement (price pulls back but doesn't break origin)
  for (let i = 50; i < 65; i++) {
    const close = price - 0.0020;
    const high = price + 0.0005;
    const low = close - 0.0010;
    candles.push({ open: price, high, low, close, volume: 1000, time: baseTime + i * 86400 });
    price = close;
  }
  
  return candles;
}

console.log("═══ Testing findImpulseLeg with synthetic Daily candles ═══\n");

const candles = generateBullishImpulseCandles();
console.log(`Generated ${candles.length} daily candles`);
console.log(`Price range: ${Math.min(...candles.map((c: any) => c.low)).toFixed(5)} → ${Math.max(...candles.map((c: any) => c.high)).toFixed(5)}`);

// Check structure
const structure = analyzeMarketStructure(candles);
console.log(`\nStructure Analysis:`);
console.log(`  Swing points: ${structure.swingPoints.length}`);
console.log(`  BOS: ${structure.bos.length} (bullish: ${structure.bos.filter((b: any) => b.type === "bullish").length}, bearish: ${structure.bos.filter((b: any) => b.type === "bearish").length})`);
console.log(`  CHoCH: ${structure.choch.length} (bullish: ${structure.choch.filter((b: any) => b.type === "bullish").length}, bearish: ${structure.choch.filter((b: any) => b.type === "bearish").length})`);

// Show all breaks
const allBreaks = [...structure.bos, ...structure.choch].sort((a, b) => a.index - b.index);
for (const b of allBreaks) {
  const date = new Date(candles[b.index].time * 1000).toISOString().slice(0,10);
  console.log(`  ${b.type === "bullish" ? "↑" : "↓"} ${b.type} ${structure.bos.includes(b) ? "BOS" : "CHoCH"} at idx ${b.index} (${date}) price ${b.price.toFixed(5)}`);
}

// Try finding impulse
const bullImpulse = findImpulseLeg(candles, "bullish");
if (bullImpulse) {
  console.log(`\n✅ BULLISH impulse found:`);
  console.log(`   Start idx: ${bullImpulse.startIndex}, End idx: ${bullImpulse.endIndex}`);
  console.log(`   Low: ${bullImpulse.low.toFixed(5)} → High: ${bullImpulse.high.toFixed(5)}`);
  console.log(`   BOS: ${bullImpulse.bosPrice.toFixed(5)}`);
  console.log(`   Valid: ${bullImpulse.isValid}`);
} else {
  console.log(`\n❌ No bullish impulse found`);
  console.log(`   Possible reasons:`);
  console.log(`   - No bullish BOS/CHoCH detected in structure`);
  console.log(`   - Origin was broken (price closed below swing low after BOS)`);
}

const bearImpulse = findImpulseLeg(candles, "bearish");
if (bearImpulse) {
  console.log(`\n✅ BEARISH impulse found:`);
  console.log(`   Start idx: ${bearImpulse.startIndex}, End idx: ${bearImpulse.endIndex}`);
  console.log(`   High: ${bearImpulse.high.toFixed(5)} → Low: ${bearImpulse.low.toFixed(5)}`);
  console.log(`   BOS: ${bearImpulse.bosPrice.toFixed(5)}`);
} else {
  console.log(`\n❌ No bearish impulse found (expected — data is bullish)`);
}
