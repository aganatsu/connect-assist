/**
 * STEP 9 — fill-time position sizing.
 *
 * Size is computed at the moment of the fill, from the ACTUAL fill price and
 * the ACTUAL stop, so every trade risks the configured percentage of the
 * balance at fill:
 *
 *   riskUsd   = balance × riskPercent / 100
 *   perLotUsd = |fill − stop| × lotUnits × quote→USD  (+ round-trip commission)
 *   lots      = floor(riskUsd / perLotUsd, 0.01)        — never above target
 *
 * One rule: no 0.5× standalone cut, no Unified 1.0×, no correlation or
 * volatility multipliers. Lot caps are a safety ceiling applied LAST; when one
 * binds, the record shows the real (lower) risk instead of hiding it.
 *
 * Replaces the Route 2 path that kept the placement-time size at fill, so risk
 * drifted with |fill − SL| / |limit − SL| (0.19%–1.21% in the $100k period).
 */
import { getQuoteToUSDRate, SPECS } from "./smcAnalysis.ts";
import { requiredRatePairs } from "./rateMapPolicy.ts";

export interface FillSizingInput {
  balance: number;
  riskPercent: number;
  fillPrice: number;
  stop: number;
  symbol: string;
  rateMap?: Record<string, number>;
  commissionPerLot?: number;
  /** Safety ceiling in lots; the 10× notional leverage cap also applies. */
  maxLotsPerTrade?: number;
}

export interface FillSizing {
  ok: boolean;
  reason: string | null;
  lots: number;
  uncappedLots: number;
  riskPercentTarget: number;
  riskUsdTarget: number;
  riskUsdActual: number;
  riskPercentActual: number;
  perLotRiskUsd: number;
  stopDistance: number;
  capped: boolean;
  capLots: number;
  capReason: string | null;
  quoteToUSD: number;
  balance: number;
  fillPrice: number;
  stop: number;
}

const floor2 = (x: number) => Math.floor(x * 100 + 1e-9) / 100;

export function fillTimeSize(i: FillSizingInput): FillSizing {
  const spec = SPECS[i.symbol] || SPECS["EUR/USD"];
  const base = {
    riskPercentTarget: i.riskPercent, balance: i.balance, fillPrice: i.fillPrice, stop: i.stop,
  };
  const fail = (reason: string): FillSizing => ({
    ok: false, reason, lots: 0, uncappedLots: 0, riskUsdTarget: 0, riskUsdActual: 0, riskPercentActual: 0,
    perLotRiskUsd: 0, stopDistance: Math.abs(i.fillPrice - i.stop), capped: false, capLots: 0, capReason: null, quoteToUSD: 0, ...base,
  });
  if (!(i.balance > 0)) return fail("balance not positive");
  if (!(i.riskPercent > 0 && i.riskPercent <= 5)) return fail(`risk percent ${i.riskPercent} outside (0, 5]`);
  if (!(i.fillPrice > 0) || !(i.stop > 0)) return fail("fill price or stop missing");
  const stopDistance = Math.abs(i.fillPrice - i.stop);
  if (!(stopDistance > 0)) return fail("zero stop distance");
  const missing = requiredRatePairs([i.symbol]).find((p) => !(i.rateMap?.[p] && i.rateMap[p] > 0));
  if (missing) return fail(`missing FX rate ${missing} — size cannot be computed exactly`);

  const quoteToUSD = getQuoteToUSDRate(i.symbol, i.rateMap);
  const perLotRiskUsd = stopDistance * spec.lotUnits * quoteToUSD + (i.commissionPerLot ?? 0);
  const riskUsdTarget = i.balance * i.riskPercent / 100;
  const uncappedLots = riskUsdTarget / perLotRiskUsd;

  const priceInUSD = spec.type === "forex" ? i.fillPrice * quoteToUSD : i.fillPrice;
  const leverageCap = floor2((i.balance * 10) / (spec.lotUnits * priceInUSD));
  const configuredCap = i.maxLotsPerTrade && i.maxLotsPerTrade > 0 ? i.maxLotsPerTrade : Infinity;
  const capLots = Math.min(leverageCap, configuredCap);
  let lots = floor2(uncappedLots);
  let capped = false;
  let capReason: string | null = null;
  if (lots > capLots) {
    lots = floor2(capLots);
    capped = true;
    capReason = capLots === leverageCap ? "10× notional leverage cap" : `maxLotsPerTrade ${configuredCap}`;
  }
  if (lots < 0.01) return { ...fail(`size ${uncappedLots.toFixed(4)} lots rounds below 0.01`), perLotRiskUsd, stopDistance, quoteToUSD };

  const riskUsdActual = lots * perLotRiskUsd;
  return {
    ok: true, reason: null, lots, uncappedLots, riskUsdTarget, riskUsdActual,
    riskPercentActual: (riskUsdActual / i.balance) * 100, perLotRiskUsd, stopDistance,
    capped, capLots, capReason, quoteToUSD, ...base,
  };
}
