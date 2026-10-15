import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  candleTimeMs, EPOCH_MS, evaluateObservation, fxOpenNY, H1_MS, MIN_LIVE_RELEASE_MS, type Observation, planWrites, priceDecimals,
  RESEARCH_IMPORT_END_MS, roundToGrid, SETTLE_MS, type SourceSpan, valueHash,
} from "../../../functions/_shared/structure/canonicalBars.ts";
import { aggregate, fxOpen } from "../../../functions/_shared/structure/v32c/timeframes.ts";
import { initState, step } from "../../../functions/_shared/structure/v32c/engine.ts";
import { frozenV32cConfig } from "../../../functions/_shared/structure/v32c/config.ts";
import { SYNTHETIC_SERIES } from "../../fixtures/v32c/synthetic.ts";

/** Canonical 1H bars (V3.2c PR2): validity, grid rounding, the amended D9 settlement rule, append-only planning. */

const BAR = Date.parse("2026-11-04T09:00:00Z"); // a Wednesday, after the live release floor
const LIVE: SourceSpan = { source: "scanner_live", sourceRef: null, minBarTime: MIN_LIVE_RELEASE_MS, maxBarTimeExclusive: Infinity };
const obs = (p: Partial<Observation> = {}): Observation => ({ symbol: "EUR/USD", barTime: BAR, o: 1.1, h: 1.1012, l: 1.0995, c: 1.1008, observedAt: BAR + H1_MS + SETTLE_MS, provider: null, ...p });

Deno.test("frozen-calendar parity: fxOpenNY equals the frozen V3.2c fxOpen for every hour 2024-01-01 → 2028-01-01", () => {
  let n = 0;
  for (let t = Date.parse("2024-01-01T00:00:00Z"); t < Date.parse("2028-01-01T00:00:00Z"); t += H1_MS, n++) assertEquals(fxOpenNY(t), fxOpen(t), new Date(t).toISOString());
  assert(n > 35_000);
});

Deno.test("D9 settlement: before +15 min an observation is not canonical; at/after +15 min it is", () => {
  assertEquals(evaluateObservation(obs({ observedAt: BAR + H1_MS - 1 }), LIVE).kind === "rejected" && (evaluateObservation(obs({ observedAt: BAR + H1_MS - 1 }), LIVE) as any).reason, "not_closed");
  const early = evaluateObservation(obs({ observedAt: BAR + H1_MS + SETTLE_MS - 1 }), LIVE);
  assertEquals(early.kind === "rejected" ? early.reason : null, "not_settled");
  assertEquals(evaluateObservation(obs({ observedAt: BAR + H1_MS + SETTLE_MS }), LIVE).kind, "candidate");
  assertEquals(evaluateObservation(obs({ observedAt: BAR + 10 * H1_MS }), LIVE).kind, "candidate");
});

Deno.test("price grid: 5 dp for all six pairs (JPY included); symmetric rounding of float32 artefacts", () => {
  for (const p of ["EUR/USD", "GBP/USD", "USD/JPY", "CHF/JPY", "NZD/CAD", "NZD/CHF"]) assertEquals(priceDecimals(p), 5, p);
  assertEquals(roundToGrid("NZD/CAD", 0.82586002), 0.82586);
  assertEquals(roundToGrid("NZD/CAD", 0.82209003), 0.82209);
  assertEquals(roundToGrid("USD/JPY", 158.95808), 158.95808, "real 5-dp JPY precision is preserved");
  assertEquals(roundToGrid("CHF/JPY", 172.52699000001), 172.52699);
  assertEquals(roundToGrid("EUR/USD", -1.100005), -roundToGrid("EUR/USD", 1.100005), "symmetric in sign");
  const e = evaluateObservation(obs({ symbol: "NZD/CAD", o: 0.82209003, h: 0.82306999, l: 0.82056999, c: 0.82157999 }), LIVE);
  assertEquals(e.kind === "candidate" ? [e.row.open, e.row.high, e.row.low, e.row.close] : null, [0.82209, 0.82307, 0.82057, 0.82158]);
});

Deno.test("validity: unknown symbol, non-finite, off-grid, outside FX hours, before epoch, OHLC-inconsistent after rounding", () => {
  const r = (p: Partial<Observation>, span = LIVE) => { const e = evaluateObservation(obs(p), span); return e.kind === "rejected" ? e.reason : "candidate"; };
  assertEquals(r({ symbol: "XAU/USD" }), "unknown_symbol");
  assertEquals(r({ h: NaN }), "ohlc_inconsistent");
  assertEquals(r({ barTime: BAR + 60_000, observedAt: BAR + 3 * H1_MS }), "off_grid");
  assertEquals(r({ barTime: Date.parse("2026-11-07T12:00:00Z"), observedAt: Date.parse("2026-11-07T14:00:00Z") }), "outside_fx_hours"); // Saturday
  assertEquals(r({ barTime: EPOCH_MS - H1_MS, observedAt: EPOCH_MS + H1_MS }, { ...LIVE, minBarTime: 0 }), "before_epoch");
  assertEquals(r({ o: 1.1, h: 1.0999, l: 1.0995, c: 1.1 }), "ohlc_inconsistent");
});

Deno.test("ownership spans: the live path refuses the import span and the reserved window; the import path refuses ≥ 2026-10-09 21:00Z", () => {
  const live = (t: number) => { const e = evaluateObservation(obs({ barTime: t, observedAt: t + 2 * H1_MS }), LIVE); return e.kind === "rejected" ? e.reason : "candidate"; };
  assertEquals(live(Date.parse("2026-10-07T09:00:00Z")), "outside_source_span", "import-owned span");
  assertEquals(live(Date.parse("2026-10-14T09:00:00Z")), "outside_source_span", "reserved V2.1.1 window");
  assertEquals(live(Date.parse("2026-10-23T19:00:00Z")), "outside_source_span", "the last open hours before the release floor");
  assertEquals(live(Date.parse("2026-10-25T22:00:00Z")), "candidate", "first bar of the week after the window");
  const IMPORT: SourceSpan = { source: "research_import", sourceRef: "sha", minBarTime: EPOCH_MS, maxBarTimeExclusive: RESEARCH_IMPORT_END_MS };
  const imp = (t: number) => { const e = evaluateObservation(obs({ barTime: t, observedAt: t + 5 * 86_400_000 }), IMPORT); return e.kind === "rejected" ? e.reason : "candidate"; };
  assertEquals(imp(RESEARCH_IMPORT_END_MS - H1_MS), "candidate");
  assertEquals(imp(Date.parse("2026-10-12T09:00:00Z")), "outside_source_span");
});

Deno.test("append-only planning: new → insert; same value → duplicate; different value → revision, canonical untouched", () => {
  const a = evaluateObservation(obs(), LIVE), b = evaluateObservation(obs({ c: 1.1009 }), LIVE);
  assert(a.kind === "candidate" && b.kind === "candidate");
  const empty = planWrites([a], new Map(), "scanner_live");
  assertEquals([empty.inserts.length, empty.revisions.length], [1, 0]);
  const stored = new Map([[a.row.bar_time, { hash: a.hash, open: a.row.open, high: a.row.high, low: a.row.low, close: a.row.close }]]);
  const dup = planWrites([a], stored, "scanner_live");
  assertEquals([dup.inserts.length, dup.revisions.length, dup.counts.duplicate], [0, 0, 1]);
  const rev = planWrites([b], stored, "scanner_live");
  assertEquals([rev.inserts.length, rev.revisions.length], [0, 1]);
  assertEquals(rev.revisions[0].canonical_value_hash, a.hash);
  assertEquals(+rev.revisions[0].max_abs_diff.toFixed(5), 0.0001);
});

Deno.test("stale / repeated observations: a second, different observation in the same batch is a revision, never a second insert", () => {
  const first = evaluateObservation(obs({ observedAt: BAR + H1_MS + SETTLE_MS }), LIVE);
  const later = evaluateObservation(obs({ c: 1.1001, observedAt: BAR + 3 * H1_MS }), LIVE);
  const p = planWrites([first, later], new Map(), "scanner_live");
  assertEquals(p.inserts.length, 1);
  assertEquals(p.inserts[0].close, 1.1008, "first settled observation wins");
  assertEquals(p.revisions.length, 1);
});

Deno.test("rejections: data-quality reasons are logged with the path's source; ownership reasons are only counted", () => {
  const notSettled = evaluateObservation(obs({ observedAt: BAR + H1_MS + 60_000 }), LIVE);
  const owned = evaluateObservation(obs({ barTime: Date.parse("2026-10-14T09:00:00Z"), observedAt: Date.parse("2026-10-14T12:00:00Z") }), LIVE);
  const p = planWrites([notSettled, owned], new Map(), "scanner_live");
  assertEquals(p.rejections.map((r) => [r.reason, r.source]), [["not_settled", "scanner_live"]]);
  assertEquals(p.counts["rejected:outside_source_span"], 1);
});

Deno.test("candle time parsing and value hash", () => {
  assertEquals(candleTimeMs("2026-11-04T09:00:00Z"), BAR);
  assertEquals(candleTimeMs("2026-11-04 09:00:00"), BAR);
  assertEquals(valueHash("USD/JPY", 150.1, 150.2, 150, 150.15), "150.10000|150.20000|150.00000|150.15000");
});

Deno.test("NY D/4H compatibility: canonical rows → frozen aggregation → identical V3.2c events to the raw series (synthetic)", () => {
  const IMPORT: SourceSpan = { source: "research_import", sourceRef: "synthetic", minBarTime: EPOCH_MS, maxBarTimeExclusive: RESEARCH_IMPORT_END_MS };
  const raw = SYNTHETIC_SERIES["SYN-A"]().filter((b) => b.t >= EPOCH_MS); // 5-dp synthetic prices: rounding is a no-op
  const canon = raw.map((b) => evaluateObservation({ symbol: "EUR/USD", barTime: b.t, o: b.o, h: b.h, l: b.l, c: b.c, observedAt: b.t + 2 * H1_MS, provider: null }, IMPORT))
    .flatMap((e) => (e.kind === "candidate" ? [{ t: Date.parse(e.row.bar_time), o: e.row.open, h: e.row.high, l: e.row.low, c: e.row.close }] : []));
  const run = (hours: { t: number; o: number; h: number; l: number; c: number }[], tf: "D" | "4H" | "1H") => {
    const ag = aggregate(tf, hours.filter((b) => fxOpen(b.t))); let s = initState(); const ev: unknown[] = [];
    for (const b of ag.bars) { const r = step(frozenV32cConfig(tf), s, b); s = r.state; ev.push(...r.events); }
    return { bars: ag.bars.length, skipped: ag.skipped, ev: JSON.stringify(ev) };
  };
  assertEquals(canon.length, raw.length, "every synthetic FX-open bar is canonical");
  for (const tf of ["D", "4H", "1H"] as const) assertEquals(run(canon, tf), run(raw, tf), tf);
});

Deno.test("planWrites refuses a mixed-symbol batch (its bar_time keys are per symbol)", () => {
  const a = evaluateObservation(obs(), LIVE), b = evaluateObservation(obs({ symbol: "GBP/USD", o: 1.3, h: 1.3009, l: 1.2993, c: 1.3002 }), LIVE);
  assertThrows(() => planWrites([a, b], new Map(), "scanner_live"), Error, "one symbol per call");
  assertEquals(planWrites([b], new Map(), "scanner_live").inserts.length, 1);
});
