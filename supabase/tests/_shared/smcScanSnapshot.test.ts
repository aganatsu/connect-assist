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
  assertEquals(manifest[0].forming_bar, null, "at nowMs the last 5m bar has closed");
  assertEquals(manifest.length, 2, "but each slot still gets its own manifest row");
  assertEquals(manifest[0].slot, "low");
  assertEquals(manifest[1].slot, "entry");
});

Deno.test("consecutive scans add one bar, not three hundred", () => {
  // This is the whole economic argument. A jsonb array per scan costs ~24 KB
  // every five minutes for an array that gained one bar.
  // nowMs is set past the end of each array so every bar is closed and storable;
  // the forming-bar case is covered separately below.
  const first = buildSnapshot(args([{ slot: "low", timeframe: "5m", candles: series(300) }],
    T0 + 300 * 300_000));
  const second = buildSnapshot(args([{ slot: "low", timeframe: "5m", candles: series(301) }],
    T0 + 301 * 300_000));
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
  assert(row.htf_confluence_hash, "the HTF bundle must be verifiable");
  assert(row.liquidity_pool_hash);
  // And the bundles themselves are stored, not left to be re-derived. The
  // detector parameters behind them are config-driven and were not recoverable;
  // a replay that guessed them reported divergence that did not exist.
  assertEquals(row.htf_confluence, ctxArgs().htfConfluence);
  assertEquals(row.liquidity_pools, ctxArgs().liquidityPools);
  assertEquals(hashStructure(row.htf_confluence), row.htf_confluence_hash,
    "the stored bundle must hash to the recorded digest");
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

Deno.test("no two snapshot inputs collide on the manifest's natural key", () => {
  // THE BUG THIS PINS. The key was (scan_cycle_id, symbol, slot) and `context`
  // is a ROLE used three times per scan — 4H, Daily and 1H — so a single upsert
  // batch collided with itself and Postgres rejected the whole statement:
  //   23505 Key (scan_cycle_id, symbol, slot)=(..., context) already exists
  // Live result: 1,500 bars written, 0 manifests. Caught only in production
  // because nothing checked buildSnapshot's output against the real key.
  const m5 = series(50), m15 = series(50, 900_000), h1 = series(50, 3_600_000);
  const { manifest } = buildSnapshot(args([
    { slot: "top", timeframe: "1h", candles: h1 },
    { slot: "mid", timeframe: "15m", candles: m15 },
    { slot: "low", timeframe: "5m", candles: m5 },
    { slot: "entry", timeframe: "5m", candles: m5 },        // same interval as `low`
    { slot: "confirm", timeframe: "15m", candles: m15 },
    { slot: "ltf_confirm", timeframe: "5m", candles: m5 },
    { slot: "context", timeframe: "4h", candles: series(50, 14_400_000) },
    { slot: "context", timeframe: "1d", candles: series(50, 86_400_000) },
    { slot: "context", timeframe: "1h", candles: h1 },      // three `context` rows
  ]));
  const keys = manifest.map((m) => `${m.scan_cycle_id}|${m.symbol}|${m.slot}|${m.timeframe}`);
  assertEquals(new Set(keys).size, keys.length,
    "two rows share (scan, symbol, slot, timeframe) — the upsert will fail as a whole");
  // And the old three-part key genuinely would have collided, so this test is
  // exercising the real failure rather than a hypothetical one.
  const oldKeys = manifest.map((m) => `${m.scan_cycle_id}|${m.symbol}|${m.slot}`);
  assert(new Set(oldKeys).size < oldKeys.length,
    "the pre-fix key must still be demonstrably insufficient");
});

Deno.test("the scanner upserts on the four-part key", async () => {
  const src = await Deno.readTextFile("supabase/functions/bot-scanner/index.ts");
  assert(src.includes('onConflict: "scan_cycle_id,symbol,slot,timeframe"'),
    "the onConflict target must match the constraint, or every manifest write fails");
});

Deno.test("the migration is additive and deletes nothing", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  for (const banned of ["drop table", "truncate", "delete from", "alter table public.scan_candle_snapshots"]) {
    assert(!sql.toLowerCase().includes(banned), `the migration performs "${banned}"`);
  }
  // The dedup key is what makes the storage estimate hold.
  const barSql = await Deno.readTextFile(
    "supabase/migrations/20260925114000_smc_scan_bars_observation_keyed.sql");
  assert(barSql.includes("primary key (symbol, timeframe, bar_time, bar_hash)"),
    "bars are keyed by OBSERVATION — a provider revision must add a row, not vanish");
  const keySql = sql + await Deno.readTextFile(
    "supabase/migrations/20260925103000_smc_scan_manifest_key_timeframe.sql");
  assert(keySql.includes("unique (scan_cycle_id, symbol, slot, timeframe)"),
    "the manifest key must include the interval — `context` appears three times per scan");
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

Deno.test("the replay reads stored bundles and never re-derives them", async () => {
  const src = await Deno.readTextFile("local-runner/zone-stage2-replay.ts");
  for (const d of ["detectLiquidityPools", "detectOrderBlocks", "detectFVGs", "detectZigZagPivots"]) {
    assert(!src.includes(d),
      `the replay calls ${d} — re-deriving an input whose parameters were not recorded`);
  }
  assert(src.includes("ctx.htf_confluence"), "the replay must read the stored HTF bundle");
  assert(src.includes("ctx.liquidity_pools"), "the replay must read the stored pools");
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

// ─────────────────────────────────────────────────────────────────────────────
// the forming bar must never enter the immutable store
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("a forming bar is held on the manifest, not written to the bar table", () => {
  // THE BUG THIS PINS. smc_scan_bars dedups on (symbol, timeframe, bar_time)
  // and writes with ignoreDuplicates, so the FIRST observation of a bar is
  // permanent. That is right for a closed bar and wrong for the forming one,
  // whose OHLC changes every scan. Live result: the 15m bar opening 10:15 was
  // stored partial at 10:25, and at 10:45 the manifest hashed the completed bar
  // while the table still held the partial one — replay BARS_UNRECOVERABLE.
  const m5 = series(10);
  const midBar = T0 + 9 * 300_000 + 60_000;      // 1 min into the last bar
  const { bars, manifest } = buildSnapshot(args([
    { slot: "low", timeframe: "5m", candles: m5 },
  ], midBar));

  assertEquals(manifest[0].last_bar_closed, false);
  assertEquals(bars.length, 9, "the forming bar must be withheld from the bar table");
  assert(!bars.some((b) => b.bar_time === m5[9].datetime), "the forming bar leaked into storage");
  assertEquals(manifest[0].forming_bar?.datetime, m5[9].datetime);
  assertEquals(manifest[0].forming_bar?.close, m5[9].close);
  // The manifest still describes the whole array the engine saw.
  assertEquals(manifest[0].bar_count, 10);
});

Deno.test("a forming bar excluded from one slot cannot sneak in through another", () => {
  // The scalper passes the same 5m array as low, entry AND ltf_confirm. If the
  // exclusion were computed per slot, the second slot would re-admit the bar.
  const m5 = series(10);
  const midBar = T0 + 9 * 300_000 + 60_000;
  const { bars } = buildSnapshot(args([
    { slot: "low", timeframe: "5m", candles: m5 },
    { slot: "entry", timeframe: "5m", candles: m5 },
    { slot: "ltf_confirm", timeframe: "5m", candles: m5 },
  ], midBar));
  assertEquals(bars.length, 9);
  assert(!bars.some((b) => b.bar_time === m5[9].datetime));
});

Deno.test("reconstruction reunites stored bars with the manifest's forming bar", () => {
  const m5 = series(10);
  const midBar = T0 + 9 * 300_000 + 60_000;
  const { bars, manifest } = buildSnapshot(args([
    { slot: "low", timeframe: "5m", candles: m5 },
  ], midBar));

  // What the table would return: the 9 closed bars only.
  const stored = bars.map((b) => ({
    datetime: b.bar_time, open: b.open, high: b.high, low: b.low, close: b.close,
  })) as Candle[];

  const out = reconstruct(manifest[0], stored);
  assert(out.ok, `reconstruction failed: ${out.ok ? "" : out.reason}`);
  if (!out.ok) return;
  assertEquals(out.candles.length, 10, "the forming bar must be restored");
  assertEquals(out.candles[9].datetime, m5[9].datetime);
  assertEquals(out.candles[9].close, m5[9].close);
});

Deno.test("an unknown interval is treated as forming, never as closed", () => {
  // barMsOf returns null for an unrecognised label, so closure is unprovable.
  // Guessing "closed" would write a possibly-partial bar into a store that can
  // never be corrected; guessing "forming" costs a few bytes.
  const cs = series(5);
  const { bars, manifest } = buildSnapshot(args([
    { slot: "confirm", timeframe: "not-an-interval", candles: cs },
  ]));
  assertEquals(manifest[0].last_bar_closed, null);
  assertEquals(bars.length, 4, "the unprovable bar must be withheld");
  assertEquals(manifest[0].forming_bar?.datetime, cs[4].datetime);
});

Deno.test("each stored bar carries a digest of its own values", () => {
  // The key includes bar_hash so an identical re-observation collapses while a
  // revision of an already-closed bar is preserved. Measured: a 5m bar stored
  // 14 seconds after its close was still provisional and settled differently
  // later — "closed by the clock" is not "final from the provider".
  const { bars } = buildSnapshot(args([
    { slot: "low", timeframe: "5m", candles: series(5) },
  ], T0 + 10 * 300_000));
  assertEquals(bars.length, 5);
  assertEquals(new Set(bars.map((b) => b.bar_hash)).size, 5, "distinct bars, distinct digests");
  // Same bar, revised close → different digest → a second row, not a lost value.
  const revised = series(5).map((c, i) => i === 4 ? { ...c, close: c.close + 0.001 } : c);
  const after = buildSnapshot(args([
    { slot: "low", timeframe: "5m", candles: revised },
  ], T0 + 10 * 300_000));
  assertEquals(after.bars[4].bar_time, bars[4].bar_time);
  assert(after.bars[4].bar_hash !== bars[4].bar_hash, "a revised bar must be a new observation");
});

Deno.test("the replay reconstructs as known at scan time, not as known now", async () => {
  const src = await Deno.readTextFile("local-runner/zone-stage2-replay.ts");
  assert(/\.lte\("first_seen_at", asOf\)/.test(src),
    "observations later than the scan must be excluded, or replay rebuilds a history the scanner never saw");
  assert(src.includes("m.scanned_at"), "the manifest's own timestamp is the as-of point");
});

Deno.test("bars carry the provider datetime verbatim, not a re-derived one", () => {
  // timestamptz canonicalises on the way back, dropping ".000" from feeds that
  // emit sub-second precision (MetaAPI and Polygon both do, via
  // new Date(t).toISOString()). The digest is over the exact bytes the engine
  // saw, so identity needs the raw string; bar_time stays the queryable instant.
  const withMs = [{ datetime: "2026-01-01T00:00:00.000Z", open: 1, high: 1, low: 1, close: 1 }] as Candle[];
  const { bars } = buildSnapshot(args([{ slot: "low", timeframe: "5m", candles: withMs }],
    Date.UTC(2026, 0, 2)));
  assertEquals(bars[0].bar_time_raw, "2026-01-01T00:00:00.000Z",
    "the provider string must survive verbatim");
});

Deno.test("OHLC is stored as exact decimal, not rounded float", async () => {
  // 1.001 + 2e-5 is 1.0010199999999998; double precision renders back 1.00102
  // at 15 significant digits, losing the last ulp and breaking every digest.
  const sql = await Deno.readTextFile(
    "supabase/migrations/20260925123000_smc_scan_bars_exact_numeric.sql");
  for (const col of ["open", "high", "low", "close"]) {
    assert(new RegExp(`alter column ${col}\\s+type numeric`).test(sql),
      `${col} must be numeric — float output rounds and the digest is over exact values`);
  }
  assert(1.001 + 2e-5 !== 1.00102, "the precision hazard this guards is real");
});
