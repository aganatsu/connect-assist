import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FakeDb } from "../scannerHarness.ts";
import { recordStructureBarsWhileFull } from "../../../functions/_shared/structure/recordWhileFull.ts";
import { liveWriterConfig } from "../../../functions/_shared/structure/structureBarsWriter.ts";
import { liveWriter5mConfig } from "../../../functions/_shared/structure/structureBarsWriter5m.ts";
import type { Candle } from "../../../functions/_shared/smcAnalysis.ts";

/** The structure-bar recorders keep running while bot-scanner is at its position cap (owner approval 2026-10-26). */

const NOW = Date.parse("2026-11-04T10:22:00Z"); // Wednesday, FX open
const ON1H = liveWriterConfig((k) => ({ STRUCTURE_BARS_LIVE_WRITE: "on", STRUCTURE_BARS_RELEASE_AT: "2026-10-23T21:00:00Z" } as Record<string, string>)[k]);
const ON5M = liveWriter5mConfig((k) => (k === "STRUCTURE_BARS_5M_LIVE_WRITE" ? "on" : undefined));
const OFF1H = liveWriterConfig(() => undefined), OFF5M = liveWriter5mConfig(() => undefined);
function series(stepMs: number, n: number): Candle[] {
  const out: Candle[] = [], last = Math.floor(NOW / stepMs) * stepMs;
  for (let i = n - 1; i >= 0; i--) { const t = last - i * stepMs, p = 1.1 + (i % 5) * 0.0002; out.push({ datetime: new Date(t).toISOString().replace(".000Z", "Z"), open: p, high: p + 0.0004, low: p - 0.0003, close: p + 0.0001 } as Candle); }
  return out;
}
function fetcher() {
  const calls: string[] = [];
  const f = (sym: string, interval: string, range: string) => { calls.push(`${sym}|${interval}|${range}`); return Promise.resolve(series(interval === "1h" ? 3_600_000 : 300_000, 120)); };
  return { calls, f };
}

Deno.test("while full: both writers record the structure pairs the account trades (same 1h/5m '5d' fetches as a full scan); others skipped", async () => {
  const db = new FakeDb(), { calls, f } = fetcher();
  const r = await recordStructureBarsWhileFull(db.client(), ["EUR/USD", "XAU/USD", "GBP/USD"], f, { entryInterval: "5m", nowMs: NOW, clock: () => NOW, cfg1h: ON1H, cfg5m: ON5M });
  assertEquals(Object.keys(r).sort(), ["EUR/USD", "GBP/USD"]);
  assertEquals(calls.sort(), ["EUR/USD|1h|5d", "EUR/USD|5m|5d", "GBP/USD|1h|5d", "GBP/USD|5m|5d"]);
  assert(r["EUR/USD"].h1?.ok && r["EUR/USD"].m5?.ok, JSON.stringify(r));
  assert(db.rows("structure_bars_1h").length > 0 && db.rows("structure_bars_5m").length > 0);
});

Deno.test("while full: writers off → no fetch at all; 5m only for a 5m entry timeframe", async () => {
  const db = new FakeDb(), a = fetcher();
  assertEquals(await recordStructureBarsWhileFull(db.client(), ["EUR/USD"], a.f, { entryInterval: "5m", nowMs: NOW, clock: () => NOW, cfg1h: OFF1H, cfg5m: OFF5M }), {});
  assertEquals(a.calls, []);
  const b = fetcher();
  await recordStructureBarsWhileFull(db.client(), ["EUR/USD"], b.f, { entryInterval: "15m", nowMs: NOW, clock: () => NOW, cfg1h: ON1H, cfg5m: ON5M });
  assertEquals(b.calls, ["EUR/USD|1h|5d"]);
});

Deno.test("while full: FX closed for more than 2 hours → no calls; just after the Friday close → still records (bars still settling)", async () => {
  const db = new FakeDb(), sat = fetcher();
  assertEquals(await recordStructureBarsWhileFull(db.client(), ["EUR/USD"], sat.f, { entryInterval: "5m", nowMs: Date.parse("2026-10-31T12:00:00Z"), cfg1h: ON1H, cfg5m: ON5M }), {});
  assertEquals(sat.calls, []);
  const fri = fetcher();
  await recordStructureBarsWhileFull(db.client(), ["EUR/USD"], fri.f, { entryInterval: "5m", nowMs: Date.parse("2026-10-30T21:40:00Z"), cfg1h: ON1H, cfg5m: ON5M });
  assertEquals(fri.calls.length, 2);
});

Deno.test("while full: a failed fetch or database error is contained per pair, never thrown", async () => {
  const db = new FakeDb();
  const r = await recordStructureBarsWhileFull(db.client(), ["EUR/USD", "GBP/USD"], (s) => (s === "EUR/USD" ? Promise.reject(new Error("credit refused")) : Promise.resolve(series(3_600_000, 60))),
    { entryInterval: "5m", nowMs: NOW, clock: () => NOW, cfg1h: ON1H, cfg5m: ON5M });
  assertEquals(r["EUR/USD"].error, "credit refused");
  assert(r["GBP/USD"].h1 !== undefined);
  db.fault = () => "throw";
  const t = await recordStructureBarsWhileFull(db.client(), ["EUR/USD"], (s, i) => Promise.resolve(series(i === "1h" ? 3_600_000 : 300_000, 60)), { entryInterval: "5m", nowMs: NOW, clock: () => NOW, cfg1h: ON1H, cfg5m: ON5M });
  assertEquals([t["EUR/USD"].h1?.ok, t["EUR/USD"].m5?.ok], [false, false]);
});
