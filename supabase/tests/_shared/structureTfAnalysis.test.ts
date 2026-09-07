import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * `runConfluenceAnalysis` derived every SMC concept from `candles`, the ENTRY
 * timeframe. `STYLE_OVERRIDES.scalper` forces `entryTimeframe: "5m"` and
 * `entryTimeframe` is not in `userProtectedFields`, so a saved "15m" is
 * overwritten silently every scan.
 *
 * That put order blocks, FVGs, premium/discount, liquidity pools, ZigZag/Fib,
 * displacement, breaker blocks and the ATR that floors the stop all on 5-minute
 * candles — and the zone engine's low slot is the same series
 * (`zoneH1Candles = candles` for scalper), so zones were 5m zones too.
 *
 * The style model is bias 1H / structure 15m / confirm 5m.
 * `determineDirectionStyleAware` implements it. This function never did.
 *
 * Measured 2026-09-07 over 24h, 808 evaluations: `priceAtZone` true 357 times,
 * price actually between the zone edges 61 times. EUR/USD, XAU/USD and GBP/JPY
 * were inside zero times across 287 evaluations while being declared at-zone
 * 112 times.
 *
 * THE DIVIDING RULE — anything identifying a LEVEL price should return to uses
 * the structure timeframe; anything identifying a MOMENT to act stays on entry.
 *
 * THE HAZARD this file mostly guards: structural objects carry `.index` into
 * the series they were detected from, and several recency checks compare those
 * against `candles.length`. Moving detection without moving every index
 * consumer would leave recency silently comparing 15m indices to a 5m length.
 */

const scoring = await Deno.readTextFile(
  new URL("../../functions/_shared/confluenceScoring.ts", import.meta.url),
);
const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const mapper = await Deno.readTextFile(
  new URL("../../functions/_shared/configMapper.ts", import.meta.url),
);
const backtest = await Deno.readTextFile(
  new URL("../../functions/backtest-engine/index.ts", import.meta.url),
);

Deno.test("the structural series falls back to entry candles", () => {
  // Off, or absent, or too short — all must reproduce today exactly.
  assert(
    /const structTfOn = \(config as any\)\.structureTfAnalysis === true\s*\n\s*&& !!_injectedStructure && _injectedStructure\.length >= 20;/.test(scoring),
    "flag, presence and length must all be required",
  );
  assert(
    /const sc: Candle\[\] = structTfOn \? _injectedStructure! : candles;/.test(scoring),
    "fallback must be the entry candles",
  );
});

Deno.test("every level detection moved to the structural series", () => {
  for (const call of [
    "detectOrderBlocks(sc,",
    "detectFVGs(sc,",
    "detectLiquidityPools(sc,",
    "calculatePremiumDiscount(sc)",
    "detectZigZagPivots(sc,",
    "detectSwingPoints(sc)",
    "detectDisplacement(sc)",
    "detectBreakerBlocks(orderBlocks, sc, structureBreaks)",
    "detectSweepReclaim(sc, structureSweeps, fvgs)",
  ]) {
    assert(scoring.includes(call), `${call} must use the structural series`);
  }
  assert(
    /const structureCandles = sc\.length > structureLookback \? sc\.slice\(-structureLookback\) : sc;/.test(scoring),
    "the structure lookback slice must come off the structural series",
  );
});

Deno.test("displacement moved WITH the order blocks it tags", () => {
  // tagDisplacementQuality matches displacement candle indices against OB and
  // FVG indices. Splitting them would compare 15m indices to 5m ones — the
  // single most likely way this change corrupts scoring rather than breaking
  // loudly.
  const disp = scoring.indexOf("const displacement = detectDisplacement(");
  const tag = scoring.indexOf("tagDisplacementQuality(orderBlocks, fvgs, displacement.displacementCandles)");
  assert(disp > -1 && tag > disp, "the tagging must follow the detection");
  assert(
    /const displacement = detectDisplacement\(sc\);/.test(scoring),
    "displacement must share the series its consumers index into",
  );
});

Deno.test("every index-vs-length recency check moved too", () => {
  // These compare a structural object's .index against a series length. Left on
  // `candles` they would silently mis-evaluate recency rather than error.
  for (const check of [
    "recencyIdx >= sc.length - 15",
    "sc.length - 1 - lastChoch.index",
    "best.sweptAtIndex >= sc.length - 20",
  ]) {
    assert(scoring.includes(check), `recency check not migrated: ${check}`);
  }
  // And none of the old forms survive.
  for (const stale of [
    "recencyIdx >= candles.length - 15",
    "candles.length - 1 - lastChoch.index",
    "best.sweptAtIndex >= candles.length - 20",
  ]) {
    assert(!scoring.includes(stale), `stale index consumer left behind: ${stale}`);
  }
});

Deno.test("level-tolerance ATRs moved; the spread check did not", () => {
  // Six ATR call sites serve level proximity or SL sizing and follow the levels.
  // The spread gate compares current spread to current volatility — a moment
  // check, and the only one that stays on the entry timeframe.
  assertEquals((scoring.match(/calculateATR\(sc/g) ?? []).length, 7);
  assertEquals((scoring.match(/calculateATR\(candles/g) ?? []).length, 1);
  const i = scoring.indexOf("const spreadATR = calculateATR(candles, 14);");
  assert(i > -1, "the spread ATR must stay on the entry timeframe");
});

Deno.test("timing concepts stayed on the entry timeframe", () => {
  for (const call of [
    "detectJudasSwing(candles)",
    "detectReversalCandle(candles)",
    "computeVolumeProfile(candles)",
    "calculateAnchoredVWAP(candles,",
    "detectAMDPhase(candles,",
    "candles.slice(-10)",
  ]) {
    assert(scoring.includes(call), `${call} must stay on the entry timeframe`);
  }
  assert(
    /const lastPrice = candles\[candles\.length - 1\]\.close;/.test(scoring),
    "lastPrice must be the freshest price, not the structure bar's close",
  );
});

Deno.test("the scanner picks the structure series from STYLE_TF_LABELS", () => {
  // STYLE_OVERRIDES.entryTimeframe and STYLE_TF_LABELS.confirmTFLabel disagree
  // for day_trader ("15min" vs 1H) and swing_trader ("1h" vs 4H). Only scalper
  // agrees. The structure slot must come from the mapping the direction engine
  // already trusts rather than from the one that contradicts it.
  assert(/resolvedStyle === "scalper"\s*\n\s*\? \(m15Candles\.length >= 20 \? m15Candles : null\)/.test(scanner));
  assert(/resolvedStyle === "swing_trader"\s*\n\s*\? \(dailyCandles\.length >= 20 \? dailyCandles : null\)/.test(scanner));
  assert(/: \(h4Candles\.length >= 20 \? h4Candles : null\);/.test(scanner));
  assert(/\(pairConfig as any\)\._structureCandles = structureSeries;/.test(scanner));
});

Deno.test("a missing structure series complains instead of silently reverting", () => {
  assert(
    /structureTfAnalysis === true && !structureSeries/.test(scanner),
    "the flag being on with no series must be detected",
  );
  assert(
    /console\.warn\(`\[\$\{pair\}\] structureTfAnalysis ON but no /.test(scanner),
    "and said out loud — silent fallback is the failure mode of this codebase",
  );
});

Deno.test("the backtester refuses to diverge silently", () => {
  // It has entry / 1H / Daily and no structure series, so it cannot reproduce
  // the live analysis. Left alone it would fall back to the entry timeframe and
  // quietly model a different system than the one trading.
  assert(
    /\(pairConfig as any\)\.structureTfAnalysis = false;/.test(backtest),
    "the backtester must force the mode off",
  );
  assert(
    /diagnostics\.structureTfDisabledForParity = true;/.test(backtest),
    "and record that its results do not reflect the live configuration",
  );
  assert(
    /structureTfDisabledForParity: false,/.test(backtest),
    "the field must be declared, not bolted on untyped",
  );
});

Deno.test("both timeframes are measured while the flag is off", () => {
  // P/D is the one to watch: 103 of 103 premium/discount rejections lost, and
  // it was being read across a 5-minute range.
  for (const field of [
    "entryZone", "structZone", "zonesDisagree", "entryAtrPips", "structAtrPips",
    "structureLabel", "structureBars",
  ]) {
    assert(new RegExp(`${field}:`).test(scanner), `shadow field ${field} missing`);
  }
  assert(
    /zonesDisagree: !!_structPd && !!analysis\.pd\s*\n\s*&& _structPd\.currentZone !== analysis\.pd\.currentZone/.test(scanner),
    "disagreement must compare the two zone labels directly",
  );
});

Deno.test("the flag defaults off in the live mapper and bot-scanner agrees", () => {
  assert(/^  structureTfAnalysis: false,/m.test(mapper), "RUNTIME_DEFAULTS entry missing");
  assert(
    /structureTfAnalysis: strategy\.structureTfAnalysis \?\? raw\.structureTfAnalysis \?\? RUNTIME_DEFAULTS\.structureTfAnalysis/.test(mapper),
    "must be mapped in configMapper",
  );
  const a = scanner.match(/^  structureTfAnalysis: (\w+),/m);
  const b = mapper.match(/^  structureTfAnalysis: (\w+),/m);
  assert(a && b, "missing from one defaults object");
  assertEquals(a[1], b[1]);
});

// ── Behavioural tests: actually run the engine both ways ────────────────────
//
// The assertions above check the source reads correctly. These check it
// BEHAVES correctly, which is what matters for a change that moves every level
// in the system at once.

import { runConfluenceAnalysis } from "../../functions/_shared/confluenceScoring.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

/** Deterministic series: `step` controls the swing size, so the two timeframes
 *  produce genuinely different structure rather than a rescaled copy. */
function series(n: number, base: number, step: number, periodBars: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const wave = Math.sin((i / periodBars) * Math.PI * 2) * step;
    const drift = i * step * 0.02;
    const close = base + wave + drift;
    const open = base + Math.sin(((i - 1) / periodBars) * Math.PI * 2) * step + drift;
    out.push({
      open,
      high: Math.max(open, close) + step * 0.3,
      low: Math.min(open, close) - step * 0.3,
      close,
      volume: 1000 + (i % 7) * 50,
      datetime: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
    } as Candle);
  }
  return out;
}

const cfg = {
  instruments: ["EUR/USD"],
  structureLookback: 50,
  obLookbackCandles: 30,
  liquidityPoolMinTouches: 3,
  fibDevMultiplier: 3,
  fibDepth: 10,
  _currentSymbol: "EUR/USD",
};

const entryCandles = series(200, 1.1, 0.0004, 14);      // fast, small swings
const structCandles = series(200, 1.1, 0.0020, 40);     // slow, large swings
const daily = series(60, 1.1, 0.0050, 20);

Deno.test("flag OFF is byte-identical whether or not a series is injected", () => {
  // The whole safety claim of this change. If injecting the series changes
  // anything while the flag is off, it is not shipping inert.
  const without = runConfluenceAnalysis(entryCandles, daily, { ...cfg }, undefined, 0);
  const withSeries = runConfluenceAnalysis(
    entryCandles, daily, { ...cfg, _structureCandles: structCandles }, undefined, 0,
  );
  assertEquals(
    JSON.stringify(withSeries.factors),
    JSON.stringify(without.factors),
    "an injected series must be inert until the flag turns it on",
  );
  assertEquals(withSeries.score, without.score);
  assertEquals(withSeries.pd.currentZone, without.pd.currentZone);
  assertEquals(withSeries.atrValue, without.atrValue);
});

Deno.test("flag ON actually changes the levels", () => {
  // The complement: if turning it on changed nothing, the wiring is dead — the
  // exact failure that hid analysis.atrValue for months.
  const off = runConfluenceAnalysis(entryCandles, daily, { ...cfg }, undefined, 0);
  const on = runConfluenceAnalysis(
    entryCandles, daily,
    { ...cfg, structureTfAnalysis: true, _structureCandles: structCandles },
    undefined, 0,
  );
  assert(on.atrValue !== off.atrValue, "ATR must come from the structure series");
  assert(on.atrValue > off.atrValue, "the slower series has the larger range here");
});

Deno.test("lastPrice still comes from the entry series", () => {
  // Levels move; the price they are compared against must not.
  const on = runConfluenceAnalysis(
    entryCandles, daily,
    { ...cfg, structureTfAnalysis: true, _structureCandles: structCandles },
    undefined, 0,
  );
  assertEquals(on.lastPrice, entryCandles[entryCandles.length - 1].close);
  assert(
    on.lastPrice !== structCandles[structCandles.length - 1].close,
    "the fixture must actually distinguish the two, or this proves nothing",
  );
});

Deno.test("a short structure series is refused, not half-applied", () => {
  // 19 bars is below the 20-bar guard. Half-applying would mix 15m levels with
  // a 5m ATR and produce a state no timeframe ever saw.
  const on = runConfluenceAnalysis(
    entryCandles, daily,
    { ...cfg, structureTfAnalysis: true, _structureCandles: structCandles.slice(0, 19) },
    undefined, 0,
  );
  const off = runConfluenceAnalysis(entryCandles, daily, { ...cfg }, undefined, 0);
  assertEquals(on.atrValue, off.atrValue, "too short must fall back entirely");
  assertEquals(JSON.stringify(on.factors), JSON.stringify(off.factors));
});

Deno.test("structural objects index into the series they came from", () => {
  // The index-coupling hazard, checked against real output rather than regex:
  // every OB and FVG index must be addressable in the structure series.
  const on = runConfluenceAnalysis(
    entryCandles, daily,
    { ...cfg, structureTfAnalysis: true, _structureCandles: structCandles },
    undefined, 0,
  );
  for (const ob of on.orderBlocks ?? []) {
    assert(ob.index >= 0 && ob.index < structCandles.length,
      `order block index ${ob.index} outside the structure series`);
  }
  for (const f of on.fvgs ?? []) {
    assert(f.index >= 0 && f.index < structCandles.length,
      `FVG index ${f.index} outside the structure series`);
  }
  for (const s of on.structure?.swingPoints ?? []) {
    assert(s.index >= 0 && s.index < structCandles.length,
      `swing index ${s.index} outside the structure series`);
  }
});
