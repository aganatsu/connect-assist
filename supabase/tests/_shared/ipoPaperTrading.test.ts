import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { auditLedger, summarize } from "../../functions/_shared/ipoForwardLedger.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const SRC = "supabase/functions/ipo-paper-trading/index.ts";

const bar = (i: number, o: number, h: number, l: number, c: number): Candle =>
  ({ datetime: new Date(Date.UTC(2025, 0, 1) + i * 3600_000).toISOString(),
     open: o, high: h, low: l, close: c, volume: 0 } as Candle);

function market(n: number, seed = 7): Candle[] {
  let x = seed;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const vol = 0.3 + Math.abs(Math.sin(i / 90)) * 1.4;
    const o = p;
    p = Math.max(1, p + (rnd() - 0.5) * vol * 2);
    out.push(bar(i, o, Math.max(o, p) + rnd() * vol, Math.min(o, p) - rnd() * vol, p));
  }
  return out;
}

/** Imported lazily so the module's Deno.serve call does not start a server. */
async function paper() {
  return await import("../../functions/ipo-paper-trading/index.ts");
}

Deno.test("PAPER ONLY — the runner cannot reach broker execution", async () => {
  const src = await Deno.readTextFile(SRC);
  // CODE only. Prose naming the forbidden things is how the guarantee is
  // documented; matching on it would make the test unwritable.
  // The negative lookbehind matters: a plain //-stripper eats the "//" in
  // https:// and silently truncates the supabase-js import off the list.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
  for (const forbidden of [
    "broker-execute", "brokerExecute", "multiBrokerFailover", "placeOrder",
    "paper_positions", "pending_orders", "executeTrade",
    "unifiedPositionSizing", "propFirmGate", "brokerConn",
  ]) {
    assert(!code.includes(forbidden),
      `the paper runner references "${forbidden}" — it must place no orders`);
  }
  // It may import only these. Anything else is a new capability.
  const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).sort();
  assertEquals(imports, [
    "../_shared/apiCreditBudget.ts", "../_shared/candleSource.ts",
    "../_shared/cors.ts", "../_shared/ipoForwardLedger.ts",
    "../_shared/ipoLifecycle.ts", "../_shared/ipoLiveEngine.ts",
    "../_shared/ipoZones.ts", "../_shared/smcAnalysis.ts",
    "https://esm.sh/@supabase/supabase-js@2",
  ], "the paper runner gained a dependency it should not have");
});

Deno.test("PAPER ONLY — it writes to exactly one table", async () => {
  const src = await Deno.readTextFile(SRC);
  const tables = [...src.matchAll(/\.from\("([^"]+)"\)/g)].map((m) => m[1]);
  assertEquals([...new Set(tables)], ["ipo_paper_ledger"],
    `the runner touched ${tables.join(", ")}; only the ledger is permitted`);
});

Deno.test("the instrument set and gates match the frozen spec", async () => {
  const { PAPER_INSTRUMENTS } = await paper();
  assertEquals(PAPER_INSTRUMENTS.map((i: any) => i.instrument),
    ["EUR/USD", "USD/JPY", "BTC/USD"]);
  assertEquals(PAPER_INSTRUMENTS.map((i: any) => i.timeframe), ["1h", "30min", "1h"]);
  // BTC is the only volatility-gated instrument in the spec.
  assertEquals(PAPER_INSTRUMENTS.map((i: any) => i.highVolOnly), [false, false, true]);
});

Deno.test("costs match the frozen assumptions", async () => {
  const { PAPER_INSTRUMENTS } = await paper();
  const [eur, jpy, btc] = PAPER_INSTRUMENTS as any[];
  assertEquals(eur.costPerSide(1.1), 0.00008, "EUR/USD 0.8 pip");
  assertEquals(jpy.costPerSide(150), 0.008, "USD/JPY 0.8 pip");
  assertEquals(btc.costPerSide(40000), 60, "BTC 0.15% of price");
});

Deno.test("history is long enough for the BTC volatility warmup", async () => {
  const { HISTORY_BARS } = await paper();
  const { MIN_REFERENCE } = await import("../../functions/_shared/ipoLiveVolatility.ts");
  assert(HISTORY_BARS > MIN_REFERENCE * 2,
    `${HISTORY_BARS} bars leaves too little past the ${MIN_REFERENCE}-bar warmup`);
});

Deno.test("produced rows pass the ledger audit", async () => {
  const { buildRows } = await paper();
  const rows = buildRows(market(700), {
    instrument: "EUR/USD", timeframe: "1h", highVolOnly: false, costPerSide: () => 0.00008,
  });
  assert(rows.length > 0, "the fixture produced no rows, so this proves nothing");
  assertEquals(auditLedger(rows), []);
});

Deno.test("refusals are recorded as rows, with a reason", async () => {
  const { buildRows } = await paper();
  const rows = buildRows(market(700), {
    instrument: "BTC/USD", timeframe: "1h", highVolOnly: true, costPerSide: (p: number) => p * 0.0015,
  });
  const s = summarize(rows);
  assert(s.notFilled > 0, "a gated instrument must refuse something");
  for (const r of rows.filter((x: any) => !x.filled)) {
    assert(r.noFillReason !== null, `unfilled row at ${r.timestamp} has no reason`);
  }
  assert(Object.keys(s.byNoFillReason).includes("VOLATILITY_NOT_ELIGIBLE"),
    `expected volatility refusals, got ${JSON.stringify(s.byNoFillReason)}`);
});

Deno.test("a gated instrument never fills outside HIGH_VOL", async () => {
  const { buildRows } = await paper();
  const rows = buildRows(market(700), {
    instrument: "BTC/USD", timeframe: "1h", highVolOnly: true, costPerSide: (p: number) => p * 0.0015,
  });
  for (const r of rows.filter((x: any) => x.filled)) {
    assertEquals(r.volatilityBucket, "HIGH_VOL",
      `filled in ${r.volatilityBucket} on a gated instrument`);
  }
});

Deno.test("every filled row is completed with an exit and a result", async () => {
  const { buildRows } = await paper();
  const rows = buildRows(market(700), {
    instrument: "EUR/USD", timeframe: "1h", highVolOnly: false, costPerSide: () => 0.00008,
  });
  const filled = rows.filter((r: any) => r.filled);
  assert(filled.length > 0);
  // A position still open at the end of history is marked OPEN, not NOT_FILLED.
  for (const r of filled.filter((x: any) => x.exitReason === "OPEN")) {
    assertEquals(r.realizedR, null, "an open row must not report a result");
  }
  for (const r of filled.filter((x: any) => x.exitReason !== "OPEN")) {
    assert(r.exitTimestamp !== null, `filled row at ${r.timestamp} never exited`);
    assert(r.realizedR !== null, `filled row at ${r.timestamp} has no result`);
    assert(r.mae !== null && r.mfe !== null, "excursions missing");
  }
});

Deno.test("the runner is stateless — the same candles give the same rows", async () => {
  const { buildRows } = await paper();
  const cfg = { instrument: "EUR/USD", timeframe: "1h", highVolOnly: false, costPerSide: () => 0.00008 };
  const s = market(600);
  assertEquals(JSON.stringify(buildRows(s, cfg)), JSON.stringify(buildRows(s, cfg)));
});

Deno.test("rows carry a natural key that makes the upsert idempotent", async () => {
  const { buildRows } = await paper();
  const rows = buildRows(market(700), {
    instrument: "EUR/USD", timeframe: "1h", highVolOnly: false, costPerSide: () => 0.00008,
  });
  const keys = rows.map((r: any) => `${r.instrument}|${r.timestamp}|${r.ipoCandleTimestamp}`);
  assertEquals(keys.length, new Set(keys).size,
    "duplicate natural keys would collide on upsert and lose rows");
});
