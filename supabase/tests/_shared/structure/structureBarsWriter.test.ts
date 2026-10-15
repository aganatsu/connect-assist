import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FakeDb } from "../scannerHarness.ts";
import { H1_MS, SETTLE_MS } from "../../../functions/_shared/structure/canonicalBars.ts";
import { liveWriterConfig, OBSERVATION_SLACK_MS, writeLiveStructureBars } from "../../../functions/_shared/structure/structureBarsWriter.ts";
import type { Candle } from "../../../functions/_shared/smcAnalysis.ts";

/** The default-off live writer: isolation, batching, bounded awaited persistence, failure containment. */

const RELEASE = "2026-10-25T21:00:00Z";
const ON = liveWriterConfig((k) => ({ STRUCTURE_BARS_LIVE_WRITE: "on", STRUCTURE_BARS_RELEASE_AT: RELEASE } as Record<string, string>)[k]);
// 60 hourly candles ending with the bar forming at NOW (Wednesday 2026-11-04 10:20Z): last closed bar 09:00–10:00.
const NOW = Date.parse("2026-11-04T10:20:00Z");
// A fetch at 10:13: observation = 10:11 (fetch − 2 min slack) < 10:15, so the 09:00–10:00 bar is closed but NOT settled.
const FETCH = Date.parse("2026-11-04T10:13:00Z");
function candles(n = 60, bump = 0): Candle[] {
  const out: Candle[] = [], forming = Math.floor(NOW / H1_MS) * H1_MS;
  for (let i = n - 1; i >= 0; i--) {
    const t = forming - i * H1_MS, p = 1.1 + (i % 7) * 0.0003;
    out.push({ datetime: new Date(t).toISOString().replace(".000Z", "Z"), open: p, high: p + 0.0009 + (i === 3 ? bump : 0), low: p - 0.0007, close: p + 0.0002 });
  }
  return out;
}
const freezeAll = (cs: Candle[]) => Object.freeze(cs.map((c) => Object.freeze({ ...c })));

Deno.test("config: off by default; on requires a release time at/after 2026-10-23 21:00Z", () => {
  assertEquals(liveWriterConfig(() => undefined), { enabled: false, reason: "flag off" });
  assertEquals(liveWriterConfig((k) => (k === "STRUCTURE_BARS_LIVE_WRITE" ? "on" : undefined)).enabled, false);
  assertEquals(liveWriterConfig((k) => ({ STRUCTURE_BARS_LIVE_WRITE: "on", STRUCTURE_BARS_RELEASE_AT: "2026-10-15T00:00:00Z" } as Record<string, string>)[k]).enabled, false, "inside the reserved window");
  assertEquals(liveWriterConfig((k) => ({ STRUCTURE_BARS_LIVE_WRITE: "true", STRUCTURE_BARS_RELEASE_AT: RELEASE } as Record<string, string>)[k]).enabled, false, "only the exact value 'on' enables");
  assert(ON.enabled);
});

Deno.test("OFF: no database operation at all", async () => {
  const db = new FakeDb();
  const t = await writeLiveStructureBars(db.client(), "EUR/USD", candles(), { cfg: liveWriterConfig(() => undefined), fetchStartedAtMs: NOW });
  assertEquals([t.ok, t.dbOps, db.reads.length, db.writes.length], [true, 0, 0, 0]);
});

Deno.test("ON: settled bars become canonical, the newest closed bar is not yet settled, at most 4 batched operations", async () => {
  const db = new FakeDb();
  const t = await writeLiveStructureBars(db.client(), "EUR/USD", freezeAll(candles()), { cfg: ON, fetchStartedAtMs: FETCH });
  assert(t.ok, JSON.stringify(t));
  assert(t.dbOps <= 4, `${t.dbOps} ops`);
  const rows = db.rows("structure_bars_1h");
  // last 48 candles: 1 forming (not_closed, counted), 1 closed but observed only 11 min after its close → not_settled (logged)
  assertEquals(t.counts["rejected:not_closed"], 1);
  assertEquals(t.counts["rejected:not_settled"], 1);
  assert(rows.length > 0 && rows.every((r) => r.source === "scanner_live" && Date.parse(r.bar_time) >= Date.parse(RELEASE)));
  assert(rows.every((r) => Date.parse(r.observed_at) >= Date.parse(r.bar_time) + H1_MS + SETTLE_MS));
  assertEquals(db.rows("structure_bar_rejections").map((r) => r.reason), ["not_settled"]);
});

Deno.test("re-run: identical observations are duplicates (no writes to canonical); a changed value is a revision only", async () => {
  const db = new FakeDb();
  await writeLiveStructureBars(db.client(), "EUR/USD", candles(), { cfg: ON, fetchStartedAtMs: FETCH });
  const before = structuredClone(db.rows("structure_bars_1h"));
  const again = await writeLiveStructureBars(db.client(), "EUR/USD", candles(), { cfg: ON, fetchStartedAtMs: FETCH + 600_000 });
  assertEquals(again.counts.insert ?? 0, 1, "only the bar that has meanwhile settled is new");
  const rev = await writeLiveStructureBars(db.client(), "EUR/USD", candles(60, 0.0005), { cfg: ON, fetchStartedAtMs: FETCH + 1_200_000 });
  assertEquals(rev.counts.revision, 1);
  const after = db.rows("structure_bars_1h");
  for (const r of before) assertEquals(after.find((x) => x.bar_time === r.bar_time), r, "canonical rows never rewritten");
  assertEquals(db.rows("structure_bar_revisions").length, 1);
});

Deno.test("observation time is fetch start − slack: a candle fetched exactly at +15 min is NOT treated as settled", async () => {
  const lastClosedStart = Math.floor(NOW / H1_MS) * H1_MS - H1_MS;
  const db = new FakeDb();
  const t = await writeLiveStructureBars(db.client(), "EUR/USD", candles(), { cfg: ON, fetchStartedAtMs: lastClosedStart + H1_MS + SETTLE_MS });
  assert(!db.rows("structure_bars_1h").some((r) => Date.parse(r.bar_time) === lastClosedStart), "slack keeps it pending");
  assert(t.counts["rejected:not_settled"] >= 1);
  const t2 = await writeLiveStructureBars(db.client(), "EUR/USD", candles(), { cfg: ON, fetchStartedAtMs: lastClosedStart + H1_MS + SETTLE_MS + OBSERVATION_SLACK_MS });
  assert(t2.ok && db.rows("structure_bars_1h").some((r) => Date.parse(r.bar_time) === lastClosedStart));
});

Deno.test("failures never throw: read error, read throw, write error → telemetry only", async () => {
  for (const [name, fault] of [
    ["read error", (op: string) => (op === "read" ? "error" : null)],
    ["read throw", (op: string) => (op === "read" ? "throw" : null)],
    ["write error", (op: string) => (op === "write" ? "error" : null)],
  ] as const) {
    const db = new FakeDb(); db.fault = fault as FakeDb["fault"];
    const t = await writeLiveStructureBars(db.client(), "EUR/USD", candles(), { cfg: ON, fetchStartedAtMs: NOW });
    assertEquals(t.ok, false, name); assert(t.error, name);
  }
});

Deno.test("bounded: a hung database is aborted at the timeout and the call resolves (nothing left unawaited)", async () => {
  let aborted = 0;
  const hung = {
    from: () => {
      let signal: AbortSignal | undefined;
      const q: any = {
        select: () => q, eq: () => q, in: () => q, upsert: () => q,
        abortSignal: (s: AbortSignal) => { signal = s; return q; },
        then: (res: any, rej: any) => new Promise((_r, reject) => signal?.addEventListener("abort", () => { aborted++; reject(new Error("aborted")); })).then(res, rej),
      };
      return q;
    },
  };
  const t0 = Date.now();
  const t = await writeLiveStructureBars(hung, "EUR/USD", candles(), { cfg: ON, fetchStartedAtMs: NOW, timeoutMs: 50 });
  assertEquals([t.ok, t.timedOut], [false, true]);
  assertEquals(aborted, 1, "the in-flight query was aborted");
  assert(Date.now() - t0 < 1_000);
});

Deno.test("never mutates the scanner's candles", async () => {
  const cs = candles(), snapshot = structuredClone(cs);
  await writeLiveStructureBars(new FakeDb().client(), "EUR/USD", freezeAll(cs), { cfg: ON, fetchStartedAtMs: NOW });
  assertEquals(cs, snapshot);
});
