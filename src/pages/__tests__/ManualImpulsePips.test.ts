import { describe, it, expect } from "vitest";
import { INSTRUMENTS } from "@/lib/marketData";

/**
 * The Manual Impulse form converts a marked price range into pips. Guessing pip
 * size from the symbol ("JPY means 0.01, else 0.0001") is wrong for metals, oil
 * and crypto — it overstated a BTC leg by 10,000x and read a mismarked AUD/CAD
 * leg as 54,300 pips. INSTRUMENTS already carries the real value.
 */
const pipSizeFor = (symbol: string) =>
  INSTRUMENTS.find((i) => i.symbol === symbol)?.pipSize ??
  (symbol.includes("JPY") ? 0.01 : 0.0001);

describe("manual impulse pip sizing", () => {
  it("uses the instrument's real pip size, not a symbol guess", () => {
    const naive = (s: string) => (s.includes("JPY") ? 0.01 : 0.0001);
    const drifted = INSTRUMENTS
      .filter((i) => naive(i.symbol) !== i.pipSize)
      .map((i) => i.symbol);
    // These are precisely the instruments the old heuristic got wrong.
    expect(drifted.length).toBeGreaterThan(0);
    for (const symbol of drifted) {
      const real = INSTRUMENTS.find((i) => i.symbol === symbol)!.pipSize;
      expect(pipSizeFor(symbol)).toBe(real);
      expect(pipSizeFor(symbol)).not.toBe(naive(symbol));
    }
  });

  it("every listed instrument resolves a pip size", () => {
    for (const i of INSTRUMENTS) {
      expect(pipSizeFor(i.symbol)).toBe(i.pipSize);
      expect(pipSizeFor(i.symbol)).toBeGreaterThan(0);
    }
  });

  // The warning threshold. Deliberately loose and non-blocking: MIN_SL_PIPS is
  // not scaled consistently across asset classes, so a tight ratio would refuse
  // legitimate gold and crypto legs.
  const WARN_AT = (minStop: number) => minStop * 1.5 * 1000;

  it("a mismarked AUD/CAD leg trips the warning", () => {
    // The live report: JPY-scale prices entered against AUD/CAD.
    const pips = (114.661 - 109.231) / pipSizeFor("AUD/CAD");
    expect(Math.round(pips)).toBe(54300);
    expect(pips).toBeGreaterThan(WARN_AT(20));
  });

  it("genuine large Daily legs do NOT trip it", () => {
    // A real ~300 dollar gold leg is ~600x its floor — a tighter ratio would
    // have refused it outright.
    expect(300 / pipSizeFor("XAU/USD")).toBeLessThan(WARN_AT(50));
    expect(4000 / pipSizeFor("BTC/USD")).toBeLessThan(WARN_AT(150));
    // 5.00 of price on USD/JPY is a 500-pip leg, not 500 of price.
    expect(5.0 / pipSizeFor("USD/JPY")).toBeLessThan(WARN_AT(25));
  });
});
