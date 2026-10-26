// Impulse-on-V3 zone layer (owner design 2026-10-26: V3 supplies the leg, the Impulse engine finds the zone inside it).
// Ported unchanged in logic from the research harness that produced the frozen results (~/strategy-v2/impulse-on-v3,
// SPEC.md sha f1dcfd16… + SPEC_V1.1_AMENDMENT.md sha 9e3de29c…; zones.ts + zones_full.ts sha 1974c5fd…).
//
//   - bestZoneWithLeg: production findBestEntryZone steps 2–7 with the leg INJECTED (step 1, findImpulseLeg, is replaced by the
//     V3 leg). Calls the SAME production functions; parity with findBestEntryZone given production's own leg is tested.
//   - detectFVGsFull / mapImpulsePOIsFull: the ONLY behavioural change vs production is that the 50-candle recency window is lifted,
//     so zones are found on the WHOLE V3 leg (73% of V3 legs exceed 50 bars). OBs use production detectOrderBlocks unchanged with
//     its own obLookbackOverride = max(50, slice length). Parity with production wherever the window is not binding is tested.
// deno-lint-ignore-file no-explicit-any
import * as SM from "../smcAnalysis.ts";
import * as IZ from "../impulseZoneEngine.ts";
/** Not exported by production (impulseZoneEngine.ts PRICE_AT_ZONE_ATR_MULT / PRICE_AT_ZONE_STRICT_ATR_MULT); equality is tested. */
export const PRICE_AT_ZONE_ATR_MULT = 1.5, PRICE_AT_ZONE_STRICT_ATR_MULT = 0.3;

export function detectFVGsFull(candles: any[]): any[] {
  const fvgs: any[] = [];
  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2], c2 = candles[i - 1], c3 = candles[i];
    if (c3.low > c1.high && c2.close > c2.open) {
      const fvg: any = { index: i - 1, high: c3.low, low: c1.high, type: "bullish", datetime: c2.datetime, mitigated: false, state: "open", fillPercent: 0, respectedCount: 0 };
      const gapSize = fvg.high - fvg.low;
      for (let j = i + 1; j < candles.length; j++) {
        const c = candles[j];
        if (c.low <= fvg.low) { fvg.mitigated = true; fvg.state = "filled"; fvg.fillPercent = 100; fvg.filledAt = j; if (!fvg.firstTestedAt) fvg.firstTestedAt = j; break; }
        if (c.low < fvg.high) { const pen = Math.min(100, ((fvg.high - c.low) / gapSize) * 100); if (pen > fvg.fillPercent) fvg.fillPercent = pen; if (!fvg.firstTestedAt) fvg.firstTestedAt = j; if (fvg.fillPercent > 0 && fvg.fillPercent < 100 && fvg.state === "open") fvg.state = "partially_filled"; }
        else if (c.low <= fvg.high + gapSize * 0.2 && c.close > fvg.high) { fvg.respectedCount++; if (fvg.state === "open" && fvg.respectedCount >= 1) fvg.state = "respected"; }
      }
      fvgs.push(fvg);
    }
    if (c1.low > c3.high && c2.close < c2.open) {
      const fvg: any = { index: i - 1, high: c1.low, low: c3.high, type: "bearish", datetime: c2.datetime, mitigated: false, state: "open", fillPercent: 0, respectedCount: 0 };
      const gapSize = fvg.high - fvg.low;
      for (let j = i + 1; j < candles.length; j++) {
        const c = candles[j];
        if (c.high >= fvg.high) { fvg.mitigated = true; fvg.state = "filled"; fvg.fillPercent = 100; fvg.filledAt = j; if (!fvg.firstTestedAt) fvg.firstTestedAt = j; break; }
        if (c.high > fvg.low) { const pen = Math.min(100, ((c.high - fvg.low) / gapSize) * 100); if (pen > fvg.fillPercent) fvg.fillPercent = pen; if (!fvg.firstTestedAt) fvg.firstTestedAt = j; if (fvg.fillPercent > 0 && fvg.fillPercent < 100 && fvg.state === "open") fvg.state = "partially_filled"; }
        else if (c.high >= fvg.low - gapSize * 0.2 && c.close < fvg.low) { fvg.respectedCount++; if (fvg.state === "open" && fvg.respectedCount >= 1) fvg.state = "respected"; }
      }
      fvgs.push(fvg);
    }
  }
  return fvgs;
}

export function mapImpulsePOIsFull(candles: any[], impulse: any, options?: { originOBRetest?: boolean }): any[] {
  if (!impulse.isValid) return [];
  const start = Math.max(0, impulse.startIndex), end = Math.min(candles.length, impulse.endIndex + 1);
  const impulseCandles = candles.slice(start, end);
  if (impulseCandles.length < 3) return [];
  const fvgs = detectFVGsFull(impulseCandles);
  const obLookback = 10, obStart = Math.max(0, start - obLookback), obCandles = candles.slice(obStart, end);
  const obStructure = SM.analyzeMarketStructure(obCandles);
  const obBreaks = [...obStructure.bos, ...obStructure.choch];
  const obs = SM.detectOrderBlocks(obCandles, obBreaks, Math.max(50, obCandles.length)); // production detector; window = whole slice (≥ production's 50)
  const pois: any[] = [];
  for (const fvg of fvgs) if (fvg.type === impulse.direction && fvg.state !== "filled") pois.push({ type: "fvg", high: fvg.high, low: fvg.low, candleIndex: start + fvg.index, direction: fvg.type });
  for (const ob of obs) {
    const fullIndex = obStart + ob.index;
    if (fullIndex < obStart || fullIndex > impulse.endIndex) continue;
    const impHigh = Math.max(impulse.high, impulse.low), impLow = Math.min(impulse.high, impulse.low);
    if (ob.high < impLow || ob.low > impHigh) continue;
    if (ob.type === impulse.direction && ob.state !== "broken" && ob.state !== "mitigated") pois.push({ type: "ob", high: ob.high, low: ob.low, candleIndex: fullIndex, direction: ob.type });
  }
  if (options?.originOBRetest) throw new Error("originOBRetest not used by the live config; not mirrored");
  return pois;
}

export function bestZoneWithLeg(htfCandles: any[], entryCandles: any[], impulse: any, direction: "bullish" | "bearish", currentPrice: number, htfData?: any, options?: any, poiMapper?: (c: any[], leg: any, o?: any) => any[]) {
  const pois = (poiMapper ?? IZ.mapImpulsePOIs)(htfCandles, impulse, { originOBRetest: options?.originOBRetest });
  if (pois.length === 0) return { bestZone: null, impulse, allZones: [], why: "no_pois" };
  let rankedZones = IZ.overlayFibOnPOIs(impulse, pois, { fibMaxRetracement: options?.fibMaxRetracement, originOBRetest: options?.originOBRetest });
  if (rankedZones.length === 0) return { bestZone: null, impulse, allZones: [], why: "no_fib_aligned" };
  if (options?.dailyZoneBounds) {
    const bounds = options.dailyZoneBounds;
    rankedZones = rankedZones.filter((z: any) => Math.max(z.poi.low, bounds.low) <= Math.min(z.poi.high, bounds.high));
    if (rankedZones.length === 0) return { bestZone: null, impulse, allZones: [], why: "no_daily_overlap" };
  }
  rankedZones = IZ.checkHistoricalSR(htfCandles, rankedZones, impulse.startIndex);
  if (htfData) rankedZones = IZ.checkHTFConfluence(rankedZones, htfData);
  const topZones = rankedZones.slice(0, 3);
  for (let i = 0; i < topZones.length; i++) topZones[i] = IZ.refineLowerTF(entryCandles, topZones[i]);
  for (let i = 0; i < topZones.length; i++) rankedZones[i] = topZones[i];
  const bestZonePOI = IZ.rankAndSelectBestZone(rankedZones);
  if (!bestZonePOI) return { bestZone: null, impulse, allZones: rankedZones, why: "no_zone_scored" };
  const atr = SM.calculateATR(htfCandles);
  const looseThreshold = atr * PRICE_AT_ZONE_ATR_MULT, strictThreshold = atr * (options?.strictATRMult ?? PRICE_AT_ZONE_STRICT_ATR_MULT);
  const zoneHigh = bestZonePOI.poi.high, zoneLow = bestZonePOI.poi.low;
  let distanceToZone = 0; const priceInsideZone = currentPrice >= zoneLow && currentPrice <= zoneHigh;
  if (!priceInsideZone) distanceToZone = currentPrice > zoneHigh ? currentPrice - zoneHigh : zoneLow - currentPrice;
  const pipSize = options?.pipSize ?? 0.0001, distancePips = distanceToZone / pipSize;
  let priceAtZone = priceInsideZone || Math.abs(currentPrice - zoneHigh) <= looseThreshold || Math.abs(currentPrice - zoneLow) <= looseThreshold;
  let sideOk = true;
  if (direction === "bullish") { if (currentPrice > zoneHigh) sideOk = currentPrice - zoneHigh <= strictThreshold; }
  else if (currentPrice < zoneLow) sideOk = zoneLow - currentPrice <= strictThreshold;
  const priceAtZoneStrict = priceInsideZone || ((Math.abs(currentPrice - zoneHigh) <= strictThreshold || Math.abs(currentPrice - zoneLow) <= strictThreshold) && sideOk);
  return { bestZone: { zone: bestZonePOI, impulse, priceAtZone, priceInsideZone, priceAtZoneStrict, sideOk, distanceToZone, distancePips }, impulse, allZones: rankedZones, why: "ok" };
}
