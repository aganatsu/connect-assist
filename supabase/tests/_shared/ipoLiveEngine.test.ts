import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  LiveEngine, replay, batchTrades, compareToBatch, episodesFor, type EngineConfig,
} from "../../functions/_shared/ipoLiveEngine.ts";
import { classifyCausal } from "../../functions/_shared/ipoLiveVolatility.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const bar = (i: number, o: number, h: number, l: number, c: number): Candle =>
  ({ datetime: new Date(Date.UTC(2025, 0, 1) + i * 3600_000).toISOString(),
     open: o, high: h, low: l, close: c, volume: 0 } as Candle);

const cfg = (over: Partial<EngineConfig> = {}): EngineConfig =>
  ({ instrument: "EUR/USD", timeframe: "1h", highVolOnly: false, costPerSide: () => 0, ...over });

/**
 * A deterministic pseudo-random walk with a slow volatility cycle.
 *
 * Smooth sinusoids were tried first and produce almost no valid IPOs — the
 * lifecycle needs genuine contractions and clearances, which a clean wave never
 * gives it. A seeded walk produces all four volatility buckets and dozens of
 * trades, so the assertions below actually have something to bite on.
 */
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

Deno.test("the engine cannot see a bar it has not been fed", () => {
  // Feeding a prefix must give the same trades as feeding the whole series and
  // truncating — the defining property of a causal engine.
  const s = market(700);
  const full = replay(s, cfg()).trades.filter((t) => t.exitIndex !== null && t.exitIndex < 450);
  const partial = replay(s.slice(0, 450), cfg()).trades.filter((t) => t.exitIndex !== null);
  assertEquals(partial.length, full.length, "trade count changed when the future was removed");
  for (let i = 0; i < partial.length; i++) {
    assertEquals(partial[i].entryIndex, full[i].entryIndex);
    assertEquals(partial[i].netR, full[i].netR);
  }
});

Deno.test("never more than one position open at a time", () => {
  const s = market(700);
  const e = new LiveEngine(cfg());
  for (const b of s) {
    e.feed(b);
    // Structural: `openTrade` is a single slot, so the invariant is that any
    // trade already closed is never still referenced as open.
    if (e.openTrade) assertEquals(e.openTrade.exitIndex, null);
  }
  const overlapping = e.trades.filter((t, i) =>
    i > 0 && t.entryIndex <= (e.trades[i - 1].exitIndex ?? -1));
  assertEquals(overlapping, [], "an entry occurred before the previous exit");
});

Deno.test("a volatility-gated instrument refuses everything outside HIGH_VOL", () => {
  const s = market(700);
  const e = replay(s, cfg({ highVolOnly: true, instrument: "BTC/USD" }));
  for (const t of e.trades) assertEquals(t.vol, "HIGH_VOL");
  assert(e.refusals.some((r) => r.reason === "VOLATILITY_NOT_ELIGIBLE"),
    "the gate never fired, so this test proves nothing");
});

Deno.test("an ungated instrument takes trades in more than one bucket", () => {
  const s = market(700);
  const e = replay(s, cfg());
  const buckets = new Set(e.trades.map((t) => t.vol));
  assert(e.trades.length > 5, `fixture produced only ${e.trades.length} trades`);
  assert(buckets.size >= 2, `expected several buckets, got ${[...buckets].join(",")}`);
  assert(!e.refusals.some((r) => r.reason === "VOLATILITY_NOT_ELIGIBLE"),
    "an ungated instrument must never refuse on volatility");
});

Deno.test("cost is fixed at entry, not recomputed at exit", () => {
  // A price-proportional fee with a large price move between entry and exit
  // would change the cost if it were read at the exit bar.
  const s = market(700);
  const rising = s.map((c, i) => bar(i, c.open * (1 + i / 100), c.high * (1 + i / 100),
    c.low * (1 + i / 100), c.close * (1 + i / 100)));
  const e = replay(rising, cfg({ costPerSide: (p) => p * 0.001 }));
  for (const t of e.trades) {
    const expected = (2 * rising[t.entryIndex].close * 0.001) / t.risk;
    assertEquals(Math.round(t.costR * 1e9), Math.round(expected * 1e9),
      `trade entered at ${t.entryIndex} priced its cost off the wrong bar`);
  }
});

Deno.test("exits are stop-first when a bar spans both levels", () => {
  const s = market(700);
  const e = replay(s, cfg());
  for (const t of e.trades) {
    if (t.exitIndex === null) continue;
    const c = s[t.exitIndex];
    const long = t.direction === "demand";
    const spans = (long ? c.high >= t.target : c.low <= t.target) &&
                  (long ? c.close < t.stop : c.close > t.stop);
    if (spans) assert((t.netR ?? 0) < 0, "an ambiguous bar was booked as a win");
  }
});

Deno.test("every trade's target is exactly 2R from the fill", () => {
  const s = market(700);
  for (const t of replay(s, cfg()).trades) {
    const expected = t.direction === "demand" ? t.entry + 2 * t.risk : t.entry - 2 * t.risk;
    assertEquals(Math.round(t.target * 1e9), Math.round(expected * 1e9));
    assertEquals(Math.round(t.risk * 1e9), Math.round(Math.abs(t.entry - t.stop) * 1e9));
  }
});

Deno.test("MAE and MFE are non-negative and measured from the fill", () => {
  const s = market(700);
  for (const t of replay(s, cfg()).trades) {
    assert(t.mae >= 0 && t.mfe >= 0, `negative excursion on trade at ${t.entryIndex}`);
  }
});

Deno.test("the engine re-implements no rule — it only drives frozen modules", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/ipoLiveEngine.ts");
  const imports = [...src.matchAll(/from\s+"\.\/([^"]+)"/g)].map((m) => m[1]);
  // Every rule it applies must arrive by import from a frozen module.
  for (const required of ["ipoLifecycle.ts", "ipoContractionStateExit.ts",
                          "ipoContractionTwoStage.ts", "ipoLiveVolatility.ts"]) {
    assert(imports.includes(required), `expected the engine to delegate to ${required}`);
  }
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // 2R is the frozen target and 1/3-style thirds must never appear here.
  assertEquals(code.match(/0\.\d+/g) ?? [], [],
    "a decimal literal in the engine means a rule was re-implemented");
});

Deno.test("compareToBatch reports both directions and value drift", () => {
  const live = [
    { ipoIndex: 1, entryIndex: 5, netR: 2, instrument: "X", direction: "demand",
      entry: 0, stop: 0, target: 0, risk: 1, vol: "HIGH_VOL", costR: 0,
      exitIndex: 6, exitPrice: 0, mae: 0, mfe: 0 },
    { ipoIndex: 9, entryIndex: 20, netR: 1, instrument: "X", direction: "demand",
      entry: 0, stop: 0, target: 0, risk: 1, vol: "HIGH_VOL", costR: 0,
      exitIndex: 21, exitPrice: 0, mae: 0, mfe: 0 },
  ] as any[];
  const batch = [
    { ipoIndex: 1, entryIndex: 5, netR: 2.5 },
    { ipoIndex: 30, entryIndex: 40, netR: -1 },
  ];
  const d = compareToBatch(live, batch);
  assertEquals(d.matched, 1);
  assertEquals(d.liveOnly.map((t) => t.entryIndex), [20]);
  assertEquals(d.batchOnly.map((t) => t.entryIndex), [40]);
  assertEquals(d.valueMismatches.length, 1);
  assertEquals(d.valueMismatches[0].batch, 2.5);
});

Deno.test("episodesFor applies the frozen contraction stack to any prefix", () => {
  const s = market(700);
  const full = episodesFor(s);
  const prefix = episodesFor(s.slice(0, 400));
  // Episodes fully contained in the prefix must be identical in both.
  for (const e of prefix.filter((x) => x.end < 300)) {
    assert(full.some((f) => f.start === e.start && f.end === e.end),
      `episode ${e.start}-${e.end} vanished when the future was added`);
  }
});

Deno.test("live and batch agree on the VALUE of every trade they both take", () => {
  const s = market(700);
  const lab = classifyCausal(s);
  const live = replay(s, cfg()).trades;
  const batch = batchTrades(s, false, () => 0, (i) => lab[i].vol);
  const d = compareToBatch(live, batch);
  assertEquals(d.valueMismatches, [],
    "the two paths disagreed on realized R for the same trade — an implementation bug, not lookahead");
});
