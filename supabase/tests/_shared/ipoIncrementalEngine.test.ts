import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { replay } from "../../functions/_shared/ipoLiveEngine.ts";
import {
  IncrementalEngine, replayIncremental, compareEngines,
} from "../../functions/_shared/ipoIncrementalEngine.ts";
import { episodesFor } from "../../functions/_shared/ipoLiveEngine.ts";
import type { EngineConfig } from "../../functions/_shared/ipoLiveEngine.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const bar = (i: number, o: number, h: number, l: number, c: number): Candle =>
  ({ datetime: new Date(Date.UTC(2025, 0, 1) + i * 3600_000).toISOString(),
     open: o, high: h, low: l, close: c, volume: 0 } as Candle);

const cfg = (over: Partial<EngineConfig> = {}): EngineConfig =>
  ({ instrument: "EUR/USD", timeframe: "1h", highVolOnly: false, costPerSide: () => 0, ...over });

/** Seeded walk with a slow volatility cycle — produces real contractions. */
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

/** THE contract: identical to the oracle, field by field. */
function assertEquivalent(s: Candle[], c: EngineConfig, label: string) {
  const o = replay(s, c).trades;
  const i = replayIncremental(s, c).trades;
  const r = compareEngines(o, i, 1e-9);
  assertEquals(r.firstDivergence, null,
    `${label}: ${r.firstDivergence}  [oracle ${o.length} / incremental ${i.length}]`);
  assertEquals(r.oracleOnly.length, 0, `${label}: oracle-only trades`);
  assertEquals(r.incrementalOnly.length, 0, `${label}: incremental-only trades`);
  assertEquals(r.fieldMismatches, [], `${label}: field mismatches`);
  assertEquals(o.length, i.length, `${label}: trade count`);
  return o.length;
}

Deno.test("equivalence — ungated instrument", () => {
  const n = assertEquivalent(market(700), cfg(), "ungated");
  assert(n > 3, `only ${n} trades — the fixture must exercise the engine`);
});

Deno.test("equivalence — volatility-gated instrument", () => {
  assertEquivalent(market(700, 42), cfg({ highVolOnly: true, instrument: "BTC/USD" }), "gated");
});

Deno.test("equivalence — price-proportional cost", () => {
  assertEquivalent(market(600, 11), cfg({ costPerSide: (p) => p * 0.0015 }), "proportional cost");
});

Deno.test("equivalence holds at every prefix length, not just the end", () => {
  // A divergence that self-corrects would still be a live-trading bug.
  const s = market(500, 3);
  for (const n of [120, 200, 280, 360, 440, 500]) {
    assertEquivalent(s.slice(0, n), cfg(), `prefix ${n}`);
  }
});

Deno.test("the incremental engine is causal — a later bar cannot change an earlier trade", () => {
  const s = market(600, 5);
  const full = replayIncremental(s, cfg()).trades.filter((t) => (t.exitIndex ?? 0) < 380);
  const part = replayIncremental(s.slice(0, 380), cfg()).trades.filter((t) => t.exitIndex !== null);
  assertEquals(part.length, full.length);
  for (let i = 0; i < part.length; i++) {
    assertEquals(part[i].entryIndex, full[i].entryIndex);
    assertEquals(part[i].netR, full[i].netR);
  }
});

Deno.test("the episode cache reproduces episodesFor at EVERY prefix", () => {
  // The cache is only sound because an episode ending before K-1 never changes.
  // If that ever stops holding, this fails before any trade does.
  const s = market(400, 9);
  const e = new IncrementalEngine(cfg());
  for (let k = 0; k < s.length; k++) {
    e.feed(s[k]);
    const cached = (e as unknown as { episodes: Array<{ start: number; end: number }> }).episodes;
    const truth = episodesFor(s.slice(0, k + 1));
    assertEquals(
      cached.map((x) => `${x.start}-${x.end}`).join(" "),
      truth.map((x) => `${x.start}-${x.end}`).join(" "),
      `episode list diverged at prefix ${k}`);
  }
});

Deno.test("suppression is re-evaluated, not frozen at candidate formation", () => {
  // A contraction detected later retroactively suppresses an earlier candidate.
  // Measured on real data: candidate 109 was VALID at prefix 110 and suppressed
  // at prefix 115. Holding the first answer would take a trade the oracle refuses.
  const s = market(500, 21);
  assertEquivalent(s, cfg(), "retroactive suppression");
});

Deno.test("never more than one position open at a time", () => {
  const e = new IncrementalEngine(cfg());
  for (const b of market(700)) e.feed(b);
  const t = e.trades;
  for (let i = 1; i < t.length; i++) {
    assert(t[i].entryIndex > (t[i - 1].exitIndex ?? -1),
      `trade ${i} opened at ${t[i].entryIndex} before the previous exit ${t[i - 1].exitIndex}`);
  }
});

Deno.test("a gated instrument fills only in HIGH_VOL", () => {
  const e = replayIncremental(market(700, 42), cfg({ highVolOnly: true }));
  for (const t of e.trades) assertEquals(t.vol, "HIGH_VOL");
  assert(e.refusals.some((r) => r.reason === "VOLATILITY_NOT_ELIGIBLE"),
    "the gate never fired, so this proves nothing");
});

Deno.test("cost is fixed at entry, matching the oracle", () => {
  const s = market(500, 13);
  const e = replayIncremental(s, cfg({ costPerSide: (p) => p * 0.001 }));
  for (const t of e.trades) {
    assertEquals(Math.round(t.costR * 1e9),
      Math.round(((2 * s[t.entryIndex].close * 0.001) / t.risk) * 1e9));
  }
});

Deno.test("the oracle is untouched by this module", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/ipoLiveEngine.ts");
  assert(src.includes("export class LiveEngine"), "the oracle must still exist");
  assert(!src.includes("ipoIncrementalEngine"),
    "the oracle must not depend on the engine it is meant to check");
  const mine = await Deno.readTextFile("supabase/functions/_shared/ipoIncrementalEngine.ts");
  // It may import the oracle's TYPES, but must not delegate decisions to it.
  assert(!/\breplay\s*\(/.test(mine.replace(/replayIncremental/g, "")),
    "the incremental engine must not call the oracle to do its work");
});

Deno.test("Phase B is engine-only — no trading-state table is referenced", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/ipoIncrementalEngine.ts");
  for (const t of ["paper_positions", "pending_orders", "paper_trade_history",
                   "paper_accounts", "broker-execute", "supabase", "createClient"]) {
    assert(!src.includes(t), `"${t}" must not appear in a Phase B engine module`);
  }
});
