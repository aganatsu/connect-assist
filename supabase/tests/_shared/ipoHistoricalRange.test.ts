import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { barsToDays, fetchHistoricalRangeCandles } from "../../functions/_shared/ipoHistoricalRange.ts";

/**
 * The range fetcher exists so a measurement can tell "the detector missed it"
 * apart from "the detector never saw it". These tests pin the properties that
 * distinction depends on: enough history either side of the window, a strictly
 * increasing series across page boundaries, an explicit UTC request, and a
 * truncation flag when the provider's history starts late.
 *
 * fetch is stubbed. Nothing here calls TwelveData.
 */

const origFetch = globalThis.fetch;
const origKey = Deno.env.get("TWELVE_DATA_API_KEY");
function stub(handler: (url: string) => unknown) {
  const urls: string[] = [];
  Deno.env.set("TWELVE_DATA_API_KEY", "test-key");
  globalThis.fetch = ((input: any) => {
    const url = String(input);
    urls.push(url);
    return Promise.resolve(new Response(JSON.stringify(handler(url)), {
      status: 200, headers: { "content-type": "application/json" },
    }));
  }) as typeof fetch;
  return {
    urls,
    restore() {
      globalThis.fetch = origFetch;
      if (origKey === undefined) Deno.env.delete("TWELVE_DATA_API_KEY");
      else Deno.env.set("TWELVE_DATA_API_KEY", origKey);
    },
  };
}

/** n 4H bars starting at `start`, in ASC order, as TwelveData formats them. */
function tdBars(start: string, n: number) {
  const out: any[] = [];
  let t = Date.parse(start);
  for (let i = 0; i < n; i++) {
    out.push({
      datetime: new Date(t).toISOString().slice(0, 19).replace("T", " "),
      open: "100", high: "101", low: "99", close: "100.5", volume: "1",
    });
    t += 4 * 3600 * 1000;
  }
  return out;
}

Deno.test("the request asks for UTC — an exchange offset would move a 16:00 bar", () => {
  // candleSource learned this on 2026-09-08: TwelveData defaults to the
  // exchange timezone and the caller appends "Z", asserting a UTC that was
  // never requested. The corpus pins 4H IPOs at 16:00, so an hour of drift
  // either misses the bar or silently matches the wrong one.
  const s = stub(() => ({ values: tdBars("2020-05-01T00:00:00Z", 10) }));
  try {
    return fetchHistoricalRangeCandles({
      symbol: "BTC/USD", interval: "4h", startDate: "2020-05-01", endDate: "2020-05-05",
    }).then(() => {
      assert(s.urls.length > 0);
      for (const u of s.urls) {
        assert(u.includes("timezone=UTC"), "every page must request UTC");
        assert(u.includes("order=ASC"), "ascending, so pagination can walk forward");
        assert(u.includes("outputsize=5000"));
        assert(u.includes("start_date=") && u.includes("end_date="));
      }
    });
  } finally { s.restore(); }
});

Deno.test("the fetched window is buffered on BOTH sides of the requested one", async () => {
  // Before: ATR(14), confirmed swings and the structure ledger all need prior
  // bars. After: confirmation, tests and invalidation all happen later, so a
  // window ending at the zone reports a lifecycle that just ran out of chart.
  const s = stub(() => ({ values: tdBars("2020-04-01T00:00:00Z", 10) }));
  try {
    const r = await fetchHistoricalRangeCandles({
      symbol: "BTC/USD", interval: "4h", startDate: "2020-05-08", endDate: "2020-05-11",
    });
    assertEquals(r.requestedWindow, { startDate: "2020-05-08", endDate: "2020-05-11" });
    assert(r.fetchedWindow.startDate < "2020-05-08", "history before the window");
    assert(r.fetchedWindow.endDate > "2020-05-11", "and bars after it");
    const url = new URL(s.urls[0]);
    assertEquals(url.searchParams.get("start_date"), r.fetchedWindow.startDate);
  } finally { s.restore(); }
});

Deno.test("page boundaries do not duplicate a bar", async () => {
  // The next page starts AT the last bar of the previous one, so the boundary
  // bar arrives twice. Left in, it becomes a zero-range bar in every ATR window
  // that spans the join.
  let page = 0;
  const s = stub(() => {
    page++;
    if (page === 1) return { values: tdBars("2020-01-01T00:00:00Z", 5000) };
    // second page repeats the last bar of the first, as the provider does
    return { values: tdBars(new Date(Date.parse("2020-01-01T00:00:00Z") + 4999 * 4 * 3600 * 1000).toISOString(), 10) };
  });
  try {
    const r = await fetchHistoricalRangeCandles({
      symbol: "BTC/USD", interval: "4h", startDate: "2020-01-01", endDate: "2022-01-01",
    });
    assertEquals(r.pages, 2);
    const seen = new Set(r.candles.map((c) => c.datetime));
    assertEquals(seen.size, r.candles.length, "no duplicate datetimes across the join");
    for (let i = 1; i < r.candles.length; i++) {
      assert(r.candles[i].datetime > r.candles[i - 1].datetime, "strictly increasing");
    }
  } finally { s.restore(); }
});

Deno.test("a provider history that starts late is flagged, not silently short", async () => {
  const s = stub(() => ({ values: tdBars("2024-06-09T08:00:00Z", 20) }));
  try {
    const r = await fetchHistoricalRangeCandles({
      symbol: "BTC/USD", interval: "4h", startDate: "2020-05-08", endDate: "2020-05-11",
    });
    assertEquals(r.truncatedAtStart, true);
    assert(r.notes.some((n) => n.includes("provider history begins")),
      "a short series must not read as a quiet market");
  } finally { s.restore(); }
});

Deno.test("a provider error yields an empty series with a reason, never a partial lie", async () => {
  const s = stub(() => ({ status: "error", message: "symbol not found" }));
  try {
    const r = await fetchHistoricalRangeCandles({
      symbol: "BTC/USD", interval: "4h", startDate: "2020-05-08", endDate: "2020-05-11",
    });
    assertEquals(r.candles.length, 0);
    assertEquals(r.source, "none");
    assert(r.notes.some((n) => n.includes("symbol not found")));
  } finally { s.restore(); }
});

Deno.test("bar-to-day conversion leaves room for closed sessions", () => {
  // 300 4H bars is 50 calendar days of continuous trading, but FX closes at
  // weekends. Under-fetching silently shortens the detector's history.
  assert(barsToDays("4h", 300) > 50);
  assert(barsToDays("1d", 300) > 300);
  assertEquals(barsToDays("4h", 0), 2, "never zero-width");
});

Deno.test("SHADOW ONLY — nothing in production imports the range fetcher", async () => {
  const allowed = [
    "supabase/functions/smc-analysis/index.ts",
    "supabase/functions/_shared/ipoHistoricalRange.ts",
  ];
  const offenders: string[] = [];
  const walk = async (dir: string) => {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) { await walk(p); continue; }
      if (!p.endsWith(".ts") || p.includes(".test.")) continue;
      if (allowed.some((a) => p.endsWith(a))) continue;
      if ((await Deno.readTextFile(p)).includes("ipoHistoricalRange")) offenders.push(p);
    }
  };
  await walk("supabase/functions");
  assertEquals(offenders, [], `unexpected production import:\n${offenders.join("\n")}`);
});

Deno.test("market-data and backtest-engine are untouched by this work", async () => {
  // The range pattern is COPIED from backtest-engine, not shared with it.
  // Refactoring the live backtest path to import this module would be a
  // production change for a research need.
  const bt = await Deno.readTextFile("supabase/functions/backtest-engine/index.ts");
  assert(bt.includes("async function fetchTwelveDataRange("),
    "backtest keeps its own range fetcher");
  assert(!bt.includes("ipoHistoricalRange"), "and does not import the research one");

  const md = await Deno.readTextFile("supabase/functions/market-data/index.ts");
  assert(!md.includes("ipoHistoricalRange"), "market-data behaviour is unchanged");

  // Known divergence, recorded deliberately: the backtest range fetcher does
  // not request timezone=UTC. That is a production concern and out of scope
  // here; this assertion exists so the gap is not forgotten.
  const btRange = bt.slice(bt.indexOf("async function fetchTwelveDataRange("));
  const btUrl = btRange.slice(0, btRange.indexOf("\n}"));
  assert(!btUrl.includes("timezone=UTC"),
    "if backtest gains timezone=UTC, update this test and the note in ipoHistoricalRange.ts");
});
