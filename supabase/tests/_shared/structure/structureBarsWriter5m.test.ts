import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FakeDb } from "../scannerHarness.ts";
import { evaluateObservation5m, M5_MS } from "../../../functions/_shared/structure/canonicalBars5m.ts";
import { liveWriter5mConfig, writeLiveStructureBars5m } from "../../../functions/_shared/structure/structureBarsWriter5m.ts";
import { OBSERVATION_SLACK_MS } from "../../../functions/_shared/structure/structureBarsWriter.ts";
import { SETTLE_MS } from "../../../functions/_shared/structure/canonicalBars.ts";
import type { Candle } from "../../../functions/_shared/smcAnalysis.ts";

/** The default-off canonical 5m writer (Impulse-on-V3 shadow, option A): settlement, batching, isolation, failure containment. */

const ON = liveWriter5mConfig((k) => (k === "STRUCTURE_BARS_5M_LIVE_WRITE" ? "on" : undefined));
const NOW = Date.parse("2026-11-04T10:22:00Z"); // Wednesday; the 10:20 bar is forming
function candles(n = 60, bump = 0): Candle[] {
  const out: Candle[] = [], forming = Math.floor(NOW / M5_MS) * M5_MS;
  for (let i = n - 1; i >= 0; i--) {
    const t = forming - i * M5_MS, p = 1.1 + (i % 7) * 0.0001;
    out.push({ datetime: new Date(t).toISOString().replace(".000Z", "Z"), open: p, high: p + 0.0003 + (i === 6 ? bump : 0), low: p - 0.0002, close: p + 0.0001 });
  }
  return out;
}

Deno.test("5m rule: settled = observed ≥ 15 min after close; grid, FX hours and OHLC enforced; 5-dp rounding", () => {
  const t = Date.parse("2026-11-04T10:00:00Z"), b = { symbol: "EUR/USD", barTime: t, o: 1.1, h: 1.10050001, l: 1.0998, c: 1.1002, provider: null };
  assertEquals(evaluateObservation5m({ ...b, observedAt: t + M5_MS + SETTLE_MS - 1 }).kind, "rejected");
  const ok = evaluateObservation5m({ ...b, observedAt: t + M5_MS + SETTLE_MS });
  assert(ok.kind === "candidate" && ok.row.high === 1.1005 && ok.row.source === "scanner_live");
  assertEquals((evaluateObservation5m({ ...b, barTime: t + 60_000, observedAt: t + 3_600_000 }) as { reason: string }).reason, "off_grid");
  assertEquals((evaluateObservation5m({ ...b, barTime: Date.parse("2026-11-07T12:00:00Z"), observedAt: Date.parse("2026-11-07T13:00:00Z") }) as { reason: string }).reason, "outside_fx_hours");
  assertEquals((evaluateObservation5m({ ...b, h: 1.0999, observedAt: t + 3_600_000 }) as { reason: string }).reason, "ohlc_inconsistent");
  assertEquals((evaluateObservation5m({ ...b, symbol: "BTC/USD", observedAt: t + 3_600_000 }) as { reason: string }).reason, "unknown_symbol");
});

Deno.test("5m writer: off by default (no database access at all)", async () => {
  assertEquals(liveWriter5mConfig(() => undefined), { enabled: false, reason: "flag off" });
  assertEquals(liveWriter5mConfig(() => "true").enabled, false, "only the exact value 'on' enables");
  const db = new FakeDb();
  const t = await writeLiveStructureBars5m(db.client(), "EUR/USD", candles(), { cfg: liveWriter5mConfig(() => undefined), fetchStartedAtMs: NOW });
  assertEquals([t.ok, t.dbOps, db.reads.length, db.writes.length], [true, 0, 0, 0]);
});

Deno.test("5m writer ON: only settled bars become canonical, ≤ 3 batched operations; a re-run adds only newly settled bars", async () => {
  const db = new FakeDb(), frozen = Object.freeze(candles().map((c) => Object.freeze({ ...c })));
  const t = await writeLiveStructureBars5m(db.client(), "EUR/USD", frozen, { cfg: ON, fetchStartedAtMs: NOW });
  assert(t.ok, JSON.stringify(t));
  assert(t.dbOps <= 3);
  const rows = db.rows("structure_bars_5m");
  assert(rows.length > 40 && rows.every((r) => Date.parse(r.observed_at) >= Date.parse(r.bar_time) + M5_MS + SETTLE_MS));
  assertEquals(rows.every((r) => Date.parse(r.observed_at) === NOW - OBSERVATION_SLACK_MS), true);
  assert(t.counts["rejected:not_settled"] >= 2 && t.counts["rejected:not_closed"] === 1);
  const n0 = rows.length;
  const again = await writeLiveStructureBars5m(db.client(), "EUR/USD", candles(), { cfg: ON, fetchStartedAtMs: NOW + 10 * 60_000 });
  assertEquals(again.counts.insert, 2, "two more bars have settled 10 minutes later");
  assertEquals(db.rows("structure_bars_5m").length, n0 + 2);
});

Deno.test("5m writer: a changed value for a canonical bar is a revision row only; the canonical row never changes", async () => {
  const db = new FakeDb();
  await writeLiveStructureBars5m(db.client(), "EUR/USD", candles(), { cfg: ON, fetchStartedAtMs: NOW });
  const before = structuredClone(db.rows("structure_bars_5m"));
  const r = await writeLiveStructureBars5m(db.client(), "EUR/USD", candles(60, 0.0004), { cfg: ON, fetchStartedAtMs: NOW + 60_000 });
  assertEquals(r.counts.revision, 1);
  assertEquals(db.rows("structure_bars_5m").filter((x) => before.some((b) => b.bar_time === x.bar_time)), before);
  assertEquals(db.rows("structure_bar_5m_revisions").length, 1);
});

Deno.test("5m writer: database errors and throws are contained in the telemetry, never thrown", async () => {
  const db = new FakeDb();
  db.fault = (op) => (op === "write" ? "error" : null);
  const e = await writeLiveStructureBars5m(db.client(), "EUR/USD", candles(), { cfg: ON, fetchStartedAtMs: NOW });
  assertEquals(e.ok, false);
  db.fault = () => "throw";
  const t = await writeLiveStructureBars5m(db.client(), "EUR/USD", candles(), { cfg: ON, fetchStartedAtMs: NOW });
  assertEquals([t.ok, typeof t.error], [false, "string"]);
});
