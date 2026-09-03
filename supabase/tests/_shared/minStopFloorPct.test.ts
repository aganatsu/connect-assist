import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { MIN_SL_PIPS, SPECS } from "../../functions/_shared/smcAnalysis.ts";

/**
 * MIN_SL_PIPS is denominated in pips, and a pip is not a comparable unit across
 * asset classes. That is what made the gold entry wrong: 50 looks reasonable
 * next to 20 and 35, but XAU/USD carries pipSize 0.01 on a ~$4,400 instrument,
 * so the floor was $0.50 — 0.011% of price, against 0.16-0.31% everywhere else.
 * Fifteen times too small, so the static floor never bound and gold ran on the
 * ATR floor alone.
 *
 * Measured 2026-09-03: gold's three real stop-outs closed after 6, 7 and 9
 * minutes on $3.03-$3.96 stops; the two winners ran 13 and 126. Gold was the
 * only net-negative symbol.
 *
 * This test does not fix the unit problem — a percentage-of-price floor would,
 * and docs/STOP_LOSS_CONSOLIDATION.md wants a replay study before a change of
 * that scope. It does make the class of error visible: any instrument whose
 * floor falls outside a sane percentage band fails here, including new symbols
 * added later by someone who has not thought about their pip convention.
 */

/** Representative prices, only for converting a pip floor into a percentage. */
const REFERENCE_PRICE: Record<string, number> = {
  "GBP/JPY": 214, "EUR/JPY": 165, "USD/JPY": 158,
  "AUD/JPY": 103, "CAD/JPY": 115, "NZD/JPY": 95, "CHF/JPY": 178,
  "GBP/USD": 1.27, "GBP/AUD": 1.95, "GBP/CAD": 1.73, "GBP/NZD": 2.13, "GBP/CHF": 1.13,
  "EUR/USD": 1.16, "EUR/GBP": 0.84, "EUR/AUD": 1.63, "EUR/CAD": 1.48,
  "EUR/NZD": 1.79, "EUR/CHF": 0.94,
  "AUD/USD": 0.65, "NZD/USD": 0.58, "USD/CAD": 1.38, "USD/CHF": 0.88,
  "AUD/CAD": 0.90, "AUD/NZD": 1.09, "AUD/CHF": 0.57,
  "NZD/CAD": 0.81, "NZD/CHF": 0.51, "CAD/CHF": 0.63,
  "XAU/USD": 4400, "BTC/USD": 77000,
};

/** Band the existing forex floors already sit in, with headroom either side. */
const MIN_PCT = 0.05;
const MAX_PCT = 0.50;

function floorPct(symbol: string): number | null {
  const pips = MIN_SL_PIPS[symbol];
  const spec = SPECS[symbol];
  const price = REFERENCE_PRICE[symbol];
  if (pips === undefined || !spec || !price) return null;
  return ((pips * spec.pipSize) / price) * 100;
}

Deno.test("every MIN_SL_PIPS entry has a spec and a reference price", () => {
  const missing = Object.keys(MIN_SL_PIPS).filter(
    (s) => !SPECS[s] || !REFERENCE_PRICE[s],
  );
  assert(
    missing.length === 0,
    `no spec or reference price for: ${missing.join(", ")} — add one so the ` +
      `floor can be checked in percentage terms`,
  );
});

Deno.test("no stop floor is a negligible fraction of price", () => {
  const offenders: string[] = [];
  for (const symbol of Object.keys(MIN_SL_PIPS)) {
    const pct = floorPct(symbol);
    if (pct !== null && pct < MIN_PCT) {
      offenders.push(`${symbol} ${pct.toFixed(3)}%`);
    }
  }
  assert(
    offenders.length === 0,
    `floors below ${MIN_PCT}% of price provide no protection and let the ` +
      `instrument run on the ATR floor alone: ${offenders.join(", ")}. ` +
      `This is what 50 pips did on gold.`,
  );
});

Deno.test("no stop floor is absurdly wide", () => {
  const offenders: string[] = [];
  for (const symbol of Object.keys(MIN_SL_PIPS)) {
    const pct = floorPct(symbol);
    if (pct !== null && pct > MAX_PCT) {
      offenders.push(`${symbol} ${pct.toFixed(3)}%`);
    }
  }
  assert(
    offenders.length === 0,
    `floors above ${MAX_PCT}% of price force very wide stops and very small ` +
      `positions: ${offenders.join(", ")}`,
  );
});

Deno.test("gold's floor is comparable to the forex floors", () => {
  const gold = floorPct("XAU/USD");
  const gbpjpy = floorPct("GBP/JPY");
  assert(gold !== null && gbpjpy !== null, "missing reference data");
  // 700 pips x 0.01 / 4400 = 0.159%, against GBP/JPY at 0.163%.
  assert(
    gold >= gbpjpy * 0.75 && gold <= gbpjpy * 1.75,
    `gold floor ${gold.toFixed(3)}% should sit near GBP/JPY's ${gbpjpy.toFixed(3)}% — ` +
      `it was 0.011% before 2026-09-03`,
  );
});

Deno.test("the floors span less than an order of magnitude", () => {
  // The failure mode was one instrument being 15x out of line. Whatever the
  // individual values, they should be the same kind of number.
  const pcts = Object.keys(MIN_SL_PIPS)
    .map(floorPct)
    .filter((p): p is number => p !== null);
  const spread = Math.max(...pcts) / Math.min(...pcts);
  assert(
    spread < 10,
    `stop floors span ${spread.toFixed(1)}x in percentage terms — ` +
      `min ${Math.min(...pcts).toFixed(3)}%, max ${Math.max(...pcts).toFixed(3)}%`,
  );
});
