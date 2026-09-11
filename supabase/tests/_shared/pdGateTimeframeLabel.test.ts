import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runConfluenceAnalysis } from "../../functions/_shared/confluenceScoring.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

/**
 * The premium/discount rejection reason prints the timeframe and the swing
 * bounds. It was written for that purpose: on 2026-09-03 a XAU/USD setup read
 * 100.0% on this gate, 60.0% in Tier 1 and 73.9% against the 1H impulse — all
 * correct, all differently defined, and impossible to reconcile from the screen.
 *
 * The label was `config.entryTimeframe`, read unconditionally. Once
 * structureTfAnalysis moved premium/discount onto the structure series, the
 * message printed "5m" over a 15m range — observed live 2026-09-08:
 *
 *   "Buying in premium zone rejected — price 1.35466 at 85.8% of the 5m swing
 *    range 1.35297–1.35494"
 *
 * The numbers were the 15m ones. A gate that names the wrong timeframe is worse
 * than one that names none, and this is the gate that rejected 103 setups.
 */

const scoring = await Deno.readTextFile(
  new URL("../../functions/_shared/confluenceScoring.ts", import.meta.url),
);
const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

function series(n: number, base: number, step: number, period: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const wave = Math.sin((i / period) * Math.PI * 2) * step;
    const close = base + wave + i * step * 0.02;
    const open = base + Math.sin(((i - 1) / period) * Math.PI * 2) * step + i * step * 0.02;
    out.push({
      open, close,
      high: Math.max(open, close) + step * 0.3,
      low: Math.min(open, close) - step * 0.3,
      volume: 1000, datetime: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
    } as Candle);
  }
  return out;
}

const cfg = { structureLookback: 50, obLookbackCandles: 30, liquidityPoolMinTouches: 3,
  fibDevMultiplier: 3, fibDepth: 10, _currentSymbol: "EUR/USD" };
const entry = series(200, 1.1, 0.0004, 14);
const struct = series(200, 1.1, 0.0020, 40);
const daily = series(60, 1.1, 0.0050, 20);

Deno.test("the engine reports which series produced the levels", () => {
  const off = runConfluenceAnalysis(entry, daily, { ...cfg }, undefined, 0);
  assertEquals((off as any).structuralSeriesUsed, false);

  const on = runConfluenceAnalysis(
    entry, daily, { ...cfg, structureTfAnalysis: true, _structureCandles: struct }, undefined, 0,
  );
  assertEquals((on as any).structuralSeriesUsed, true);
});

Deno.test("a too-short series reports false, matching the fallback it took", () => {
  // Reporting true here would label a 5m range as 15m — the same lie in reverse.
  const short = runConfluenceAnalysis(
    entry, daily,
    { ...cfg, structureTfAnalysis: true, _structureCandles: struct.slice(0, 19) },
    undefined, 0,
  );
  assertEquals((short as any).structuralSeriesUsed, false);
});

Deno.test("the gate labels from what was used, not from entryTimeframe", () => {
  assert(
    /const tfLabel = \(analysis as any\)\.structuralSeriesUsed === true/.test(scanner),
    "the label must branch on the series actually used",
  );
  assert(
    !/const tfLabel = \(config as any\)\.entryTimeframe \?\? "entry TF";/.test(scanner),
    "the unconditional entryTimeframe label must be gone",
  );
  assert(/_structureTfLabel \?\? "structure TF"/.test(scanner), "structure label with a fallback");
  assert(/entryTimeframe \?\? "entry TF"/.test(scanner), "entry label retained for the off case");
});

Deno.test("the structure label is injected alongside the series", () => {
  // Injected separately from the candles, so they can never disagree about
  // which timeframe is in play.
  const i = scanner.indexOf("_structureCandles = structureSeries;");
  const j = scanner.indexOf("_structureTfLabel =", i);
  assert(j > i && j - i < 200, "the label must be set with the series");
  assert(/STYLE_TF_LABELS\[resolvedStyle\]\?\.structureTFLabel/.test(scanner),
    "and come from the same mapping the series came from");
});

Deno.test("the reason still prints the bounds it is judging against", () => {
  assert(/of the \$\{tfLabel\} 5-swing box \$\{fmtP\(sLow\)\}–\$\{fmtP\(sHigh\)\}/.test(scanner),
    "timeframe AND bounds — the point of the message");
  // And since 2026-09-10 the leg-relative figure alongside it, so the two
  // measures can be compared from the reason string itself.
  assert(/impulse leg \$\{_legPd\.percent\.toFixed\(1\)\}%/.test(scanner),
    "the impulse-leg percentage is printed beside the box percentage");
});
