import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildSnapshot } from "../../../functions/_shared/smcScanSnapshot.ts";
import type { Candle } from "../../../functions/_shared/smcAnalysis.ts";
import { valueHash } from "../../../functions/_shared/structure/canonicalBars.ts";
import { FILL_OBSERVATION_SLACK_MS, planFill, valuesAtScan, type FillManifest, type FillStoredBar } from "../../../functions/_shared/structure/scanBarsFill.ts";

/** The smc_scan_bars fill (D26) — synthetic scans written through the scanner's own buildSnapshot. */

const H = 3_600_000, M = 60_000, SYM = "EUR/USD";
const T0 = Date.parse("2026-10-13T00:00:00Z"); // Tuesday, FX open all day
const iso = (ms: number) => new Date(ms).toISOString();
const isoZ = (ms: number) => iso(ms).replace(".000Z", "Z");
const bar = (t: number, base: number): Candle => ({ datetime: isoZ(t), open: base, high: base + 0.001, low: base - 0.001, close: base + 0.0005 } as Candle);

/** A fake store: smc_scan_bars rows (one per distinct value, first_seen_at) + one 1H manifest per scan, as the scanner writes them. */
function store() {
  const bars: FillStoredBar[] = [], manifests: FillManifest[] = [];
  let n = 0;
  const scan = (nowMs: number, candles: Candle[]) => {
    const id = `scan-${++n}`;
    const s = buildSnapshot({ scanCycleId: id, userId: "u", botId: "smc", symbol: SYM, style: "scalper", nowMs, fetchedAt: iso(nowMs), inputs: [{ slot: "context", timeframe: "1h", candles }] });
    for (const b of s.bars) {
      if (bars.some((x) => x.bar_time === iso(Date.parse(b.bar_time)) && valueHash(SYM, x.open, x.high, x.low, x.close) === valueHash(SYM, b.open, b.high, b.low, b.close))) continue;
      bars.push({ bar_time: iso(Date.parse(b.bar_time)), bar_time_raw: b.bar_time_raw, open: b.open, high: b.high, low: b.low, close: b.close, first_seen_at: iso(nowMs), provider: null });
    }
    for (const m of s.manifest) manifests.push({ ...m, scanned_at: iso(nowMs + 500), forming_bar: m.forming_bar ?? null } as FillManifest);
    return id;
  };
  return { bars, manifests, scan };
}
const series = (upTo: number, override: Record<number, Candle> = {}) => {
  const out: Candle[] = [];
  for (let t = T0; t < upTo; t += H) out.push(override[t] ?? bar(t, 1.1 + (t - T0) / H / 1000));
  return out;
};

Deno.test("fill: a provisional value seen at close is never canonical; the first settled scan's value is, timed conservatively", () => {
  const s = store(), B = T0 + 16 * H, close = B + H, until = T0 + 17 * H;
  const provisional = { ...bar(B, 1.2), close: 1.2003 } as Candle;
  s.scan(close + 7_000, series(close, { [B]: provisional }));   // 17:00:07 — closed by the clock, not yet final
  s.scan(close + 10 * M, series(close));                        // 17:10 — final value first seen here (first_seen_at < settle point)
  s.scan(close + 20 * M, series(close));                        // 17:20 — observedAt 17:10, still inside the settle window
  const settledId = s.scan(close + 30 * M, series(close));      // 17:30 — observedAt 17:20 ≥ close + 15 min
  const p = planFill(SYM, s.manifests, s.bars, until, new Map());
  const row = p.inserts.find((r) => r.bar_time === iso(B))!;
  const final = series(close)[16];
  assertEquals(valueHash(SYM, row.open, row.high, row.low, row.close), valueHash(SYM, final.open, final.high, final.low, final.close));
  assertEquals(row.observed_at, iso(close + 30 * M - FILL_OBSERVATION_SLACK_MS));
  assertEquals(row.source, "smc_scan_bars_fill");
  assertEquals(row.source_ref, `smc_scan_manifest:${settledId}`);
  assertEquals(p.revisions.length, 0, "the provisional value precedes settlement: it is not a revision");
  assertEquals(p.counts.manifest_verified, 4);
  assert(p.counts["observation_rejected:not_settled"] > 0);
});

Deno.test("fill: a later DIFFERENT settled value is a revision against the canonical value, never a rewrite", () => {
  const s = store(), B = T0 + 10 * H, until = T0 + 12 * H, last = T0 + 12 * H;
  s.scan(last + 30 * M, series(last));
  const revised = { ...bar(B, 1.11), high: 1.11 + 0.0013 } as Candle;
  s.scan(last + 40 * M, series(last, { [B]: revised }));
  const p = planFill(SYM, s.manifests, s.bars, until, new Map());
  const row = p.inserts.find((r) => r.bar_time === iso(B))!;
  assertEquals(row.high, bar(B, 1.11).high);
  assertEquals(p.revisions.length, 1);
  assertEquals(p.revisions[0].bar_time, iso(B));
  assertEquals(p.revisions[0].canonical_value_hash, valueHash(SYM, row.open, row.high, row.low, row.close));
  assertEquals(+p.revisions[0].max_abs_diff.toFixed(5), 0.0003);
  assertEquals(p.counts.later_revision, 1);
});

Deno.test("fill: a manifest that does not reconstruct is skipped, never trusted", () => {
  const s = store(), last = T0 + 6 * H;
  s.scan(last + 30 * M, series(last));
  s.manifests[0].content_hash = "0000000000000000";
  const p = planFill(SYM, s.manifests, s.bars, last, new Map());
  assertEquals(p.inserts.length, 0);
  assertEquals(p.counts.manifest_unreconstructable, 1);
});

Deno.test("fill: values at scan = latest stored value first seen at or before scanned_at", () => {
  const s = store(), B = T0 + 2 * H, last = T0 + 4 * H;
  s.scan(last + 30 * M, series(last));
  s.scan(last + 40 * M, series(last, { [B]: bar(B, 1.5) }));
  const first = valuesAtScan(s.manifests[0], s.bars).find((c) => c.datetime === isoZ(B))!;
  const second = valuesAtScan(s.manifests[1], s.bars).find((c) => c.datetime === isoZ(B))!;
  assertEquals(first.open, bar(B, 1.102).open);
  assertEquals(second.open, 1.5);
});

Deno.test("fill: span, forming bar, weekend hours, existing rows", () => {
  const s = store(), last = T0 + 8 * H;
  const forming = [...series(last), bar(last, 1.3)];                       // the 08:00 bar is still forming at 08:30
  s.scan(last + 30 * M, forming);
  const until = T0 + 6 * H;
  const p = planFill(SYM, s.manifests, s.bars, until, new Map());
  assert(p.inserts.every((r) => Date.parse(r.bar_time) < until), "nothing at/after --until (the live writer's span)");
  assertEquals(p.inserts.length, 6);
  const all = planFill(SYM, s.manifests, s.bars, T0 + 9 * H, new Map());
  assert(!all.inserts.some((r) => r.bar_time === iso(last)), "a forming bar is never an observation");
  // re-run with the rows already stored: nothing new
  const existing = new Map(p.inserts.map((r) => [r.bar_time, { hash: valueHash(SYM, r.open, r.high, r.low, r.close), open: r.open, high: r.high, low: r.low, close: r.close }]));
  const again = planFill(SYM, s.manifests, s.bars, until, existing);
  assertEquals(again.inserts.length, 0);
  assertEquals(again.counts.duplicate, 6);
  // weekend bars (FX closed) are counted, not planned
  const w = store(), sat = Date.parse("2026-10-17T10:00:00Z");
  w.scan(sat + 2 * H, [bar(sat - H, 1.1), bar(sat, 1.1)]);
  const pw = planFill(SYM, w.manifests, w.bars, Date.parse("2026-10-18T00:00:00Z"), new Map());
  assertEquals(pw.inserts.length, 0);
  assertEquals(pw.counts["observation_rejected:outside_fx_hours"], 2);
  assertThrows(() => planFill(SYM, [], [], until + 1, new Map()), Error, "hour boundary");
  assertThrows(() => planFill(SYM, [], [], Date.parse("2026-10-09T21:00:00Z"), new Map()), Error, "hour boundary");
});
