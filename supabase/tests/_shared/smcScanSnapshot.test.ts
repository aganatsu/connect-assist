/**
 * SMC scan candle observability.
 *
 * WHAT THESE GUARD. The feature exists because `scan_candle_snapshots` was
 * created and never written to, so no SMC engine can be determinism-tested. The
 * two ways this replacement could fail are (a) costing more than it is worth,
 * and (b) reaching a trading decision. Both are pinned here, along with the
 * reconstruction contract a future replay depends on.
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildSnapshot, buildContext, hashCandles, hashStructure, lastBarClosed, barMsOf,
  reconstruct, SMC_CONTRACT_VERSION, type SnapshotInput,
} from "../../functions/_shared/smcScanSnapshot.ts";
import type { Candle } from "../../functions/_shared/smcAnalysis.ts";

const T0 = Date.UTC(2026, 8, 25, 0, 0, 0);
const bar = (i: number, step = 300_000): Candle => ({
  datetime: new Date(T0 + i * step).toISOString(),
  open: 1 + i / 1e5, high: 1.001 + i / 1e5, low: 0.999 + i / 1e5,
  close: 1.0005 + i / 1e5, volume: 10 + i,
});
const series = (n: number, step = 300_000) => Array.from({ length: n }, (_, i) => bar(i, step));

const args = (inputs: SnapshotInput[], nowMs = T0 + 300 * 300_000) => ({
  scanCycleId: "scan_abc", userId: "11111111-1111-1111-1111-111111111111",
  botId: "smc", symbol: "EUR/USD", style: "scalper", nowMs,
  fetchedAt: new Date(nowMs).toISOString(), inputs,
});

// ─────────────────────────────────────────────────────────────────────────────
// deduplication — the reason this design exists
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("a bar shared by two slots is stored once, not twice", () => {
  // The scalper passes the 5m array as BOTH `low` and `entry`. Writing it twice
  // would double the bar table for no information.
  const m5 = series(300);
  const { bars, manifest } = buildSnapshot(args([
    { slot: "low", timeframe: "5m", candles: m5 },
    { slot: "entry", timeframe: "5m", candles: m5 },
  ]));
  assertEquals(bars.length, 300, "the shared array was stored twice");
  assertEquals(manifest.length, 2, "but each slot still gets its own manifest row");
  assertEquals(manifest[0].slot, "low");
  assertEquals(manifest[1].slot, "entry");
});

Deno.test("consecutive scans add one bar, not three hundred", () => {
  // This is the whole economic argument. A jsonb array per scan costs ~24 KB
  // every five minutes for an array that gained one bar.
  const first = buildSnapshot(args([{ slot: "low", timeframe: "5m", candles: series(300) }]));
  const second = buildSnapshot(args([{ slot: "low", timeframe: "5m", candles: series(301) }]));
  const firstKeys = new Set(first.bars.map((b) => b.bar_time));
  const novel = second.bars.filter((b) => !firstKeys.has(b.bar_time));
  assertEquals(novel.length, 1, "a five-minute tick should introduce exactly one new bar");
  // The manifest still describes the full 301-bar array.
  assertEquals(second.manifest[0].bar_count, 301);
});

Deno.test("an empty slot writes nothing rather than a zero-bar manifest", () => {
  const { bars, manifest } = buildSnapshot(args([
    { slot: "top", timeframe: "1h", candles: [] },
    { slot: "low", timeframe: "5m", candles: series(10) },
  ]));
  assertEquals(manifest.length, 1);
  assertEquals(manifest[0].slot, "low");
  assertEquals(bars.length, 10);
});

// ─────────────────────────────────────────────────────────────────────────────
// the reconstruction contract a replay depends on
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("a manifest plus stored bars reconstructs the exact array", () => {
  const m5 = series(300);
  const { manifest } = buildSnapshot(args([{ slot: "low", timeframe: "5m", candles: m5 }]));
  // Stored bars arrive from Postgres in arbitrary order and with neighbours.
  const stored = [...series(400)].reverse();
  const out = reconstruct(manifest[0], stored);
  assert(out.ok, `reconstruction failed: ${out.ok ? "" : out.reason}`);
  if (!out.ok) return;
  assertEquals(out.candles.length, 300);
  assertEquals(out.candles[0].datetime, m5[0].datetime);
  assertEquals(out.candles[299].datetime, m5[299].datetime);
});

Deno.test("a tampered or incomplete bar set fails loudly, never silently", () => {
  const m5 = series(300);
  const { manifest } = buildSnapshot(args([{ slot: "low", timeframe: "5m", candles: m5 }]));

  // One bar altered — the digest must catch it rather than score a different array.
  const tampered = m5.map((c, i) => i === 150 ? { ...c, close: c.close + 0.01 } : c);
  const bad = reconstruct(manifest[0], tampered);
  assertEquals(bad.ok, false);
  if (!bad.ok) assert(bad.reason.includes("content_hash"));

  // One bar missing.
  const short = m5.filter((_, i) => i !== 150);
  const missing = reconstruct(manifest[0], short);
  assertEquals(missing.ok, false);
  if (!missing.ok) assert(missing.reason.includes("bar_count"));
});

Deno.test("the hash depends on prices and order, not on volume alone", () => {
  const a = series(50);
  assertEquals(hashCandles(a), hashCandles([...a]), "same array must hash the same");
  const movedPrice = a.map((c, i) => i === 10 ? { ...c, high: c.high + 1e-6 } : c);
  assert(hashCandles(a) !== hashCandles(movedPrice), "a price change must change the hash");
  const shorter = a.slice(0, 49);
  assert(hashCandles(a) !== hashCandles(shorter), "a length change must change the hash");
});

// ─────────────────────────────────────────────────────────────────────────────
// the forming-bar question, recorded rather than re-derived
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("last_bar_closed records whether the newest bar had finished", () => {
  const m5 = series(10);                       // last bar opens at T0 + 9*5min
  const lastOpen = T0 + 9 * 300_000;
  assertEquals(lastBarClosed(m5, lastOpen + 300_000, 300_000), true, "closed exactly on the boundary");
  assertEquals(lastBarClosed(m5, lastOpen + 120_000, 300_000), false, "still forming mid-bar");
  // Unknown bar length is null, never a guess.
  assertEquals(lastBarClosed(m5, lastOpen, null), null);
  assertEquals(lastBarClosed([], lastOpen, 300_000), null);
});

Deno.test("the forming-bar flag reaches the manifest", () => {
  const m5 = series(10);
  const mid = buildSnapshot(args([{ slot: "low", timeframe: "5m", candles: m5 }],
    T0 + 9 * 300_000 + 60_000));
  assertEquals(mid.manifest[0].last_bar_closed, false,
    "production scores a forming bar ~61% of the time; the row must say so");
  const done = buildSnapshot(args([{ slot: "low", timeframe: "5m", candles: m5 }],
    T0 + 10 * 300_000));
  assertEquals(done.manifest[0].last_bar_closed, true);
});

Deno.test("an unrecognised timeframe yields null rather than a wrong bar length", () => {
  assertEquals(barMsOf("5m"), 300_000);
  assertEquals(barMsOf("1h"), 3_600_000);
  assertEquals(barMsOf("confirm"), null);
  const { manifest } = buildSnapshot(args([{ slot: "confirm", timeframe: "confirm", candles: series(5) }]));
  assertEquals(manifest[0].last_bar_closed, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// the non-candle arguments — the Stage 2E lesson
// ─────────────────────────────────────────────────────────────────────────────

const ctxArgs = (over: Record<string, unknown> = {}) => ({
  scanCycleId: "scan_abc", userId: "11111111-1111-1111-1111-111111111111",
  botId: "smc", symbol: "AUD/USD", style: "day_trader",
  direction: "long", lastPrice: 0.6612,
  tfLabels: { display: { top: "D", mid: "4H", low: "1H" }, slots: { top: "1d" } },
  engineArgs: { pipSize: 0.0001, tpRatio: 2, minSlPips: 12 },
  htfConfluence: { h4OBs: [{ high: 1, low: 0.9 }], direction: "bullish" },
  liquidityPools: [{ level: 0.66, touches: 3 }],
  ...over,
});

Deno.test("the context row carries the arguments candles cannot reproduce", () => {
  const row = buildContext(ctxArgs());
  // Stage 2E: omitting htfConfluenceData took AUD/USD from 84.9% to 37.3%.
  assert(row.htf_confluence_hash, "the HTF bundle must be recoverable or verifiable");
  assert(row.liquidity_pool_hash);
  assertEquals(row.direction, "long");
  assertEquals(row.last_price, 0.6612);
  assertEquals((row.engine_args as Record<string, unknown>).tpRatio, 2);
  assertEquals(row.contract_version, SMC_CONTRACT_VERSION);
});

Deno.test("an absent HTF bundle hashes to null, not to the hash of nothing", () => {
  // `null` and "present but empty" are different inputs to the engine and must
  // stay distinguishable — conflating them is how the Stage 1 harness hid its
  // own omission.
  const absent = buildContext(ctxArgs({ htfConfluence: null }));
  assertEquals(absent.htf_confluence_hash, null);
  const empty = buildContext(ctxArgs({ htfConfluence: {} }));
  assert(empty.htf_confluence_hash !== null);
});

Deno.test("structure hashing ignores key order but not values", () => {
  assertEquals(
    hashStructure({ a: 1, b: { c: 2, d: 3 } }),
    hashStructure({ b: { d: 3, c: 2 }, a: 1 }),
    "a refactor that reorders an object literal must not read as drift",
  );
  assert(hashStructure({ a: 1 }) !== hashStructure({ a: 2 }), "a value change must show");
  assert(hashStructure([1, 2]) !== hashStructure([2, 1]), "array order is meaningful");
  assertEquals(hashStructure({ a: -0 }), hashStructure({ a: 0 }));
});

Deno.test("a cyclic structure degrades rather than throwing into the scan", () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  assertEquals(hashStructure(cyclic), "unhashable");
});

Deno.test("every zone-engine slot gets a real interval, never a slot name", async () => {
  // Bars are keyed (symbol, timeframe, bar_time). Writing "confirm" into the
  // timeframe column would store the same 15m bar twice and destroy the
  // deduplication the whole design rests on.
  const src = await Deno.readTextFile("supabase/functions/bot-scanner/index.ts");
  const at = src.indexOf("let zoneSlotTFs: Record<string, string>;");
  assert(at > 0, "the canonical slot-interval map is gone");
  const tail = src.slice(at, src.indexOf("buildSnapshot({"));
  // Three style branches must each define all six slots.
  const assignments = [...tail.matchAll(/zoneSlotTFs = \{([\s\S]*?)\};/g)];
  assertEquals(assignments.length, 3, "scalper, swing and day_trader must each map their slots");
  for (const a of assignments) {
    for (const slot of ["top", "mid", "low", "entry", "confirm", "ltf_confirm"]) {
      assert(a[1].includes(`${slot}:`), `a style branch omits the ${slot} slot`);
    }
    for (const tf of a[1].matchAll(/"([^"]+)"/g)) {
      assert(barMsOf(tf[1]) !== null, `"${tf[1]}" is not a recognised interval`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// it must not be able to change a trading decision
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("the module is pure — no database, no network, no clock", async () => {
  const src = await Deno.readTextFile("supabase/functions/_shared/smcScanSnapshot.ts");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
  for (const banned of ["createClient", "supabase-js", "fetch(", "Deno.env", ".from(", "Date.now("]) {
    assert(!code.includes(banned), `the snapshot module reaches ${banned}`);
  }
});

Deno.test("the scanner's snapshot write is fail-open and reaches no decision", async () => {
  const src = await Deno.readTextFile("supabase/functions/bot-scanner/index.ts");
  const at = src.indexOf("buildSnapshot({");
  assert(at > 0, "the snapshot write is gone");

  // It has its own try/catch and only warns.
  const block = src.slice(at - 900, at + 4500);
  assert(/catch \(snapErr: any\) \{[\s\S]*?snapshotFailures\+\+;[\s\S]*?console\.warn/.test(block),
    "a snapshot failure must be caught, counted and warned — never thrown");
  assert(!/throw[\s\S]{0,80}snapErr/.test(block), "a snapshot failure must not rethrow");

  // Nothing downstream branches on the counters.
  for (const m of src.matchAll(/snapshots(?:Written|Failures)/g)) {
    const around = src.slice(Math.max(0, m.index! - 60), m.index! + 60);
    assert(!/\bif\s*\([^)]*snapshot/i.test(around),
      `a decision branches on the snapshot counter: ...${around.trim()}...`);
  }

  // It writes only its own two tables.
  assert(src.includes('.from("smc_scan_bars")'));
  assert(src.includes('.from("smc_scan_manifest")'));
});

Deno.test("the write happens AFTER the engine has run, so inputs are already fixed", async () => {
  const src = await Deno.readTextFile("supabase/functions/bot-scanner/index.ts");
  const engine = src.indexOf("const unifiedResult: UnifiedZoneResult = findUnifiedZone(");
  const snap = src.indexOf("buildSnapshot({");
  assert(engine > 0 && snap > engine,
    "the snapshot must be built after findUnifiedZone, or it could influence what is scored");
});

// ─────────────────────────────────────────────────────────────────────────────
// schema posture
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATION = "supabase/migrations/20260925090000_smc_scan_bar_observability.sql";

Deno.test("both tables are RLS-forced and unreachable from a browser", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  for (const t of ["smc_scan_bars", "smc_scan_manifest", "smc_scan_context"]) {
    assert(new RegExp(`alter table public\\.${t}\\s+enable row level security`).test(sql), `${t} ENABLE`);
    assert(new RegExp(`alter table public\\.${t}\\s+force\\s+row level security`).test(sql), `${t} FORCE`);
    assert(new RegExp(`revoke all on public\\.${t}\\s+from anon, authenticated`).test(sql), `${t} REVOKE`);
    assert(new RegExp(`grant all on public\\.${t}\\s+to service_role`).test(sql), `${t} GRANT`);
  }
});

Deno.test("the migration is additive and deletes nothing", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  for (const banned of ["drop table", "truncate", "delete from", "alter table public.scan_candle_snapshots"]) {
    assert(!sql.toLowerCase().includes(banned), `the migration performs "${banned}"`);
  }
  // The dedup key is what makes the storage estimate hold.
  assert(sql.includes("primary key (symbol, timeframe, bar_time)"),
    "without the bar key the table degenerates to one row per scan per bar");
  assert(sql.includes("unique (scan_cycle_id, symbol, slot)"),
    "a retried scan must converge rather than duplicate");
  assert(sql.includes("unique (scan_cycle_id, symbol)"),
    "the context row is one per scan per symbol");
  // No silent retention policy.
  assert(!/pg_cron|cron\.schedule/i.test(sql), "the migration must not schedule deletion");
});

Deno.test("the contract version is declared in one place and stamped on every row", () => {
  assertEquals(SMC_CONTRACT_VERSION, "smc-zone-impulse-control-v1");
  const { manifest } = buildSnapshot(args([{ slot: "low", timeframe: "5m", candles: series(5) }]));
  assertEquals(manifest[0].contract_version, SMC_CONTRACT_VERSION);
});

// ─────────────────────────────────────────────────────────────────────────────
// the replay utility's contract with the engine
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("the replay feeds slots in the engine's counter-intuitive positional order", async () => {
  // findUnifiedZone's first three parameters are named h1/h4/entry but are
  // TF-agnostic: the scanner passes its LOWEST structural array first and its
  // HIGHEST as the ninth argument. Getting this backwards inverts the waterfall
  // and reads as engine nondeterminism.
  const src = await Deno.readTextFile("local-runner/zone-stage2-replay.ts");
  const call = src.slice(src.indexOf("findUnifiedZone("), src.indexOf("findUnifiedZone(") + 1400);
  const args = call.slice(call.indexOf("(") + 1);
  const lowAt = args.indexOf("slots.low"), midAt = args.indexOf("slots.mid");
  const entryAt = args.indexOf("slots.entry"), topAt = args.indexOf("slots.top");
  assert(lowAt >= 0 && midAt > lowAt && entryAt > midAt,
    "the first three arguments must be low, mid, entry — in that order");
  assert(topAt > entryAt, "the highest slot belongs in the ninth position, not the first");
  // An absent top slot must stay undefined; [] is a different input.
  assert(!/slots\.top \?\? \[\]/.test(src),
    "defaulting the top slot to [] fabricates an input production withheld");
});

Deno.test("the replay refuses to run the engine on inputs already known to differ", async () => {
  const src = await Deno.readTextFile("local-runner/zone-stage2-replay.ts");
  const guard = src.indexOf("INPUTS_DIVERGED");
  const engine = src.indexOf("findUnifiedZone(", src.indexOf("const replayed"));
  assert(guard > 0 && guard < engine,
    "an input-digest mismatch must short-circuit before the engine runs");
  assert(src.includes("engine not run"),
    "the report must say the engine was not reached, not imply it disagreed");
});

Deno.test("an empty replay reports that nothing was compared", async () => {
  // Stage 1's harness printed DETERMINISM_MATCH on 0 of 0 comparisons. A run
  // with nothing to replay must never read as a pass.
  const src = await Deno.readTextFile("local-runner/zone-stage2-replay.ts");
  assert(src.includes("NOTHING WAS COMPARED"), "the zero-comparison guard is gone");
  assert(src.includes("NO_SNAPSHOT"),
    "scans predating the patch must be labelled, not silently dropped");
});

Deno.test("the replay is read-only", async () => {
  const src = await Deno.readTextFile("local-runner/zone-stage2-replay.ts");
  for (const banned of [".insert(", ".upsert(", ".update(", ".delete(", ".rpc("]) {
    assert(!src.includes(banned), `the replay utility performs ${banned}`);
  }
  // The service-role key is read from the environment and never echoed.
  assert(src.includes('Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")'));
  // Naming the variable in a "please set this" error is fine; interpolating its
  // VALUE is not.
  assert(!src.includes("${key}"), "the key value must never be interpolated");
  assert(!/console\.[a-z]+\([^)]*\bkey\b\s*[,)]/.test(src), "the key value must never be logged");
});
