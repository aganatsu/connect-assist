import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  excursions, toJsonl, parseJsonl, auditLedger, summarize,
  LEDGER_FIELDS, type LedgerRow,
} from "../../functions/_shared/ipoForwardLedger.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const bar = (i: number, o: number, h: number, l: number, c: number): Candle =>
  ({ datetime: `2026-01-0${i + 1}T00:00:00Z`, open: o, high: h, low: l, close: c, volume: 0 } as Candle);

const row = (o: Partial<LedgerRow> = {}): LedgerRow => ({
  timestamp: "2026-01-01T00:00:00Z", instrument: "EUR/USD", timeframe: "1h", direction: "long",
  ipoCandleTimestamp: "2025-12-31T20:00:00Z", ipoZoneLow: 1.05, ipoZoneHigh: 1.06,
  entryLevel: 1.05, invalidationLevel: 1.04, targetPrice: 1.07,
  fvgPresent: true, fvgTimestamp: "2025-12-31T21:00:00Z",
  volatilityBucket: "HIGH_VOL", contractionState: "OUTSIDE_CONTRACTION",
  lifecycleState: "VALID_LIVE", filled: true, noFillReason: null, fillPrice: 1.05,
  exitTimestamp: "2026-01-01T05:00:00Z", exitPrice: 1.07, exitReason: "TARGET_2R",
  realizedR: 1.9, mae: 0.4, mfe: 2.0, ...o,
});

Deno.test("excursions are measured from the fill, in nominal R", () => {
  const s = [bar(0, 100, 101, 99, 100), bar(1, 100, 104, 96, 103), bar(2, 103, 110, 102, 109)];
  // long, entry 100, risk 5 → worst low 96 = 0.8R adverse; best high 110 = 2.0R favourable
  const e = excursions(s, 0, 2, 100, 5, true);
  assertEquals(e.mae, 0.8);
  assertEquals(e.mfe, 2.0);
});

Deno.test("excursions mirror for shorts", () => {
  const s = [bar(0, 100, 106, 99, 100), bar(1, 100, 101, 90, 92)];
  const e = excursions(s, 0, 1, 100, 5, false);
  assertEquals(e.mae, 1.2, "the 106 high is 6 against a 5-wide risk");
  assertEquals(e.mfe, 2.0, "the 90 low is 10 in favour");
});

Deno.test("excursions ignore bars before the fill", () => {
  const s = [bar(0, 100, 100, 50, 100), bar(1, 100, 101, 99, 100)];
  const e = excursions(s, 1, 1, 100, 5, true);
  assertEquals(e.mae, 0.2, "the 50 low happened before entry and must not count");
});

Deno.test("a clean ledger audits with no problems", () => {
  assertEquals(auditLedger([row(), row({ instrument: "USD/JPY" })]), []);
});

Deno.test("audit catches a fill with no price", () => {
  const p = auditLedger([row({ fillPrice: null })]);
  assert(p.some((x) => x.includes("filled with no fill price")), p.join("; "));
});

Deno.test("audit catches an unfilled row that still reports a result", () => {
  const p = auditLedger([row({
    filled: false, fillPrice: null, noFillReason: "PRICE_DID_NOT_REACH_50_PERCENT",
    exitReason: "NOT_FILLED", realizedR: 1.9,
  })]);
  assert(p.some((x) => x.includes("not filled but reports a result")), p.join("; "));
});

Deno.test("audit requires a reason for every unfilled row", () => {
  const p = auditLedger([row({
    filled: false, fillPrice: null, noFillReason: null, exitReason: "NOT_FILLED", realizedR: null,
  })]);
  assert(p.some((x) => x.includes("no reason given")), p.join("; "));
});

Deno.test("a target exit that still lost money is recorded, not flagged as an error", () => {
  // BTC fees are proportional to price while 1R is the candle's wick span, so a
  // small-risk trade can reach 2R and still finish negative. That is an economic
  // fact the ledger must surface, not a data-integrity failure.
  const r = row({ exitReason: "TARGET_2R", realizedR: -0.07 });
  assertEquals(auditLedger([r]), []);
  assertEquals(summarize([r]).costDominatedWins, 1);
});

Deno.test("audit still catches a target exit with no result at all", () => {
  const p = auditLedger([row({ exitReason: "TARGET_2R", realizedR: null })]);
  assert(p.some((x) => x.includes("reports no result")), p.join("; "));
});

Deno.test("audit catches a missing field and an inverted zone", () => {
  const bad = row(); delete (bad as any).mfe;
  const p = auditLedger([bad, row({ ipoZoneLow: 1.09 })]);
  assert(p.some((x) => x.includes("missing field mfe")), p.join("; "));
  assert(p.some((x) => x.includes("inverted zone")), p.join("; "));
});

Deno.test("JSONL round-trips every declared field", () => {
  const rows = [row(), row({ filled: false, fillPrice: null, realizedR: null, mae: null, mfe: null,
    noFillReason: "VOLATILITY_NOT_ELIGIBLE", exitReason: "NOT_FILLED", exitTimestamp: null, exitPrice: null })];
  const back = parseJsonl(toJsonl(rows));
  assertEquals(back.length, 2);
  for (const f of LEDGER_FIELDS) {
    assertEquals(back[0][f], rows[0][f], `field ${f} did not survive the round trip`);
    assertEquals(back[1][f], rows[1][f], `field ${f} did not survive the round trip`);
  }
});

Deno.test("an empty ledger serialises to an empty string, not a stray newline", () => {
  assertEquals(toJsonl([]), "");
  assertEquals(parseJsonl(""), []);
});

Deno.test("summary counts unfilled rows and their reasons", () => {
  const rows = [
    row({ realizedR: 2 }),
    row({ realizedR: -1, exitReason: "S2_CLOSE_INVALIDATION" }),
    row({ filled: false, fillPrice: null, realizedR: null, exitReason: "NOT_FILLED",
          noFillReason: "VOLATILITY_NOT_ELIGIBLE", volatilityBucket: "LOW_VOL" }),
  ];
  const s = summarize(rows);
  assertEquals(s.rows, 3);
  assertEquals(s.filled, 2);
  assertEquals(s.notFilled, 1);
  assertEquals(s.totalR, 1);
  assertEquals(s.expectancyR, 0.5);
  assertEquals(s.byNoFillReason["VOLATILITY_NOT_ELIGIBLE"], 1);
  assertEquals(s.byVolatilityBucket["LOW_VOL"], 1);
});

Deno.test("the ledger decides nothing — it cannot reach any rule module", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/ipoForwardLedger.ts");
  // Structural, not lexical: if it cannot import the rule modules it cannot
  // recompute a rule, whatever its identifiers happen to be called.
  const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assertEquals(imports, ["./smcAnalysis.ts"],
    `the ledger may only depend on the Candle type; found ${imports.join(", ")}`);
  for (const rule of ["ipoLifecycle", "ipoRegimeDescriptors", "ipoAPlusClassifier",
                      "ipoRawBacktest", "ipoZones", "ipoLiveVolatility"]) {
    assert(!src.includes(rule), `the ledger references ${rule}; it must only record`);
  }
  // No tuned constant can hide in a module that merely records.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assertEquals(code.match(/\d+\.\d+/g) ?? [], []);
});
