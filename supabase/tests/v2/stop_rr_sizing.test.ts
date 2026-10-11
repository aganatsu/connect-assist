import { assert, assertAlmostEquals, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { clause } from "./helpers/clause.ts";
import { D } from "./helpers/series.ts";
import { chochOrigin, stopLoss, stopTooTight, stopTooWide } from "../../functions/_shared/v2/v2Stop.ts";
import { mkSeries } from "./helpers/series.ts";
import { grossR, netR, rr, rrAtLeastMin } from "../../functions/_shared/v2/v2NetRR.ts";
import { dollarPnl, size } from "../../functions/_shared/v2/v2Sizing.ts";
import { COMMISSION_USD_PER_LOT, COST_PTS, PAIRS, PIP, QUOTE_TO_USD, RESEARCH_RATES, SPREAD_PTS } from "../../functions/_shared/v2/spec.ts";

clause(["0.1", "6.5"], "frozen cost table; commission pips back-compute to ≈ $5.003/lot at the research rates", () => {
  assertEquals(PAIRS.map((p) => COST_PTS[p]), [1500, 2000, 1790, 3290, 3210, 3420]);
  assertEquals(PAIRS.map((p) => SPREAD_PTS[p]), [1000, 1500, 1000, 2500, 2500, 3000]);
  for (const p of PAIRS) {
    const commPips = (COST_PTS[p] - SPREAD_PTS[p]) / 1000;
    const usd = commPips * PIP[p] * 100_000 * QUOTE_TO_USD[p];
    assert(Math.abs(usd - COMMISSION_USD_PER_LOT) < 0.07, `${p} commission ${usd}`);
  }
  assertEquals(RESEARCH_RATES, { USDJPY: 158.31985, USDCAD: 1.42552, USDCHF: 0.83022 });
});

clause(["5.3", "6.2", "SA1"], "SA1: CHoCH origin = extreme of the 5m bars in (ps, k] (k included); SL = origin ∓ 1 pip; no POI fallback; MISSING → not computable", () => {
  const s5 = mkSeries([[0, 1, -1, 0], [0, 1, -3, 0], [0, 1, -2, 0], [0, 4, -1, 3], [3, 5, -0.5, 4.5]], "5m");
  const px = (pips: number) => Math.round((1.16 + pips * 0.0001) * 1e7);
  assertEquals(chochOrigin("LONG", s5, 0, 4), px(-3));                    // bars 1..4
  assertEquals(chochOrigin("LONG", s5, 1, 4), px(-2));                    // the protected swing bar itself is excluded
  assertEquals(chochOrigin("SHORT", s5, 0, 3), px(4));
  assertEquals(chochOrigin("LONG", s5, 4, 4), null);                      // empty range
  assertEquals(chochOrigin("LONG", mkSeries([[0, 1, -1, 0], null, [0, 1, -2, 0]], "5m"), 0, 2), null);
  assertEquals(stopLoss("LONG", D(-3)), D(-4));
  assertEquals(stopLoss("SHORT", D(4)), D(5));
});

clause(["6.3"], "STOP_TOO_WIDE at > 1.5×ATR (equal passes); STOP_TOO_TIGHT at < 3×spread (equal passes)", () => {
  const sum = D(7) * 14;                                       // ATR 7 pips → 1.5×ATR = 10.5
  assertFalse(stopTooWide(D(10.5), sum));
  assert(stopTooWide(D(10.501), sum));
  assertFalse(stopTooTight("EUR/USD", D(3)));                  // 3 × 1.0
  assert(stopTooTight("EUR/USD", D(2.999)));
  assertFalse(stopTooTight("NZD/CHF", D(9))); assert(stopTooTight("NZD/CHF", D(8.999)));
});

clause(["0.10"], "R:R = (|TP − entry| − cost)/|entry − SL|; 1.50 exactly passes; LONG/SHORT symmetric; cost once", () => {
  // EUR/USD cost 1.5 pips: entry 0, SL −10 → need TP ≥ 16.5
  assert(rrAtLeastMin("EUR/USD", 0, D(-10), D(16.5)));
  assertFalse(rrAtLeastMin("EUR/USD", 0, D(-10), D(16.499)));
  assert(rrAtLeastMin("EUR/USD", 0, D(10), D(-16.5)));
  assertAlmostEquals(rr("EUR/USD", D(4.5), D(-4), D(20)), 14 / 8.5);
  assertEquals(grossR("LONG", 0, D(-10), D(20)), 2);
  assertEquals(grossR("SHORT", 0, D(10), D(-20)), 2);
  assertAlmostEquals(netR("EUR/USD", "LONG", 0, D(-10), D(-10)), -1.15);   // loss −1R − 1.5/10
  assertAlmostEquals(netR("EUR/USD", "SHORT", 0, D(10), D(-20)), 1.85);
});

clause(["6.4", "6.5"], "sizing: (dist + cost) in the $500 budget, floor to 0.01, cap 20, never feeds R; dollar loss at SL ≤ $500", () => {
  const s = size("EUR/USD", D(4.5), D(-4));                    // (8.5 + 1.5) pips × $10 = $100/lot → 5.00 lots
  assertEquals(s, { ok: true, lots: 5, lossPerLotAtSL: 100 });
  const j = size("USD/JPY", D(0), D(-30));                      // (30 + 1.79) × 1000 JPY / 158.31985
  assertEquals(j.lots, Math.floor(500 / ((31.79 * 0.01 * 100_000) / 158.31985) * 100) / 100);
  for (const p of PAIRS) {
    for (const stop of [3, 7.5, 12, 40]) {
      const z = size(p, 0, D(-stop));
      assert(z.lots <= 20 && z.lots >= 0.01);
      assert(-dollarPnl(p, z.lots, -D(stop)) <= 500 + 1e-6, `${p} ${stop}`);
    }
  }
  // the cap never binds under the research profile (smallest loss per lot: USD/JPY at the 3-pip floor)
  assert(size("USD/JPY", 0, D(-3)).lots < 20);
  assert(size("EUR/USD", 0, D(-0.01)).lots === 20);            // below any real stop floor the cap applies
});
